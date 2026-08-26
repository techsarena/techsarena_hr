"""Mobile-friendly API facade for Techs Arena HCM.

The endpoints in this module deliberately compose existing ERPNext/HRMS
documents and business rules.  They do not duplicate HRMS validation and they
never trust an employee identifier supplied by the client for self-service
actions.
"""

from __future__ import annotations

import json
import re
from datetime import datetime

import frappe
from frappe import _
from frappe.utils import (
	add_months,
	add_days,
	add_years,
	cint,
	date_diff,
	flt,
	get_datetime,
	get_first_day,
	get_last_day,
	get_timedelta,
	getdate,
	now_datetime,
	nowdate,
)

from techsarena_hr.role_dashboards import build_role_dashboards

HR_ROLES = {"HR User", "HR Manager", "Administrator"}
#: Roles that decide requests in the approvals inbox. The queue spans leave,
#: expenses, attendance and comp-off, so every approver role belongs here.
MANAGER_ROLES = HR_ROLES | {"Leave Approver", "Expense Approver", "Shift Request Approver"}
SETTINGS_ROLES = HR_ROLES | {"System Manager", "Accounts Manager"}
SETTINGS_EDIT_ROLES = {"System Manager", "HR Manager", "Administrator"}


def _require_login() -> str:
	user = frappe.session.user
	if not user or user == "Guest":
		frappe.throw(_("Please sign in to continue."), frappe.AuthenticationError)
	return user


def _require_hrms() -> None:
	if not frappe.db.table_exists("Employee"):
		frappe.throw(
			_("HRMS is not installed on this site. Install ERPNext and HRMS, then try again."),
			frappe.ValidationError,
		)


def _require_hr_access(user: str | None = None) -> str:
	"""Keep HR-only endpoints aligned with the capability exposed to the client."""
	user = user or _require_login()
	if not set(frappe.get_roles(user)).intersection(HR_ROLES):
		frappe.throw(_("You do not have access to HR records."), frappe.PermissionError)
	return user


def _current_employee(user: str | None = None, required: bool = True) -> str | None:
	user = user or _require_login()
	employee = frappe.db.get_value("Employee", {"user_id": user, "status": "Active"}, "name")
	if required and not employee:
		frappe.throw(
			_("Your account is not linked to an active Employee record. Please contact HR."),
			frappe.PermissionError,
		)
	return employee


def _visible_employee_names(employee: str | None) -> set[str]:
	"""The employee plus everyone under them in the reporting tree.

	Self-service visibility for a non-HR user: their own record and their direct
	and indirect reports, and nothing else. With no reports this collapses to
	``{employee}`` (own records only). Traversed in Python off a single query;
	a ``seen`` set makes an accidental reporting cycle safe.
	"""
	if not employee:
		return set()
	children: dict[str, list[str]] = {}
	for row in frappe.get_all(
		"Employee",
		filters={"status": "Active"},
		fields=["name", "reports_to"],
		limit_page_length=0,
	):
		if row.reports_to:
			children.setdefault(row.reports_to, []).append(row.name)
	visible = {employee}
	queue = [employee]
	while queue:
		current = queue.pop()
		for child in children.get(current, ()):
			if child not in visible:
				visible.add(child)
				queue.append(child)
	return visible


def _require_employee_user(user: str | None = None) -> tuple[str, str]:
	user = user or _require_login()
	if "Employee" not in set(frappe.get_roles(user)):
		frappe.throw(
			_("The Employee role is required to use employee self-service."),
			frappe.PermissionError,
		)
	return user, _current_employee(user)


def _as_text(value) -> str | None:
	return str(value) if value is not None else None


#: Realtime event namespace. The client subscribes to these once, on the socket
#: Frappe already runs; nothing here polls.
REALTIME_EVENT = "techsarena_hr"


def _publish(event: str, payload: dict, *, user: str | None = None) -> None:
	"""Push a change to a connected client over Frappe's socket.

	Fire-and-forget by design: a socket that is down must never fail the write
	that triggered it. ``after_commit`` means the client is only told once the
	transaction is durable, so a listener that immediately refetches cannot read
	back the pre-write state.
	"""
	try:
		frappe.publish_realtime(
			event=REALTIME_EVENT,
			message={"event": event, **payload},
			user=user,
			after_commit=True,
		)
	except Exception:
		# Realtime is an enhancement, never a dependency of the mutation.
		frappe.log_error(title="Techsarena realtime publish failed")


def _publish_to_employee(employee: str, event: str, payload: dict) -> None:
	"""Notify the user account behind an Employee record, if it has one."""
	if not employee:
		return
	user = frappe.db.get_value("Employee", employee, "user_id")
	if user:
		_publish(event, {"employee": employee, **payload}, user=user)


def _shift_crosses_midnight(shift_type: str | None) -> bool:
	"""Whether a shift's end time falls on the day after its start."""
	if not shift_type:
		return False
	row = frappe.db.get_value("Shift Type", shift_type, ["start_time", "end_time"], as_dict=True)
	if not row or row.start_time is None or row.end_time is None:
		return False
	return get_timedelta(row.end_time).total_seconds() <= get_timedelta(row.start_time).total_seconds()


def _punch_window(employee: str, employee_doc=None) -> tuple[datetime, datetime]:
	"""The span of time whose punches belong to the employee's *current* shift.

	A day-shift employee's punches all fall inside one civil day, so the window
	is simply midnight to midnight. A night-shift employee who starts at 22:00
	and ends at 06:00 has their IN and OUT land on **different civil days** — the
	old midnight-to-midnight window split the pair, so the OUT day booked zero
	worked seconds while the IN day kept an unclosed punch counting live against
	``now_datetime()`` and inflated hours without bound.

	For a midnight-crossing shift the window therefore opens on the *previous*
	day, so an open IN from last night is still visible and pairs with today's
	OUT.
	"""
	day = getdate(nowdate())
	start = datetime.combine(day, datetime.min.time())
	end = datetime.combine(day, datetime.max.time())

	if employee_doc is None:
		employee_doc = frappe.db.get_value(
			"Employee", employee, ["default_shift"], as_dict=True
		)
	shift = (employee_doc or {}).get("default_shift")
	if shift and _shift_crosses_midnight(shift):
		start = datetime.combine(add_days(day, -1), datetime.min.time())
	return start, end


def _attendance(employee: str, employee_doc=None) -> dict:
	day = getdate(nowdate())
	start, end = _punch_window(employee, employee_doc)
	logs = frappe.get_list(
		"Employee Checkin",
		filters={"employee": employee, "time": ["between", [start, end]]},
		fields=["name", "time", "log_type", "shift", "device_id", "latitude", "longitude"],
		order_by="time asc",
		limit_page_length=100,
	)
	# On a night shift the window reaches back a day, so a *completed* previous
	# shift would otherwise be re-counted as today's. Once the last punch is an
	# OUT that landed before today began, the previous shift is closed: drop
	# everything before today and start the current day clean.
	if logs and start.date() != day:
		midnight = datetime.combine(day, datetime.min.time())
		last = logs[-1]
		if last.log_type == "OUT" and get_datetime(last.time) < midnight:
			logs = [log for log in logs if get_datetime(log.time) >= midnight]

	last_log = logs[-1] if logs else None
	is_checked_in = bool(last_log and last_log.log_type != "OUT")
	seconds = 0
	pending_in = None
	for log in logs:
		if log.log_type == "IN" or (not log.log_type and pending_in is None):
			pending_in = get_datetime(log.time)
		elif log.log_type == "OUT" and pending_in:
			seconds += max(0, int((get_datetime(log.time) - pending_in).total_seconds()))
			pending_in = None
	if pending_in and is_checked_in:
		seconds += max(0, int((now_datetime() - pending_in).total_seconds()))

	# Time on site that was not counted as worked — the gap between the first
	# punch and the last (or now, while still in) minus the paired intervals.
	# This is what the punch bar shows as "Break".
	break_seconds = 0
	if logs:
		anchor = now_datetime() if is_checked_in else get_datetime(last_log.time)
		on_site = max(0, int((anchor - get_datetime(logs[0].time)).total_seconds()))
		break_seconds = max(0, on_site - seconds)

	attendance = frappe.db.get_value(
		"Attendance",
		{"employee": employee, "attendance_date": day, "docstatus": ["<", 2]},
		["status", "working_hours", "late_entry", "early_exit", "shift"],
		as_dict=True,
	)
	return {
		"checked_in": is_checked_in,
		"first_in": _as_text(logs[0].time) if logs else None,
		"last_log": _as_text(last_log.time) if last_log else None,
		"working_seconds": seconds,
		"break_seconds": break_seconds,
		# Where the punch was taken, when the device recorded it.
		"location": (last_log.device_id if last_log else None) or None,
		"shift": (last_log.shift if last_log else None) or (attendance.shift if attendance else None),
		"status": attendance.status if attendance else None,
		"working_hours": attendance.working_hours if attendance else None,
		"late_entry": bool(attendance.late_entry) if attendance else False,
		"early_exit": bool(attendance.early_exit) if attendance else False,
	}


def _leave_balances(employee: str) -> list[dict]:
	from hrms.hr.doctype.leave_application.leave_application import get_leave_details

	details = get_leave_details(employee, nowdate())
	return [
		{
			"leave_type": leave_type,
			"allocated": values.get("total_leaves", 0),
			"remaining": values.get("remaining_leaves", 0),
			"taken": values.get("leaves_taken", 0),
			"pending": values.get("leaves_pending_approval", 0),
		}
		for leave_type, values in details.get("leave_allocation", {}).items()
	]


def _holidays(employee_doc) -> list[dict]:
	holiday_list = employee_doc.holiday_list or frappe.db.get_value(
		"Company", employee_doc.company, "default_holiday_list"
	)
	if not holiday_list:
		return []
	return frappe.get_all(
		"Holiday",
		filters={"parent": holiday_list, "holiday_date": [">=", nowdate()]},
		fields=["holiday_date", "description", "weekly_off"],
		order_by="holiday_date asc",
		limit_page_length=8,
	)


def _leave_requests(employee: str) -> list[dict]:
	return frappe.get_list(
		"Leave Application",
		filters={"employee": employee, "docstatus": ["<", 2]},
		fields=[
			"name",
			"leave_type",
			"from_date",
			"to_date",
			"total_leave_days",
			"status",
			"description",
			"leave_approver_name",
			"creation",
		],
		order_by="creation desc",
		limit_page_length=12,
	)


def _salary_slips(employee: str) -> list[dict]:
	slips = frappe.get_list(
		"Salary Slip",
		filters={"employee": employee, "docstatus": 1},
		fields=[
			"name",
			"start_date",
			"end_date",
			"posting_date",
			"currency",
			"gross_pay",
			"total_deduction",
			"net_pay",
			"bank_name",
		],
		order_by="end_date desc",
		limit_page_length=12,
	)
	if not slips:
		return slips

	# Hydrate every slip's component rows in two queries rather than one
	# frappe.get_doc() per slip, so opening an older month in the app shows a
	# breakdown instead of an empty earnings/deductions list.
	slip_names = [slip.name for slip in slips]
	by_name = {slip.name: slip for slip in slips}
	for slip in slips:
		slip["earnings"] = []
		slip["deductions"] = []

	for row in frappe.get_all(
		"Salary Detail",
		filters={
			"parent": ["in", slip_names],
			"parenttype": "Salary Slip",
			"parentfield": ["in", ["earnings", "deductions"]],
		},
		fields=["parent", "parentfield", "salary_component", "amount"],
		order_by="parent asc, idx asc",
	):
		slip = by_name.get(row.parent)
		if slip is not None:
			slip[row.parentfield].append(
				{"salary_component": row.salary_component, "amount": row.amount}
			)

	return slips


def _pending_approvals(user: str, roles: set[str]) -> list[dict]:
	filters: dict = {"status": "Open", "docstatus": 0}
	if not roles.intersection(HR_ROLES):
		filters["leave_approver"] = user
	return frappe.get_list(
		"Leave Application",
		filters=filters,
		fields=[
			"name",
			"employee",
			"employee_name",
			"department",
			"leave_type",
			"from_date",
			"to_date",
			"total_leave_days",
			"description",
			"creation",
			"leave_balance",
		],
		order_by="creation asc",
		limit_page_length=30,
	)


#: Employee fields the profile screen renders, grouped the way the UI tabs are.
#: Regional/optional fields (PAN, IFSC, PF) are only present on some installs, so
#: every group is filtered through _existing_fields() before it reaches the query.
PROFILE_FIELD_GROUPS: dict[str, tuple[str, ...]] = {
	"identity": (
		"name",
		"employee_name",
		"employee_number",
		"image",
		"salutation",
		"designation",
		"department",
		"branch",
		"company",
		"status",
		"user_id",
		"reports_to",
	),
	"personal": (
		"date_of_birth",
		"gender",
		"blood_group",
		"marital_status",
		"person_to_be_contacted",
		"relation",
		"emergency_phone_number",
		"current_address",
		"permanent_address",
		"company_email",
		"personal_email",
		"prefered_email",
		"cell_number",
	),
	"job": (
		"date_of_joining",
		"employment_type",
		"grade",
		"default_shift",
		"holiday_list",
		"scheduled_confirmation_date",
		"final_confirmation_date",
		"contract_end_date",
		"date_of_retirement",
		"notice_number_of_days",
		"resignation_letter_date",
		"relieving_date",
		"leave_approver",
		"expense_approver",
		"shift_request_approver",
	),
	"statutory": (
		"bank_name",
		"bank_ac_no",
		"ifsc_code",
		"pan_number",
		"provident_fund_account",
		"health_insurance_provider",
		"health_insurance_no",
		"payroll_cost_center",
	),
}


def _existing_fields(doctype: str, candidates) -> list[str]:
	"""Keep only the fieldnames this site actually has (regional/custom aware)."""
	meta = frappe.get_meta(doctype)
	return [field for field in candidates if field == "name" or meta.has_field(field)]


def _employee_documents(employee: str) -> list[dict]:
	rows = frappe.get_all(
		"Employee Attachment" if frappe.db.table_exists("Employee Attachment") else "File",
		filters={"attached_to_doctype": "Employee", "attached_to_name": employee},
		fields=["name", "file_name", "file_url", "file_size", "is_private", "creation"],
		order_by="creation desc",
		limit_page_length=50,
	)
	return rows


def _employee_assets(employee: str) -> list[dict]:
	if not frappe.db.table_exists("Asset"):
		return []
	return frappe.get_all(
		"Asset",
		filters={"custodian": employee, "docstatus": ["<", 2]},
		fields=["name", "asset_name", "item_code", "asset_category", "status", "purchase_date"],
		order_by="purchase_date desc",
		limit_page_length=50,
	)


def _directory(*, unrestricted: bool = False, visible: set[str] | None = None) -> list[dict]:
	# HR sees everyone; everyone else sees only their own reporting subtree
	# (self + reports). ``visible`` is that subtree, computed by the caller.
	filters: dict = {"status": "Active"}
	if not unrestricted:
		if not visible:
			return []
		filters["name"] = ["in", sorted(visible)]
	employees = frappe.get_all(
		"Employee",
		filters=filters,
		fields=[
			"name",
			"employee_name",
			"image",
			"designation",
			"department",
			"branch",
			"company",
			"company_email",
			"cell_number",
			"reports_to",
			"user_id",
		],
		order_by="employee_name asc",
		limit_page_length=100,
	)
	user_ids = [employee.user_id for employee in employees if employee.user_id]
	roles_by_user: dict[str, list[str]] = {user_id: [] for user_id in user_ids}
	if user_ids:
		for row in frappe.get_all(
			"Has Role",
			filters={"parent": ["in", user_ids]},
			fields=["parent", "role"],
			order_by="idx asc",
		):
			roles_by_user.setdefault(row.parent, []).append(row.role)
	for employee in employees:
		employee["roles"] = roles_by_user.get(employee.user_id, [])
	return employees


def _users() -> list[dict]:
	users = frappe.get_list(
		"User",
		filters={"enabled": 1},
		fields=["name", "full_name", "user_type", "user_image", "last_active"],
		order_by="full_name asc",
		limit_page_length=200,
	)
	user_ids = [user.name for user in users]
	roles_by_user: dict[str, list[str]] = {user_id: [] for user_id in user_ids}
	if user_ids:
		for row in frappe.get_all(
			"Has Role",
			filters={"parent": ["in", user_ids]},
			fields=["parent", "role"],
			order_by="idx asc",
		):
			roles_by_user.setdefault(row.parent, []).append(row.role)
	for user in users:
		user["roles"] = roles_by_user.get(user.name, [])
	return users


def _notifications(user: str) -> list[dict]:
	"""The first page for the bell. The full inbox pages through
	`techsarena_hr.notifications.notifications`, which this deliberately
	mirrors so the first render and the first page agree."""
	return frappe.get_list(
		"Notification Log",
		filters={"for_user": user},
		fields=["name", "subject", "email_content", "type", "document_type", "document_name", "read", "creation"],
		order_by="creation desc",
		limit_page_length=20,
	)


def _hr_summary() -> dict:
	month_start = get_first_day(nowdate())
	month_end = get_last_day(nowdate())
	return {
		"headcount": frappe.db.count("Employee", {"status": "Active"}),
		"new_this_month": frappe.db.count(
			"Employee", {"date_of_joining": ["between", [month_start, month_end]]}
		),
		"open_leave_requests": frappe.db.count("Leave Application", {"status": "Open", "docstatus": 0}),
		"salary_slips_this_month": frappe.db.count(
			"Salary Slip", {"start_date": [">=", add_months(month_start, 0)], "docstatus": 1}
		),
	}


def _headcount_movement(months: int = 12) -> list[dict]:
	"""Joiners and leavers per month, oldest first.

	Counted from ``date_of_joining`` and ``relieving_date`` on Employee, which is
	the only record of movement a stock HRMS keeps.  Employees are counted in the
	month the event falls in regardless of current status, so someone who joined
	and left inside the window still shows on both series.
	"""
	today = getdate(nowdate())
	buckets: list[dict] = []
	for offset in range(months - 1, -1, -1):
		start = get_first_day(add_months(today, -offset))
		end = get_last_day(start)
		buckets.append(
			{
				"month": str(start),
				"joiners": frappe.db.count(
					"Employee", {"date_of_joining": ["between", [start, end]]}
				),
				"exits": frappe.db.count(
					"Employee", {"relieving_date": ["between", [start, end]]}
				),
			}
		)
	return buckets


def _attrition(movement: list[dict], headcount: int) -> dict:
	"""Exits over the window against average headcount.

	Average headcount is approximated as the current active count plus the exits
	in the window, halved with the current count -- the standard mid-period
	denominator.  Returned as ``None`` rather than 0 when there is nothing to
	divide by, so the client can omit the figure instead of showing a false 0%.
	"""
	exits = sum(cint(row["exits"]) for row in movement)
	start_headcount = headcount + exits - sum(cint(row["joiners"]) for row in movement)
	average = (headcount + start_headcount) / 2
	if average <= 0:
		return {"rate": None, "exits": exits}
	return {"rate": round((exits / average) * 100, 1), "exits": exits}


def _applicant_funnel() -> list[dict]:
	"""Candidates by stage across every opening.

	Job Applicant is optional in a stock install, so a site without it returns an
	empty funnel rather than erroring.
	"""
	if not frappe.db.table_exists("Job Applicant"):
		return []
	rows = frappe.get_all(
		"Job Applicant",
		fields=["status", "count(name) as total"],
		group_by="status",
		limit_page_length=0,
	)
	return [{"stage": row.status or "Open", "count": cint(row.total)} for row in rows]


@frappe.whitelist()
def insights(months: int = 12) -> dict:
	"""Workforce analytics for the Insights screen.

	Everything here is derived from records the site already keeps -- no figure is
	synthesised.  A section the site cannot answer (no recruitment module, no
	payroll entry open) comes back empty so the client can omit that card rather
	than render a plausible-looking zero.
	"""
	_require_hr_access()
	_require_hrms()

	months = max(1, min(cint(months) or 12, 24))
	headcount = frappe.db.count("Employee", {"status": "Active"})
	movement = _headcount_movement(months)

	departments = [
		{"name": row.department or _("Unassigned"), "count": cint(row.total)}
		for row in frappe.get_all(
			"Employee",
			filters={"status": "Active"},
			fields=["department", "count(name) as total"],
			group_by="department",
			order_by="total desc",
			limit_page_length=0,
		)
	]

	return {
		"months": months,
		"headcount": headcount,
		"movement": movement,
		"attrition": _attrition(movement, headcount),
		"departments": departments,
		"funnel": _applicant_funnel(),
		"summary": _hr_summary(),
	}


def _require_settings_access(user: str | None = None) -> tuple[str, set[str]]:
	"""Allow the setup hub to the roles represented by its cards."""
	user = user or _require_login()
	roles = set(frappe.get_roles(user))
	if not roles.intersection(SETTINGS_ROLES):
		frappe.throw(_("You do not have access to organisation settings."), frappe.PermissionError)
	return user, roles


def _settings_recent_changes() -> list[dict]:
	"""Latest edits across the configuration DocTypes shown in the hub."""
	targets = {
		"Company": "Company",
		"Department": "Department",
		"Branch": "Location",
		"Holiday List": "Holiday list",
		"Leave Type": "Leave type",
		"Leave Policy": "Leave policy",
		"Shift Type": "Shift type",
		"Salary Component": "Salary component",
		"Payroll Settings": "Payroll settings",
		"Role": "Role",
	}
	changes = []
	for doctype, label in targets.items():
		if not frappe.db.table_exists(doctype):
			continue
		for row in frappe.get_all(
			doctype,
			fields=["name", "modified", "modified_by"],
			order_by="modified desc",
			limit_page_length=2,
		):
			changes.append(
				{
					"title": f"{label} · {row.name}",
					"changed_by": frappe.utils.get_fullname(row.modified_by) or row.modified_by,
					"modified": _as_text(row.modified),
				}
			)
	changes.sort(key=lambda row: get_datetime(row["modified"]), reverse=True)
	return changes[:5]


def _settings_editors() -> list[dict]:
	user_ids = set(
		frappe.get_all(
			"Has Role",
			filters={"role": ["in", sorted(SETTINGS_EDIT_ROLES)]},
			pluck="parent",
			limit_page_length=0,
		)
	)
	if not user_ids:
		return []
	users = frappe.get_all(
		"User",
		filters={"name": ["in", sorted(user_ids)], "enabled": 1},
		fields=["name", "full_name"],
		order_by="full_name asc",
		limit_page_length=20,
	)
	roles_by_user: dict[str, list[str]] = {user.name: [] for user in users}
	for row in frappe.get_all(
		"Has Role",
		filters={"parent": ["in", list(roles_by_user)], "role": ["in", sorted(SETTINGS_EDIT_ROLES)]},
		fields=["parent", "role"],
		order_by="idx asc",
	):
		roles_by_user.setdefault(row.parent, []).append(row.role)
	return [
		{
			"id": user.name,
			"name": user.full_name or user.name,
			"initials": "".join(
				part[0].upper() for part in (user.full_name or user.name).split()[:2] if part
			),
			"role": (roles_by_user.get(user.name) or ["System Manager"])[0],
		}
		for user in users
	]


