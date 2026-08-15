"""Role-scoped dashboard data for the Techs Arena HCM client."""

from __future__ import annotations

from statistics import median

import frappe
from frappe.utils import add_days, flt, get_first_day, getdate, now_datetime, nowdate

DASHBOARD_ROLE_ORDER = (
	"System Manager",
	"HR Manager",
	"HR User",
	"Leave Approver",
	"Expense Approver",
	"Shift Request Approver",
	"Interviewer",
)


def build_role_dashboards(user: str, roles: set[str], employee: str | None) -> dict:
	"""Build every dashboard the signed-in user is allowed to select."""
	available = [role for role in DASHBOARD_ROLE_ORDER if role in roles]
	if "Employee" in roles:
		available.append("Employee")

	dashboards = {}
	for role in available:
		if role != "Employee":
			dashboards[role] = _dashboard_for(role, user)
	return {
		"dashboard_roles": available,
		# Employee is the common landing screen for everyone who has that
		# role. Other responsibilities remain available in the switcher.
		"default_dashboard_role": "Employee" if "Employee" in available else (available[0] if available else None),
		"role_dashboards": dashboards,
	}


def _dashboard_for(role: str, user: str) -> dict:
	builders = {
		"Leave Approver": _leave_approver,
		"Expense Approver": _expense_approver,
		"Shift Request Approver": _shift_approver,
		"HR User": _hr_user,
		"HR Manager": _hr_manager,
		"Interviewer": _interviewer,
		"System Manager": _system_manager,
	}
	return {"role": role, **builders[role](user)}


def _metric(label: str, value, detail: str | None = None, tone: str = "neutral") -> dict:
	return {"label": label, "value": str(value), "detail": detail, "tone": tone}


def _item(
	title: str,
	subtitle: str | None = None,
	trailing: str | None = None,
	status: str | None = None,
) -> dict:
	return {"title": title, "subtitle": subtitle, "trailing": trailing, "status": status}


def _panel(title: str, items: list[dict], badge: str | None = None) -> dict:
	return {"title": title, "badge": badge, "items": items}


def _safe_list(doctype: str, **kwargs) -> list:
	if not frappe.db.table_exists(doctype):
		return []
	try:
		# These builders already authorize by dashboard role and apply the
		# signed-in approver/interviewer as a filter where required. Using
		# get_all avoids Employee user permissions hiding the rest of that
		# explicitly assigned work queue.
		return frappe.get_all(doctype, **kwargs)
	except (frappe.PermissionError, frappe.ValidationError):
		return []


def _count(doctype: str, filters: dict | None = None) -> int:
	if not frappe.db.table_exists(doctype):
		return 0
	try:
		return frappe.db.count(doctype, filters or {})
	except (frappe.PermissionError, frappe.ValidationError):
		return 0


def _money(value, currency: str = "") -> str:
	amount = flt(value)
	abs_amount = abs(amount)
	if abs_amount >= 10_000_000:
		text = f"{amount / 10_000_000:.2f}Cr"
	elif abs_amount >= 100_000:
		text = f"{amount / 100_000:.2f}L"
	elif abs_amount >= 1_000:
		text = f"{amount / 1_000:.1f}K"
	else:
		text = f"{amount:,.0f}"
	return f"{currency}{text}"


def _age_label(creation) -> str:
	if not creation:
		return "New"
	hours = max(0, int((now_datetime() - creation).total_seconds() / 3600))
	if hours >= 48:
		return f"{hours // 24} days old"
	return f"{hours}h old"


