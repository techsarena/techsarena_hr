"""Realistic, idempotent records for the local role-dashboard demo users."""

from __future__ import annotations

from datetime import timedelta

import frappe
from frappe.utils import add_days, get_first_day, get_last_day, getdate, now_datetime, nowdate

LEAVE_APPROVER = "leave.approver@techsarena.local"
EXPENSE_APPROVER = "expense.approver@techsarena.local"
SHIFT_APPROVER = "shift.approver@techsarena.local"
INTERVIEWER = "interviewer@techsarena.local"

DEPARTMENT_BY_USER = {
	LEAVE_APPROVER: "Research & Development",
	EXPENSE_APPROVER: "Accounts",
	SHIFT_APPROVER: "Operations",
	"hr.user@techsarena.local": "Human Resources",
	"hr.manager@techsarena.local": "Human Resources",
	INTERVIEWER: "Research & Development",
	"system.manager@techsarena.local": "Management",
	"employee@techsarena.local": "Research & Development",
}


def provision_role_demo_records(company: str) -> dict[str, int]:
	"""Seed non-empty queues and self-service records for every demo account."""
	created: dict[str, int] = {}
	employees = _employees_by_user()
	if not employees:
		frappe.throw("Provision the role demo users before creating their records.")

	currency = frappe.db.get_value("Company", company, "default_currency") or "PKR"
	holiday_list = _ensure_holiday_list(company, created)
	general_shift, evening_shift = _ensure_shift_types(holiday_list, created)
	_ensure_salary_masters(company, currency, created)

	for index, (email, employee) in enumerate(employees.items()):
		department = DEPARTMENT_BY_USER[email]
		frappe.db.set_value(
			"Employee",
			employee.name,
			{
				"holiday_list": holiday_list,
				"default_shift": general_shift,
				"leave_approver": LEAVE_APPROVER,
				"expense_approver": EXPENSE_APPROVER,
				"shift_request_approver": SHIFT_APPROVER,
				"company_email": email,
				"department": department,
			},
			update_modified=False,
		)
		employee.department = department
		_ensure_leave_allocations(employee.name, company, created)
		_ensure_attendance(employee, company, index, created)
		_ensure_salary_slip(employee, company, currency, index, created)
		_ensure_notification(email, index, created)

	_ensure_leave_requests(employees, company, created)
	_ensure_expense_claims(employees, company, created)
	_ensure_shift_requests(employees, company, evening_shift, created)
	_ensure_recruitment(company, created)
	_ensure_system_activity(created)

	frappe.db.set_value("Company", company, "default_holiday_list", holiday_list)
	frappe.clear_cache()
	return dict(sorted(created.items()))


def _employees_by_user() -> dict:
	rows = frappe.get_all(
		"Employee",
		filters={"user_id": ["like", "%@techsarena.local"], "status": "Active"},
		fields=["name", "employee_name", "user_id", "department"],
		order_by="name asc",
	)
	return {row.user_id: row for row in rows}


def _mark(created: dict[str, int], doctype: str) -> None:
	created[doctype] = created.get(doctype, 0) + 1


def _sync_fields(doc, values: dict) -> None:
	changes = {field: value for field, value in values.items() if doc.get(field) != value}
	if changes:
		frappe.db.set_value(doc.doctype, doc.name, changes, update_modified=False)


def _insert_raw(values: dict, created: dict[str, int], *, creation=None):
	doctype = values["doctype"]
	name = values.get("name")
	if name and frappe.db.exists(doctype, name):
		return frappe.get_doc(doctype, name)
	doc = frappe.get_doc(values)
	if creation:
		doc.creation = creation
		doc.modified = creation
		doc.owner = "Administrator"
		doc.modified_by = "Administrator"
	doc.db_insert()
	for child in doc.get_all_children():
		child.db_insert()
	_mark(created, doctype)
	return doc