@frappe.whitelist()
def settings_hub() -> dict:
	"""Real HRMS configuration and coverage behind the responsive setup hub."""
	user, roles = _require_settings_access()
	_require_hrms()
	today = getdate(nowdate())

	employees = frappe.get_all(
		"Employee",
		filters={"status": "Active"},
		fields=["name", "employee_name", "company", "date_of_joining", "default_shift", "leave_approver"],
		order_by="employee_name asc",
		limit_page_length=0,
	)
	employee_ids = {row.name for row in employees}
	staff_count = len(employees)

	assignments = []
	if frappe.db.table_exists("Leave Policy Assignment"):
		assignments = frappe.get_all(
			"Leave Policy Assignment",
			filters={"docstatus": 1},
			fields=["employee", "effective_from", "effective_to"],
			limit_page_length=0,
		)
	assigned_leave = {
		row.employee
		for row in assignments
		if row.employee in employee_ids
		and (not row.effective_from or getdate(row.effective_from) <= today)
		and (not row.effective_to or getdate(row.effective_to) >= today)
	}
	unassigned = [row for row in employees if row.name not in assigned_leave]

	salary_assignments = []
	if frappe.db.table_exists("Salary Structure Assignment"):
		salary_assignments = frappe.get_all(
			"Salary Structure Assignment",
			filters={"docstatus": 1, "from_date": ["<=", today]},
			fields=["employee"],
			limit_page_length=0,
		)
	assigned_salary = {row.employee for row in salary_assignments if row.employee in employee_ids}

	companies = (
		frappe.get_all(
			"Company",
			fields=_existing_fields("Company", ["name", "default_currency", "country", "default_holiday_list"]),
			order_by="name asc",
			limit_page_length=0,
		)
		if frappe.db.table_exists("Company")
		else []
	)
	departments = (
		frappe.get_all("Department", fields=["name"], order_by="name asc", limit_page_length=0)
		if frappe.db.table_exists("Department")
		else []
	)
	branches = (
		frappe.get_all("Branch", fields=["name"], order_by="name asc", limit_page_length=0)
		if frappe.db.table_exists("Branch")
		else []
	)
	holiday_lists = (
		frappe.get_all("Holiday List", fields=["name", "from_date", "to_date"], order_by="name asc", limit_page_length=0)
		if frappe.db.table_exists("Holiday List")
		else []
	)
	leave_types = (
		frappe.get_all("Leave Type", fields=["name"], order_by="name asc", limit_page_length=0)
		if frappe.db.table_exists("Leave Type")
		else []
	)
	leave_policies = (
		frappe.get_all(
			"Leave Policy",
			filters={"docstatus": 1},
			fields=["name", "title"],
			order_by="title asc",
			limit_page_length=0,
		)
		if frappe.db.table_exists("Leave Policy")
		else []
	)
	shift_fields = _existing_fields(
		"Shift Type", ["name", "start_time", "end_time", "enable_auto_attendance"]
	)
	shift_types = (
		frappe.get_all("Shift Type", fields=shift_fields, order_by="name asc", limit_page_length=0)
		if frappe.db.table_exists("Shift Type")
		else []
	)
	auto_shifts = sum(cint(row.get("enable_auto_attendance")) for row in shift_types)
	salary_components = (
		frappe.get_all("Salary Component", fields=["name", "type"], order_by="name asc", limit_page_length=0)
		if frappe.db.table_exists("Salary Component")
		else []
	)
	earnings = sum(row.type == "Earning" for row in salary_components)
	deductions = sum(row.type == "Deduction" for row in salary_components)
	role_count = frappe.db.count("Role") if frappe.db.table_exists("Role") else 0
	payroll = (
		frappe.db.get_singles_dict("Payroll Settings")
		if frappe.db.table_exists("Payroll Settings")
		else {}
	)
	company_name = companies[0].name if companies else "Organisation"
	company_description = ", ".join(
		part
		for part in (
			f"{len(companies)} legal {'entity' if len(companies) == 1 else 'entities'}",
			companies[0].get("default_currency") if companies else None,
		)
		if part
	)
	location_names = [row.name for row in branches]
	default_holidays = [row.get("default_holiday_list") for row in companies if row.get("default_holiday_list")]
	shift_assigned = sum(bool(row.default_shift) for row in employees)
	approver_assigned = sum(bool(row.leave_approver) for row in employees)

	def detail_rows(rows, value_key="name", limit=8):
		return [{"label": row.get(value_key) or row.name, "value": None} for row in rows[:limit]]

	return {
		"organisation_name": company_name,
		"staff_count": staff_count,
		"can_edit": bool(roles.intersection(SETTINGS_EDIT_ROLES)),
		"alert": {
			"unassigned_leave_policy": len(unassigned),
			"employees": [
				{
					"id": row.name,
					"name": row.employee_name,
					"joined_on": _as_text(row.date_of_joining),
				}
				for row in unassigned
			],
			"leave_policies": [
				{"id": row.name, "name": row.title or row.name} for row in leave_policies
			],
		},
		"sections": [
			{
				"id": "organisation",
				"title": "ORGANISATION",
				"items": [
					{
						"id": "company",
						"title": "Company",
						"description": company_description or company_name,
						"details": [
							{
								"label": row.name,
								"value": " · ".join(
									part for part in (row.get("default_currency"), row.get("country")) if part
								),
							}
							for row in companies
						],
					},
					{
						"id": "departments",
						"title": "Departments",
						"description": f"{len(departments)} departments",
						"count": len(departments),
						"details": detail_rows(departments),
					},
					{
						"id": "locations",
						"title": "Locations",
						"description": ", ".join(location_names[:3]) or "No branches configured",
						"count": len(branches),
						"details": detail_rows(branches),
					},
				],
			},
			{
				"id": "time_off",
				"title": "TIME OFF & ATTENDANCE",
				"items": [
					{
						"id": "holiday_lists",
						"title": "Holiday lists",
						"description": (
							f"{default_holidays[0]} is the company default"
							if default_holidays
							else f"{len(holiday_lists)} lists configured"
						),
						"count": len(holiday_lists),
						"details": detail_rows(holiday_lists),
					},
					{
						"id": "leave_types",
						"title": "Leave types",
						"description": ", ".join(row.name for row in leave_types[:5]) or "No leave types configured",
						"count": len(leave_types),
						"details": detail_rows(leave_types),
					},
					{
						"id": "leave_policies",
						"title": "Leave policies",
						"description": f"{len(leave_policies)} policies · {len(assigned_leave)} of {staff_count} assigned",
						"badge": f"{len(unassigned)} unassigned" if unassigned else None,
						"badge_kind": "danger" if unassigned else "success",
						"details": [
							{"label": row.title or row.name, "value": row.name} for row in leave_policies
						],
					},
					{
						"id": "shift_types",
						"title": "Shift types",
						"description": f"{len(shift_types)} shifts · {auto_shifts} with auto-attendance",
						"count": len(shift_types),
						"details": detail_rows(shift_types),
					},
					{
						"id": "attendance_rules",
						"title": "Attendance rules",
						"description": f"Auto-attendance on for {auto_shifts} of {len(shift_types)} shifts",
						"details": [
							{
								"label": row.name,
								"value": "Auto-attendance on" if cint(row.get("enable_auto_attendance")) else "Auto-attendance off",
							}
							for row in shift_types
						],
					},
					{
						"id": "approvers",
						"title": "Approvers",
						"description": f"Leave approver set for {approver_assigned} of {staff_count} employees",
						"details": [
							{"label": row.employee_name, "value": row.leave_approver}
							for row in employees if row.leave_approver
						][:8],
					},
				],
			},
			{
				"id": "payroll_access",
				"title": "PAYROLL & ACCESS",
				"items": [
					{
						"id": "salary_components",
						"title": "Salary components",
						"description": f"{earnings} earnings, {deductions} deductions",
						"count": len(salary_components),
						"details": [
							{"label": row.name, "value": row.type} for row in salary_components[:12]
						],
					},
					{
						"id": "payroll_settings",
						"title": "Payroll settings",
						"description": "Working days based on " + (payroll.get("payroll_based_on") or "site defaults"),
						"details": [
							{"label": "Working days based on", "value": payroll.get("payroll_based_on")},
							{
								"label": "Email salary slips",
								"value": "On" if cint(payroll.get("email_salary_slip_to_employee")) else "Off",
							},
							{
								"label": "Show leave balances",
								"value": "On" if cint(payroll.get("show_leave_balances_in_salary_slip")) else "Off",
							},
						],
					},
					{
						"id": "roles_permissions",
						"title": "Roles & permissions",
						"description": f"{role_count} roles configured",
						"count": role_count,
						"details": [
							{"label": role, "value": "Setup access"} for role in sorted(SETTINGS_ROLES)
						],
					},
				],
			},
		],
		"recent_changes": _settings_recent_changes(),
		"health": [
			{"label": "Employees with a shift", "value": shift_assigned, "total": staff_count},
			{
				"label": "Leave policy assigned",
				"value": len(assigned_leave),
				"total": staff_count,
				"warning": bool(unassigned),
			},
			{
				"label": "Salary structure assigned",
				"value": len(assigned_salary),
				"total": staff_count,
			},
			{"label": "Approver chain set", "value": approver_assigned, "total": staff_count},
		],
		"editors": _settings_editors(),
	}


@frappe.whitelist(methods=["POST"])
def assign_leave_policy(employee: str, leave_policy: str) -> dict:
	"""Assign a submitted policy through HRMS so its own validation allocates leave."""
	_unused_user, roles = _require_settings_access()
	_require_hrms()
	if not roles.intersection(SETTINGS_EDIT_ROLES):
		frappe.throw(_("Only an HR Manager or System Manager can assign leave policies."), frappe.PermissionError)
	if not frappe.db.exists("Employee", {"name": employee, "status": "Active"}):
		frappe.throw(_("The employee is not active or no longer exists."))
	if not frappe.db.exists("Leave Policy", {"name": leave_policy, "docstatus": 1}):
		frappe.throw(_("Choose a submitted leave policy."))
	return _create_leave_policy_assignment(employee, leave_policy)


def _create_leave_policy_assignment(employee: str, leave_policy: str) -> dict:
	company = frappe.db.get_value("Employee", employee, "company")
	leave_period = frappe.db.get_value(
		"Leave Period",
		{
			"company": company,
			"from_date": ["<=", nowdate()],
			"to_date": [">=", nowdate()],
			"is_active": 1,
		},
		"name",
	)
	if not leave_period:
		frappe.throw(_("Create an active Leave Period for {0} before assigning a policy.").format(company))
	doc = frappe.get_doc(
		{
			"doctype": "Leave Policy Assignment",
			"employee": employee,
			"leave_policy": leave_policy,
			"assignment_based_on": "Leave Period",
			"leave_period": leave_period,
		}
	)
	doc.insert()
	doc.submit()
	return {"name": doc.name, "employee": employee, "leave_policy": leave_policy}


def _current_leave_policy_assignments() -> list:
	today = getdate(nowdate())
	return frappe.get_all(
		"Leave Policy Assignment",
		filters={
			"docstatus": 1,
			"effective_from": ["<=", today],
			"effective_to": [">=", today],
		},
		fields=[
			"name",
			"employee",
			"employee_name",
			"company",
			"leave_policy",
			"effective_from",
			"effective_to",
			"creation",
			"owner",
		],
		order_by="creation desc",
		limit_page_length=0,
	)


def _leave_policy_allocation_rows(doc) -> list[dict]:
	leave_types = [row.leave_type for row in doc.leave_policy_details]
	details = {
		row.name: row
		for row in frappe.get_all(
			"Leave Type",
			filters={"name": ["in", leave_types]},
			fields=_existing_fields(
				"Leave Type",
				[
					"name",
					"is_earned_leave",
					"earned_leave_frequency",
					"is_carry_forward",
					"maximum_carry_forwarded_leaves",
					"is_compensatory",
					"is_lwp",
					"max_leaves_allowed",
					"techsarena_applies_to",
				],
			),
			limit_page_length=0,
		)
	}
	rows = []
	for allocation in doc.leave_policy_details:
		leave_type = details.get(allocation.leave_type)
		is_compensatory = bool(leave_type and cint(leave_type.get("is_compensatory")))
		is_earned = bool(leave_type and cint(leave_type.get("is_earned_leave")))
		is_carry_forward = bool(leave_type and cint(leave_type.get("is_carry_forward")))
		frequency = leave_type.get("earned_leave_frequency") if leave_type else None
		accrual = _("On approval") if is_compensatory else (frequency if is_earned and frequency else _("Yearly"))
		carry_limit = flt(leave_type.get("maximum_carry_forwarded_leaves")) if leave_type else 0
		carry_forward = (
			_("Up to {0}").format(int(carry_limit) if carry_limit.is_integer() else carry_limit)
			if is_carry_forward
			else _("No")
		)
		notes = leave_type.get("techsarena_applies_to") if leave_type else None
		if not notes:
			notes = (
				_("From approved extra work")
				if is_compensatory
				else (_("Unpaid leave") if leave_type and cint(leave_type.get("is_lwp")) else None)
			)
		annual_days = flt(allocation.annual_allocation)
		rows.append(
			{
				"leave_type": allocation.leave_type,
				"days": _("Earned")
				if is_compensatory
				else (int(annual_days) if annual_days.is_integer() else annual_days),
				"annual_days": annual_days,
				"accrual": accrual,
				"carry_forward": carry_forward,
				"notes": notes or _("Standard policy allocation"),
			}
		)
	return rows


def _leave_policy_payload(name: str, assignments=None, employees=None) -> dict:
	doc = frappe.get_doc("Leave Policy", name)
	assignments = assignments if assignments is not None else _current_leave_policy_assignments()
	employees = employees if employees is not None else frappe.get_all(
		"Employee",
		filters={"status": "Active"},
		fields=["name", "employee_name", "company", "department", "date_of_joining"],
		order_by="employee_name asc",
		limit_page_length=0,
	)
	assigned_employee_ids = {row.employee for row in assignments}
	policy_assignments = [row for row in assignments if row.leave_policy == name]
	policy_employee_ids = {row.employee for row in policy_assignments}
	employees_by_id = {row.name: row for row in employees}
	unassigned = [row for row in employees if row.name not in assigned_employee_ids]
	assigned = [employees_by_id[employee] for employee in policy_employee_ids if employee in employees_by_id]
	period = None
	if policy_assignments:
		period = {
			"from_date": min(getdate(row.effective_from) for row in policy_assignments),
			"to_date": max(getdate(row.effective_to) for row in policy_assignments),
		}
	if not period:
		period_row = frappe.get_all(
			"Leave Period",
			filters={"is_active": 1, "from_date": ["<=", nowdate()], "to_date": [">=", nowdate()]},
			fields=["from_date", "to_date"],
			order_by="from_date asc",
			limit_page_length=1,
		)
		period = period_row[0] if period_row else None
	companies = sorted({row.company for row in [*assigned, *unassigned] if row.company})
	latest = policy_assignments[0] if policy_assignments else None
	return {
		"name": doc.name,
		"title": doc.title or doc.name,
		"effective_from": _as_text(period.get("from_date")) if period else None,
		"effective_to": _as_text(period.get("to_date")) if period else None,
		"allocations": _leave_policy_allocation_rows(doc),
		"assigned": {
			"count": len(assigned),
			"employees": [
				{
					"id": row.name,
					"name": row.employee_name,
					"department": row.department,
					"company": row.company,
					"joined_on": _as_text(row.date_of_joining),
				}
				for row in assigned
			],
		},
		"unassigned": [
			{
				"id": row.name,
				"name": row.employee_name,
				"department": row.department,
				"company": row.company,
				"joined_on": _as_text(row.date_of_joining),
				"pro_rated_from": _as_text(
					max(
						getdate(row.date_of_joining),
						getdate(period.get("from_date")) if period else getdate(row.date_of_joining),
					)
				),
			}
			for row in unassigned
		],
		"rule": {
			"company": companies[0] if len(companies) == 1 else None,
			"status": "Active",
			"description": _("Active employees without a current leave policy are available for manual assignment."),
		},
		"last_assignment": (
			{
				"date": _as_text(latest.creation),
				"employee_count": len(policy_assignments),
				"changed_by": frappe.utils.get_fullname(latest.owner) or latest.owner,
			}
			if latest
			else None
		),
		"modified": _as_text(doc.modified),
	}


@frappe.whitelist()
def leave_policy_settings(name: str | None = None) -> dict:
	"""Submitted policies, allocation rules and employees awaiting assignment."""
	_unused_user, roles = _require_settings_access()
	_require_hrms()
	policies = frappe.get_all(
		"Leave Policy",
		filters={"docstatus": 1},
		fields=["name", "title", "modified"],
		order_by="title asc",
		limit_page_length=0,
	)
	if name and not frappe.db.exists("Leave Policy", {"name": name, "docstatus": 1}):
		frappe.throw(_("Leave policy {0} was not found or is not submitted.").format(name), frappe.DoesNotExistError)
	assignments = _current_leave_policy_assignments()
	employees = frappe.get_all(
		"Employee",
		filters={"status": "Active"},
		fields=["name", "employee_name", "company", "department", "date_of_joining"],
		order_by="employee_name asc",
		limit_page_length=0,
	)
	counts = {}
	for assignment in assignments:
		counts[assignment.leave_policy] = counts.get(assignment.leave_policy, 0) + 1
	selected = name or max((row.name for row in policies), key=lambda policy: counts.get(policy, 0), default=None)
	return {
		"can_edit": bool(roles.intersection(SETTINGS_EDIT_ROLES)),
		"policies": [
			{
				"name": row.name,
				"title": row.title or row.name,
				"assigned": counts.get(row.name, 0),
			}
			for row in policies
		],
		"selected": _leave_policy_payload(selected, assignments, employees) if selected else None,
	}


@frappe.whitelist(methods=["POST"])
def bulk_assign_leave_policy(leave_policy: str, employees=None) -> dict:
	"""Assign one submitted policy to selected employees in a single transaction."""
	_unused_user, roles = _require_settings_access()
	_require_hrms()
	if not roles.intersection(SETTINGS_EDIT_ROLES):
		frappe.throw(_("Only an HR Manager or System Manager can assign leave policies."), frappe.PermissionError)
	if not frappe.db.exists("Leave Policy", {"name": leave_policy, "docstatus": 1}):
		frappe.throw(_("Choose a submitted leave policy."))
	employee_ids = json.loads(employees) if isinstance(employees, str) else employees or []
	employee_ids = list(dict.fromkeys(str(employee) for employee in employee_ids if employee))
	if not employee_ids:
		frappe.throw(_("Select at least one employee."))
	created = []
	for employee in employee_ids:
		if not frappe.db.exists("Employee", {"name": employee, "status": "Active"}):
			frappe.throw(_("Employee {0} is not active or no longer exists.").format(employee))
		created.append(_create_leave_policy_assignment(employee, leave_policy))
	return {"assigned": len(created), "records": created}


def _holiday_list_employees(name: str) -> tuple[list, list]:
	"""Employees inheriting this list and those with a site-specific override."""
	companies = frappe.get_all(
		"Company",
		filters={"default_holiday_list": name},
		pluck="name",
		limit_page_length=0,
	)
	direct = frappe.get_all(
		"Employee",
		filters={"status": "Active", "holiday_list": name},
		fields=["name", "employee_name", "company"],
		limit_page_length=0,
	)
	inherited = []
	if companies:
		inherited = frappe.get_all(
			"Employee",
			filters={"status": "Active", "company": ["in", companies], "holiday_list": ["is", "not set"]},
			fields=["name", "employee_name", "company"],
			limit_page_length=0,
		)
	by_id = {row.name: row for row in [*direct, *inherited]}
	overrides = []
	if companies:
		overrides = frappe.get_all(
			"Employee",
			filters={
				"status": "Active",
				"company": ["in", companies],
				"holiday_list": ["is", "set"],
			},
			fields=["name", "employee_name", "company", "holiday_list"],
			limit_page_length=0,
		)
		overrides = [row for row in overrides if row.holiday_list != name]
	return list(by_id.values()), overrides


def _holiday_dates(from_date, to_date, weekdays: list[str]) -> list:
	from datetime import timedelta

	wanted = {day.lower() for day in weekdays}
	current = getdate(from_date)
	end = getdate(to_date)
	dates = []
	while current <= end:
		if current.strftime("%A").lower() in wanted:
			dates.append(current)
		current += timedelta(days=1)
	return dates