def _leave_approver(user: str) -> dict:
	roles = set(frappe.get_roles(user))
	filters = {"status": "Open", "docstatus": 0}
	if not roles.intersection({"HR User", "HR Manager", "System Manager", "Administrator"}):
		filters["leave_approver"] = user
	pending = _safe_list(
		"Leave Application",
		filters=filters,
		fields=[
			"name",
			"employee_name",
			"leave_type",
			"from_date",
			"to_date",
			"total_leave_days",
			"creation",
			"leave_balance",
		],
		order_by="creation asc",
		limit_page_length=30,
	)
	overdue_cutoff = getdate(add_days(nowdate(), -2))
	overdue = [row for row in pending if row.creation and getdate(row.creation) <= overdue_cutoff]
	approved = _safe_list(
		"Leave Application",
		filters={"status": "Approved", "modified": [">=", get_first_day(nowdate())]},
		fields=["creation", "modified"],
		limit_page_length=500,
	)
	response_hours = [
		max(0, (row.modified - row.creation).total_seconds() / 3600)
		for row in approved
		if row.creation and row.modified
	]
	items = [
		_item(
			f"{row.employee_name or row.name} · {row.leave_type}",
			f"{row.from_date} - {row.to_date} · {flt(row.total_leave_days):g} days",
			_age_label(row.creation),
			"overdue" if row in overdue else "pending",
		)
		for row in pending[:6]
	]
	return {
		"title": f"{len(pending)} requests waiting on you",
		"subtitle": "Review the oldest requests first and keep team coverage healthy.",
		"primary_action": "Open approvals",
		"primary_page": "approvals",
		"metrics": [
			_metric("Awaiting you", len(pending)),
			_metric("Overdue > 48h", len(overdue), tone="danger" if overdue else "success"),
			_metric("Approved this month", len(approved)),
			_metric("Median response", f"{median(response_hours):.1f}h" if response_hours else "—"),
		],
		"panels": [
			_panel("Pending leave applications", items, f"{len(pending)} pending"),
			_panel(
				"Policy checks on the queue",
				[
					_item(f"{len(pending) - len(overdue)} requests are within 48 hours", status="clear"),
					_item(f"{len(overdue)} requests need escalation", status="overdue"),
				],
			),
		],
	}


def _expense_approver(user: str) -> dict:
	roles = set(frappe.get_roles(user))
	filters = {"approval_status": "Draft", "docstatus": 0}
	if not roles.intersection({"HR Manager", "System Manager", "Administrator", "Accounts Manager"}):
		filters["expense_approver"] = user
	claims = _safe_list(
		"Expense Claim",
		filters=filters,
		fields=[
			"name",
			"employee_name",
			"department",
			"posting_date",
			"total_claimed_amount",
			"total_sanctioned_amount",
			"remark",
			"creation",
			"company",
		],
		order_by="creation asc",
		limit_page_length=30,
	)
	total = sum(flt(row.total_claimed_amount) for row in claims)
	paid = _safe_list(
		"Expense Claim",
		filters={"is_paid": 1, "posting_date": [">=", get_first_day(nowdate())]},
		fields=["total_amount_reimbursed"],
		limit_page_length=500,
	)
	paid_total = sum(flt(row.total_amount_reimbursed) for row in paid)
	items = [
		_item(
			row.employee_name or row.name,
			row.remark or row.department or f"Submitted {row.posting_date}",
			_money(row.total_claimed_amount),
			"pending",
		)
		for row in claims[:7]
	]
	return {
		"title": f"{_money(total)} across {len(claims)} claims",
		"subtitle": "Money, receipt and policy in one approval queue.",
		"primary_action": "Review claims",
		"metrics": [
			_metric("Pending value", _money(total)),
			_metric("Policy flags", 0, tone="success"),
			_metric("Missing receipts", 0, tone="success"),
			_metric("Reimbursed this month", _money(paid_total)),
		],
		"panels": [
			_panel("Expense claims awaiting approval", items, f"{len(claims)} claims"),
			_panel(
				"Budget burn",
				[
					_item("Pending claims", "Current approval liability", _money(total)),
					_item("Reimbursed", "Paid since month start", _money(paid_total)),
				],
			),
		],
	}


def _shift_approver(user: str) -> dict:
	roles = set(frappe.get_roles(user))
	filters = {"status": "Draft", "docstatus": 0}
	if not roles.intersection({"HR User", "HR Manager", "System Manager", "Administrator"}):
		filters["approver"] = user
	requests = _safe_list(
		"Shift Request",
		filters=filters,
		fields=["name", "employee_name", "department", "shift_type", "from_date", "to_date", "creation"],
		order_by="from_date asc",
		limit_page_length=30,
	)
	departments = {row.department for row in requests if row.department}
	items = [
		_item(
			f"{row.employee_name or row.name} · {row.shift_type}",
			f"{row.from_date} - {row.to_date}" if row.to_date else str(row.from_date),
			_age_label(row.creation),
			"pending",
		)
		for row in requests[:7]
	]
	return {
		"title": f"{len(requests)} shift requests to review",
		"subtitle": "Roster gaps and team coverage decide the answer.",
		"primary_action": "Review requests",
		"metrics": [
			_metric("Pending requests", len(requests)),
			_metric("Teams affected", len(departments)),
			_metric(
				"Starting this week",
				sum(1 for row in requests if getdate(row.from_date) <= getdate(add_days(nowdate(), 7))),
			),
			_metric("Roster status", "Live", tone="success"),
		],
		"panels": [
			_panel("Requests", items, f"{len(requests)} pending"),
			_panel(
				"Roster coverage",
				[_item(department, "Has a pending shift change") for department in sorted(departments)[:6]],
			),
		],
	}