def _ensure_holiday_list(company: str, created: dict[str, int]) -> str:
	year = getdate(nowdate()).year
	name = f"Orbit Demo Holidays {year}"
	_insert_raw(
		{
			"doctype": "Holiday List",
			"name": name,
			"holiday_list_name": name,
			"from_date": f"{year}-01-01",
			"to_date": f"{year}-12-31",
			"holidays": [
				{
					"holiday_date": add_days(nowdate(), 14),
					"description": "Independence Day",
					"weekly_off": 0,
				},
				{
					"holiday_date": add_days(nowdate(), 35),
					"description": "Company Foundation Day",
					"weekly_off": 0,
				},
				{
					"holiday_date": add_days(nowdate(), 70),
					"description": "Community Day",
					"weekly_off": 0,
				},
			],
		},
		created,
	)
	return name


def _ensure_shift_types(holiday_list: str, created: dict[str, int]) -> tuple[str, str]:
	shifts = (
		("Orbit General Shift", "09:00:00", "18:00:00"),
		("Orbit Evening Shift", "14:00:00", "22:00:00"),
	)
	for name, start, end in shifts:
		_insert_raw(
			{
				"doctype": "Shift Type",
				"name": name,
				"start_time": start,
				"end_time": end,
				"holiday_list": holiday_list,
				"determine_check_in_and_check_out": "Strictly based on Log Type in Employee Checkin",
			},
			created,
		)
	return shifts[0][0], shifts[1][0]


def _ensure_leave_allocations(employee: str, company: str, created: dict[str, int]) -> None:
	year = getdate(nowdate()).year
	for leave_type, amount in (("Privilege Leave", 12), ("Sick Leave", 8), ("Casual Leave", 6)):
		filters = {
			"employee": employee,
			"leave_type": leave_type,
			"from_date": f"{year}-01-01",
			"to_date": f"{year}-12-31",
			"docstatus": 1,
		}
		if frappe.db.exists("Leave Allocation", filters):
			continue
		doc = frappe.get_doc(
			{
				"doctype": "Leave Allocation",
				"employee": employee,
				"leave_type": leave_type,
				"from_date": filters["from_date"],
				"to_date": filters["to_date"],
				"total_leaves_allocated": amount,
				"new_leaves_allocated": amount,
				"company": company,
			}
		)
		doc.insert(ignore_permissions=True)
		doc.submit()
		_mark(created, "Leave Allocation")


def _ensure_attendance(employee, company: str, index: int, created: dict[str, int]) -> None:
	attendance_name = f"ORBIT-DEMO-ATT-{employee.name}"
	doc = _insert_raw(
		{
			"doctype": "Attendance",
			"name": attendance_name,
			"employee": employee.name,
			"employee_name": employee.employee_name,
			"attendance_date": nowdate(),
			"company": company,
			"status": "Present" if index % 4 else "Work From Home",
			"working_hours": 7.5 + (index % 3) * 0.4,
			"late_entry": 1 if index in {1, 4} else 0,
			"early_exit": 1 if index == 6 else 0,
			"shift": "Orbit General Shift",
			"docstatus": 1,
		},
		created,
	)
	_sync_fields(doc, {"department": employee.department})
	start = now_datetime() - timedelta(hours=8, minutes=index * 2)
	end = now_datetime() - timedelta(minutes=20 + index)
	for suffix, time, log_type in (("IN", start, "IN"), ("OUT", end, "OUT")):
		_insert_raw(
			{
				"doctype": "Employee Checkin",
				"name": f"ORBIT-DEMO-CHECKIN-{employee.name}-{suffix}",
				"employee": employee.name,
				"employee_name": employee.employee_name,
				"time": time,
				"log_type": log_type,
				"shift": "Orbit General Shift",
				"device_id": "Orbit Demo Seed",
			},
			created,
		)


def _ensure_salary_masters(company: str, currency: str, created: dict[str, int]) -> None:
	for name, abbreviation, component_type in (
		("Orbit Basic", "OB", "Earning"),
		("Orbit Allowance", "OA", "Earning"),
		("Orbit Tax", "OT", "Deduction"),
	):
		_insert_raw(
			{
				"doctype": "Salary Component",
				"name": name,
				"salary_component": name,
				"salary_component_abbr": abbreviation,
				"type": component_type,
			},
			created,
		)
	_insert_raw(
		{
			"doctype": "Salary Structure",
			"name": "Orbit Demo Salary Structure",
			"company": company,
			"is_active": "Yes",
			"currency": currency,
			"payroll_frequency": "Monthly",
		},
		created,
	)