def _holiday_list_payload(name: str) -> dict:
	doc = frappe.get_doc("Holiday List", name)
	employees, overrides = _holiday_list_employees(name)
	weekly_rows = [row for row in doc.holidays if cint(row.weekly_off)]
	regular_rows = [row for row in doc.holidays if not cint(row.weekly_off)]
	weekly_off_days = sorted(
		{getdate(row.holiday_date).strftime("%A") for row in weekly_rows},
		key=["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].index,
	)
	all_dates = {getdate(row.holiday_date) for row in doc.holidays}
	weekday_holidays = sum(date.strftime("%A") not in weekly_off_days for date in all_dates)
	total_days = date_diff(doc.to_date, doc.from_date) + 1
	holiday_type_field = frappe.get_meta("Holiday").has_field("holiday_type")
	return {
		"name": doc.name,
		"list_name": doc.holiday_list_name or doc.name,
		"from_date": _as_text(doc.from_date),
		"to_date": _as_text(doc.to_date),
		"is_default": bool(
			frappe.db.exists("Company", {"default_holiday_list": name})
		),
		"weekly_off_days": weekly_off_days,
		"holidays": [
			{
				"id": row.name,
				"date": _as_text(row.holiday_date),
				"description": row.description,
				"type": row.get("holiday_type") if holiday_type_field else None,
			}
			for row in regular_rows
		],
		"applies_to": {
			"count": len(employees),
			"employees": [
				{"id": row.name, "name": row.employee_name, "company": row.company}
				for row in employees
			],
			"override_count": len(overrides),
			"overrides": [
				{
					"id": row.name,
					"name": row.employee_name,
					"holiday_list": row.holiday_list,
				}
				for row in overrides
			],
		},
		"impact": {
			"weekday_holidays": weekday_holidays,
			"weekly_off_holidays": len(weekly_rows),
			"working_days": max(0, total_days - len(all_dates)),
		},
		"modified": _as_text(doc.modified),
		"modified_by": frappe.utils.get_fullname(doc.modified_by) or doc.modified_by,
	}


@frappe.whitelist()
def holiday_lists(name: str | None = None) -> dict:
	"""Holiday-list records, weekly offs, coverage and yearly impact."""
	_unused_user, roles = _require_settings_access()
	_require_hrms()
	lists = frappe.get_all(
		"Holiday List",
		fields=["name", "holiday_list_name", "from_date", "to_date"],
		order_by="from_date desc, holiday_list_name asc",
		limit_page_length=0,
	)
	defaults = set(
		frappe.get_all(
			"Company",
			filters={"default_holiday_list": ["is", "set"]},
			pluck="default_holiday_list",
			limit_page_length=0,
		)
	)
	if name and not frappe.db.exists("Holiday List", name):
		frappe.throw(_("Holiday list {0} was not found.").format(name), frappe.DoesNotExistError)
	selected = name or next((row.name for row in lists if row.name in defaults), None)
	selected = selected or (lists[0].name if lists else None)
	return {
		"can_edit": bool(roles.intersection(SETTINGS_EDIT_ROLES)),
		"lists": [
			{
				"id": row.name,
				"name": row.holiday_list_name or row.name,
				"from_date": _as_text(row.from_date),
				"to_date": _as_text(row.to_date),
				"is_default": row.name in defaults,
			}
			for row in lists
		],
		"selected": _holiday_list_payload(selected) if selected else None,
	}


def _parse_holiday_draft(holidays, weekly_off_days) -> tuple[list[dict], list[str]]:
	rows = json.loads(holidays) if isinstance(holidays, str) else holidays or []
	days = json.loads(weekly_off_days) if isinstance(weekly_off_days, str) else weekly_off_days or []
	return rows, [str(day) for day in days]


@frappe.whitelist(methods=["POST"])
def holiday_change_impact(name: str, holidays=None, weekly_off_days=None) -> dict:
	"""Count existing leave applications touched by an unsaved calendar change."""
	_require_settings_access()
	doc = frappe.get_doc("Holiday List", name)
	rows, days = _parse_holiday_draft(holidays, weekly_off_days)
	proposed = {getdate(row.get("date")) for row in rows if row.get("date")}
	proposed.update(_holiday_dates(doc.from_date, doc.to_date, days))
	original = {getdate(row.holiday_date) for row in doc.holidays}
	changed_dates = proposed.symmetric_difference(original)
	if not changed_dates:
		return {"applications": 0, "employees": 0}
	employees, _unused_overrides = _holiday_list_employees(name)
	employee_ids = [row.name for row in employees]
	if not employee_ids:
		return {"applications": 0, "employees": 0}
	applications = frappe.get_all(
		"Leave Application",
		filters={
			"employee": ["in", employee_ids],
			"docstatus": ["<", 2],
			"from_date": ["<=", max(changed_dates)],
			"to_date": [">=", min(changed_dates)],
		},
		fields=["name", "employee", "from_date", "to_date"],
		limit_page_length=0,
	)
	affected = [
		row
		for row in applications
		if any(getdate(row.from_date) <= date <= getdate(row.to_date) for date in changed_dates)
	]
	return {
		"applications": len({row.name for row in affected}),
		"employees": len({row.employee for row in affected}),
	}


@frappe.whitelist(methods=["POST"])
def save_holiday_list(name: str, holidays=None, weekly_off_days=None) -> dict:
	"""Save explicit holidays and one or more weekly-off weekdays."""
	_unused_user, roles = _require_settings_access()
	if not roles.intersection(SETTINGS_EDIT_ROLES):
		frappe.throw(_("Only an HR Manager or System Manager can edit holiday lists."), frappe.PermissionError)
	doc = frappe.get_doc("Holiday List", name)
	rows, days = _parse_holiday_draft(holidays, weekly_off_days)
	doc.set("holidays", [])
	holiday_type_field = frappe.get_meta("Holiday").has_field("holiday_type")
	for row in rows:
		values = {
			"holiday_date": getdate(row.get("date")),
			"description": row.get("description") or _("Holiday"),
			"weekly_off": 0,
		}
		if holiday_type_field and row.get("type"):
			values["holiday_type"] = row.get("type")
		doc.append("holidays", values)
	for date in _holiday_dates(doc.from_date, doc.to_date, days):
		if any(getdate(row.holiday_date) == date for row in doc.holidays):
			continue
		doc.append(
			"holidays",
			{
				"holiday_date": date,
				"description": date.strftime("%A"),
				"weekly_off": 1,
			},
		)
	doc.save()
	return _holiday_list_payload(doc.name)


@frappe.whitelist(methods=["POST"])
def duplicate_holiday_list(name: str) -> dict:
	"""Create the next year's editable list without changing the source."""
	_unused_user, roles = _require_settings_access()
	if not roles.intersection(SETTINGS_EDIT_ROLES):
		frappe.throw(_("Only an HR Manager or System Manager can duplicate holiday lists."), frappe.PermissionError)
	source = frappe.get_doc("Holiday List", name)
	next_year = getdate(source.from_date).year + 1
	base_name = re.sub(r"\b\d{4}\b", str(next_year), source.holiday_list_name or source.name)
	if base_name == (source.holiday_list_name or source.name):
		base_name = f"{base_name} {next_year}"
	target_name = base_name
	suffix = 2
	while frappe.db.exists("Holiday List", target_name):
		target_name = f"{base_name} ({suffix})"
		suffix += 1
	target = frappe.get_doc(
		{
			"doctype": "Holiday List",
			"holiday_list_name": target_name,
			"from_date": add_years(source.from_date, 1),
			"to_date": add_years(source.to_date, 1),
			"color": source.color,
			"country": source.country,
			"subdivision": source.subdivision,
		}
	)
	for row in source.holidays:
		target.append(
			"holidays",
			{
				"holiday_date": add_years(row.holiday_date, 1),
				"description": row.description,
				"weekly_off": row.weekly_off,
			},
		)
	target.insert()
	return {"name": target.name}


def _current_shift_by_employee() -> dict[str, str]:
	"""Resolve today's submitted assignment, falling back to Employee.default_shift."""
	today = getdate(nowdate())
	employees = frappe.get_all(
		"Employee",
		filters={"status": "Active"},
		fields=["name", "default_shift"],
		limit_page_length=0,
	)
	resolved = {row.name: row.default_shift for row in employees if row.default_shift}
	if not frappe.db.table_exists("Shift Assignment"):
		return resolved
	assignments = frappe.get_all(
		"Shift Assignment",
		filters={"docstatus": 1, "status": "Active", "start_date": ["<=", today]},
		fields=["employee", "shift_type", "start_date", "end_date", "modified"],
		order_by="start_date desc, modified desc",
		limit_page_length=0,
	)
	assigned = set()
	for row in assignments:
		if row.employee in assigned or (row.end_date and getdate(row.end_date) < today):
			continue
		resolved[row.employee] = row.shift_type
		assigned.add(row.employee)
	return resolved


def _shift_type_payload(name: str, assigned_by_employee: dict[str, str] | None = None) -> dict:
	doc = frappe.get_doc("Shift Type", name)
	assigned_by_employee = assigned_by_employee or _current_shift_by_employee()
	employee_ids = [employee for employee, shift in assigned_by_employee.items() if shift == name]
	employees = (
		frappe.get_all(
			"Employee",
			filters={"name": ["in", employee_ids]},
			fields=["name", "employee_name", "department"],
			order_by="employee_name asc",
			limit_page_length=0,
		)
		if employee_ids
		else []
	)
	departments: dict[str, int] = {}
	for employee in employees:
		department = employee.department or _("Other")
		departments[department] = departments.get(department, 0) + 1

	attendance = frappe.get_all(
		"Attendance",
		filters={
			"shift": name,
			"docstatus": 1,
			"attendance_date": [">=", add_days(nowdate(), -29)],
		},
		fields=["status", "late_entry", "early_exit", "working_hours"],
		limit_page_length=0,
	)
	versions = (
		frappe.get_all(
			"Version",
			filters={"ref_doctype": "Shift Type", "docname": name},
			fields=["name", "owner", "creation"],
			order_by="creation desc",
			limit_page_length=8,
		)
		if frappe.db.table_exists("Version")
		else []
	)
	return {
		"name": doc.name,
		"code": doc.name,
		"start_time": _as_text(doc.start_time),
		"end_time": _as_text(doc.end_time),
		"holiday_list": doc.holiday_list,
		"color": doc.color,
		"working_hours_threshold_for_half_day": flt(doc.working_hours_threshold_for_half_day),
		"working_hours_threshold_for_absent": flt(doc.working_hours_threshold_for_absent),
		"begin_check_in_before_shift_start_time": cint(doc.begin_check_in_before_shift_start_time),
		"allow_check_out_after_shift_end_time": cint(doc.allow_check_out_after_shift_end_time),
		"enable_late_entry_marking": bool(doc.enable_late_entry_marking),
		"late_entry_grace_period": cint(doc.late_entry_grace_period),
		"enable_early_exit_marking": bool(doc.enable_early_exit_marking),
		"early_exit_grace_period": cint(doc.early_exit_grace_period),
		"enable_auto_attendance": bool(doc.enable_auto_attendance),
		"mark_auto_attendance_on_holidays": bool(doc.mark_auto_attendance_on_holidays),
		"auto_update_last_sync": bool(doc.auto_update_last_sync),
		"process_attendance_after": _as_text(doc.process_attendance_after),
		"last_sync_of_checkin": _as_text(doc.last_sync_of_checkin),
		"assigned": {
			"count": len(employees),
			"departments": [
				{"name": department, "count": count}
				for department, count in sorted(departments.items(), key=lambda item: (-item[1], item[0]))
			],
			"employees": [
				{
					"id": row.name,
					"name": row.employee_name,
					"department": row.department,
				}
				for row in employees
			],
		},
		"last_30_days": {
			"marked_present": sum(row.status == "Present" for row in attendance),
			"half_days": sum(row.status == "Half Day" for row in attendance),
			"late_entries": sum(cint(row.late_entry) for row in attendance),
			"early_exits": sum(cint(row.early_exit) for row in attendance),
		},
		"activity": [
			{
				"id": row.name,
				"title": _("Shift settings updated"),
				"changed_by": frappe.utils.get_fullname(row.owner) or row.owner,
				"modified": _as_text(row.creation),
			}
			for row in versions
		],
		"modified": _as_text(doc.modified),
		"modified_by": frappe.utils.get_fullname(doc.modified_by) or doc.modified_by,
	}


@frappe.whitelist()
def shift_type_settings(name: str | None = None) -> dict:
	"""Shift rules, live coverage and recent attendance for the setup editor."""
	_unused_user, roles = _require_settings_access()
	_require_hrms()
	assigned = _current_shift_by_employee()
	rows = frappe.get_all(
		"Shift Type",
		fields=["name", "start_time", "end_time", "enable_auto_attendance", "modified"],
		order_by="name asc",
		limit_page_length=0,
	)
	if name and not frappe.db.exists("Shift Type", name):
		frappe.throw(_("Shift type {0} was not found.").format(name), frappe.DoesNotExistError)
	default_name = max(
		(row.name for row in rows),
		key=lambda shift_name: sum(shift == shift_name for shift in assigned.values()),
		default=None,
	)
	selected = name or default_name
	selected = selected or (rows[0].name if rows else None)
	return {
		"can_edit": bool(roles.intersection(SETTINGS_EDIT_ROLES)),
		"holiday_lists": frappe.get_all("Holiday List", pluck="name", order_by="name asc", limit_page_length=0),
		"shifts": [
			{
				"name": row.name,
				"start_time": _as_text(row.start_time),
				"end_time": _as_text(row.end_time),
				"assigned": sum(shift == row.name for shift in assigned.values()),
				"is_default": row.name == default_name,
				"crosses_midnight": get_timedelta(row.end_time).total_seconds()
				<= get_timedelta(row.start_time).total_seconds(),
				"enabled": bool(row.enable_auto_attendance),
			}
			for row in rows
		],
		"selected": _shift_type_payload(selected, assigned) if selected else None,
	}


def _shift_settings_values(values) -> dict:
	values = json.loads(values) if isinstance(values, str) else values or {}
	allowed = {
		"start_time",
		"end_time",
		"holiday_list",
		"working_hours_threshold_for_half_day",
		"working_hours_threshold_for_absent",
		"begin_check_in_before_shift_start_time",
		"allow_check_out_after_shift_end_time",
		"enable_late_entry_marking",
		"late_entry_grace_period",
		"enable_early_exit_marking",
		"early_exit_grace_period",
		"enable_auto_attendance",
		"mark_auto_attendance_on_holidays",
		"auto_update_last_sync",
	}
	return {field: value for field, value in values.items() if field in allowed}


@frappe.whitelist(methods=["POST"])
def save_shift_type_settings(name: str, values=None) -> dict:
	"""Persist editable Shift Type rules through HRMS validation."""
	_unused_user, roles = _require_settings_access()
	if not roles.intersection(SETTINGS_EDIT_ROLES):
		frappe.throw(_("Only an HR Manager or System Manager can edit shift types."), frappe.PermissionError)
	doc = frappe.get_doc("Shift Type", name)
	for field, value in _shift_settings_values(values).items():
		doc.set(field, value)
	if cint(doc.enable_auto_attendance) and not doc.process_attendance_after:
		doc.process_attendance_after = nowdate()
	doc.save()
	return _shift_type_payload(doc.name)


@frappe.whitelist(methods=["POST"])
def create_shift_type(name: str, start_time: str, end_time: str) -> dict:
	"""Create a Shift Type with the minimum rules required by HRMS."""
	_unused_user, roles = _require_settings_access()
	if not roles.intersection(SETTINGS_EDIT_ROLES):
		frappe.throw(_("Only an HR Manager or System Manager can create shift types."), frappe.PermissionError)
	if not name.strip():
		frappe.throw(_("Shift type name is required."))
	doc = frappe.get_doc(
		{
			"doctype": "Shift Type",
			"name": name.strip(),
			"start_time": start_time,
			"end_time": end_time,
		}
	)
	doc.insert()
	return _shift_type_payload(doc.name)


@frappe.whitelist(allow_guest=True)
def health() -> dict:
	"""Small unauthenticated readiness endpoint used by the login screen."""
	installed = frappe.get_installed_apps()
	return {
		"ok": True,
		"site": frappe.local.site,
		"hrms_installed": "hrms" in installed and "erpnext" in installed,
		"techsarena_hr_installed": "techsarena_hr" in installed,
	}


@frappe.whitelist()
def bootstrap() -> dict:
	"""Return the role-aware data needed for the primary app surfaces."""
	user = _require_login()
	_require_hrms()
	roles = set(frappe.get_roles(user))
	employee = _current_employee(user, required=False)
	has_employee_access = "Employee" in roles and bool(employee)
	profile = None
	if has_employee_access:
		profile = frappe.get_value(
			"Employee",
			employee,
			[
				"name",
				"employee_name",
				"image",
				"designation",
				"department",
				"branch",
				"company",
				"company_email",
				"personal_email",
				"cell_number",
				"date_of_joining",
				"default_shift",
				"reports_to",
			],
			as_dict=True,
		)

	can_manage_hr = bool(roles.intersection(HR_ROLES))
	can_approve = can_manage_hr or bool(roles.intersection(MANAGER_ROLES))
	dashboard_context = build_role_dashboards(user, roles, employee)
	# Only meaningful inside a real HTTP request; generating one needs a live
	# session object, so never let this break bootstrap in a console or job.
	csrf_token = None
	try:
		if frappe.request:
			from frappe.sessions import get_csrf_token

			csrf_token = get_csrf_token()
	except Exception:
		csrf_token = None

	return {
		"user": {
			"id": user,
			"full_name": frappe.utils.get_fullname(user),
			"roles": sorted(roles),
		},
		# Under `vite dev` the page is served by Vite, so Frappe's Jinja template
		# never renders window.csrf_token and every POST would fail the CSRF
		# check. Handing the token to the already-authenticated client here lets
		# writes work in dev without relaxing CSRF on the site.
		"csrf_token": csrf_token,
		"capabilities": {
			"employee_self_service": has_employee_access,
			"can_approve_leave": can_approve,
			"can_manage_hr": can_manage_hr,
			"can_view_directory": frappe.has_permission("Employee", "read"),
			"can_manage_users": bool(roles.intersection({"System Manager", "Administrator"})),
			# Company-wide pay is narrower than HR access: an HR User may read
			# employees without being entitled to see everyone's salary.
			"can_run_payroll": bool(roles.intersection(PAYROLL_ROLES)),
		},
		"profile": profile,
		"attendance": _attendance(employee) if has_employee_access else None,
		"leave_balances": _leave_balances(employee) if has_employee_access else [],
		"holidays": _holidays(frappe.get_doc("Employee", employee)) if has_employee_access else [],
		"leave_requests": _leave_requests(employee) if has_employee_access else [],
		"salary_slips": _salary_slips(employee) if has_employee_access else [],
		"approvals": _pending_approvals(user, roles) if can_approve else [],
		"directory": _directory(
			unrestricted=can_manage_hr,
			visible=None if can_manage_hr else _visible_employee_names(employee),
		)
		if frappe.has_permission("Employee", "read")
		else [],
		"users": _users() if roles.intersection({"System Manager", "Administrator"}) else [],
		"notifications": _notifications(user),
		"branding": _resolved_branding(),
		"hr_summary": _hr_summary() if can_manage_hr else None,
		**dashboard_context,
	}


@frappe.whitelist()
def employee_profile(employee: str | None = None) -> dict:
	"""Full profile for one employee, grouped for the profile screen's tabs.

	Employees may always read their own record and anyone in their reporting
	subtree (their reports, recursively). Beyond that it falls through to the
	normal Employee read permission, so HR visibility stays governed by Frappe's
	rules. Pay and statutory details remain gated to self-or-HR below.
	"""
	user = _require_login()
	_require_hrms()

	own = _current_employee(user, required=False)
	employee = employee or own
	if not employee:
		frappe.throw(
			_("Your account is not linked to an active Employee record. Please contact HR."),
			frappe.PermissionError,
		)
	# A user may read their own record and anyone in their reporting subtree; HR
	# and other privileged roles fall through to Frappe's own read permission.
	if (
		employee != own
		and employee not in _visible_employee_names(own)
		and not frappe.has_permission("Employee", "read", doc=employee)
	):
		frappe.throw(_("You are not allowed to view this employee."), frappe.PermissionError)
	if not frappe.db.exists("Employee", employee):
		frappe.throw(_("Employee {0} was not found.").format(employee), frappe.DoesNotExistError)

	is_self = employee == own
	can_manage_hr = bool(set(frappe.get_roles(user)).intersection(HR_ROLES))
	# Bank details and statutory identifiers stay with the person they belong to
	# and with HR — a peer looking someone up in the directory does not get them.
	include_statutory = is_self or can_manage_hr

	groups = {key: value for key, value in PROFILE_FIELD_GROUPS.items()}
	if not include_statutory:
		groups.pop("statutory", None)

	wanted: list[str] = []
	for names in groups.values():
		for field in names:
			if field not in wanted:
				wanted.append(field)
	fields = _existing_fields("Employee", wanted)
	record = frappe.db.get_value("Employee", employee, fields, as_dict=True) or {}

	def section(key: str) -> dict:
		return {
			field: record.get(field)
			for field in _existing_fields("Employee", groups.get(key, ()))
			if field in record
		}

	reports_to = record.get("reports_to")
	manager = None
	if reports_to:
		manager = frappe.db.get_value(
			"Employee",
			reports_to,
			["name", "employee_name", "designation", "image", "user_id"],
			as_dict=True,
		)

	reports = frappe.get_all(
		"Employee",
		filters={"reports_to": employee, "status": "Active"},
		fields=["name", "employee_name", "designation", "image", "user_id"],
		order_by="employee_name asc",
		limit_page_length=50,
	)

	return {
		"employee": employee,
		"is_self": is_self,
		"can_view_statutory": include_statutory,
		"identity": section("identity"),
		"personal": section("personal"),
		"job": section("job"),
		"statutory": section("statutory") if include_statutory else {},
		"manager": manager,
		"reports": reports,
		"documents": _employee_documents(employee),
		"assets": _employee_assets(employee),
		"leave_balances": _leave_balances(employee) if include_statutory else [],
		"salary_slips": _salary_slips(employee) if include_statutory else [],
	}


def _month_attendance_stats(employee: str) -> dict:
	"""This month's attendance tally for the workspace 'Today' card."""
	start = get_first_day(nowdate())
	end = getdate(nowdate())
	rows = frappe.get_all(
		"Attendance",
		filters={
			"employee": employee,
			"docstatus": ["<", 2],
			"attendance_date": ["between", [start, end]],
		},
		fields=["status", "working_hours", "late_entry"],
		limit_page_length=200,
	)
	present = sum(1 for row in rows if row.status in ("Present", "Work From Home"))
	on_leave = sum(1 for row in rows if row.status == "On Leave")
	half_day = sum(1 for row in rows if row.status == "Half Day")
	late = sum(1 for row in rows if row.late_entry)
	worked = [row.working_hours for row in rows if row.working_hours]
	return {
		"present": present + half_day,
		"on_leave": on_leave,
		"late_entry": late,
		"average_hours": round(sum(worked) / len(worked), 1) if worked else 0,
	}


def _next_leave(employee: str) -> dict | None:
	"""The employee's next upcoming approved or pending leave."""
	rows = frappe.get_all(
		"Leave Application",
		filters={
			"employee": employee,
			"docstatus": ["<", 2],
			"status": ["in", ["Open", "Approved"]],
			"to_date": [">=", nowdate()],
		},
		fields=["name", "leave_type", "from_date", "to_date", "status", "total_leave_days"],
		order_by="from_date asc",
		limit_page_length=1,
	)
	return rows[0] if rows else None


def _expiring_allocations(employee: str) -> list[dict]:
	"""Allocations with unused days running out, e.g. comp-off about to lapse."""
	return frappe.get_all(
		"Leave Allocation",
		filters={
			"employee": employee,
			"docstatus": 1,
			"to_date": [">=", nowdate()],
		},
		fields=["leave_type", "to_date", "total_leaves_allocated", "unused_leaves"],
		order_by="to_date asc",
		limit_page_length=20,
	)


#: Rows the "Your team this week" home card shows before it truncates.
TEAM_WEEK_LIMIT = 5


def _team_week(employee: str, employee_doc) -> dict:
	"""Mon–Fri attendance/leave grid for the employee's team.

	Each teammate gets one entry per weekday with a state the UI colours:
	`approved`, `pending` or `none`.  Includes the viewer so the row order in
	the design ("your team, you included") is reproducible.
	"""
	today = getdate(nowdate())
	monday = frappe.utils.add_days(today, -today.weekday())
	friday = frappe.utils.add_days(monday, 4)

	# get_list (not get_all) so Employee permissions and User Permissions decide
	# the scope, matching team_calendar: HR reads the whole company while a
	# self-service user only sees the records they may read. Keying off
	# reports_to alone showed a lone row whenever the reporting tree was unset.
	members = frappe.get_list(
		"Employee",
		filters={"status": "Active"},
		fields=["name", "employee_name"],
		order_by="employee_name asc",
		limit_page_length=0,
	)
	if not any(member.name == employee for member in members):
		members.append(
			frappe._dict({"name": employee, "employee_name": employee_doc.employee_name})
		)
	names = [member.name for member in members]

	applications = frappe.get_all(
		"Leave Application",
		filters={
			"employee": ["in", names],
			"docstatus": ["<", 2],
			"status": ["in", ["Open", "Approved"]],
			"from_date": ["<=", friday],
			"to_date": [">=", monday],
		},
		fields=["employee", "from_date", "to_date", "status", "leave_type"],
		limit_page_length=200,
	)

	days = [frappe.utils.add_days(monday, offset) for offset in range(5)]
	rows = []
	for member in members:
		states = []
		for day in days:
			state = "none"
			for app in applications:
				if app.employee != member.name:
					continue
				if getdate(app.from_date) <= day <= getdate(app.to_date):
					state = "approved" if app.status == "Approved" else "pending"
					break
			states.append(state)
		rows.append(
			{
				"employee": member.name,
				"employee_name": member.employee_name,
				"is_self": member.name == employee,
				"days": states,
			}
		)

	# The home card is a glance, not a roster: show at most TEAM_WEEK_LIMIT rows.
	# Keep the viewer and whoever is actually away, since an alphabetical head
	# would just show people with empty weeks on a large team.
	total = len(rows)
	if total > TEAM_WEEK_LIMIT:
		ranked = sorted(
			rows,
			key=lambda row: (
				not row["is_self"],
				all(state == "none" for state in row["days"]),
				row["employee_name"] or "",
			),
		)
		keep = {row["employee"] for row in ranked[:TEAM_WEEK_LIMIT]}
		rows = [row for row in rows if row["employee"] in keep]

	return {
		"week_start": str(monday),
		"days": [str(day) for day in days],
		"department": employee_doc.department,
		"members": rows,
		# Lets the card say "5 of 9" instead of implying the team is only 5.
		"total_members": total,
	}


def _shift_window(shift_type: str | None) -> dict | None:
	if not shift_type:
		return None
	row = frappe.db.get_value(
		"Shift Type", shift_type, ["name", "start_time", "end_time"], as_dict=True
	)
	if not row:
		return None
	return {
		"shift_type": row.name,
		"start_time": _as_text(row.start_time),
		"end_time": _as_text(row.end_time),
	}


def _attendance_month(employee: str, month_start, month_end) -> list[dict]:
	"""One row per marked attendance day, with punch times for the calendar."""
	return frappe.get_all(
		"Attendance",
		filters={
			"employee": employee,
			"docstatus": ["<", 2],
			"attendance_date": ["between", [month_start, month_end]],
		},
		fields=[
			"name",
			"attendance_date",
			"status",
			"working_hours",
			"in_time",
			"out_time",
			"late_entry",
			"early_exit",
			"shift",
			"leave_type",
		],
		order_by="attendance_date asc",
		limit_page_length=62,
	)


def _upcoming_shifts(employee: str, employee_doc, days: int = 7) -> list[dict]:
	"""Next few days of shift assignments, with holidays folded in."""
	start = getdate(nowdate())
	end = frappe.utils.add_days(start, days - 1)

	assignments = frappe.get_all(
		"Shift Assignment",
		filters={
			"employee": employee,
			"docstatus": 1,
			"status": "Active",
			"start_date": ["<=", end],
		},
		fields=["shift_type", "start_date", "end_date"],
		order_by="start_date asc",
		limit_page_length=50,
	)

	holiday_list = employee_doc.holiday_list or frappe.db.get_value(
		"Company", employee_doc.company, "default_holiday_list"
	)
	holidays = {}
	if holiday_list:
		for row in frappe.get_all(
			"Holiday",
			filters={"parent": holiday_list, "holiday_date": ["between", [start, end]]},
			fields=["holiday_date", "description", "weekly_off"],
			limit_page_length=50,
		):
			holidays[getdate(row.holiday_date)] = row

	default_shift = _shift_window(employee_doc.default_shift)
	out = []
	for offset in range(days):
		day = frappe.utils.add_days(start, offset)
		holiday = holidays.get(day)
		shift = None
		for assignment in assignments:
			if getdate(assignment.start_date) <= day and (
				not assignment.end_date or day <= getdate(assignment.end_date)
			):
				shift = _shift_window(assignment.shift_type)
				break
		out.append(
			{
				"date": str(day),
				"shift": shift or default_shift,
				"holiday": holiday.description if holiday else None,
				"weekly_off": bool(holiday.weekly_off) if holiday else False,
			}
		)
	return out


def _attendance_requests(employee: str) -> list[dict]:
	"""Regularisation and shift-change requests for the Requests panel."""
	requests = []
	for row in frappe.get_all(
		"Attendance Request",
		filters={"employee": employee, "docstatus": ["<", 2]},
		fields=["name", "from_date", "to_date", "reason", "explanation", "docstatus", "creation"],
		order_by="creation desc",
		limit_page_length=10,
	):
		requests.append(
			{
				"name": row.name,
				"kind": "Regularisation",
				"detail": row.reason,
				"explanation": row.explanation,
				"from_date": row.from_date,
				"to_date": row.to_date,
				"status": "Approved" if row.docstatus == 1 else "Pending",
				"creation": row.creation,
			}
		)
	for row in frappe.get_all(
		"Shift Request",
		filters={"employee": employee, "docstatus": ["<", 2]},
		fields=["name", "from_date", "to_date", "shift_type", "status", "docstatus", "creation"],
		order_by="creation desc",
		limit_page_length=10,
	):
		requests.append(
			{
				"name": row.name,
				"kind": "Shift change",
				"detail": row.shift_type,
				"explanation": None,
				"from_date": row.from_date,
				"to_date": row.to_date,
				# A freshly filed Shift Request sits at status "Draft" until the
				# approver acts; from the employee's side that is simply pending.
				"status": "Pending"
				if row.docstatus == 0 and row.status in (None, "", "Draft")
				else (row.status or "Approved"),
				"creation": row.creation,
			}
		)
	requests.sort(key=lambda item: item["creation"], reverse=True)
	return requests[:8]


@frappe.whitelist()
def attendance_month(month: str | None = None) -> dict:
	"""Everything the Attendance & shifts screen renders for one month.

	`month` is any date inside the wanted month (YYYY-MM-DD); it defaults to the
	current one.  Days needing attention are derived rather than stored: a day
	is flagged when attendance was marked but no closing punch exists.
	"""
	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)
	employee_doc = frappe.get_doc("Employee", employee)

	anchor = getdate(month) if month else getdate(nowdate())
	month_start = get_first_day(anchor)
	month_end = get_last_day(anchor)

	days = _attendance_month(employee, month_start, month_end)

	holiday_list = employee_doc.holiday_list or frappe.db.get_value(
		"Company", employee_doc.company, "default_holiday_list"
	)
	holidays = []
	if holiday_list:
		holidays = frappe.get_all(
			"Holiday",
			filters={
				"parent": holiday_list,
				"holiday_date": ["between", [month_start, month_end]],
			},
			fields=["holiday_date", "description", "weekly_off"],
			order_by="holiday_date asc",
			limit_page_length=62,
		)

	present = sum(1 for row in days if row.status == "Present")
	wfh = sum(1 for row in days if row.status == "Work From Home")
	on_leave = sum(1 for row in days if row.status == "On Leave")
	half_day = sum(1 for row in days if row.status == "Half Day")
	worked = [row.working_hours for row in days if row.working_hours]

	# A marked day with an opening punch but no closing one still needs the
	# employee to regularise it before payroll locks.
	needs_action = [
		{
			"date": str(row.attendance_date),
			"reason": "Missing check-out",
			"in_time": _as_text(row.in_time),
		}
		for row in days
		if row.in_time and not row.out_time and row.status in ("Present", "Half Day")
	]

	return {
		"month": str(month_start),
		"month_start": str(month_start),
		"month_end": str(month_end),
		"today": _attendance(employee),
		"default_shift": _shift_window(employee_doc.default_shift),
		"days": days,
		"holidays": holidays,
		"summary": {
			"days_present": present + half_day,
			"work_from_home": wfh,
			"on_leave": on_leave,
			"average_hours": round(sum(worked) / len(worked), 2) if worked else 0,
		},
		"needs_action": needs_action,
		"upcoming_shifts": _upcoming_shifts(employee, employee_doc),
		"requests": _attendance_requests(employee),
	}