def _hr_user(user: str) -> dict:
	month_start = get_first_day(nowdate())
	new_employees = _safe_list(
		"Employee",
		filters={"status": "Active", "date_of_joining": [">=", month_start]},
		fields=["employee_name", "designation", "department", "date_of_joining"],
		order_by="date_of_joining desc",
		limit_page_length=12,
	)
	exceptions = _safe_list(
		"Attendance",
		filters={"attendance_date": nowdate(), "docstatus": ["<", 2]},
		fields=["employee_name", "status", "late_entry", "early_exit", "working_hours"],
		limit_page_length=100,
	)
	exceptions = [row for row in exceptions if row.status != "Present" or row.late_entry or row.early_exit]
	leavers = _safe_list(
		"Employee",
		filters={"status": "Left", "relieving_date": [">=", month_start]},
		fields=["employee_name", "department", "relieving_date"],
		order_by="relieving_date asc",
		limit_page_length=12,
	)
	return {
		"title": f"Good morning, {frappe.utils.get_fullname(user).split()[0]}",
		"subtitle": "Here is today's operational HR work queue.",
		"primary_action": "Add employee",
		"primary_page": "people",
		"metrics": [
			_metric("Onboarding open", len(new_employees)),
			_metric("Exits in progress", len(leavers)),
			_metric("Attendance exceptions", len(exceptions), tone="danger" if exceptions else "success"),
			_metric("Active employees", _count("Employee", {"status": "Active"})),
		],
		"panels": [
			_panel(
				"Onboarding pipeline",
				[
					_item(
						row.employee_name,
						row.designation or row.department or "New employee",
						str(row.date_of_joining),
					)
					for row in new_employees[:6]
				],
			),
			_panel(
				"Attendance exceptions",
				[
					_item(
						row.employee_name,
						"Late entry" if row.late_entry else "Early exit" if row.early_exit else row.status,
						f"{flt(row.working_hours):.1f}h",
						"attention",
					)
					for row in exceptions[:6]
				],
			),
		],
	}


def _hr_manager(user: str) -> dict:
	month_start = get_first_day(nowdate())
	headcount = _count("Employee", {"status": "Active"})
	leavers = _count("Employee", {"status": "Left", "relieving_date": [">=", month_start]})
	open_roles = _count("Job Opening", {"status": "Open"})
	slips = _safe_list(
		"Salary Slip",
		filters={"start_date": [">=", month_start], "docstatus": 1},
		fields=["net_pay", "department", "employee_name"],
		limit_page_length=1000,
	)
	payroll = sum(flt(row.net_pay) for row in slips)
	departments = _safe_list(
		"Employee",
		filters={"status": "Active"},
		fields=["department", "count(name) as headcount"],
		group_by="department",
		order_by="headcount desc",
		limit_page_length=12,
	)
	return {
		"title": f"People and payroll · {now_datetime().strftime('%B %Y')}",
		"subtitle": "Headcount, cost and the current payroll run in one view.",
		"primary_action": "Open payroll",
		"primary_page": "salary",
		"metrics": [
			_metric("Headcount", headcount),
			_metric("Departures this month", leavers, tone="danger" if leavers else "success"),
			_metric("Monthly payroll", _money(payroll)),
			_metric("Open roles", open_roles),
		],
		"panels": [
			_panel(
				"Headcount by department",
				[
					_item(row.department or "Unassigned", trailing=str(row.headcount))
					for row in departments[:8]
				],
			),
			_panel(
				"Payroll run",
				[
					_item("Salary slips", f"{len(slips)} submitted", _money(payroll), "clear"),
					_item("Open positions", "Recruitment demand", str(open_roles)),
				],
			),
		],
	}