def _ensure_salary_slip(employee, company: str, currency: str, index: int, created: dict[str, int]) -> None:
	gross = 140_000 + index * 12_500
	deduction = 18_000 + index * 1_250
	month_start = get_first_day(nowdate())
	month_end = get_last_day(nowdate())
	doc = _insert_raw(
		{
			"doctype": "Salary Slip",
			"name": f"ORBIT-DEMO-SAL-{employee.name}",
			"employee": employee.name,
			"employee_name": employee.employee_name,
			"company": company,
			"salary_structure": "Orbit Demo Salary Structure",
			"posting_date": month_end,
			"start_date": month_start,
			"end_date": month_end,
			"total_working_days": 22,
			"payment_days": 22,
			"currency": currency,
			"exchange_rate": 1,
			"gross_pay": gross,
			"total_deduction": deduction,
			"net_pay": gross - deduction,
			"rounded_total": gross - deduction,
			"docstatus": 1,
			"earnings": [
				{"salary_component": "Orbit Basic", "abbr": "OB", "amount": gross * 0.65},
				{"salary_component": "Orbit Allowance", "abbr": "OA", "amount": gross * 0.35},
			],
			"deductions": [
				{"salary_component": "Orbit Tax", "abbr": "OT", "amount": deduction},
			],
		},
		created,
	)
	_sync_fields(doc, {"department": employee.department})


def _ensure_leave_requests(employees: dict, company: str, created: dict[str, int]) -> None:
	for index, employee in enumerate(employees.values()):
		start = getdate(add_days(nowdate(), 5 + index * 3))
		end = getdate(add_days(start, index % 3))
		creation = now_datetime() - timedelta(hours=12 + index * 15)
		doc = _insert_raw(
			{
				"doctype": "Leave Application",
				"name": f"ORBIT-DEMO-LEAVE-{index + 1:02}",
				"employee": employee.name,
				"employee_name": employee.employee_name,
				"company": company,
				"leave_type": ("Privilege Leave", "Sick Leave", "Casual Leave")[index % 3],
				"from_date": start,
				"to_date": end,
				"total_leave_days": (end - start).days + 1,
				"status": "Open",
				"leave_approver": LEAVE_APPROVER,
				"leave_approver_name": "Nikhil Varma",
				"leave_balance": 8 - index % 4,
				"description": "[Orbit Demo] Family or personal commitment",
				"docstatus": 0,
			},
			created,
			creation=creation,
		)
		_sync_fields(doc, {"department": employee.department})


def _ensure_expense_claims(employees: dict, company: str, created: dict[str, int]) -> None:
	expense_types = ("Travel", "Food", "Medical", "Calls", "Others")
	for index, employee in enumerate(list(employees.values())[:6]):
		amount = 6_500 + index * 4_250
		doc = _insert_raw(
			{
				"doctype": "Expense Claim",
				"name": f"ORBIT-DEMO-EXPENSE-{index + 1:02}",
				"employee": employee.name,
				"employee_name": employee.employee_name,
				"company": company,
				"expense_approver": EXPENSE_APPROVER,
				"approval_status": "Draft",
				"status": "Draft",
				"posting_date": add_days(nowdate(), -index),
				"remark": f"[Orbit Demo] {expense_types[index % len(expense_types)]} reimbursement",
				"total_claimed_amount": amount,
				"total_sanctioned_amount": amount,
				"grand_total": amount,
				"docstatus": 0,
				"expenses": [
					{
						"expense_date": add_days(nowdate(), -(index + 1)),
						"expense_type": expense_types[index % len(expense_types)],
						"description": "Demo receipt attached",
						"amount": amount,
						"sanctioned_amount": amount,
					}
				],
			},
			created,
			creation=now_datetime() - timedelta(hours=8 + index * 9),
		)
		_sync_fields(doc, {"department": employee.department})