@frappe.whitelist(methods=["POST"])
def request_regularisation(
	from_date: str,
	to_date: str,
	reason: str = "On Duty",
	explanation: str | None = None,
	half_day: int | str = 0,
) -> dict:
	"""File an Attendance Request for a day that was missed or mispunched."""
	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)

	start = getdate(from_date)
	end = getdate(to_date)
	if end < start:
		frappe.throw(_("The end date cannot be before the start date."))

	doc = frappe.new_doc("Attendance Request")
	doc.employee = employee
	doc.from_date = start
	doc.to_date = end
	doc.reason = reason
	doc.explanation = explanation
	doc.half_day = frappe.utils.cint(half_day)
	doc.insert()
	_publish("approval_queue_changed", {"doctype": "Attendance Request", "name": doc.name})
	return {"name": doc.name, "status": "Pending"}


@frappe.whitelist(methods=["POST"])
def request_shift_change(shift_type: str, from_date: str, to_date: str) -> dict:
	"""Ask to work a different shift for a date range."""
	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)

	start = getdate(from_date)
	end = getdate(to_date)
	if end < start:
		frappe.throw(_("The end date cannot be before the start date."))

	doc = frappe.new_doc("Shift Request")
	doc.employee = employee
	doc.shift_type = shift_type
	doc.from_date = start
	doc.to_date = end
	doc.insert()
	return {"name": doc.name, "status": doc.status}


@frappe.whitelist()
def shift_types() -> list[dict]:
	"""Selectable shifts for the shift-change form."""
	_require_login()
	_require_hrms()
	return frappe.get_all(
		"Shift Type",
		fields=["name", "start_time", "end_time"],
		order_by="name asc",
		limit_page_length=50,
	)


@frappe.whitelist()
def workspace_summary() -> dict:
	"""Extra data the employee workspace cards need beyond bootstrap."""
	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)
	employee_doc = frappe.get_doc("Employee", employee)
	return {
		"attendance_stats": _month_attendance_stats(employee),
		"next_leave": _next_leave(employee),
		"allocations": _expiring_allocations(employee),
		"team_week": _team_week(employee, employee_doc),
	}


@frappe.whitelist()
def team_calendar(from_date: str, to_date: str) -> dict:
	"""Who on your team is away between two dates, plus your holiday list.

	Powers the leave calendar and the overlap warning shown before submitting a
	request.  "Team" is every active employee the caller is permitted to read,
	so HR sees the whole company while a self-service user sees only the records
	their User Permissions allow.
	"""
	user = _require_login()
	_require_hrms()
	# Note: unpack into a named throwaway, never `_` — that is frappe's
	# translation function and rebinding it breaks every _() call below.
	_unused_user, employee = _require_employee_user(user)

	start = getdate(from_date)
	end = getdate(to_date)
	if end < start:
		frappe.throw(_("The end date cannot be before the start date."))

	employee_doc = frappe.get_doc("Employee", employee)
	# get_list (not get_all) so Employee permissions and User Permissions decide
	# the scope: HR reads the whole company, while a self-service user is pinned
	# to the records they may see. The old peers-and-reports rule returned an
	# empty team — and so an empty calendar — for anyone whose reporting tree
	# was not filled in, which is every employee on a fresh site.
	team = sorted(
		row.name
		for row in frappe.get_list(
			"Employee",
			filters={"status": "Active", "name": ["!=", employee]},
			fields=["name"],
			limit_page_length=0,
		)
	)

	entries = []
	if team:
		entries = frappe.get_all(
			"Leave Application",
			filters={
				"employee": ["in", team],
				"docstatus": ["<", 2],
				"status": ["in", ["Open", "Approved"]],
				"from_date": ["<=", end],
				"to_date": [">=", start],
			},
			fields=[
				"name",
				"employee",
				"employee_name",
				"department",
				"leave_type",
				"from_date",
				"to_date",
				"total_leave_days",
				"status",
			],
			order_by="from_date asc",
			limit_page_length=200,
		)

	holiday_list = employee_doc.holiday_list or frappe.db.get_value(
		"Company", employee_doc.company, "default_holiday_list"
	)
	holidays = []
	if holiday_list:
		holidays = frappe.get_all(
			"Holiday",
			filters={
				"parent": holiday_list,
				"holiday_date": ["between", [start, end]],
			},
			fields=["holiday_date", "description", "weekly_off"],
			order_by="holiday_date asc",
			limit_page_length=200,
		)

	own = frappe.get_all(
		"Leave Application",
		filters={
			"employee": employee,
			"docstatus": ["<", 2],
			"status": ["in", ["Open", "Approved"]],
			"from_date": ["<=", end],
			"to_date": [">=", start],
		},
		fields=[
			"name",
			"employee",
			"employee_name",
			"department",
			"leave_type",
			"from_date",
			"to_date",
			"total_leave_days",
			"status",
		],
		order_by="from_date asc",
		limit_page_length=100,
	)

	return {
		"from_date": str(start),
		"to_date": str(end),
		"team_size": len(team),
		"team_leave": entries,
		"own_leave": own,
		"holidays": holidays,
		"holiday_list": holiday_list,
		# Lets the calendar label the viewer's own row and their approver's
		# without the client having to guess from names.
		"employee": employee,
		"reports_to": employee_doc.reports_to or None,
	}


def _blocked_dates(employee: str, leave_type: str | None, start, end) -> list[dict]:
	"""Blackout dates from HRMS's Leave Block List that hit this range.

	Delegates to HRMS's own resolver, which walks both the company-wide lists
	(``applies_to_all_departments``) and the requester's department list, and
	honours the per-list allow list. Passing ``all_lists=False`` means a user on
	a list's allow list correctly sees no block.
	"""
	if not frappe.db.table_exists("Leave Block List"):
		return []
	try:
		from hrms.hr.doctype.leave_block_list.leave_block_list import get_applicable_block_dates
	except ImportError:
		return []

	company = frappe.db.get_value("Employee", employee, "company")
	rows = get_applicable_block_dates(
		start, end, employee=employee, company=company, leave_type=leave_type
	) or []
	return sorted(
		({"block_date": str(row.get("block_date")), "reason": row.get("reason")} for row in rows),
		key=lambda row: row["block_date"],
	)


@frappe.whitelist()
def leave_preview(leave_type: str, from_date: str, to_date: str, half_day: int | str = 0) -> dict:
	"""Working days, resulting balance and clashes for a draft leave request.

	Day counting is delegated to HRMS so half-days and each leave type's
	`include_holiday` setting are honoured exactly as they will be on submit.
	"""
	from hrms.hr.doctype.leave_application.leave_application import get_number_of_leave_days

	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)

	start = getdate(from_date)
	end = getdate(to_date)
	if end < start:
		frappe.throw(_("The end date cannot be before the start date."))

	days = get_number_of_leave_days(employee, leave_type, start, end, half_day)

	balance = None
	for row in _leave_balances(employee):
		if row["leave_type"] == leave_type:
			balance = row["remaining"]
			break

	overlap = team_calendar(str(start), str(end))
	blocked = _blocked_dates(employee, leave_type, start, end)
	return {
		"leave_type": leave_type,
		"from_date": str(start),
		"to_date": str(end),
		"working_days": days,
		"balance_before": balance,
		"balance_after": None if balance is None else balance - days,
		"sufficient_balance": balance is None or balance >= days,
		"team_leave": overlap["team_leave"],
		"team_size": overlap["team_size"],
		"holidays": overlap["holidays"],
		# Blackout dates. HRMS surfaces these as a msgprint on the Desk form,
		# which a REST client never sees, and only *enforces* them at approval
		# time — so without this the employee would file a request that looks
		# fine and gets refused days later. See submit_leave, which blocks it up
		# front.
		"blocked_dates": blocked,
		"has_blocked_dates": bool(blocked),
	}


POLICY_FIELDS = (
	"name",
	"max_leaves_allowed",
	"is_carry_forward",
	"maximum_carry_forwarded_leaves",
	"is_earned_leave",
	"earned_leave_frequency",
	"allow_half_day",
	"include_holiday",
	"is_compensatory",
	"is_lwp",
	"allow_encashment",
	"encashment_threshold_days",
	"max_continuous_days_allowed",
	"applicable_after",
	"techsarena_policy_version",
	"techsarena_effective_from",
	"techsarena_applies_to",
	"techsarena_notice_days",
	"techsarena_escalation_days",
	"techsarena_secondary_approver_above",
)


def _policy_attachments(leave_types: list[str], holiday_list: str | None) -> list[dict]:
	"""Files genuinely attached to the leave types or the employee's holiday list.

	Nothing is fabricated here: a site that attaches no handbook simply shows no
	documents.  Private files are included because the reader is the employee the
	policy applies to, and the file route still enforces its own permissions.
	"""
	targets = [("Leave Type", name) for name in leave_types]
	if holiday_list:
		targets.append(("Holiday List", holiday_list))
	if not targets:
		return []

	rows = frappe.get_all(
		"File",
		filters={
			"attached_to_doctype": ["in", sorted({doctype for doctype, _name in targets})],
			"attached_to_name": ["in", sorted({name for _doctype, name in targets})],
		},
		fields=["name", "file_name", "file_url", "attached_to_doctype", "attached_to_name"],
		order_by="creation desc",
		limit_page_length=25,
	)
	# The two `in` filters cross-join, so drop pairs that were never attached.
	allowed = set(targets)
	return [
		{
			"id": row.name,
			"title": row.file_name,
			"url": row.file_url,
			"source": row.attached_to_name,
		}
		for row in rows
		if (row.attached_to_doctype, row.attached_to_name) in allowed
	]


def _approval_chain(employee_doc) -> list[dict]:
	"""Who actually decides this employee's leave, in the order they are asked.

	Both steps come from the employee's own record — the named leave approver if
	one is set, otherwise the reporting manager that HRMS falls back to.
	"""
	chain = []
	approver = employee_doc.get("leave_approver")
	if approver:
		chain.append(
			{
				"name": frappe.utils.get_fullname(approver),
				"role": "Leave Approver",
				"scope": "all requests",
			}
		)
	if employee_doc.get("reports_to"):
		manager = frappe.db.get_value(
			"Employee", employee_doc.reports_to, ["employee_name", "designation"], as_dict=True
		)
		if manager and not any(row["name"] == manager.employee_name for row in chain):
			chain.append(
				{
					"name": manager.employee_name,
					"role": manager.designation or "Reports To",
					"scope": "all requests" if not chain else "escalation",
				}
			)
	return chain


@frappe.whitelist()
def leave_policies() -> dict:
	"""The site's leave types with the rules and people behind each one.

	Everything returned is read from the site: the leave type's own configuration,
	the policy fields this app adds to it, the employee's approval route, and files
	actually attached to those records.
	"""
	user = _require_login()
	_require_hrms()
	employee = _current_employee(user, required=False)

	fields = _existing_fields("Leave Type", POLICY_FIELDS)
	types = frappe.get_all("Leave Type", fields=fields, order_by="name asc", limit_page_length=0)

	employee_doc = frappe.get_doc("Employee", employee) if employee else None
	holiday_list = None
	if employee_doc:
		holiday_list = employee_doc.holiday_list or frappe.db.get_value(
			"Company", employee_doc.company, "default_holiday_list"
		)

	# Holidays still ahead in the list's own year — the Policies screen shows
	# these beside the leave rules, since "what am I owed" and "what is already
	# a day off" are the same question for someone planning time away.
	holidays = []
	if holiday_list:
		holidays = frappe.get_all(
			"Holiday",
			filters={
				"parent": holiday_list,
				"holiday_date": [">=", frappe.utils.nowdate()],
				"weekly_off": 0,
			},
			fields=["holiday_date", "description", "weekly_off"],
			order_by="holiday_date asc",
			limit_page_length=12,
		)

	return {
		"leave_types": types,
		"approval_chain": _approval_chain(employee_doc) if employee_doc else [],
		"documents": _policy_attachments([row.name for row in types], holiday_list),
		"holiday_list": holiday_list,
		"holidays": holidays,
		"policy_set": " · ".join(
			part
			for part in (
				employee_doc.company if employee_doc else None,
				employee_doc.department if employee_doc else None,
			)
			if part
		)
		or None,
	}


# --------------------------------------------------------------------------- #
# Leave block lists (blackout dates)
# --------------------------------------------------------------------------- #


@frappe.whitelist()
def leave_block_lists(name: str | None = None) -> dict:
	"""Blackout calendars HR maintains, with one list expanded when named.

	The list a Department points at is reported alongside the company-wide ones
	so HR can see which populations a blackout actually reaches — that mapping
	lives on Department, not on the block list, and is easy to lose track of.
	"""
	_require_hr_access()
	_require_hrms()
	if not frappe.db.table_exists("Leave Block List"):
		return {"lists": [], "selected": None, "departments": []}

	lists = frappe.get_all(
		"Leave Block List",
		fields=[
			"name",
			"leave_block_list_name",
			"company",
			"applies_to_all_departments",
			"leave_type",
		],
		order_by="leave_block_list_name asc",
		limit_page_length=0,
	)

	# Which departments route to which list — one query, not one per list.
	departments = frappe.get_all(
		"Department",
		filters={"leave_block_list": ["is", "set"]},
		fields=["name", "leave_block_list"],
		limit_page_length=0,
	)
	by_list: dict[str, list[str]] = {}
	for row in departments:
		by_list.setdefault(row.leave_block_list, []).append(row.name)

	today = getdate(nowdate())
	counts = _block_list_date_counts([row.name for row in lists], today)
	for row in lists:
		row["departments"] = by_list.get(row.name, [])
		row["total_dates"] = counts.get(row.name, {}).get("total", 0)
		row["upcoming_dates"] = counts.get(row.name, {}).get("upcoming", 0)

	selected = _block_list_payload(name) if name else None
	return {"lists": lists, "selected": selected, "departments": departments}


def _block_list_date_counts(names: list[str], today) -> dict[str, dict]:
	"""Total and still-to-come blackout dates per list, in one query."""
	if not names:
		return {}
	counts: dict[str, dict] = {}
	for row in frappe.get_all(
		"Leave Block List Date",
		filters={"parent": ["in", names]},
		fields=["parent", "block_date"],
		limit_page_length=0,
	):
		entry = counts.setdefault(row.parent, {"total": 0, "upcoming": 0})
		entry["total"] += 1
		if getdate(row.block_date) >= today:
			entry["upcoming"] += 1
	return counts


def _block_list_payload(name: str) -> dict:
	"""One block list in full: its dates and its allow list."""
	if not frappe.db.exists("Leave Block List", name):
		frappe.throw(_("Block list {0} was not found.").format(name), frappe.DoesNotExistError)

	doc = frappe.get_doc("Leave Block List", name)
	dates = [
		{"name": row.name, "block_date": str(row.block_date), "reason": row.reason}
		for row in sorted(doc.get("leave_block_list_dates") or [], key=lambda r: str(r.block_date))
	]
	allowed = [row.allow_user for row in (doc.get("leave_block_list_allowed") or []) if row.allow_user]
	allowed_names = {}
	if allowed:
		allowed_names = {
			row.name: row.full_name or row.name
			for row in frappe.get_all(
				"User",
				filters={"name": ["in", allowed]},
				fields=["name", "full_name"],
				limit_page_length=0,
			)
		}
	return {
		"name": doc.name,
		"leave_block_list_name": doc.leave_block_list_name,
		"company": doc.company,
		"applies_to_all_departments": cint(doc.applies_to_all_departments),
		"leave_type": doc.leave_type,
		"dates": dates,
		"allowed_users": [{"user": u, "full_name": allowed_names.get(u, u)} for u in allowed],
	}


@frappe.whitelist(methods=["POST"])
def save_leave_block_list(
	name: str | None = None,
	leave_block_list_name: str | None = None,
	company: str | None = None,
	applies_to_all_departments: int | str = 0,
	leave_type: str | None = None,
	dates=None,
	allowed_users=None,
) -> dict:
	"""Create or update a blackout calendar. HR only.

	``dates`` is a JSON list of ``{block_date, reason}``; ``allowed_users`` a
	JSON list of user ids exempt from the block. Both replace the existing rows
	wholesale — the screen edits the whole table, so a partial merge would make
	deletions impossible to express.
	"""
	_require_hr_access()
	_require_hrms()
	if not frappe.db.table_exists("Leave Block List"):
		frappe.throw(_("Leave Block List is not available on this site."), frappe.ValidationError)

	rows = frappe.parse_json(dates) if isinstance(dates, str) else (dates or [])
	users = frappe.parse_json(allowed_users) if isinstance(allowed_users, str) else (allowed_users or [])

	if name:
		doc = frappe.get_doc("Leave Block List", name)
	else:
		if not leave_block_list_name:
			frappe.throw(_("Name the block list before saving."), frappe.ValidationError)
		doc = frappe.new_doc("Leave Block List")

	if leave_block_list_name:
		doc.leave_block_list_name = leave_block_list_name
	if company:
		doc.company = company
	elif not doc.company:
		doc.company = frappe.defaults.get_user_default("Company")
	doc.applies_to_all_departments = cint(applies_to_all_departments)
	# An empty leave_type means the block applies to every type — that is HRMS's
	# own convention, so pass the blank through rather than skipping the write.
	doc.leave_type = leave_type or None

	seen: set[str] = set()
	doc.set("leave_block_list_dates", [])
	for row in rows:
		block_date = row.get("block_date") if isinstance(row, dict) else row
		if not block_date:
			continue
		key = str(getdate(block_date))
		# HRMS raises on a repeated date; de-duplicate here so a double-click in
		# the date picker is silently tolerated rather than failing the save.
		if key in seen:
			continue
		seen.add(key)
		doc.append(
			"leave_block_list_dates",
			{
				"block_date": getdate(block_date),
				"reason": (row.get("reason") if isinstance(row, dict) else None) or _("Blocked"),
			},
		)

	doc.set("leave_block_list_allowed", [])
	for user in dict.fromkeys(u for u in users if u):
		doc.append("leave_block_list_allowed", {"allow_user": user})

	doc.save()
	return _block_list_payload(doc.name)