def _interviewer(user: str) -> dict:
	parents = _safe_list(
		"Interview Detail",
		filters={"interviewer": user},
		fields=["parent"],
		limit_page_length=500,
	)
	names = [row.parent for row in parents]
	interviews = []
	if names:
		interviews = _safe_list(
			"Interview",
			filters={"name": ["in", names], "scheduled_on": [">=", add_days(nowdate(), -30)]},
			fields=[
				"name",
				"job_applicant",
				"job_opening",
				"designation",
				"interview_round",
				"scheduled_on",
				"from_time",
				"to_time",
				"status",
			],
			order_by="scheduled_on asc, from_time asc",
			limit_page_length=50,
		)
	today = [row for row in interviews if getdate(row.scheduled_on) == getdate(nowdate())]
	upcoming = [row for row in interviews if getdate(row.scheduled_on) >= getdate(nowdate())]
	feedback = _safe_list(
		"Interview Feedback",
		filters={"interviewer": user, "docstatus": 1},
		fields=["interview", "average_rating"],
		limit_page_length=500,
	)
	feedback_names = {row.interview for row in feedback}
	overdue = [
		row for row in interviews if row.scheduled_on < getdate(nowdate()) and row.name not in feedback_names
	]
	ratings = [flt(row.average_rating) for row in feedback if row.average_rating is not None]
	items = [
		_item(
			row.job_applicant or row.name,
			f"{row.designation or row.job_opening or 'Candidate'} · {row.interview_round or 'Interview'}",
			str(row.from_time or row.scheduled_on),
			row.status.lower(),
		)
		for row in today[:6]
	]
	return {
		"title": f"{len(today)} interviews today",
		"subtitle": f"{len(overdue)} scorecards still need your feedback.",
		"primary_action": "Submit feedback",
		"metrics": [
			_metric("Today", len(today)),
			_metric("Feedback overdue", len(overdue), tone="danger" if overdue else "success"),
			_metric("Upcoming", len(upcoming)),
			_metric("Your avg rating", f"{sum(ratings) / len(ratings):.1f}/5" if ratings else "—"),
		],
		"panels": [
			_panel("Today's interviews", items, f"{len(today)} today"),
			_panel(
				"Feedback owed",
				[
					_item(
						row.job_applicant or row.name,
						row.designation or row.job_opening,
						"Overdue",
						"overdue",
					)
					for row in overdue[:6]
				],
			),
		],
	}


def _system_manager(user: str) -> dict:
	errors = _safe_list(
		"Error Log",
		filters={"creation": [">=", add_days(now_datetime(), -1)]},
		fields=["method", "reference_doctype", "creation"],
		order_by="creation desc",
		limit_page_length=8,
	)
	jobs = _safe_list(
		"RQ Job",
		fields=["job_name", "queue", "status", "creation"],
		order_by="creation desc",
		limit_page_length=100,
	)
	queued = sum(1 for row in jobs if row.status in {"queued", "deferred", "scheduled"})
	failed = sum(
		1
		for row in jobs
		if row.status == "failed" and row.creation and row.creation >= add_days(now_datetime(), -1)
	)
	active_users = _count("User", {"enabled": 1, "user_type": "System User"})
	total_users = _count("User", {"user_type": "System User"})
	role_items = [
		_item(role, trailing=str(_count("Has Role", {"role": role})))
		for role in (
			"Employee",
			"Leave Approver",
			"Expense Approver",
			"HR User",
			"HR Manager",
			"System Manager",
		)
	]
	return {
		"title": f"All services connected, {failed} jobs failing",
		"subtitle": f"Site {frappe.local.site} · scheduler and access overview.",
		"primary_action": "Review failed jobs",
		"metrics": [
			_metric("Site status", "Online", tone="success"),
			_metric("Queued jobs", queued, tone="attention" if queued else "success"),
			_metric("Failed 24h", failed, tone="danger" if failed else "success"),
			_metric("Active users", f"{active_users}/{total_users}"),
		],
		"panels": [
			_panel(
				"Background jobs",
				[
					_item(row.job_name or "Background job", row.queue, row.status, row.status)
					for row in jobs[:8]
				],
				f"{failed} failed",
			),
			_panel("Roles assigned", role_items),
			_panel(
				"Recent errors",
				[
					_item(
						row.method or "Application error", row.reference_doctype, str(row.creation), "overdue"
					)
					for row in errors
				],
				str(len(errors)),
			),
		],
	}