def _ensure_shift_requests(
	employees: dict,
	company: str,
	evening_shift: str,
	created: dict[str, int],
) -> None:
	for index, employee in enumerate(list(employees.values())[:6]):
		start = add_days(nowdate(), 2 + index * 2)
		doc = _insert_raw(
			{
				"doctype": "Shift Request",
				"name": f"ORBIT-DEMO-SHIFT-{index + 1:02}",
				"employee": employee.name,
				"employee_name": employee.employee_name,
				"company": company,
				"shift_type": evening_shift,
				"from_date": start,
				"to_date": add_days(start, 2),
				"status": "Draft",
				"approver": SHIFT_APPROVER,
				"docstatus": 0,
			},
			created,
			creation=now_datetime() - timedelta(hours=5 + index * 7),
		)
		_sync_fields(doc, {"department": employee.department})


def _ensure_recruitment(company: str, created: dict[str, int]) -> None:
	openings = (
		("ORBIT-DEMO-JOB-BACKEND", "Backend Engineer", "Engineering Lead"),
		("ORBIT-DEMO-JOB-DESIGN", "Product Designer", "Product Designer"),
		("ORBIT-DEMO-JOB-HR", "People Operations Specialist", "HR Executive"),
	)
	for name, title, designation in openings:
		_insert_raw(
			{
				"doctype": "Job Opening",
				"name": name,
				"job_title": title,
				"company": company,
				"designation": designation,
				"status": "Open",
				"posted_on": nowdate(),
				"vacancies": 2,
			},
			created,
		)
	_insert_raw(
		{
			"doctype": "Interview Round",
			"name": "Orbit Demo Technical Round",
			"round_name": "Technical Round",
			"designation": "Engineering Lead",
		},
		created,
	)
	candidates = (
		("Ananya Kulkarni", "ananya.demo@example.com", "10:30:00", 0),
		("Zoya Sheikh", "zoya.demo@example.com", "14:00:00", 0),
		("Arjun Bose", "arjun.demo@example.com", "16:30:00", 0),
		("Kabir Rana", "kabir.demo@example.com", "11:00:00", -7),
		("Tara Iyer", "tara.demo@example.com", "15:00:00", -2),
	)
	for index, (candidate, email, time, day_offset) in enumerate(candidates):
		applicant_name = f"ORBIT-DEMO-APPLICANT-{index + 1:02}"
		_insert_raw(
			{
				"doctype": "Job Applicant",
				"name": applicant_name,
				"applicant_name": candidate,
				"email_id": email,
				"status": "Open",
				"job_title": openings[0][0],
				"designation": "Engineering Lead",
			},
			created,
		)
		_insert_raw(
			{
				"doctype": "Interview",
				"name": f"ORBIT-DEMO-INTERVIEW-{index + 1:02}",
				"job_applicant": applicant_name,
				"job_opening": openings[0][0],
				"designation": "Engineering Lead",
				"interview_round": "Orbit Demo Technical Round",
				"status": "Pending",
				"scheduled_on": add_days(nowdate(), day_offset),
				"from_time": time,
				"to_time": "17:30:00",
				"docstatus": 0,
				"interview_details": [{"interviewer": INTERVIEWER}],
			},
			created,
		)

	_ensure_onboarding(company, created)