@frappe.whitelist(methods=["POST"])
def delete_leave_block_list(name: str) -> dict:
	"""Remove a blackout calendar. HR only."""
	_require_hr_access()
	_require_hrms()
	if not frappe.db.exists("Leave Block List", name):
		frappe.throw(_("Block list {0} was not found.").format(name), frappe.DoesNotExistError)

	linked = frappe.get_all(
		"Department", filters={"leave_block_list": name}, pluck="name", limit_page_length=0
	)
	if linked:
		frappe.throw(
			_("{0} is still assigned to {1}. Clear it from those departments first.").format(
				name, ", ".join(linked[:5])
			),
			frappe.ValidationError,
		)
	frappe.delete_doc("Leave Block List", name)
	return {"name": name, "deleted": True}


@frappe.whitelist(methods=["POST"])
def assign_block_list_to_department(department: str, leave_block_list: str | None = None) -> dict:
	"""Point a department at a blackout calendar, or clear it. HR only.

	The department link is how a non-company-wide list reaches anyone, so it is
	part of the block-list workflow rather than a separate department screen.
	"""
	_require_hr_access()
	_require_hrms()
	if not frappe.db.exists("Department", department):
		frappe.throw(_("Department {0} was not found.").format(department), frappe.DoesNotExistError)
	if leave_block_list and not frappe.db.exists("Leave Block List", leave_block_list):
		frappe.throw(
			_("Block list {0} was not found.").format(leave_block_list), frappe.DoesNotExistError
		)

	doc = frappe.get_doc("Department", department)
	doc.leave_block_list = leave_block_list or None
	doc.save()
	return {"department": department, "leave_block_list": doc.leave_block_list}


@frappe.whitelist()
def my_blocked_dates(from_date: str, to_date: str) -> dict:
	"""Blackout dates that apply to the signed-in employee in a range.

	Lets the leave calendar shade blocked days before the employee picks them.
	"""
	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)

	start = getdate(from_date)
	end = getdate(to_date)
	if end < start:
		frappe.throw(_("The end date cannot be before the start date."))
	return {
		"from_date": str(start),
		"to_date": str(end),
		"blocked_dates": _blocked_dates(employee, None, start, end),
	}


#: How far back a client-supplied punch time is honoured. Long enough to cover a
#: shift spent out of signal, short enough that a stale queue cannot rewrite last
#: week's attendance.
OFFLINE_PUNCH_MAX_AGE_HOURS = 24


def _punch_time(punched_at: str | None):
	"""Server time, unless the client supplied a defensible earlier moment."""
	server_now = now_datetime()
	if not punched_at:
		return server_now
	try:
		claimed = get_datetime(punched_at)
	except Exception:
		return server_now
	# A future timestamp means a wrong client clock, not a real punch.
	if claimed > server_now:
		return server_now
	if (server_now - claimed).total_seconds() > OFFLINE_PUNCH_MAX_AGE_HOURS * 3600:
		frappe.throw(
			_("That punch is more than {0} hours old and cannot be recorded automatically. "
			  "Please raise an attendance regularisation request.").format(OFFLINE_PUNCH_MAX_AGE_HOURS)
		)
	return claimed


@frappe.whitelist(methods=["POST"])
def check_in_out(
	log_type: str,
	latitude=None,
	longitude=None,
	device_id: str | None = None,
	punched_at: str | None = None,
) -> dict:
	"""Record a punch.

	`punched_at` exists for punches taken offline and synced later: without it a
	punch made at 09:00 and delivered at 17:00 would be stamped 17:00 and count
	eight hours that were not worked. It is accepted only in the past and only
	within OFFLINE_PUNCH_MAX_AGE_HOURS, so it cannot be used to backdate
	attendance arbitrarily — a client clock is not a trusted source.
	"""
	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)
	log_type = (log_type or "").upper()
	if log_type not in {"IN", "OUT"}:
		frappe.throw(_("Log type must be IN or OUT."))

	# Serialise concurrent punches for this employee before reading the current
	# state. Without the lock this is a check-then-act: a double-tap, a retry or
	# a second tab can both read "not checked in" and both insert an IN. The
	# duplicate is not cosmetic — _attendance pairs punches sequentially, so a
	# second IN overwrites the pending one and silently discards the first
	# interval, undercounting worked hours for the day and feeding that into
	# payroll.
	frappe.db.get_value("Employee", employee, "name", for_update=True)

	current = _attendance(employee)
	if log_type == "IN" and current["checked_in"]:
		frappe.throw(_("You are already checked in."))
	if log_type == "OUT" and not current["checked_in"]:
		frappe.throw(_("You are not currently checked in."))

	doc = frappe.new_doc("Employee Checkin")
	doc.employee = employee
	doc.time = _punch_time(punched_at)
	doc.log_type = log_type
	doc.device_id = device_id or "Techs Arena HCM"
	doc.latitude = latitude
	doc.longitude = longitude
	# The employee owns this record and holds create rights on Employee Checkin.
	# Elevating bypassed HRMS's own validation and any site customisation (e.g. a
	# rule blocking backdated punches) for no benefit.
	doc.insert()

	updated = _attendance(employee)
	_publish_to_employee(employee, "attendance_updated", {"today": updated})
	return updated


@frappe.whitelist(methods=["POST"])
def submit_leave(
	leave_type: str,
	from_date: str,
	to_date: str,
	description: str | None = None,
	half_day: int | str = 0,
) -> dict:
	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)

	start = getdate(from_date)
	end = getdate(to_date)
	if end < start:
		frappe.throw(_("The end date cannot be before the start date."))

	# Refuse blackout dates at application time.
	#
	# HRMS only *enforces* its Leave Block List when status becomes "Approved"
	# (validate_block_days), and at application time merely msgprints a warning
	# that a REST client never receives. So without this an employee files a
	# request that looks accepted, plans around it, and has it refused days
	# later at the approver's desk. Failing here makes the blackout visible at
	# the moment it applies.
	blocked = _blocked_dates(employee, leave_type, start, end)
	if blocked:
		detail = ", ".join(
			f"{row['block_date']}" + (f" ({row['reason']})" if row.get("reason") else "")
			for row in blocked[:5]
		)
		more = len(blocked) - 5
		if more > 0:
			detail += _(" and {0} more").format(more)
		frappe.throw(
			_("Leave cannot be applied for on blocked dates: {0}").format(detail),
			frappe.ValidationError,
		)

	doc = frappe.new_doc("Leave Application")
	doc.employee = employee
	doc.leave_type = leave_type
	doc.from_date = start
	doc.to_date = end
	doc.description = description
	doc.half_day = frappe.utils.cint(half_day)
	doc.status = "Open"
	doc.insert()
	_publish("approval_queue_changed", {"doctype": "Leave Application", "name": doc.name})
	return {"name": doc.name, "status": doc.status, "total_leave_days": doc.total_leave_days}


@frappe.whitelist(methods=["POST"])
def decide_leave(name: str, decision: str, comment: str | None = None) -> dict:
	user = _require_login()
	_require_hrms()
	doc = frappe.get_doc("Leave Application", name)
	roles = set(frappe.get_roles(user))
	if doc.leave_approver != user and not roles.intersection(HR_ROLES):
		frappe.throw(_("You are not the approver for this request."), frappe.PermissionError)
	if doc.docstatus != 0 or doc.status != "Open":
		frappe.throw(_("This request has already been decided."))
	decision = (decision or "").title()
	if decision not in {"Approved", "Rejected"}:
		frappe.throw(_("Decision must be Approved or Rejected."))
	doc.check_permission("submit")
	doc.status = decision
	doc.save()
	doc.submit()
	if comment:
		doc.add_comment("Comment", text=comment)
	# Tell the requester's open tab, and every approver whose queue just shrank.
	_publish_to_employee(
		doc.employee, "leave_decided", {"name": doc.name, "status": doc.status}
	)
	_publish("approval_queue_changed", {"doctype": "Leave Application", "name": doc.name})
	return {"name": doc.name, "status": doc.status, "docstatus": doc.docstatus}


PAYROLL_ROLES = {"HR Manager", "System Manager", "Administrator", "Accounts Manager"}


def _require_payroll_access(user: str | None = None) -> str:
	"""Company-wide pay is only for the roles that actually run payroll."""
	user = user or _require_login()
	if not set(frappe.get_roles(user)).intersection(PAYROLL_ROLES):
		frappe.throw(_("You do not have access to payroll."), frappe.PermissionError)
	return user


def _payroll_exceptions(entry, slips: list[dict]) -> list[dict]:
	"""What stands between this run and being paid out.

	Each exception names the employee, says why the slip cannot be paid, and
	carries the action that clears it, so the screen never asks the user to go
	hunting for what to fix.
	"""
	exceptions = []
	employees = [row.employee for row in entry.employees] if entry.get("employees") else []

	# A slip with no bank account is generated but cannot be transferred.
	if employees:
		banked = {
			row.name: row
			for row in frappe.get_all(
				"Employee",
				filters={"name": ["in", employees]},
				fields=["name", "employee_name", "bank_ac_no", "salary_mode"],
			)
		}
		for employee, row in banked.items():
			if not row.bank_ac_no and (row.salary_mode or "Bank") == "Bank":
				exceptions.append(
					{
						"kind": "bank_account",
						"employee": employee,
						"employee_name": row.employee_name,
						"title": _("Bank account missing"),
						"detail": _("Slip generated but cannot be paid out."),
						"action": "request_details",
					}
				)

	# An employee with no salary structure produces no slip at all.
	slipped = {slip["employee"] for slip in slips}
	for employee in employees:
		if employee in slipped:
			continue
		row = frappe.db.get_value(
			"Employee", employee, ["employee_name", "date_of_joining"], as_dict=True
		)
		if not row:
			continue
		exceptions.append(
			{
				"kind": "no_structure",
				"employee": employee,
				"employee_name": row.employee_name,
				"title": _("No salary structure"),
				"detail": _("Joined {0}. Assign a structure or exclude them from this run.").format(
					frappe.utils.formatdate(row.date_of_joining, "d MMM")
					if row.date_of_joining
					else _("recently")
				),
				"action": "assign_structure",
			}
		)
	return exceptions


def _payroll_cost_split(slips: list[dict]) -> list[dict]:
	"""Net pay grouped by department, largest first."""
	totals: dict[str, dict] = {}
	for slip in slips:
		key = slip.get("department") or _("Unassigned")
		bucket = totals.setdefault(key, {"department": key, "amount": 0.0, "headcount": 0})
		bucket["amount"] += flt(slip.get("net_pay"))
		bucket["headcount"] += 1
	return sorted(totals.values(), key=lambda row: row["amount"], reverse=True)


def _payroll_statutory(slips: list[dict]) -> list[dict]:
	"""The statutory deductions this run owes, by component.

	Read from the slips' own deduction rows rather than assumed, so a site's
	own component names (PF, TDS, PT, ESI …) come through as configured.
	"""
	names = [slip["name"] for slip in slips]
	if not names:
		return []
	rows = frappe.get_all(
		"Salary Detail",
		filters={"parent": ["in", names], "parentfield": "deductions"},
		fields=["salary_component", "sum(amount) as amount"],
		group_by="salary_component",
		order_by="amount desc",
		limit_page_length=20,
	)
	return [{"component": row.salary_component, "amount": flt(row.amount)} for row in rows]


@frappe.whitelist()
def payroll_run(name: str | None = None) -> dict:
	"""The payroll run being worked on, with everything the screen shows.

	Defaults to the most recent entry when no [name] is given, and returns the
	list of runs so the period picker has somewhere to go.
	"""
	user = _require_login()
	_require_hrms()
	_require_payroll_access(user)

	runs = frappe.get_all(
		"Payroll Entry",
		fields=["name", "start_date", "end_date", "status", "docstatus", "posting_date"],
		order_by="start_date desc",
		limit_page_length=24,
	)
	if not runs:
		return {"runs": [], "run": None}

	name = name or runs[0].name
	entry = frappe.get_doc("Payroll Entry", name)
	entry.check_permission("read")

	slips = frappe.get_all(
		"Salary Slip",
		filters={"payroll_entry": name, "docstatus": ["<", 2]},
		fields=[
			"name",
			"employee",
			"employee_name",
			"department",
			"designation",
			"salary_structure",
			"gross_pay",
			"total_deduction",
			"net_pay",
			"leave_without_pay",
			"payment_days",
			"total_working_days",
			"status",
			"docstatus",
		],
		order_by="employee_name asc",
		limit_page_length=0,
	)

	exceptions = _payroll_exceptions(entry, slips)
	held = {row["employee"] for row in exceptions}
	for slip in slips:
		lwp = flt(slip.get("leave_without_pay"))
		prorated = flt(slip.get("payment_days")) < flt(slip.get("total_working_days"))
		slip["held"] = slip["employee"] in held
		# "Changed" flags a slip an approver should look at before submitting:
		# unpaid leave or a part-month both move the figure from the norm.
		slip["changed"] = bool(lwp) or prorated
		if lwp:
			slip["note"] = _("LWP {0} day(s) deducted").format(_number_text(lwp))
		elif prorated:
			slip["note"] = _("Pro-rated · {0} of {1} days").format(
				_number_text(flt(slip.get("payment_days"))),
				_number_text(flt(slip.get("total_working_days"))),
			)

	# Employees in the run who produced no slip still belong in the register,
	# otherwise the exception panel points at a row that is not there.
	slipped = {slip["employee"] for slip in slips}
	for row in exceptions:
		if row["kind"] == "no_structure" and row["employee"] not in slipped:
			slips.append(
				{
					"name": None,
					"employee": row["employee"],
					"employee_name": row["employee_name"],
					"salary_structure": None,
					"gross_pay": None,
					"total_deduction": None,
					"net_pay": None,
					"held": True,
					"changed": False,
					"note": row["detail"],
				}
			)

	gross = sum(flt(slip.get("gross_pay")) for slip in slips)
	deductions = sum(flt(slip.get("total_deduction")) for slip in slips)
	net = sum(flt(slip.get("net_pay")) for slip in slips)

	# The previous run, for the "vs last month" comparison.
	previous = frappe.get_all(
		"Payroll Entry",
		filters={"start_date": ["<", entry.start_date], "docstatus": ["<", 2]},
		fields=["name", "end_date"],
		order_by="start_date desc",
		limit_page_length=1,
	)
	previous_net = None
	if previous:
		previous_net = (
			frappe.db.get_value(
				"Salary Slip",
				{"payroll_entry": previous[0].name, "docstatus": ["<", 2]},
				"sum(net_pay)",
			)
			or 0
		)

	return {
		"runs": runs,
		"run": {
			"name": entry.name,
			"start_date": str(entry.start_date) if entry.start_date else None,
			"end_date": str(entry.end_date) if entry.end_date else None,
			"posting_date": str(entry.posting_date) if entry.posting_date else None,
			"status": entry.status,
			"docstatus": entry.docstatus,
			"currency": entry.currency,
			"employees": len(entry.employees or []),
			"slips_created": bool(entry.salary_slips_created),
			"slips_submitted": bool(entry.salary_slips_submitted),
			"gross": gross,
			"deductions": deductions,
			"net": net,
			"previous_net": flt(previous_net) if previous_net is not None else None,
			"slips_generated": len([s for s in slips if s.get("name")]),
			"held": len(held),
		},
		"register": slips,
		"exceptions": exceptions,
		"cost_split": _payroll_cost_split(slips),
		"statutory": _payroll_statutory(slips),
	}


@frappe.whitelist(methods=["POST"])
def create_payroll_run(
	start_date: str,
	end_date: str,
	payroll_frequency: str = "Monthly",
	company: str | None = None,
	department: str | None = None,
	branch: str | None = None,
	designation: str | None = None,
	include_notice_period: int | str = 1,
	employees: str | list[str] | None = None,
) -> dict:
	"""Creates a Payroll Entry and lets HRMS generate its draft Salary Slips.

	The employee list is first derived by Payroll Entry itself, so salary
	structure, company, currency and date eligibility stay aligned with HRMS.
	The client selection can only narrow that eligible set; it cannot inject an
	employee that HRMS would not include.
	"""
	user = _require_login()
	_require_hrms()
	_require_payroll_access(user)

	start = getdate(start_date)
	end = getdate(end_date)
	if end < start:
		frappe.throw(_("The payroll end date cannot be before its start date."))

	allowed_frequencies = {"Monthly", "Fortnightly", "Bimonthly", "Weekly", "Daily"}
	frequency = (payroll_frequency or "Monthly").title()
	if frequency not in allowed_frequencies:
		frappe.throw(_("{0} is not a supported payroll frequency.").format(frequency))

	if not company:
		company = frappe.defaults.get_user_default("Company")
	if not company:
		employee = _current_employee(user, required=False)
		if employee:
			company = frappe.db.get_value("Employee", employee, "company")
	if not company:
		import erpnext

		company = erpnext.get_default_company()
	if not company or not frappe.db.exists("Company", company):
		frappe.throw(_("Set a default Company before creating payroll."))

	existing = frappe.db.get_value(
		"Payroll Entry",
		{
			"company": company,
			"start_date": start,
			"end_date": end,
			"docstatus": ["<", 2],
		},
		"name",
	)
	if existing:
		frappe.throw(
			_("Payroll Entry {0} already exists for this company and period.").format(existing)
		)

	company_defaults = frappe.db.get_value(
		"Company",
		company,
		["default_currency", "default_payroll_payable_account", "cost_center"],
		as_dict=True,
	)
	if not company_defaults.default_currency:
		frappe.throw(_("Set the default currency for {0} first.").format(company))
	if not company_defaults.default_payroll_payable_account:
		frappe.throw(_("Set the default payroll payable account for {0} first.").format(company))
	if not company_defaults.cost_center:
		frappe.throw(_("Set the default cost center for {0} first.").format(company))

	requested_rows = frappe.parse_json(employees) if isinstance(employees, str) else employees
	requested_rows = requested_rows or []
	if not isinstance(requested_rows, list):
		frappe.throw(_("Employees must be supplied as a list."))
	requested = {str(employee) for employee in requested_rows if employee}

	entry = frappe.new_doc("Payroll Entry")
	entry.company = company
	entry.posting_date = end
	entry.payroll_frequency = frequency
	entry.start_date = start
	entry.end_date = end
	entry.branch = branch or None
	entry.department = department or None
	entry.designation = designation or None
	entry.cost_center = company_defaults.cost_center
	entry.currency = company_defaults.default_currency
	entry.exchange_rate = 1
	entry.payroll_payable_account = company_defaults.default_payroll_payable_account
	# HRMS raises its own "No employees found" with an HTML body listing the
	# criteria. Swallow it and fall through to the actionable message below,
	# which names the setup step that is actually missing.
	try:
		entry.fill_employee_details()
	except frappe.ValidationError:
		frappe.clear_last_message()

	eligible_rows = list(entry.employees or [])
	if requested:
		eligible_rows = [row for row in eligible_rows if row.employee in requested]
	if not cint(include_notice_period) and eligible_rows:
		relieving = set(
			frappe.get_all(
				"Employee",
				filters={
					"name": ["in", [row.employee for row in eligible_rows]],
					"relieving_date": ["between", [start, end]],
				},
				pluck="name",
			)
		)
		eligible_rows = [row for row in eligible_rows if row.employee not in relieving]

	if not eligible_rows:
		# Distinguish "nothing is set up yet" from "this period excludes
		# everyone", because the fix is completely different.
		assigned = frappe.db.count("Salary Structure Assignment", {"docstatus": 1})
		if not assigned:
			frappe.throw(
				_(
					"No employee has a submitted Salary Structure Assignment yet, so "
					"there is nothing to generate. Assign a salary structure to your "
					"employees first, then create the payroll run."
				)
			)
		frappe.throw(
			_(
				"No selected employees are eligible for this payroll period. "
				"Check their submitted Salary Structure Assignments and payroll payable account."
			)
		)

	entry.set("employees", [])
	for row in eligible_rows:
		entry.append("employees", {"employee": row.employee})
	entry.insert()

	# HRMS's slip generator commits or rolls back independently. Persisting the
	# entry first mirrors Desk's tested flow and ensures queued jobs can read it.
	frappe.db.commit()  # nosemgrep
	try:
		entry.submit()
	except Exception:
		frappe.db.rollback()
		# A validation error before slip creation should not strand an invisible
		# draft that blocks the next attempt for the same period.
		if frappe.db.exists("Payroll Entry", entry.name) and not frappe.db.exists(
			"Salary Slip", {"payroll_entry": entry.name}
		):
			frappe.delete_doc("Payroll Entry", entry.name, ignore_permissions=True, force=True)
			frappe.db.commit()  # nosemgrep
		raise

	entry.reload()
	slips_generated = frappe.db.count(
		"Salary Slip", {"payroll_entry": entry.name, "docstatus": ["<", 2]}
	)
	return {
		"name": entry.name,
		"status": entry.status,
		"employees": len(entry.employees or []),
		"slips_generated": slips_generated,
		"queued": entry.status == "Queued",
		"excluded": max(0, len(requested) - len(entry.employees or [])) if requested else 0,
	}


@frappe.whitelist(methods=["POST"])
def submit_payroll_run(name: str) -> dict:
	"""Submits every draft slip in the run, refusing while anything is held.

	Submission is delegated to HRMS's own method so its validations, journal
	entries and accounting all happen exactly as they do in Desk.
	"""
	user = _require_login()
	_require_hrms()
	_require_payroll_access(user)

	entry = frappe.get_doc("Payroll Entry", name)
	entry.check_permission("submit")

	slips = frappe.get_all(
		"Salary Slip",
		filters={"payroll_entry": name, "docstatus": ["<", 2]},
		fields=["name", "employee", "employee_name", "department", "net_pay"],
		limit_page_length=0,
	)
	blocking = _payroll_exceptions(entry, slips)
	if blocking:
		frappe.throw(
			_("{0} exception(s) are blocking this run. Clear them before submitting.").format(
				len(blocking)
			)
		)
	if not entry.salary_slips_created:
		frappe.throw(_("Salary slips have not been generated for this run yet."))

	entry.submit_salary_slips()
	entry.reload()
	return {
		"name": entry.name,
		"status": entry.status,
		"slips_submitted": bool(entry.salary_slips_submitted),
	}


@frappe.whitelist(methods=["POST"])
def assign_salary_structure(employee: str, salary_structure: str, base: float | str = 0) -> dict:
	"""Puts an employee on a structure so their slip can be generated.

	This clears the "no salary structure" exception without leaving the app.
	"""
	user = _require_login()
	_require_hrms()
	_require_payroll_access(user)

	employee_doc = frappe.get_doc("Employee", employee)
	assignment = frappe.new_doc("Salary Structure Assignment")
	assignment.employee = employee
	assignment.salary_structure = salary_structure
	assignment.company = employee_doc.company
	# Backdating to the joining date keeps the current run in scope for them.
	assignment.from_date = employee_doc.date_of_joining or nowdate()
	if base:
		assignment.base = flt(base)
	assignment.insert()
	assignment.submit()
	return {"name": assignment.name, "employee": employee}


