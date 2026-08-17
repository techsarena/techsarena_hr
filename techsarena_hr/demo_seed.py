"""Button-triggered demo dataset: a fuller workforce for exercising the app.

Extends the role-account seed in ``demo.py`` / ``demo_records.py`` with enough
employees, logins and supporting records to test employee self-service and the
approver queues at realistic volume. Idempotent: stable names and existence
checks let it run repeatedly (from ``bench execute`` or the whitelisted
``seed_demo_data`` endpoint) without creating duplicates.
"""

from __future__ import annotations

from datetime import timedelta

import frappe
from frappe.utils import add_days, cint, getdate, now_datetime, nowdate
from frappe.utils.password import update_password

from techsarena_hr import demo_records as dr
from techsarena_hr.demo import (
	DEMO_PASSWORD,
	_default_gender,
	_ensure_designation,
	provision_role_demo_users,
)

DOMAIN = "techsarena.local"

# (email-local, first, last, department, designation, extra_roles). Weighted
# towards Human Resources so the HR, approver and directory screens have depth,
# with the remaining teams giving self-service accounts a realistic org around
# them. Emails are deterministic so re-running never duplicates a person.
BULK_WORKFORCE = (
	("demo.hr1", "Farah", "Khan", "Human Resources", "HR Executive", ("HR User",)),
	("demo.hr2", "Bilal", "Ahmed", "Human Resources", "HR Executive", ("HR User",)),
	("demo.hr3", "Sadia", "Malik", "Human Resources", "HR Business Partner", ("HR Manager",)),
	("demo.hr4", "Usman", "Tariq", "Human Resources", "Recruiter", ("HR User",)),
	("demo.hr5", "Hina", "Iqbal", "Human Resources", "HR Team Lead", ("Leave Approver",)),
	("demo.eng1", "Ahsan", "Raza", "Research & Development", "Software Engineer", ()),
	("demo.eng2", "Maria", "Yousuf", "Research & Development", "Software Engineer", ()),
	("demo.eng3", "Hamza", "Sheikh", "Research & Development", "Senior Software Engineer", ()),
	("demo.eng4", "Ayesha", "Noor", "Research & Development", "QA Engineer", ()),
	("demo.sales1", "Zain", "Abbas", "Sales", "Sales Executive", ()),
	("demo.sales2", "Nida", "Aslam", "Sales", "Account Manager", ()),
	("demo.ops1", "Fahad", "Butt", "Operations", "Operations Analyst", ()),
	("demo.ops2", "Rabia", "Zafar", "Operations", "Operations Lead", ("Shift Request Approver",)),
	("demo.fin1", "Owais", "Siddiqui", "Accounts", "Accountant", ()),
	("demo.fin2", "Sana", "Javed", "Accounts", "Finance Analyst", ("Expense Approver",)),
	("demo.sup1", "Talha", "Mahmood", "Support", "Support Specialist", ()),
)


def seed_demo_dataset(password: str = DEMO_PASSWORD) -> dict:
	"""Provision the role accounts + a bulk workforce and all their records.

	Returns a compact summary the UI can surface. Safe to call repeatedly.
	"""
	company = frappe.db.get_single_value("Global Defaults", "default_company") or frappe.db.get_value(
		"Company", {}, "name"
	)
	if not company:
		frappe.throw("Create a Company before seeding demo data.")

	# Departments must exist before any record does: Leave Allocation validates
	# the employee's department link, and a fresh site only has the NestedSet root.
	_ensure_departments(company)

	# The Techs Arena Subscription caps active employees (and payroll) per
	# company; give the demo company enough seats for the whole workforce.
	seat_target = frappe.db.count("Employee", {"status": "Active", "company": company}) + len(
		BULK_WORKFORCE
	) + 6
	seat_limit = _ensure_seat_capacity(company, seat_target)
	frappe.db.commit()

	# Role accounts first. This also lays down the shared masters (holiday list,
	# shift types, salary structure) the bulk employees reuse, and runs
	# ``provision_role_demo_records`` while only the eight known role emails
	# exist — so its ``DEPARTMENT_BY_USER`` lookup never meets an unknown address.
	role_summary = provision_role_demo_users(password)

	bulk_summary = provision_bulk_demo_workforce(company, password)
	frappe.db.commit()
	frappe.clear_cache()

	# Demo loans, only when the `lending` app is installed. Isolated so a failure
	# here never fails the rest of the seed.
	loans_summary = None
	if frappe.db.exists("DocType", "Loan"):
		try:
			from techsarena_hr.demo_loans import seed_demo_loans

			loans_summary = seed_demo_loans()
			frappe.db.commit()
		except Exception:
			frappe.db.rollback()
			frappe.log_error(title="Techsarena demo loan seed failed")

	total_employees = frappe.db.count(
		"Employee", {"user_id": ["like", f"%@{DOMAIN}"], "status": "Active"}
	)
	return {
		"password": password,
		"company": company,
		"employees": total_employees,
		"role_users": list(role_summary.get("users", [])),
		"bulk_users": bulk_summary["users"],
		"created_records": bulk_summary["created"],
		"seat_limit": seat_limit,
		"loans": loans_summary,
	}