def _ensure_onboarding(company: str, created: dict[str, int]) -> None:
	"""Seed real HRMS onboarding plans so the Hiring workflow has joiners."""
	plans = (
		{
			"index": 1,
			"applicant": "ORBIT-DEMO-APPLICANT-01",
			"employee_name": "Ananya Kulkarni",
			"starts_in": 3,
			"percent": 60,
			"status": "In Process",
			"activities": (
				("Offer accepted", "Completed", -8, "HR User", 1),
				("Documents verified", "Completed", -6, "HR User", 1),
				("Salary structure assigned", "Completed", -4, "HR Manager", 0),
				("Laptop ordered", "Open", -3, "IT User", 1),
				("Email and system access", "Open", 1, "IT User", 0),
			),
		},
		{
			"index": 2,
			"applicant": "ORBIT-DEMO-APPLICANT-02",
			"employee_name": "Zoya Sheikh",
			"starts_in": 5,
			"percent": 33,
			"status": "In Process",
			"activities": (
				("Offer accepted", "Completed", -5, "HR User", 1),
				("ID proof verified", "Open", 1, "HR User", 1),
				("Buddy introduced", "Open", 3, "HR User", 0),
			),
		},
		{
			"index": 3,
			"applicant": "ORBIT-DEMO-APPLICANT-03",
			"employee_name": "Arjun Bose",
			"starts_in": -10,
			"percent": 100,
			"status": "Completed",
			"activities": (
				("Offer accepted", "Completed", -18, "HR User", 1),
				("Documents verified", "Completed", -16, "HR User", 1),
				("Week-one plan shared", "Completed", -9, "HR Manager", 0),
			),
		},
	)
	for plan in plans:
		index = plan["index"]
		project_name = f"ORBIT-DEMO-ONBOARDING-PROJECT-{index:02}"
		_insert_raw(
			{
				"doctype": "Project",
				"name": project_name,
				"project_name": f"Employee Onboarding: {plan['employee_name']}",
				"company": company,
				"status": "Completed" if plan["percent"] == 100 else "Open",
				"percent_complete": plan["percent"],
				"expected_start_date": add_days(nowdate(), plan["starts_in"]),
			},
			created,
		)
		activities = []
		for activity_index, (label, status, due_offset, role, required) in enumerate(
			plan["activities"],
			start=1,
		):
			task_name = f"ORBIT-DEMO-ONBOARDING-TASK-{index:02}-{activity_index:02}"
			_insert_raw(
				{
					"doctype": "Task",
					"name": task_name,
					"subject": f"{label}: {plan['employee_name']}",
					"project": project_name,
					"company": company,
					"status": status,
					"exp_start_date": add_days(nowdate(), due_offset - 1),
					"exp_end_date": add_days(nowdate(), due_offset),
				},
				created,
			)
			activities.append(
				{
					"activity_name": label,
					"role": role,
					"task": task_name,
					"required_for_employee_creation": required,
					"description": "Complete this activity before the joiner's first day.",
				}
			)
		_insert_raw(
			{
				"doctype": "Employee Onboarding",
				"name": f"ORBIT-DEMO-ONBOARDING-{index:02}",
				"job_applicant": plan["applicant"],
				"employee_name": plan["employee_name"],
				"date_of_joining": add_days(nowdate(), plan["starts_in"]),
				"boarding_begins_on": add_days(nowdate(), plan["starts_in"] - 11),
				"boarding_status": plan["status"],
				"company": company,
				"department": "Research & Development",
				"designation": "Engineering Lead",
				"project": project_name,
				"docstatus": 1,
				"activities": activities,
			},
			created,
		)


def _ensure_notification(user: str, index: int, created: dict[str, int]) -> None:
	_insert_raw(
		{
			"doctype": "Notification Log",
			"name": f"ORBIT-DEMO-NOTIFICATION-{index + 1:02}",
			"for_user": user,
			"subject": "Your Techs Arena HCM dashboard is ready",
			"type": "Alert",
			"read": 0,
		},
		created,
	)


def _ensure_system_activity(created: dict[str, int]) -> None:
	for index, (method, reference) in enumerate(
		(("Salary Slip validation", "Salary Slip"), ("Outgoing email authentication", "Email Queue"))
	):
		_insert_raw(
			{
				"doctype": "Error Log",
				"name": f"ORBIT-DEMO-ERROR-{index + 1}",
				"method": method,
				"reference_doctype": reference,
				"error": "[Orbit Demo] Example operational error for the System Manager dashboard.",
			},
			created,
			creation=now_datetime() - timedelta(hours=index + 2),
		)