@frappe.whitelist()
def payroll_readiness(company: str | None = None) -> dict:
	"""What still stands between this company and its first payroll run.

	The first-run screen used to hard-code these as satisfied, which told the
	user everything was ready right up until the run failed. Each check reports
	its real state plus the action that clears it.
	"""
	user = _require_login()
	_require_hrms()
	_require_payroll_access(user)

	if not company:
		company = frappe.defaults.get_user_default("Company")
	if not company:
		import erpnext

		company = erpnext.get_default_company()

	active = frappe.db.count("Employee", {"status": "Active"})
	assigned = len(
		set(
			frappe.get_all(
				"Salary Structure Assignment",
				filters={"docstatus": 1},
				pluck="employee",
				limit_page_length=0,
			)
		)
	)
	structures = frappe.db.count("Salary Structure", {"docstatus": 1, "is_active": "Yes"})
	components = frappe.db.count("Salary Component")
	payable = (
		frappe.db.get_value("Company", company, "default_payroll_payable_account")
		if company
		else None
	)

	checks = [
		{
			"id": "structures",
			"title": "Salary structure created",
			"body": (
				f"{structures} active structure{'' if structures == 1 else 's'} ready to assign."
				if structures
				else "Create and submit a salary structure before assigning anyone."
			),
			"done": bool(structures),
			"action": None if structures else "structure",
			"action_label": "Create structure",
		},
		{
			"id": "assignments",
			"title": "Salary structures assigned",
			"body": (
				f"{assigned} of {active} active employees have a submitted assignment."
				if assigned
				else f"None of the {active} active employees can be paid until they are assigned."
			),
			"done": bool(active) and assigned >= active,
			# Assigning is the one step the dashboard can complete in place.
			"action": None if (active and assigned >= active) else "assign",
			"action_label": "Assign structures",
		},
		{
			"id": "components",
			"title": "Salary components configured",
			"body": (
				f"{components} earning and deduction component{'' if components == 1 else 's'} configured."
				if components
				else "Earnings and deductions must exist before slips can calculate."
			),
			"done": bool(components),
			"action": None if components else "components",
			"action_label": "Configure",
		},
		{
			"id": "payable",
			"title": "Payment account set" if payable else "Payment account not set",
			"body": (
				f"Payable account: {payable}."
				if payable
				else "A payable account is needed before submission."
			),
			"done": bool(payable),
			"action": None if payable else "account",
			"action_label": "Set account",
		},
	]

	return {
		"company": company,
		"active_employees": active,
		"assigned_employees": assigned,
		"unassigned_employees": max(0, active - assigned),
		"checks": checks,
		"ready": all(check["done"] for check in checks),
		"ready_count": sum(1 for check in checks if check["done"]),
	}


@frappe.whitelist()
def unassigned_employees() -> list[dict]:
	"""Active employees with no submitted salary structure assignment."""
	user = _require_login()
	_require_hrms()
	_require_payroll_access(user)

	assigned = set(
		frappe.get_all(
			"Salary Structure Assignment",
			filters={"docstatus": 1},
			pluck="employee",
			limit_page_length=0,
		)
	)
	rows = frappe.get_all(
		"Employee",
		filters={"status": "Active"},
		fields=["name", "employee_name", "department", "designation", "company", "date_of_joining"],
		order_by="employee_name asc",
		limit_page_length=0,
	)
	return [row for row in rows if row.name not in assigned]


@frappe.whitelist()
def salary_components() -> dict:
	"""Earning and deduction components, for the structure builder's pickers."""
	_require_hrms()
	_require_payroll_access()
	rows = frappe.get_all(
		"Salary Component",
		fields=["name", "type", "salary_component_abbr"],
		order_by="type asc, name asc",
		limit_page_length=0,
	)
	return {
		"earnings": [r for r in rows if r.type == "Earning"],
		"deductions": [r for r in rows if r.type == "Deduction"],
	}


@frappe.whitelist(methods=["POST"])
def create_salary_component(component_name: str, component_type: str = "Earning") -> dict:
	"""Adds a component so the structure builder never dead-ends in Desk."""
	user = _require_login()
	_require_hrms()
	_require_payroll_access(user)

	name = (component_name or "").strip()
	if not name:
		frappe.throw(_("Give the salary component a name."))
	if component_type not in ("Earning", "Deduction"):
		frappe.throw(_("A salary component is either an Earning or a Deduction."))
	if frappe.db.exists("Salary Component", name):
		frappe.throw(_("A salary component called {0} already exists.").format(name))

	doc = frappe.new_doc("Salary Component")
	doc.salary_component = name
	doc.type = component_type
	doc.insert()
	return {"name": doc.name, "type": doc.type}


@frappe.whitelist()
def draft_salary_structures() -> list[dict]:
	"""Structures that exist but are not submitted, so the UI can offer to
	submit one instead of making the user build a duplicate."""
	_require_hrms()
	_require_payroll_access()
	return frappe.get_all(
		"Salary Structure",
		filters={"docstatus": 0},
		fields=["name", "company", "currency", "payroll_frequency"],
		order_by="modified desc",
		limit_page_length=20,
	)


@frappe.whitelist(methods=["POST"])
def submit_salary_structure(name: str) -> dict:
	"""Submits an existing draft structure so it can be assigned."""
	user = _require_login()
	_require_hrms()
	_require_payroll_access(user)

	doc = frappe.get_doc("Salary Structure", name)
	if doc.docstatus == 1:
		return {"name": doc.name, "already_submitted": True}
	if doc.docstatus == 2:
		frappe.throw(_("{0} is cancelled and cannot be submitted.").format(name))
	doc.submit()
	return {"name": doc.name, "already_submitted": False}


@frappe.whitelist(methods=["POST"])
def create_salary_structure(
	structure_name: str,
	earnings: str | list | None = None,
	deductions: str | list | None = None,
	company: str | None = None,
	currency: str | None = None,
	payroll_frequency: str = "Monthly",
	submit: int | str = 1,
) -> dict:
	"""Builds a Salary Structure from the dashboard and submits it.

	Rows arrive as [{"salary_component": str, "amount": number}]. Submitting is
	what makes the structure assignable, so it is the default.
	"""
	user = _require_login()
	_require_hrms()
	_require_payroll_access(user)

	name = (structure_name or "").strip()
	if not name:
		frappe.throw(_("Give the salary structure a name."))
	if frappe.db.exists("Salary Structure", name):
		frappe.throw(_("A salary structure called {0} already exists.").format(name))

	def _rows(value):
		parsed = frappe.parse_json(value) if isinstance(value, str) else value
		return parsed or []

	earning_rows = _rows(earnings)
	deduction_rows = _rows(deductions)
	if not earning_rows:
		frappe.throw(_("Add at least one earning component."))

	if not company:
		company = frappe.defaults.get_user_default("Company")
	if not company:
		import erpnext

		company = erpnext.get_default_company()
	if not company:
		frappe.throw(_("Set a default Company before creating a salary structure."))

	if not currency:
		currency = frappe.db.get_value("Company", company, "default_currency")

	doc = frappe.new_doc("Salary Structure")
	doc.name = name
	doc.__newname = name
	doc.company = company
	doc.currency = currency
	doc.payroll_frequency = payroll_frequency or "Monthly"
	doc.is_active = "Yes"

	for field, rows in (("earnings", earning_rows), ("deductions", deduction_rows)):
		for row in rows:
			component = (row or {}).get("salary_component")
			if not component:
				continue
			if not frappe.db.exists("Salary Component", component):
				frappe.throw(_("Salary component {0} does not exist.").format(component))
			doc.append(
				field,
				{"salary_component": component, "amount": flt((row or {}).get("amount") or 0)},
			)

	doc.insert()
	if cint(submit):
		doc.submit()
	return {"name": doc.name, "docstatus": doc.docstatus, "company": company, "currency": currency}


@frappe.whitelist()
def salary_structures() -> list[dict]:
	"""The structures an employee can be assigned to."""
	_require_hrms()
	_require_payroll_access()
	return frappe.get_all(
		"Salary Structure",
		filters={"is_active": "Yes", "docstatus": 1},
		fields=["name", "company", "currency"],
		order_by="name asc",
		limit_page_length=50,
	)


#: How each request type is read into the one approvals queue. Keeping the
#: differences in data rather than in branches means adding a type later is a
#: table entry, not another arm of an if/else.
APPROVAL_SOURCES: dict[str, dict] = {
	"Leave Application": {
		"kind": "leave",
		"approver_field": "leave_approver",
		"filters": {"status": "Open", "docstatus": 0},
		"fields": (
			"name",
			"employee",
			"employee_name",
			"department",
			"leave_type",
			"from_date",
			"to_date",
			"total_leave_days",
			"description",
			"half_day",
			"leave_balance",
			"creation",
		),
	},
	"Expense Claim": {
		"kind": "expense",
		"approver_field": "expense_approver",
		"filters": {"approval_status": "Draft", "docstatus": 0},
		"fields": (
			"name",
			"employee",
			"employee_name",
			"department",
			"posting_date",
			"total_claimed_amount",
			"total_sanctioned_amount",
			"remark",
			"creation",
		),
	},
	"Attendance Request": {
		"kind": "attendance",
		"approver_field": None,
		"filters": {"docstatus": 0},
		"fields": (
			"name",
			"employee",
			"employee_name",
			"department",
			"from_date",
			"to_date",
			"reason",
			"explanation",
			"half_day",
			"creation",
		),
	},
	"Compensatory Leave Request": {
		"kind": "comp-off",
		"approver_field": None,
		"filters": {"docstatus": 0},
		"fields": (
			"name",
			"employee",
			"employee_name",
			"department",
			"leave_type",
			"work_from_date",
			"work_end_date",
			"reason",
			"creation",
		),
	},
	# Self-service profile corrections. No approver field: like attendance and
	# comp-off, the reporting line decides, and submitting is the approval.
	"Employee Profile Change Request": {
		"kind": "profile",
		"approver_field": None,
		"filters": {"docstatus": 0, "status": "Pending"},
		"fields": (
			"name",
			"employee",
			"employee_name",
			"department",
			"changes",
			"reason",
			"requested_on",
			"creation",
		),
	},
}


def _approval_row(doctype: str, source: dict, row) -> dict:
	"""Normalises one pending document into the shape the queue renders.

	Every type answers the same three questions — who, what, and over which
	dates — so the inbox can sort and filter them together.
	"""
	kind = source["kind"]
	if kind == "leave":
		title = row.leave_type or _("Leave")
		days = flt(row.total_leave_days)
		subtitle = _("{0} days").format(_number_text(days)) if days else None
		from_date, to_date = row.from_date, row.to_date
		reason = row.description
	elif kind == "expense":
		title = _("Expense claim")
		subtitle = None
		from_date = to_date = row.posting_date
		reason = row.remark
	elif kind == "attendance":
		title = _("Attendance regularisation")
		subtitle = row.reason
		from_date, to_date = row.from_date, row.to_date
		reason = row.explanation
	elif kind == "profile":
		changed = _parse_changes(row.get("changes"))
		title = _("Profile change")
		# Name the fields in the subtitle: an approver decides this on what is
		# being changed, and there are no dates to summarise it by.
		subtitle = ", ".join(item["label"] for item in changed) or None
		from_date = to_date = None
		reason = row.reason
	else:
		title = _("Comp-off request")
		subtitle = row.leave_type
		from_date, to_date = row.work_from_date, row.work_end_date
		reason = row.reason

	return {
		"id": row.name,
		"doctype": doctype,
		"kind": kind,
		"employee": row.employee,
		"employee_name": row.employee_name,
		"department": row.department,
		"title": title,
		"subtitle": subtitle,
		"from_date": str(from_date) if from_date else None,
		"to_date": str(to_date) if to_date else None,
		"days": flt(row.get("total_leave_days")) or None,
		"amount": flt(row.get("total_claimed_amount")) or None,
		"half_day": bool(row.get("half_day")),
		"reason": reason,
		"leave_balance": flt(row.leave_balance) if row.get("leave_balance") is not None else None,
		"changes": _parse_changes(row.get("changes")) if kind == "profile" else None,
		"created_at": str(row.creation) if row.creation else None,
	}


def _number_text(value: float) -> str:
	return str(int(value)) if float(value).is_integer() else f"{value:.1f}"


@frappe.whitelist()
def approval_queue() -> dict:
	"""Everything waiting on this approver, across every request type.

	HR roles see the whole queue; anyone else sees only what names them as the
	approver, and types whose approver lives on the employee record are matched
	through that record rather than a field on the request.
	"""
	user = _require_login()
	_require_hrms()
	roles = set(frappe.get_roles(user))
	is_hr = bool(roles.intersection(HR_ROLES))
	if not is_hr and not roles.intersection(MANAGER_ROLES):
		frappe.throw(_("You do not approve requests on this site."), frappe.PermissionError)

	# Types without an approver field on the document fall back to the employees
	# who name this user as their approver.
	reports = None
	if not is_hr:
		# Same set _decide_one authorises against, so what the inbox lists is
		# exactly what this user is allowed to decide.
		reports = sorted(_approver_reports(user)) or ["__none__"]

	rows = []
	for doctype, source in APPROVAL_SOURCES.items():
		if not frappe.db.table_exists(doctype):
			continue
		filters = dict(source["filters"])
		if not is_hr:
			if source["approver_field"]:
				filters[source["approver_field"]] = user
			else:
				filters["employee"] = ["in", reports]
		fields = _existing_fields(doctype, source["fields"])
		try:
			found = frappe.get_all(
				doctype,
				filters=filters,
				fields=fields,
				order_by="creation desc",
				limit_page_length=50,
			)
		except frappe.PermissionError:
			continue
		rows.extend(_approval_row(doctype, source, row) for row in found)

	# Oldest first would bury today's work; the inbox groups by age instead.
	rows.sort(key=lambda row: row["created_at"] or "", reverse=True)
	counts = {"all": len(rows)}
	for row in rows:
		counts[row["kind"]] = counts.get(row["kind"], 0) + 1
	return {"requests": rows, "counts": counts}


def _coverage_check(employee: str, department: str | None, from_date, to_date) -> list[dict]:
	"""Whether the requester's team can absorb these dates.

	Counts teammates already on approved leave over the same span. A team that
	would drop below 70% present is flagged, because that is the point an
	approver usually wants to think twice.
	"""
	if not department or not from_date or not to_date:
		return []

	team = frappe.get_all(
		"Employee",
		filters={"department": department, "status": "Active"},
		pluck="name",
	)
	if len(team) < 2:
		return []

	away = frappe.get_all(
		"Leave Application",
		filters={
			"employee": ["in", team],
			"status": "Approved",
			"docstatus": 1,
			"from_date": ["<=", to_date],
			"to_date": [">=", from_date],
		},
		pluck="employee",
	)
	# The requester is about to join them, so count them in.
	away_set = set(away) | {employee}
	present = len(team) - len(away_set)
	ratio = present / len(team) if team else 1

	checks = [
		{
			"ok": ratio >= 0.7,
			"message": _("{0} of {1} in {2} stay available on these dates").format(
				present, len(team), department
			),
		}
	]
	others = away_set - {employee}
	if others:
		names = frappe.get_all(
			"Employee", filters={"name": ["in", list(others)]}, pluck="employee_name"
		)
		checks.append(
			{
				"ok": False,
				"message": _("Already away: {0}").format(", ".join(sorted(names)[:4])),
			}
		)
	return checks


def _requester_history(employee: str) -> dict:
	"""A short record of how this person's requests have gone before."""
	leave = frappe.get_all(
		"Leave Application",
		filters={"employee": employee, "docstatus": 1},
		fields=["status", "total_leave_days"],
		limit_page_length=200,
	)
	taken = sum(flt(row.total_leave_days) for row in leave if row.status == "Approved")
	rejected = sum(1 for row in leave if row.status == "Rejected")
	return {"days_taken": taken, "rejected": rejected, "requests": len(leave)}


@frappe.whitelist()
def approval_detail(doctype: str, name: str) -> dict:
	"""The open request in full: its own fields, coverage, history, attachments."""
	user = _require_login()
	_require_hrms()
	if doctype not in APPROVAL_SOURCES:
		frappe.throw(_("{0} is not an approvable request type.").format(doctype))

	doc = frappe.get_doc(doctype, name)
	doc.check_permission("read")
	source = APPROVAL_SOURCES[doctype]
	row = frappe._dict({field: doc.get(field) for field in source["fields"] if doc.get(field) is not None})
	row.name = doc.name
	row.creation = doc.creation
	detail = _approval_row(doctype, source, row)

	from_date = detail["from_date"]
	to_date = detail["to_date"]
	detail["coverage"] = _coverage_check(doc.employee, doc.get("department"), from_date, to_date)
	detail["history"] = _requester_history(doc.employee)
	detail["designation"] = frappe.db.get_value("Employee", doc.employee, "designation")
	detail["attachments"] = frappe.get_all(
		"File",
		filters={"attached_to_doctype": doctype, "attached_to_name": name},
		fields=["name as id", "file_name as title", "file_url as url", "file_size"],
		order_by="creation desc",
		limit_page_length=10,
	)
	if doctype == "Expense Claim":
		detail["expenses"] = frappe.get_all(
			"Expense Claim Detail",
			filters={"parent": name},
			fields=["expense_date", "expense_type", "description", "amount"],
			order_by="idx asc",
			limit_page_length=0,
		)
	if doctype == "Employee Profile Change Request":
		# Pair each proposed value with what the record holds now — an approver
		# is deciding on the difference, not on the new value alone.
		current = frappe.db.get_value("Employee", doc.employee, "*", as_dict=True) or {}
		for item in detail.get("changes") or []:
			item["current"] = current.get(item["fieldname"])
	return detail


def _approver_reports(user: str) -> set[str]:
	"""Employees who name this user as their leave approver.

	The fallback authority for request types that carry no approver field of
	their own — the same set ``approval_queue`` filters those types by, so the
	inbox and the decision agree on who may act.
	"""
	return set(
		frappe.get_all(
			"Employee",
			filters={"leave_approver": user, "status": "Active"},
			pluck="name",
		)
	)


def _decide_one(doctype: str, name: str, approve: bool, comment: str | None, user: str, roles: set) -> dict:
	"""Applies one decision, letting each doctype's own workflow do the work."""
	doc = frappe.get_doc(doctype, name)
	is_hr = bool(roles.intersection(HR_ROLES))
	approver_field = APPROVAL_SOURCES[doctype]["approver_field"]
	approver = doc.get(approver_field) if approver_field else None

	if not is_hr:
		if approver_field:
			if approver and approver != user:
				frappe.throw(
					_("You are not the approver for this request."), frappe.PermissionError
				)
		else:
			# Attendance and comp-off requests carry no approver field. Without
			# this branch the guard above was skipped entirely whenever
			# approver_field was None, so any holder of a MANAGER_ROLES role could
			# decide any employee's request company-wide. Fall back to the
			# reporting relationship, exactly as approval_queue does when it
			# filters these types by `employee in reports`.
			if doc.get("employee") not in _approver_reports(user):
				frappe.throw(
					_("You are not the approver for this request."), frappe.PermissionError
				)

	if doc.docstatus != 0:
		frappe.throw(_("{0} has already been decided.").format(name))

	doc.check_permission("submit")
	if doctype == "Leave Application":
		doc.status = "Approved" if approve else "Rejected"
		doc.save()
		doc.submit()
	elif doctype == "Expense Claim":
		doc.approval_status = "Approved" if approve else "Rejected"
		doc.save()
		if approve:
			doc.submit()
	elif doctype == "Employee Profile Change Request":
		# A rejection here must leave a trace: the employee needs to see that it
		# was refused and why, so the draft is marked rather than deleted.
		if approve:
			doc.submit()
		else:
			doc.status = "Rejected"
			doc.decided_by = user
			doc.decided_on = now_datetime()
			doc.decision_comment = comment
			doc.flags.ignore_permissions = True
			doc.save()
			_publish_to_employee(
				doc.employee,
				"request_decided",
				{"doctype": doctype, "name": doc.name, "status": "Rejected"},
			)
			_publish("approval_queue_changed", {"doctype": doctype, "name": doc.name})
			return {"name": doc.name, "doctype": doctype, "status": "Rejected"}
	else:
		# Attendance and comp-off requests carry no approval field: submitting is
		# the approval, and a rejection is a cancellation of the draft.
		if approve:
			doc.submit()
		else:
			doc.delete()
			return {"name": name, "doctype": doctype, "status": "Rejected"}

	if comment:
		doc.add_comment("Comment", text=comment)
	status = doc.get("status") or doc.get("approval_status") or "Submitted"
	_publish_to_employee(
		doc.get("employee"), "request_decided", {"doctype": doctype, "name": doc.name, "status": status}
	)
	_publish("approval_queue_changed", {"doctype": doctype, "name": doc.name})
	return {
		"name": doc.name,
		"doctype": doctype,
		"status": status,
	}


@frappe.whitelist(methods=["POST"])
def decide_request(doctype: str, name: str, decision: str, comment: str | None = None) -> dict:
	"""Approves or rejects one request of any supported type."""
	user = _require_login()
	_require_hrms()
	if doctype not in APPROVAL_SOURCES:
		frappe.throw(_("{0} is not an approvable request type.").format(doctype))
	decision = (decision or "").title()
	if decision not in {"Approved", "Rejected"}:
		frappe.throw(_("Decision must be Approved or Rejected."))
	roles = set(frappe.get_roles(user))
	return _decide_one(doctype, name, decision == "Approved", comment, user, roles)


@frappe.whitelist(methods=["POST"])
def decide_requests(requests: str, decision: str, comment: str | None = None) -> dict:
	"""Decides several requests at once, reporting each outcome separately.

	One failure does not sink the batch: each request is committed on its own so
	an approver keeps the work that succeeded and sees exactly what did not.
	"""
	user = _require_login()
	_require_hrms()
	decision = (decision or "").title()
	if decision not in {"Approved", "Rejected"}:
		frappe.throw(_("Decision must be Approved or Rejected."))

	rows = frappe.parse_json(requests) or []
	roles = set(frappe.get_roles(user))
	done, failed = [], []
	for row in rows:
		doctype = row.get("doctype")
		name = row.get("name")
		if doctype not in APPROVAL_SOURCES or not name:
			failed.append({"name": name, "error": _("Unsupported request.")})
			continue
		savepoint = f"techsarena_{len(done) + len(failed)}"
		frappe.db.savepoint(savepoint)
		try:
			done.append(_decide_one(doctype, name, decision == "Approved", comment, user, roles))
		except Exception as error:
			frappe.db.rollback(save_point=savepoint)
			failed.append({"name": name, "error": str(error)})
	return {"decided": done, "failed": failed}


@frappe.whitelist()
def expense_claims() -> dict:
	"""The signed-in employee's own expense claims, newest first.

	Claim lines come from the child table so the app can show what each claim was
	actually made up of, and the claim types are returned so a new claim can be
	composed against the site's own list rather than free text.
	"""
	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)

	claims = frappe.get_all(
		"Expense Claim",
		filters={"employee": employee, "docstatus": ["<", 2]},
		fields=[
			"name",
			"posting_date",
			"approval_status",
			"status",
			"total_claimed_amount",
			"total_sanctioned_amount",
			"total_amount_reimbursed",
			"is_paid",
			"remark",
			"company",
			"docstatus",
			"expense_approver",
			"creation",
			"modified",
			"total_advance_amount",
		],
		order_by="posting_date desc, creation desc",
		limit_page_length=50,
	)

	# One query for every line, then grouped, rather than a query per claim.
	lines = {}
	if claims:
		for row in frappe.get_all(
			"Expense Claim Detail",
			filters={"parent": ["in", [claim.name for claim in claims]]},
			fields=[
				"parent",
				"expense_date",
				"expense_type",
				"description",
				"amount",
				"sanctioned_amount",
			],
			order_by="idx asc",
			limit_page_length=0,
		):
			lines.setdefault(row.parent, []).append(row)

	# Receipts are ordinary Frappe File attachments; fetched in one query and
	# grouped, so a claim can list what backs it up without a query per row.
	receipts: dict[str, list[dict]] = {}
	if claims:
		for row in frappe.get_all(
			"File",
			filters={
				"attached_to_doctype": "Expense Claim",
				"attached_to_name": ["in", [claim.name for claim in claims]],
			},
			fields=["attached_to_name", "file_name", "file_url", "file_size", "is_private"],
			order_by="creation asc",
			limit_page_length=0,
		):
			receipts.setdefault(row.attached_to_name, []).append(
				{
					"file_name": row.file_name,
					"file_url": row.file_url,
					"file_size": cint(row.file_size),
					"is_private": cint(row.is_private),
				}
			)

	approver_names = {claim.expense_approver for claim in claims if claim.get("expense_approver")}
	approvers = {}
	if approver_names:
		approvers = {
			row.name: row.full_name
			for row in frappe.get_all(
				"User",
				filters={"name": ["in", sorted(approver_names)]},
				fields=["name", "full_name"],
				limit_page_length=0,
			)
		}

	for claim in claims:
		claim["expenses"] = lines.get(claim.name, [])
		claim["receipts"] = receipts.get(claim.name, [])
		claim["expense_approver_name"] = approvers.get(claim.get("expense_approver"))

	return {
		"claims": claims,
		"claim_types": frappe.get_all("Expense Claim Type", pluck="name", order_by="name asc"),
		"currency": frappe.db.get_value("Company", frappe.defaults.get_user_default("Company"), "default_currency")
		or frappe.db.get_single_value("Global Defaults", "default_currency"),
	}