def _ensure_departments(company: str) -> None:
	"""Create the leaf Departments the seed assigns to employees.

	``demo_records`` stores plain department names (e.g. "Research & Development")
	and Leave Allocation validates that link. ERPNext would otherwise autoname a
	Department "<name> - <abbr>", so the plain name is forced via ``name_set`` to
	keep the employee link resolvable. Idempotent.
	"""
	names = set(dr.DEPARTMENT_BY_USER.values()) | {row[3] for row in BULK_WORKFORCE}
	for name in sorted(names):
		if frappe.db.exists("Department", name):
			continue
		dept = frappe.get_doc(
			{
				"doctype": "Department",
				"department_name": name,
				"company": company,
				"is_group": 0,
			}
		)
		dept.flags.name_set = True
		dept.name = name
		dept.insert(ignore_permissions=True)


def _ensure_seat_capacity(company: str, minimum: int) -> int | None:
	"""Raise the demo company's licensed seat count so the workforce fits.

	The Techs Arena Subscription (``subscription.py``) caps active employees per
	company and gates payroll on the same limit, so a fuller org needs headroom.
	Only ever *raises* an existing limit — never lowers one — and pushes an
	expired licence forward so payroll stays runnable. No-op when the company is
	unlicensed (no row, or an unlimited ``0`` seat count) or the subscription
	doctype is absent. Returns the effective seat limit, or ``None`` if untouched.
	"""
	if not frappe.db.exists("DocType", "Techsarena Subscription"):
		return None
	sub = frappe.get_doc("Techsarena Subscription")
	row = next((line for line in sub.company_licenses if line.company == company), None)
	if row is None or not cint(row.licensed_employees):
		return None  # unrestricted for this company

	changed = False
	if cint(row.licensed_employees) < minimum:
		row.licensed_employees = minimum
		changed = True
	if row.valid_upto and getdate(row.valid_upto) < getdate(nowdate()):
		row.valid_upto = add_days(nowdate(), 365)
		changed = True
	if changed:
		sub.save(ignore_permissions=True)
	return cint(row.licensed_employees)


def provision_bulk_demo_workforce(company: str, password: str = DEMO_PASSWORD) -> dict:
	"""Create the non-role employees, their logins and self-service records."""
	created: dict[str, int] = {}
	currency = frappe.db.get_value("Company", company, "default_currency") or "PKR"
	year = getdate(nowdate()).year
	holiday_list = f"Techsarena Demo Holidays {year}"
	general_shift = "Techsarena General Shift"
	evening_shift = "Techsarena Evening Shift"
	manager = frappe.db.get_value("Employee", {"user_id": f"hr.manager@{DOMAIN}"}, "name")

	users: list[str] = []
	people: list = []
	for index, (local, first, last, department, designation, extra_roles) in enumerate(BULK_WORKFORCE):
		email = f"{local}@{DOMAIN}"
		full_name = f"{first} {last}"

		if not frappe.db.exists("User", email):
			frappe.get_doc(
				{
					"doctype": "User",
					"email": email,
					"first_name": first,
					"last_name": last,
					"enabled": 1,
					"user_type": "System User",
					"send_welcome_email": 0,
				}
			).insert(ignore_permissions=True)
			users.append(email)
		user = frappe.get_doc("User", email)
		user.add_roles("Employee", "Employee Self Service", *extra_roles)
		update_password(email, password)

		employee = frappe.db.get_value("Employee", {"user_id": email}, "name")
		if not employee:
			doc = frappe.get_doc(
				{
					"doctype": "Employee",
					"first_name": first,
					"last_name": last,
					"employee_name": full_name,
					"gender": _default_gender(),
					"date_of_birth": getdate("1990-01-01"),
					"date_of_joining": getdate(add_days(nowdate(), -30 * (index + 1))),
					"company": company,
					"status": "Active",
					"user_id": email,
					"designation": _ensure_designation(designation),
				}
			).insert(ignore_permissions=True)
			employee = doc.name
			dr._mark(created, "Employee")

		frappe.db.set_value(
			"Employee",
			employee,
			{
				"holiday_list": holiday_list,
				"default_shift": general_shift,
				"leave_approver": dr.LEAVE_APPROVER,
				"expense_approver": dr.EXPENSE_APPROVER,
				"shift_request_approver": dr.SHIFT_APPROVER,
				"company_email": email,
				"department": department,
				"reports_to": manager if manager and manager != employee else None,
			},
			update_modified=False,
		)

		record = frappe._dict(name=employee, employee_name=full_name, department=department)
		people.append(record)
		dr._ensure_leave_allocations(employee, company, created)
		dr._ensure_attendance(record, company, index, created)
		dr._ensure_salary_slip(record, company, currency, index, created)
		# Not ``_ensure_notification`` — its name is keyed by index alone and
		# would collide with the role seed's notifications 01-08.
		dr._insert_raw(
			{
				"doctype": "Notification Log",
				"name": f"TECHSARENA-DEMO-BULK-NOTIF-{index + 1:02}",
				"for_user": email,
				"subject": "Your Techs Arena HCM workspace is ready",
				"type": "Alert",
				"read": 0,
			},
			created,
		)

	_seed_bulk_queues(people, company, evening_shift, created)
	frappe.db.commit()
	return {"users": users, "created": dict(sorted(created.items()))}


def _seed_bulk_queues(people: list, company: str, evening_shift: str, created: dict) -> None:
	"""Pending requests from bulk employees so approver dashboards aren't empty."""
	leave_types = ("Privilege Leave", "Sick Leave", "Casual Leave")
	for index, person in enumerate(people[:8]):
		start = getdate(add_days(nowdate(), 4 + index * 2))
		end = getdate(add_days(start, index % 3))
		doc = dr._insert_raw(
			{
				"doctype": "Leave Application",
				"name": f"TECHSARENA-DEMO-BULK-LEAVE-{index + 1:02}",
				"employee": person.name,
				"employee_name": person.employee_name,
				"company": company,
				"leave_type": leave_types[index % 3],
				"from_date": start,
				"to_date": end,
				"total_leave_days": (end - start).days + 1,
				"status": "Open",
				"leave_approver": dr.LEAVE_APPROVER,
				"leave_approver_name": "Nikhil Varma",
				"leave_balance": 8 - index % 4,
				"description": "[Techsarena Demo] Planned time off",
				"docstatus": 0,
			},
			created,
			creation=now_datetime() - timedelta(hours=10 + index * 6),
		)
		dr._sync_fields(doc, {"department": person.department})

	expense_types = ("Travel", "Food", "Medical", "Calls", "Others")
	for index, person in enumerate(people[:6]):
		amount = 5_000 + index * 3_500
		doc = dr._insert_raw(
			{
				"doctype": "Expense Claim",
				"name": f"TECHSARENA-DEMO-BULK-EXPENSE-{index + 1:02}",
				"employee": person.name,
				"employee_name": person.employee_name,
				"company": company,
				"expense_approver": dr.EXPENSE_APPROVER,
				"approval_status": "Draft",
				"status": "Draft",
				"posting_date": add_days(nowdate(), -index),
				"remark": f"[Techsarena Demo] {expense_types[index % len(expense_types)]} reimbursement",
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
			creation=now_datetime() - timedelta(hours=6 + index * 5),
		)
		dr._sync_fields(doc, {"department": person.department})

	for index, person in enumerate(people[:5]):
		start = add_days(nowdate(), 3 + index * 2)
		dr._insert_raw(
			{
				"doctype": "Shift Request",
				"name": f"TECHSARENA-DEMO-BULK-SHIFT-{index + 1:02}",
				"employee": person.name,
				"employee_name": person.employee_name,
				"company": company,
				"shift_type": evening_shift,
				"from_date": start,
				"to_date": add_days(start, 2),
				"status": "Draft",
				"approver": dr.SHIFT_APPROVER,
				"docstatus": 0,
			},
			created,
			creation=now_datetime() - timedelta(hours=4 + index * 4),
		)