@frappe.whitelist(methods=["POST"])
def withdraw_expense_claim(name: str) -> dict:
	"""Cancels one of the signed-in employee's own claims.

	A draft is deleted outright; a submitted claim is cancelled, which is what
	HRMS allows an employee to undo.  Anything already approved or reimbursed is
	refused -- that is an accounting reversal, not a withdrawal.
	"""
	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)

	claim = frappe.get_doc("Expense Claim", name)
	if claim.employee != employee:
		frappe.throw(_("You can only withdraw your own claims."), frappe.PermissionError)
	if claim.approval_status == "Approved" or flt(claim.total_amount_reimbursed):
		frappe.throw(_("This claim has already been approved and cannot be withdrawn."))
	if claim.docstatus == 2:
		frappe.throw(_("This claim has already been withdrawn."))

	if claim.docstatus == 0:
		claim.delete()
		return {"name": name, "deleted": True}
	claim.cancel()
	return {"name": name, "deleted": False}


@frappe.whitelist(methods=["POST"])
def submit_expense_claim(expenses: str, remark: str | None = None) -> dict:
	"""Files a claim for the signed-in employee.

	[expenses] is a JSON list of `{expense_date, expense_type, description,
	amount}`.  The employee is taken from the session rather than the client, and
	HRMS validates the rest on insert.
	"""
	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)

	rows = frappe.parse_json(expenses) or []
	if not rows:
		frappe.throw(_("Add at least one expense line before submitting."))

	employee_doc = frappe.get_doc("Employee", employee)
	claim = frappe.new_doc("Expense Claim")
	claim.employee = employee
	claim.company = employee_doc.company
	claim.posting_date = nowdate()
	claim.remark = remark
	if employee_doc.get("expense_approver"):
		claim.expense_approver = employee_doc.expense_approver
	for row in rows:
		claim.append(
			"expenses",
			{
				"expense_date": row.get("expense_date") or nowdate(),
				"expense_type": row.get("expense_type"),
				"description": row.get("description"),
				"amount": flt(row.get("amount")),
				"sanctioned_amount": flt(row.get("amount")),
			},
		)
	claim.insert()
	_publish("approval_queue_changed", {"doctype": "Expense Claim", "name": claim.name})
	return {"name": claim.name, "total_claimed_amount": claim.total_claimed_amount}


@frappe.whitelist()
def goals_and_appraisal() -> dict:
	"""The employee's goals and their appraisals, read-only.

	Both doctypes are optional in a stock install, so a site without them simply
	returns empty lists instead of erroring the screen out.
	"""
	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)

	goals = []
	if frappe.db.table_exists("Goal"):
		goals = frappe.get_all(
			"Goal",
			filters={"employee": employee},
			fields=[
				"name",
				"goal_name",
				"status",
				"progress",
				"start_date",
				"end_date",
				"kra",
				"appraisal_cycle",
				"is_group",
			],
			order_by="end_date asc",
			limit_page_length=50,
		)

	appraisals = []
	if frappe.db.table_exists("Appraisal"):
		appraisals = frappe.get_all(
			"Appraisal",
			filters={"employee": employee, "docstatus": ["<", 2]},
			fields=[
				"name",
				"appraisal_cycle",
				"start_date",
				"end_date",
				"total_score",
				"self_score",
				"avg_feedback_score",
				"goal_score_percentage",
				"final_score",
				"docstatus",
			],
			order_by="end_date desc",
			limit_page_length=10,
		)

	return {"goals": goals, "appraisals": appraisals}


@frappe.whitelist()
def announcements() -> dict:
	"""Published announcements aimed at this employee.

	An announcement with no company or department is company-wide; one that names
	either is only returned to employees who match it.
	"""
	user = _require_login()
	employee = _current_employee(user, required=False)
	if not frappe.db.table_exists("HR Announcement"):
		return {"announcements": []}

	filters = [
		["is_published", "=", 1],
		["published_on", "<=", nowdate()],
	]
	rows = frappe.get_all(
		"HR Announcement",
		filters=filters,
		or_filters=[["expires_on", ">=", nowdate()], ["expires_on", "is", "not set"]],
		fields=[
			"name",
			"title",
			"category",
			"body",
			"published_on",
			"expires_on",
			"company",
			"department",
			"attachment",
		],
		order_by="published_on desc",
		limit_page_length=50,
	)

	if employee:
		profile = frappe.db.get_value("Employee", employee, ["company", "department"], as_dict=True)
		rows = [
			row
			for row in rows
			if (not row.company or row.company == profile.company)
			and (not row.department or row.department == profile.department)
		]
	return {"announcements": rows}


@frappe.whitelist(methods=["POST"])
def mark_notification_read(name: str) -> dict:
	user = _require_login()
	doc = frappe.get_doc("Notification Log", name)
	if doc.for_user != user:
		frappe.throw(_("You cannot update this notification."), frappe.PermissionError)
	doc.db_set("read", 1)
	return {"name": name, "read": True}


#: Applicant statuses that count as "still in the process" for a requisition.
#: Anything outside this set has either been rejected or already accepted, so
#: it no longer represents work left to do on the opening.
IN_PROCESS_APPLICANT_STATUSES = ("Open", "Replied", "Hold")


def _job_opening_pipeline(openings: list[str]) -> dict[str, dict]:
	"""Applicant counts per opening, split by where each candidate has got to.

	Returned as a mapping keyed by opening name so the caller can attach the
	counts without a query per row.  Job Applicant is optional in a stock
	install, so a site without it gets zeroed counts rather than an error.
	"""
	empty = {
		"applicants": 0,
		"in_process": 0,
		"offers": 0,
		"stages": {},
	}
	if not openings or not frappe.db.table_exists("Job Applicant"):
		return {opening: dict(empty, stages={}) for opening in openings}

	rows = frappe.get_all(
		"Job Applicant",
		filters={"job_title": ["in", openings]},
		fields=["job_title", "status", "count(name) as total"],
		group_by="job_title, status",
		limit_page_length=0,
	)

	pipeline: dict[str, dict] = {opening: dict(empty, stages={}) for opening in openings}
	for row in rows:
		bucket = pipeline.setdefault(row.job_title, dict(empty, stages={}))
		total = cint(row.total)
		status = row.status or "Open"
		bucket["applicants"] += total
		bucket["stages"][status] = bucket["stages"].get(status, 0) + total
		if status in IN_PROCESS_APPLICANT_STATUSES:
			bucket["in_process"] += total
		if status == "Accepted":
			bucket["offers"] += total
	return pipeline


@frappe.whitelist()
def job_openings() -> dict:
	"""Every requisition the site is hiring against, with its pipeline.

	Recruitment is an optional HRMS module: a site without ``Job Opening``
	returns an empty list so the Hiring screen degrades to its empty state
	rather than erroring out.

	Ageing is measured from the posting date, which is what "how long has this
	been open" means to a recruiter.  It is reported as a day count and left to
	the client to phrase, so no threshold is baked into the API.
	"""
	_require_hr_access()
	_require_hrms()
	if not frappe.db.table_exists("Job Opening"):
		return {"openings": [], "currency": frappe.defaults.get_global_default("currency")}

	fields = [
		"name",
		"job_title",
		"designation",
		"status",
		"company",
		"department",
		"location",
		"posted_on",
		"closes_on",
		"creation",
	]
	# These vary by HRMS version, so each is only requested where it exists.
	optional = {
		"vacancies": "vacancies",
		"employment_type": "employment_type",
		"currency": "currency",
		"lower_range": "lower_range",
		"upper_range": "upper_range",
		"job_requisition": "job_requisition",
	}
	meta = frappe.get_meta("Job Opening")
	fields += [column for column in optional.values() if meta.has_field(column)]

	rows = frappe.get_all(
		"Job Opening",
		fields=fields,
		order_by="posted_on desc, creation desc",
		limit_page_length=100,
	)
	pipeline = _job_opening_pipeline([row.name for row in rows])

	#: The hiring manager lives on Job Requisition rather than the opening, so it
	#: is only resolvable on sites that use requisitions.
	requisitions: dict[str, dict] = {}
	requisition_names = [row.get("job_requisition") for row in rows if row.get("job_requisition")]
	if requisition_names and frappe.db.table_exists("Job Requisition"):
		for requisition in frappe.get_all(
			"Job Requisition",
			filters={"name": ["in", requisition_names]},
			fields=["name", "requested_by_name", "status", "expected_by"],
			limit_page_length=0,
		):
			requisitions[requisition.name] = requisition

	today = getdate(nowdate())
	openings = []
	for row in rows:
		opened_on = getdate(row.posted_on) if row.posted_on else getdate(row.creation)
		requisition = requisitions.get(row.get("job_requisition")) or {}
		counts = pipeline.get(row.name, {})
		openings.append(
			{
				"name": row.name,
				"title": row.job_title or row.designation or row.name,
				"designation": row.designation,
				"status": row.status,
				"company": row.company,
				"department": row.department,
				"location": row.location,
				"employment_type": row.get("employment_type"),
				"posted_on": row.posted_on,
				"closes_on": row.closes_on,
				"age_days": date_diff(today, opened_on) if opened_on else None,
				"posts": cint(row.get("vacancies")) or 1,
				"applicants": counts.get("applicants", 0),
				"in_process": counts.get("in_process", 0),
				"offers": counts.get("offers", 0),
				"stages": counts.get("stages", {}),
				"hiring_manager": requisition.get("requested_by_name"),
				"requisition": row.get("job_requisition"),
				"requisition_status": requisition.get("status"),
				"expected_by": requisition.get("expected_by"),
				"currency": row.get("currency"),
				"salary_from": flt(row.get("lower_range")) or None,
				"salary_to": flt(row.get("upper_range")) or None,
			}
		)

	return {
		"openings": openings,
		"currency": frappe.defaults.get_global_default("currency"),
	}


@frappe.whitelist()
def job_opening_detail(name: str) -> dict:
	"""One requisition with the candidates currently sitting in its pipeline.

	The applicant list is capped: the screen shows who is in flight, not the
	whole application history, and an opening can carry hundreds of rows.
	"""
	_require_hr_access()
	_require_hrms()
	if not frappe.db.table_exists("Job Opening"):
		frappe.throw(_("Recruitment is not set up on this site."), frappe.DoesNotExistError)

	doc = frappe.get_doc("Job Opening", name)
	applicants = []
	if frappe.db.table_exists("Job Applicant"):
		applicants = frappe.get_all(
			"Job Applicant",
			filters={"job_title": name},
			fields=[
				"name",
				"applicant_name",
				"status",
				"email_id",
				"phone_number",
				"source",
				"creation",
			],
			order_by="creation desc",
			limit_page_length=60,
		)

	counts = _job_opening_pipeline([name]).get(name, {})
	opened_on = getdate(doc.posted_on) if doc.posted_on else getdate(doc.creation)
	return {
		"opening": {
			"name": doc.name,
			"title": doc.job_title or doc.designation or doc.name,
			"designation": doc.designation,
			"status": doc.status,
			"company": doc.company,
			"department": doc.department,
			"location": doc.location,
			"description": doc.description,
			"posted_on": doc.posted_on,
			"closes_on": doc.closes_on,
			"age_days": date_diff(getdate(nowdate()), opened_on) if opened_on else None,
			"posts": cint(doc.get("vacancies")) or 1,
			"applicants": counts.get("applicants", 0),
			"in_process": counts.get("in_process", 0),
			"offers": counts.get("offers", 0),
			"stages": counts.get("stages", {}),
			"currency": doc.get("currency"),
			"salary_from": flt(doc.get("lower_range")) or None,
			"salary_to": flt(doc.get("upper_range")) or None,
		},
		"applicants": applicants,
	}


@frappe.whitelist()
def employee_onboarding() -> dict:
	"""Active joiners and the real HRMS tasks attached to their onboarding."""
	_require_hr_access()
	_require_hrms()
	if not frappe.db.table_exists("Employee Onboarding"):
		return {"onboardings": []}

	rows = frappe.get_all(
		"Employee Onboarding",
		filters={"docstatus": ["!=", 2]},
		fields=[
			"name",
			"job_applicant",
			"job_offer",
			"employee",
			"employee_name",
			"date_of_joining",
			"boarding_begins_on",
			"boarding_status",
			"employee_onboarding_template",
			"company",
			"department",
			"designation",
			"project",
			"docstatus",
		],
		order_by="date_of_joining asc, creation asc",
		limit_page_length=100,
	)
	if not rows:
		return {"onboardings": []}

	names = [row.name for row in rows]
	activities = frappe.get_all(
		"Employee Boarding Activity",
		filters={"parent": ["in", names], "parenttype": "Employee Onboarding"},
		fields=[
			"name",
			"parent",
			"activity_name",
			"user",
			"role",
			"task",
			"required_for_employee_creation",
			"description",
			"idx",
		],
		order_by="parent asc, idx asc",
		limit_page_length=0,
	)
	task_names = [activity.task for activity in activities if activity.task]
	tasks = {}
	if task_names:
		tasks = {
			task.name: task
			for task in frappe.get_all(
				"Task",
				filters={"name": ["in", task_names]},
				fields=["name", "status", "exp_start_date", "exp_end_date"],
				limit_page_length=0,
			)
		}
	users = {activity.user for activity in activities if activity.user}
	user_names = {}
	if users:
		user_names = {
			user.name: user.full_name or user.name
			for user in frappe.get_all(
				"User",
				filters={"name": ["in", list(users)]},
				fields=["name", "full_name"],
				limit_page_length=0,
			)
		}

	today = getdate(nowdate())
	by_parent = {name: [] for name in names}
	for activity in activities:
		task = tasks.get(activity.task) if activity.task else None
		status = task.status if task else "Pending"
		due_on = task.exp_end_date if task else None
		completed = status in {"Completed", "Cancelled"}
		by_parent.setdefault(activity.parent, []).append(
			{
				"name": activity.name,
				"activity_name": activity.activity_name,
				"user": activity.user,
				"owner_name": user_names.get(activity.user),
				"role": activity.role,
				"task": activity.task,
				"task_status": status,
				"due_on": due_on,
				"description": activity.description,
				"required": bool(activity.required_for_employee_creation),
				"completed": completed,
				"overdue": bool(due_on and getdate(due_on) < today and not completed),
			}
		)

	return {
		"onboardings": [
			{
				"name": row.name,
				"job_applicant": row.job_applicant,
				"job_offer": row.job_offer,
				"employee": row.employee,
				"employee_name": row.employee_name,
				"date_of_joining": row.date_of_joining,
				"boarding_begins_on": row.boarding_begins_on,
				"status": row.boarding_status,
				"template": row.employee_onboarding_template,
				"company": row.company,
				"department": row.department,
				"designation": row.designation,
				"project": row.project,
				"docstatus": row.docstatus,
				"activities": by_parent.get(row.name, []),
			}
			for row in rows
		]
	}


# ---------------------------------------------------------------------------
# Demo data seeding
# ---------------------------------------------------------------------------

DEMO_SEED_ROLES = {"System Manager", "HR Manager", "Administrator"}


@frappe.whitelist(methods=["POST"])
def seed_demo_data() -> dict:
	"""Populate the site with a demo workforce for testing.

	Guarded twice over: the caller must hold an HR/admin role, and the site must
	opt in via ``developer_mode`` or the ``techsarena_allow_demo_seed`` config
	flag, so a production site is never seeded by accident. Idempotent — see
	``techsarena_hr.demo_seed``.
	"""
	user = _require_login()
	_require_hrms()
	if not DEMO_SEED_ROLES.intersection(frappe.get_roles(user)):
		frappe.throw(
			_("Only HR Managers or System Managers can seed demo data."),
			frappe.PermissionError,
		)
	if not (frappe.conf.get("developer_mode") or frappe.conf.get("techsarena_allow_demo_seed")):
		frappe.throw(
			_("Demo seeding is disabled on this site."),
			frappe.PermissionError,
		)

	from techsarena_hr.demo_seed import seed_demo_dataset

	# Seeding provisions Users, roles and passwords, which need admin rights the
	# caller may not hold (an HR Manager cannot write User). The endpoint is
	# already role- and site-gated, so run the provisioning as Administrator and
	# restore the caller afterwards.
	frappe.set_user("Administrator")
	try:
		return seed_demo_dataset()
	finally:
		frappe.set_user(user)


# ---------------------------------------------------------------------------
# Branding
# ---------------------------------------------------------------------------


def _logo_data_uri(path: str | None) -> str | None:
	"""Embed a branding logo as a ``data:`` URI.

	The app runs cross-origin from the site in development, and Frappe serves
	static ``/files`` and ``/assets`` without CORS headers — so the browser
	cannot fetch a logo by URL. Reading the file here and returning bytes inline
	sidesteps that entirely (and works for SVG and raster alike). Returns
	``None`` on anything unexpected so the client falls back to its own mark.
	"""
	if not path or not isinstance(path, str):
		return None
	try:
		import base64
		import mimetypes
		import os

		rel = path.split("?")[0].split("#")[0]
		candidates: list[str] = []
		if rel.startswith("/assets/"):
			candidates.append(os.path.join(frappe.get_site_path("..", "assets"), rel[len("/assets/") :]))
		elif rel.startswith("/private/files/"):
			candidates.append(frappe.get_site_path("private", "files", rel[len("/private/files/") :]))
		elif rel.startswith("/files/"):
			candidates.append(frappe.get_site_path("public", "files", rel[len("/files/") :]))
		for candidate in candidates:
			if candidate and os.path.isfile(candidate) and os.path.getsize(candidate) <= 1_000_000:
				with open(candidate, "rb") as handle:
					raw = handle.read()
				mime = mimetypes.guess_type(rel)[0] or (
					"image/svg+xml" if rel.lower().endswith(".svg") else "application/octet-stream"
				)
				return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"
	except Exception:
		return None
	return None


#: The product's own logo, served from the dashboard's built assets. Used
#: wherever a site has not supplied its own — previously those places fell back
#: to text initials, which is not a brand.
DEFAULT_APP_LOGO = "/assets/techsarena_hr/dashboard/logo-128.png"
DEFAULT_FAVICON = "/assets/techsarena_hr/dashboard/favicon-64.png"


def _resolved_branding() -> dict:
	"""Client brand (name + logos) for the app surfaces.

	Reuses ``techsarena_branding``'s shared resolver so the app shows the same
	brand as the Frappe desk and login page (config > Techsarena Branding
	Settings > default). Logos are returned both as server-relative paths and as
	inline ``data:`` URIs (``*_logo_data``) — the app prefers the inline form so
	cross-origin static-file CORS never blocks the mark. Degrades to the app's
	own defaults if the branding app is not installed.
	"""
	try:
		from techsarena_branding.branding import resolve

		r = resolve()
		# A white-labelled site keeps its own mark; one that configured none gets
		# the product's rather than falling through to text initials.
		app_logo = r.get("navbar_logo") or DEFAULT_APP_LOGO
		login_logo = r.get("login_logo") or r.get("navbar_logo") or DEFAULT_APP_LOGO
		return {
			"name": r.get("client_name") or "Techsarena HCM",
			"app_logo": app_logo,
			"login_logo": login_logo,
			"app_logo_data": _logo_data_uri(app_logo),
			"login_logo_data": _logo_data_uri(login_logo),
			"favicon": r.get("favicon") or DEFAULT_FAVICON,
			"copyright": r.get("copyright"),
			"developed_by": r.get("dev_name"),
			"developer_logo": r.get("dev_logo"),
			"show_dev_credit": bool(r.get("show_dev")),
		}
	except Exception:
		return {
			"name": "Techsarena HCM",
			"app_logo": DEFAULT_APP_LOGO,
			"login_logo": DEFAULT_APP_LOGO,
			"app_logo_data": _logo_data_uri(DEFAULT_APP_LOGO),
			"login_logo_data": _logo_data_uri(DEFAULT_APP_LOGO),
			"favicon": DEFAULT_FAVICON,
			"copyright": "© Techs Arena",
			"developed_by": "Techs Arena",
			"developer_logo": None,
			"show_dev_credit": True,
		}


@frappe.whitelist(allow_guest=True)
def app_branding() -> dict:
	"""Public brand shown on the login screen, before sign-in."""
	return _resolved_branding()


# ---------------------------------------------------------------------------
# Profile self-service
#
# Employees propose corrections to their own record rather than writing to it:
# contact and bank details feed payroll and statutory filings, so the change is
# staged on an Employee Profile Change Request and applied by HR on approval.
# The editable whitelist lives on that doctype, never on the client.
# ---------------------------------------------------------------------------


@frappe.whitelist()
def profile_change_options() -> dict:
	"""Which fields self-service may propose, with their current values.

	The client renders its form from this rather than a hardcoded list, so the
	form can never offer a field the server would reject.
	"""
	from techsarena_hr.techsarena_hr.doctype.employee_profile_change_request.employee_profile_change_request import (
		EDITABLE_FIELDS,
	)

	user = _require_login()
	_require_hrms()
	employee = _current_employee(user)

	meta = frappe.get_meta("Employee")
	record = frappe.db.get_value("Employee", employee, "*", as_dict=True) or {}

	groups = []
	for group, fieldnames in EDITABLE_FIELDS.items():
		fields = []
		for fieldname in fieldnames:
			if not meta.has_field(fieldname):
				continue
			df = meta.get_field(fieldname)
			fields.append(
				{
					"fieldname": fieldname,
					"label": _(df.label or fieldname),
					"fieldtype": df.fieldtype,
					"options": df.options,
					"value": record.get(fieldname),
				}
			)
		if fields:
			groups.append({"group": group, "fields": fields})

	return {"employee": employee, "groups": groups}


@frappe.whitelist()
def my_profile_change_requests() -> dict:
	"""This employee's own change requests, newest first."""
	user = _require_login()
	_require_hrms()
	employee = _current_employee(user)

	rows = frappe.get_all(
		"Employee Profile Change Request",
		filters={"employee": employee},
		fields=(
			"name",
			"status",
			"changes",
			"reason",
			"requested_on",
			"decided_by",
			"decided_on",
			"decision_comment",
			"docstatus",
			"creation",
		),
		order_by="creation desc",
		limit_page_length=50,
	)
	for row in rows:
		row["changes"] = _parse_changes(row.get("changes"))
	return {"requests": rows, "pending": sum(1 for r in rows if r["status"] == "Pending")}


def _parse_changes(raw) -> list[dict]:
	"""Renders the stored JSON as labelled rows the client can show as-is."""
	try:
		parsed = json.loads(raw or "{}")
	except (TypeError, ValueError):
		return []
	if not isinstance(parsed, dict):
		return []
	meta = frappe.get_meta("Employee")
	rows = []
	for fieldname, value in parsed.items():
		df = meta.get_field(fieldname) if meta.has_field(fieldname) else None
		rows.append(
			{
				"fieldname": fieldname,
				"label": _(df.label) if df and df.label else fieldname,
				"value": value,
			}
		)
	return rows


@frappe.whitelist(methods=["POST"])
def submit_profile_change(changes: str, reason: str | None = None) -> dict:
	"""Stage a self-service profile correction for HR approval.

	`changes` is a JSON object of {fieldname: new value}. The employee is taken
	from the session — never from the client — so this cannot be used to edit
	somebody else's record.
	"""
	user = _require_login()
	_require_hrms()
	employee = _current_employee(user)

	try:
		payload = json.loads(changes or "{}")
	except (TypeError, ValueError):
		frappe.throw(_("The requested changes could not be read."))
	if not isinstance(payload, dict) or not payload:
		frappe.throw(_("Update at least one detail before submitting."))

	# One open request at a time keeps the approver's inbox unambiguous and
	# stops two pending requests from applying conflicting values.
	existing = frappe.db.exists(
		"Employee Profile Change Request",
		{"employee": employee, "status": "Pending", "docstatus": 0},
	)
	if existing:
		frappe.throw(
			_("You already have a profile change request awaiting approval ({0}).").format(existing)
		)

	doc = frappe.get_doc(
		{
			"doctype": "Employee Profile Change Request",
			"employee": employee,
			"changes": json.dumps(payload, default=str),
			"reason": reason,
			"status": "Pending",
		}
	)
	# The employee may create their own request but holds no write permission on
	# the doctype beyond that; the whitelist on the controller is what actually
	# constrains the payload.
	doc.insert(ignore_permissions=True)

	_publish("approval_queue_changed", {"doctype": doc.doctype, "name": doc.name})
	return {
		"name": doc.name,
		"status": doc.status,
		"changes": _parse_changes(doc.changes),
	}


@frappe.whitelist(methods=["POST"])
def withdraw_profile_change(name: str) -> dict:
	"""Take back a request that has not been decided yet."""
	user = _require_login()
	_require_hrms()
	employee = _current_employee(user)

	doc = frappe.get_doc("Employee Profile Change Request", name)
	if doc.employee != employee:
		frappe.throw(_("You can only withdraw your own requests."), frappe.PermissionError)
	if doc.docstatus != 0:
		frappe.throw(_("{0} has already been decided.").format(name))

	doc.delete(ignore_permissions=True)
	_publish("approval_queue_changed", {"doctype": "Employee Profile Change Request", "name": name})
	return {"name": name, "status": "Withdrawn"}


# ---------------------------------------------------------------------------
# Employee documents
#
# The vault behind the profile's Records tab. Files themselves travel through
# Frappe's own `upload_file` handler; these endpoints own the metadata, the
# expiry tracking, and who is allowed to see whose documents.
# ---------------------------------------------------------------------------

#: Types an employee may file against their own record. Contracts and anything
#: that constitutes an HR decision stay HR-created, so an employee cannot post a
#: document that purports to change their terms.
SELF_UPLOADABLE_DOCUMENT_TYPES = {
	"National ID",
	"Passport",
	"Visa",
	"Work Permit",
	"Driving Licence",
	"Educational Certificate",
	"Professional Certification",
	"Medical",
	"Other",
}

#: How far ahead the vault flags an expiring document.
EXPIRY_WARNING_DAYS = 60


def _assert_document_access(employee: str, user: str, *, write: bool = False) -> bool:
	"""Mirror of employee_profile's rule: self, reporting subtree, or HR.

	Returns whether the caller is acting as HR, which decides the fields they
	are allowed to set. Write access is narrower than read: a manager may see a
	report's documents but only HR and the owner may change them.
	"""
	own = _current_employee(user, required=False)
	is_hr = bool(set(frappe.get_roles(user)).intersection(HR_ROLES))
	if is_hr:
		return True
	if employee == own:
		return False
	if not write and employee in _visible_employee_names(own):
		return False
	frappe.throw(_("You are not allowed to view this employee's documents."), frappe.PermissionError)


@frappe.whitelist()
def employee_documents(employee: str | None = None) -> dict:
	"""The document vault for one employee, with expiry state per row."""
	user = _require_login()
	_require_hrms()
	employee = employee or _current_employee(user)
	is_hr = _assert_document_access(employee, user)

	rows = frappe.get_all(
		"Employee Document",
		filters={"employee": employee},
		fields=(
			"name",
			"document_type",
			"title",
			"document_number",
			"issued_on",
			"expires_on",
			"is_verified",
			"attachment",
			"notes",
			"owner",
			"creation",
		),
		order_by="expires_on asc, creation desc",
		limit_page_length=100,
	)

	today = getdate(nowdate())
	expiring = 0
	expired = 0
	for row in rows:
		if row.get("expires_on"):
			days = (getdate(row["expires_on"]) - today).days
			row["days_to_expiry"] = days
			if days < 0:
				row["expiry_state"] = "expired"
				expired += 1
			elif days <= EXPIRY_WARNING_DAYS:
				row["expiry_state"] = "expiring"
				expiring += 1
			else:
				row["expiry_state"] = "valid"
		else:
			row["days_to_expiry"] = None
			row["expiry_state"] = "none"

	return {
		"employee": employee,
		"documents": rows,
		"can_verify": is_hr,
		"document_types": sorted(SELF_UPLOADABLE_DOCUMENT_TYPES) if not is_hr else None,
		"counts": {"all": len(rows), "expiring": expiring, "expired": expired},
	}


@frappe.whitelist(methods=["POST"])
def save_employee_document(
	attachment: str,
	document_type: str,
	employee: str | None = None,
	name: str | None = None,
	title: str | None = None,
	document_number: str | None = None,
	issued_on: str | None = None,
	expires_on: str | None = None,
	notes: str | None = None,
) -> dict:
	"""Create or update one document row against an already-uploaded file.

	`attachment` is the file_url returned by Frappe's upload handler — this
	endpoint records what the file *is*, it does not receive the bytes.
	"""
	user = _require_login()
	_require_hrms()
	employee = employee or _current_employee(user)
	is_hr = _assert_document_access(employee, user, write=True)

	if not is_hr and document_type not in SELF_UPLOADABLE_DOCUMENT_TYPES:
		frappe.throw(
			_("{0} documents are filed by HR.").format(document_type), frappe.PermissionError
		)

	if name:
		doc = frappe.get_doc("Employee Document", name)
		if doc.employee != employee:
			frappe.throw(_("That document belongs to another employee."), frappe.PermissionError)
		# An employee may correct their own filing; HR may correct anyone's.
		if not is_hr and doc.owner != user:
			frappe.throw(_("You can only edit documents you uploaded."), frappe.PermissionError)
	else:
		doc = frappe.new_doc("Employee Document")
		doc.employee = employee

	doc.update(
		{
			"document_type": document_type,
			"title": title,
			"document_number": document_number,
			"issued_on": issued_on or None,
			"expires_on": expires_on or None,
			"notes": notes,
			"attachment": attachment,
		}
	)
	doc.save(ignore_permissions=True)

	_publish_to_employee(employee, "documents_changed", {"name": doc.name})
	return {"name": doc.name, "document_type": doc.document_type, "title": doc.title}


@frappe.whitelist(methods=["POST"])
def verify_employee_document(name: str, verified: int = 1) -> dict:
	"""HR's confirmation that the original was sighted."""
	_require_hr_access()
	_require_hrms()

	doc = frappe.get_doc("Employee Document", name)
	doc.is_verified = 1 if cint(verified) else 0
	doc.save(ignore_permissions=True)

	_publish_to_employee(doc.employee, "documents_changed", {"name": doc.name})
	return {"name": doc.name, "is_verified": bool(doc.is_verified)}


@frappe.whitelist(methods=["POST"])
def delete_employee_document(name: str) -> dict:
	"""Remove a document row and the file behind it."""
	user = _require_login()
	_require_hrms()

	doc = frappe.get_doc("Employee Document", name)
	is_hr = _assert_document_access(doc.employee, user, write=True)
	if not is_hr and doc.owner != user:
		frappe.throw(_("You can only remove documents you uploaded."), frappe.PermissionError)
	# A verified document is a record HR has vouched for; only HR retires it.
	if doc.is_verified and not is_hr:
		frappe.throw(_("A verified document can only be removed by HR."), frappe.PermissionError)

	employee, file_url = doc.employee, doc.attachment
	doc.delete(ignore_permissions=True)

	# Drop the orphaned File too, so removing a document does not leave the
	# bytes readable at a guessable URL.
	if file_url:
		for file_name in frappe.get_all("File", filters={"file_url": file_url}, pluck="name"):
			try:
				frappe.delete_doc("File", file_name, ignore_permissions=True, delete_permanently=True)
			except Exception:
				frappe.log_error(f"Could not delete file {file_name} for {name}")

	_publish_to_employee(employee, "documents_changed", {"name": name})
	return {"name": name, "status": "Deleted"}


@frappe.whitelist()
def expiring_documents(days: int = EXPIRY_WARNING_DAYS) -> dict:
	"""Company-wide expiry watchlist for HR.

	Visa and permit lapses are a compliance problem long before anyone notices
	them on an individual profile, so HR gets them in one place.
	"""
	_require_hr_access()
	_require_hrms()

	horizon = add_days(nowdate(), cint(days))
	rows = frappe.get_all(
		"Employee Document",
		# Both bounds on one field: a dict literal would silently drop the first.
		filters=[
			["expires_on", "is", "set"],
			["expires_on", "<=", horizon],
		],
		fields=(
			"name",
			"employee",
			"employee_name",
			"document_type",
			"title",
			"expires_on",
			"is_verified",
		),
		order_by="expires_on asc",
		limit_page_length=200,
	)
	today = getdate(nowdate())
	for row in rows:
		row["days_to_expiry"] = (getdate(row["expires_on"]) - today).days
		row["expiry_state"] = "expired" if row["days_to_expiry"] < 0 else "expiring"

	return {
		"documents": rows,
		"horizon_days": cint(days),
		"counts": {
			"expired": sum(1 for r in rows if r["expiry_state"] == "expired"),
			"expiring": sum(1 for r in rows if r["expiry_state"] == "expiring"),
		},
	}


# ---------------------------------------------------------------------------
# Expense receipts
#
# The read path already returns a claim's attachments; these own the write.
# A receipt is an ordinary Frappe File against the Expense Claim, so nothing
# here invents a parallel store — it enforces who may attach to which claim and
# at what point in the claim's life.
# ---------------------------------------------------------------------------


def _own_claim(name: str, user: str):
	"""The caller's own claim, or a permission error.

	Receipts are attached by the person making the claim: an approver reads them
	but does not add to someone else's evidence.
	"""
	_unused_user, employee = _require_employee_user(user)
	claim = frappe.db.get_value(
		"Expense Claim", name, ["name", "employee", "docstatus", "approval_status"], as_dict=True
	)
	if not claim:
		frappe.throw(_("Expense claim {0} was not found.").format(name), frappe.DoesNotExistError)
	if claim.employee != employee:
		frappe.throw(_("You can only attach receipts to your own claims."), frappe.PermissionError)
	return claim


@frappe.whitelist(methods=["POST"])
def attach_expense_receipt(claim: str, file_url: str, file_name: str | None = None) -> dict:
	"""Attach an already-uploaded file to one of the caller's own claims.

	`file_url` comes from Frappe's upload handler. The File row is re-pointed at
	the claim rather than copied, so there is exactly one copy of the bytes.
	"""
	user = _require_login()
	_require_hrms()
	doc = _own_claim(claim, user)

	# Evidence must not change after a decision has been made on it.
	if doc.docstatus != 0:
		frappe.throw(_("This claim has already been submitted and cannot be changed."))

	file_doc = frappe.db.get_value(
		"File", {"file_url": file_url}, ["name", "attached_to_doctype", "attached_to_name"], as_dict=True
	)
	if not file_doc:
		frappe.throw(_("That upload could not be found. Please try attaching it again."))
	# A file already attached elsewhere is not ours to move.
	if file_doc.attached_to_name and file_doc.attached_to_name != claim:
		frappe.throw(_("That file is already attached to another document."))

	record = frappe.get_doc("File", file_doc.name)
	record.attached_to_doctype = "Expense Claim"
	record.attached_to_name = claim
	record.is_private = 1
	if file_name:
		record.file_name = file_name
	record.save(ignore_permissions=True)

	_publish_to_employee(doc.employee, "claims_changed", {"name": claim})
	return {
		"claim": claim,
		"file_name": record.file_name,
		"file_url": record.file_url,
		"file_size": cint(record.file_size),
	}


@frappe.whitelist(methods=["POST"])
def remove_expense_receipt(claim: str, file_url: str) -> dict:
	"""Detach and delete one receipt from a claim that is still a draft."""
	user = _require_login()
	_require_hrms()
	doc = _own_claim(claim, user)

	if doc.docstatus != 0:
		frappe.throw(_("This claim has already been submitted and cannot be changed."))

	file_name = frappe.db.get_value(
		"File", {"file_url": file_url, "attached_to_doctype": "Expense Claim", "attached_to_name": claim}, "name"
	)
	if not file_name:
		frappe.throw(_("That receipt is not attached to this claim."))

	frappe.delete_doc("File", file_name, ignore_permissions=True, delete_permanently=True)
	_publish_to_employee(doc.employee, "claims_changed", {"name": claim})
	return {"claim": claim, "file_url": file_url, "status": "Removed"}


# ---------------------------------------------------------------------------
# Global search
#
# Backs the command palette. Every result is something the caller could already
# open by navigating to it — the same visibility rules `employee_profile` and
# `_directory` apply, re-checked here rather than trusted from the client.
#
# Deliberately not indexed: salary slips, payroll runs, and salary structures.
# A palette that autocompletes pay figures leaks them to anyone glancing at the
# screen, and there is no self-service question that needs it.
# ---------------------------------------------------------------------------

#: Below this a query matches most of the table and the palette is noise.
MIN_SEARCH_CHARS = 2

#: Per-section cap. The palette shows a handful of each rather than 50 of one.
SEARCH_SECTION_LIMIT = 6


def _like(term: str) -> str:
	"""Escapes a user term for a LIKE, so `%` and `_` match literally."""
	escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
	return f"%{escaped}%"


def _search_people(term: str, *, unrestricted: bool, visible: set[str]) -> list[dict]:
	"""Directory matches, by name, designation, or employee number."""
	if not unrestricted and not visible:
		return []

	filters: list = [["status", "=", "Active"]]
	if not unrestricted:
		filters.append(["name", "in", sorted(visible)])

	pattern = _like(term)
	rows = frappe.get_all(
		"Employee",
		filters=filters,
		or_filters=[
			["employee_name", "like", pattern],
			["designation", "like", pattern],
			["employee_number", "like", pattern],
		],
		fields=["name", "employee_name", "image", "designation", "department"],
		order_by="employee_name asc",
		limit_page_length=SEARCH_SECTION_LIMIT,
	)
	return [
		{
			"id": row.name,
			"kind": "person",
			"title": row.employee_name,
			"subtitle": " · ".join(x for x in (row.designation, row.department) if x) or None,
			"image": row.image,
			"to": f"/people/{row.name}",
		}
		for row in rows
	]


def _search_own_documents(term: str, employee: str | None) -> list[dict]:
	"""The caller's own document vault. Never anyone else's, HR included —
	a palette is the wrong surface for reading someone's passport."""
	if not employee or not frappe.db.table_exists("Employee Document"):
		return []
	pattern = _like(term)
	rows = frappe.get_all(
		"Employee Document",
		filters=[["employee", "=", employee]],
		or_filters=[
			["title", "like", pattern],
			["document_type", "like", pattern],
		],
		fields=["name", "title", "document_type", "expires_on"],
		order_by="creation desc",
		limit_page_length=SEARCH_SECTION_LIMIT,
	)
	return [
		{
			"id": row.name,
			"kind": "document",
			"title": row.title or row.document_type,
			"subtitle": row.document_type,
			"to": "/profile",
		}
		for row in rows
	]


def _search_own_claims(term: str, employee: str | None) -> list[dict]:
	"""The caller's own expense claims, by name or remark."""
	if not employee:
		return []
	pattern = _like(term)
	rows = frappe.get_all(
		"Expense Claim",
		filters=[["employee", "=", employee], ["docstatus", "<", 2]],
		or_filters=[["name", "like", pattern], ["remark", "like", pattern]],
		fields=["name", "remark", "posting_date", "total_claimed_amount", "approval_status"],
		order_by="posting_date desc",
		limit_page_length=SEARCH_SECTION_LIMIT,
	)
	return [
		{
			"id": row.name,
			"kind": "claim",
			"title": (row.remark or "").strip() or row.name,
			"subtitle": " · ".join(
				x for x in (row.approval_status, str(row.posting_date) if row.posting_date else None) if x
			) or None,
			"to": "/claims",
		}
		for row in rows
	]


def _search_leave(term: str, employee: str | None) -> list[dict]:
	"""The caller's own leave applications, by type or reason."""
	if not employee:
		return []
	pattern = _like(term)
	rows = frappe.get_all(
		"Leave Application",
		filters=[["employee", "=", employee], ["docstatus", "<", 2]],
		or_filters=[["leave_type", "like", pattern], ["description", "like", pattern]],
		fields=["name", "leave_type", "from_date", "to_date", "status"],
		order_by="from_date desc",
		limit_page_length=SEARCH_SECTION_LIMIT,
	)
	return [
		{
			"id": row.name,
			"kind": "leave",
			"title": row.leave_type or _("Leave"),
			"subtitle": " · ".join(
				x for x in (row.status, f"{row.from_date} → {row.to_date}" if row.from_date else None) if x
			) or None,
			"to": "/leave",
		}
		for row in rows
	]


def _search_announcements(term: str, employee: str | None) -> list[dict]:
	"""Announcements this employee would actually be shown.

	Applies the same audience and lifetime rules as `announcements()`: an
	unpublished, future-dated, expired, or differently-targeted notice must not
	surface here just because its title matched.
	"""
	if not frappe.db.table_exists("HR Announcement"):
		return []
	pattern = _like(term)
	rows = frappe.get_all(
		"HR Announcement",
		filters=[
			["is_published", "=", 1],
			["published_on", "<=", nowdate()],
			["title", "like", pattern],
		],
		or_filters=[["expires_on", ">=", nowdate()], ["expires_on", "is", "not set"]],
		fields=["name", "title", "category", "published_on", "company", "department"],
		order_by="published_on desc",
		limit_page_length=SEARCH_SECTION_LIMIT,
	)
	if employee:
		profile = frappe.db.get_value("Employee", employee, ["company", "department"], as_dict=True) or {}
		rows = [
			row
			for row in rows
			if (not row.company or row.company == profile.get("company"))
			and (not row.department or row.department == profile.get("department"))
		]
	return [
		{
			"id": row.name,
			"kind": "announcement",
			"title": row.title,
			"subtitle": row.category,
			"to": "/announcements",
		}
		for row in rows
	]


@frappe.whitelist()
def global_search(query: str) -> dict:
	"""Everything matching `query` that this user is allowed to see.

	Sections are returned separately rather than as one ranked list: the client
	groups them, and a person and a claim are not comparable enough for a single
	relevance score to mean anything.
	"""
	user = _require_login()
	_require_hrms()

	term = (query or "").strip()
	if len(term) < MIN_SEARCH_CHARS:
		return {"query": term, "sections": [], "total": 0}

	roles = set(frappe.get_roles(user))
	can_manage_hr = bool(roles.intersection(HR_ROLES))
	employee = _current_employee(user, required=False)
	# Directory reach mirrors bootstrap's: HR sees everyone, everyone else sees
	# their own reporting subtree.
	visible = set() if can_manage_hr else _visible_employee_names(employee)

	sections = []

	if frappe.has_permission("Employee", "read"):
		people = _search_people(term, unrestricted=can_manage_hr, visible=visible)
		if people:
			sections.append({"key": "people", "label": _("People"), "results": people})

	for key, label, results in (
		("leave", _("My leave"), _search_leave(term, employee)),
		("claims", _("My expenses"), _search_own_claims(term, employee)),
		("documents", _("My documents"), _search_own_documents(term, employee)),
		("announcements", _("Announcements"), _search_announcements(term, employee)),
	):
		if results:
			sections.append({"key": key, "label": label, "results": results})

	return {
		"query": term,
		"sections": sections,
		"total": sum(len(section["results"]) for section in sections),
	}


# ---------------------------------------------------------------------------
# Org chart
#
# Built from `reports_to`, the only record of hierarchy a stock HRMS keeps.
# The endpoint returns a flat node list with parent pointers rather than a
# nested tree: the client needs to look nodes up by id to expand and focus
# them, and a nested payload would have to be re-flattened to do that.
#
# A site that has not filled in `reports_to` is the normal starting state, not
# an error — the response says so explicitly so the screen can explain itself
# instead of drawing nine disconnected roots.
# ---------------------------------------------------------------------------


def _org_visible(user: str, employee: str | None) -> tuple[bool, set[str]]:
	"""Who this user may see in the chart.

	Mirrors the directory rule: HR (and anyone with unrestricted Employee read)
	sees the whole company, everyone else sees their own reporting subtree. The
	chart is a directory view, so it must not widen what the directory shows.
	"""
	roles = set(frappe.get_roles(user))
	if roles.intersection(HR_ROLES):
		return True, set()
	return False, _visible_employee_names(employee)


@frappe.whitelist()
def org_chart(root: str | None = None) -> dict:
	"""The reporting tree, as nodes the client assembles.

	`root` focuses the chart on one person and their descendants; omitted, it
	returns everyone in scope. Each node carries `report_count` (direct reports)
	so a collapsed branch can say how much it is hiding without loading it.
	"""
	user = _require_login()
	_require_hrms()
	if not frappe.has_permission("Employee", "read"):
		frappe.throw(_("You are not allowed to view the directory."), frappe.PermissionError)

	own = _current_employee(user, required=False)
	unrestricted, visible = _org_visible(user, own)

	filters: dict = {"status": "Active"}
	if not unrestricted:
		if not visible:
			return {
				"nodes": [], "roots": [], "self": own, "root": None,
				"total": 0, "unlinked": 0, "has_hierarchy": False,
			}
		filters["name"] = ["in", sorted(visible)]

	rows = frappe.get_all(
		"Employee",
		filters=filters,
		fields=[
			"name", "employee_name", "image", "designation",
			"department", "reports_to", "user_id",
		],
		order_by="employee_name asc",
		limit_page_length=0,
	)
	in_scope = {row.name for row in rows}

	# A manager outside the caller's scope must not become a dangling parent —
	# the node would point at an id the client never receives.
	nodes = []
	for row in rows:
		parent = row.reports_to if row.reports_to in in_scope else None
		nodes.append(
			{
				"id": row.name,
				"name": row.employee_name,
				"image": row.image,
				"designation": row.designation,
				"department": row.department,
				"parent": parent,
				"is_self": row.name == own,
				"report_count": 0,
			}
		)

	by_id = {node["id"]: node for node in nodes}
	for node in nodes:
		if node["parent"]:
			by_id[node["parent"]]["report_count"] += 1

	# Focusing keeps one person and everything beneath them.
	if root:
		if root not in by_id:
			frappe.throw(_("That employee is not in your part of the organisation."), frappe.PermissionError)
		keep = {root}
		queue = [root]
		children: dict[str, list[str]] = {}
		for node in nodes:
			if node["parent"]:
				children.setdefault(node["parent"], []).append(node["id"])
		while queue:
			for child in children.get(queue.pop(), ()):
				if child not in keep:
					keep.add(child)
					queue.append(child)
		nodes = [node for node in nodes if node["id"] in keep]
		# The focused node is the root of what is returned, whatever sits above it.
		by_id = {node["id"]: node for node in nodes}
		by_id[root]["parent"] = None

	roots = [node["id"] for node in nodes if not node["parent"]]
	# Everyone being a root means the reporting line is simply not filled in.
	has_hierarchy = any(node["parent"] for node in nodes)

	return {
		"nodes": nodes,
		"roots": roots,
		"self": own,
		"root": root,
		"total": len(nodes),
		# What HR would need to fix to make the chart meaningful.
		"unlinked": sum(1 for node in nodes if not node["parent"] and not node["report_count"]),
		"has_hierarchy": has_hierarchy,
	}
