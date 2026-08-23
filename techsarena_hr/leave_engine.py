"""Leave engine extensions: manual balance adjustments, unpaid-leave deductions
and a scheduled monthly accrual.

Balances live in HRMS's Leave Ledger Entry (the ledger is the source of truth;
a balance is the sum of its rows within an allocation period). A manual
adjustment is therefore just another submitted ledger row of transaction type
``Leave Allocation`` tied to the employee's active allocation — positive to
grant, negative to deduct. Every adjustment also drops an audit Comment on the
Employee so HR can see who changed what and why.
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import cint, flt, get_first_day, get_last_day, nowdate

ADJUSTMENT_TAG = "[Techsarena Leave Adjustment]"


def _hr_user() -> str:
	from techsarena_hr.api import _require_hrms, _require_login

	user = _require_login()
	_require_hrms()
	from techsarena_hr.api import HR_ROLES

	if not set(frappe.get_roles(user)).intersection(HR_ROLES):
		frappe.throw(_("You do not have access to leave administration."), frappe.PermissionError)
	return user


def _active_allocation(employee: str, leave_type: str) -> frappe._dict | None:
	rows = frappe.get_all(
		"Leave Allocation",
		filters={
			"employee": employee,
			"leave_type": leave_type,
			"docstatus": 1,
			"from_date": ["<=", nowdate()],
			"to_date": [">=", nowdate()],
		},
		fields=["name", "from_date", "to_date", "company"],
		order_by="to_date desc",
		limit_page_length=1,
	)
	return rows[0] if rows else None


def _balance(employee: str, leave_type: str) -> float:
	from hrms.hr.doctype.leave_application.leave_application import get_leave_details

	details = get_leave_details(employee, nowdate()).get("leave_allocation", {})
	return flt(details.get(leave_type, {}).get("remaining_leaves", 0))


def _lock_allocation(allocation_name: str) -> None:
	"""Serialise concurrent adjustments against one allocation.

	``_balance`` reads the ledger and the caller then writes to it. Without a
	lock that is a check-then-act: two deductions can both read the same
	pre-balance, both pass the "would this go below zero" test, and both commit —
	driving the balance negative. Locking the allocation row makes the second
	caller wait until the first has committed, so it reads the post-write
	balance.
	"""
	frappe.db.get_value("Leave Allocation", allocation_name, "name", for_update=True)


@frappe.whitelist(methods=["POST"])
def adjust_leave_balance(employee: str, leave_type: str, days, reason: str | None = None) -> dict:
	"""Grant (+) or deduct (-) leave for one employee, audited. HR only."""
	user = _hr_user()
	days = flt(days)
	if not days:
		frappe.throw(_("Enter a non-zero number of days to adjust."))
	if not frappe.db.exists("Employee", employee):
		frappe.throw(_("Employee {0} was not found.").format(employee), frappe.DoesNotExistError)

	allocation = _active_allocation(employee, leave_type)
	if not allocation:
		frappe.throw(
			_("{0} has no active {1} allocation to adjust. Assign a leave policy first.").format(
				employee, leave_type
			)
		)

	# Lock before reading the balance, so the check and the write that follows
	# are one atomic decision rather than a race between concurrent adjustments.
	_lock_allocation(allocation.name)

	before = _balance(employee, leave_type)
	if before + days < 0:
		frappe.throw(
			_("That deduction would push the balance below zero (current {0}).").format(before)
		)

	ledger = frappe.get_doc(
		{
			"doctype": "Leave Ledger Entry",
			"employee": employee,
			"leave_type": leave_type,
			"transaction_type": "Leave Allocation",
			"transaction_name": allocation.name,
			"leaves": days,
			"from_date": allocation.from_date,
			"to_date": allocation.to_date,
			"company": allocation.company,
			"holiday_list": frappe.db.get_value("Employee", employee, "holiday_list"),
		}
	)
	# Insert then submit, rather than forcing docstatus=1 in the dict. Setting
	# docstatus on a new doc skips the submit lifecycle entirely: on_submit never
	# fires and HRMS's own Leave Ledger Entry validations never run, so the row
	# lands in the ledger having never been checked against its allocation.
	ledger.insert(ignore_permissions=True)
	ledger.submit()

	note = f"{ADJUSTMENT_TAG} {days:+g} {leave_type} by {user}: {reason or 'no reason given'}"
	frappe.get_doc(
		{
			"doctype": "Comment",
			"comment_type": "Info",
			"reference_doctype": "Employee",
			"reference_name": employee,
			"content": note,
		}
	).insert(ignore_permissions=True)
	frappe.db.commit()

	return {
		"employee": employee,
		"leave_type": leave_type,
		"adjusted": days,
		"balance_before": before,
		"balance_after": _balance(employee, leave_type),
		"ledger_entry": ledger.name,
	}


@frappe.whitelist()
def leave_adjustments(employee: str | None = None) -> dict:
	"""Adjustment workspace: adjustable employees, leave types, balances and the
	recent audit trail. HR only."""
	_hr_user()
	employees = frappe.get_all(
		"Employee",
		filters={"status": "Active"},
		fields=["name", "employee_name", "department"],
		order_by="employee_name asc",
		limit_page_length=0,
	)
	leave_types = frappe.get_all("Leave Type", pluck="name", order_by="name asc")

	balances: list[dict] = []
	if employee:
		from hrms.hr.doctype.leave_application.leave_application import get_leave_details

		details = get_leave_details(employee, nowdate()).get("leave_allocation", {})
		balances = [
			{
				"leave_type": lt,
				"allocated": flt(v.get("total_leaves", 0)),
				"remaining": flt(v.get("remaining_leaves", 0)),
				"taken": flt(v.get("leaves_taken", 0)),
			}
			for lt, v in details.items()
		]

	history = frappe.get_all(
		"Comment",
		filters={
			"reference_doctype": "Employee",
			"comment_type": "Info",
			"content": ["like", f"{ADJUSTMENT_TAG}%"],
		},
		fields=["reference_name as employee", "content", "creation"],
		order_by="creation desc",
		limit_page_length=40,
	)
	return {
		"employees": employees,
		"leave_types": leave_types,
		"selected": employee,
		"balances": balances,
		"history": history,
	}


@frappe.whitelist()
def leave_deductions(from_date: str | None = None, to_date: str | None = None) -> dict:
	"""Unpaid-leave (LWP) days per employee in a period — the leave-driven payroll
	deduction. HR only."""
	_hr_user()
	start = from_date or str(get_first_day(nowdate()))
	end = to_date or str(get_last_day(nowdate()))
	lwp_types = frappe.get_all("Leave Type", filters={"is_lwp": 1}, pluck="name")
	rows: list[dict] = []
	if lwp_types:
		applications = frappe.get_all(
			"Leave Application",
			filters={
				"docstatus": 1,
				"status": "Approved",
				"leave_type": ["in", lwp_types],
				"from_date": ["<=", end],
				"to_date": [">=", start],
			},
			fields=["employee", "employee_name", "leave_type", "total_leave_days"],
			limit_page_length=0,
		)
		tally: dict[str, dict] = {}
		for app in applications:
			row = tally.setdefault(
				app.employee,
				{"employee": app.employee, "employee_name": app.employee_name, "lwp_days": 0.0},
			)
			row["lwp_days"] += flt(app.total_leave_days)
		rows = sorted(tally.values(), key=lambda r: r["lwp_days"], reverse=True)
	return {
		"from_date": start,
		"to_date": end,
		"lwp_leave_types": lwp_types,
		"deductions": rows,
		"total_lwp_days": sum(r["lwp_days"] for r in rows),
	}


def run_scheduled_leave_adjustments() -> dict:
	"""Monthly scheduler hook: accrue a configured number of days to a configured
	leave type for every active employee, once per month, idempotently.

	Off unless ``techsarena_leave_monthly_accrual`` (days) and
	``techsarena_leave_accrual_type`` (leave type) are set in site config — so it
	never changes balances on a site that hasn't opted in. The monthly marker
	Comment makes a second run in the same month a no-op.
	"""
	days = flt(frappe.conf.get("techsarena_leave_monthly_accrual"))
	leave_type = frappe.conf.get("techsarena_leave_accrual_type")
	if not days or not leave_type:
		return {"skipped": "not configured"}

	period = nowdate()[:7]  # YYYY-MM
	marker = f"{ADJUSTMENT_TAG} monthly accrual {period}"
	if frappe.db.exists("Comment", {"comment_type": "Info", "content": marker}):
		return {"skipped": f"already ran for {period}"}

	# Claim the month *before* accruing anything, and commit that claim.
	#
	# adjust_leave_balance commits per employee. With the marker written only at
	# the end, a crash partway through left hundreds of committed accruals and no
	# marker — so the next run repeated every one of them and silently inflated
	# balances. Writing the marker first makes a crash fail closed: the month is
	# already claimed, so a rerun is a no-op and HR reconciles the shortfall
	# deliberately rather than the job doubling up on its own.
	frappe.get_doc(
		{
			"doctype": "Comment",
			"comment_type": "Info",
			"reference_doctype": "Employee",
			"reference_name": "run",
			"content": marker,
		}
	).insert(ignore_permissions=True)
	frappe.db.commit()

	# The scheduler runs as Administrator already, but adjust_leave_balance calls
	# _hr_user() and the worker's session user is not guaranteed. Switch once,
	# and restore in a finally: the previous version called set_user inside the
	# loop and never restored it, leaving every subsequent job in that worker
	# running as Administrator.
	original_user = frappe.session.user
	accrued = 0
	failed = 0
	try:
		frappe.set_user("Administrator")
		for employee in frappe.get_all("Employee", filters={"status": "Active"}, pluck="name"):
			if not _active_allocation(employee, leave_type):
				continue
			try:
				adjust_leave_balance(employee, leave_type, days, f"Monthly accrual {period}")
				accrued += 1
			except Exception:
				failed += 1
				# Roll back this employee's partial work so the next iteration
				# starts from a clean transaction, then keep going.
				frappe.db.rollback()
				frappe.log_error(
					title="Techsarena leave accrual failed",
					message=f"employee={employee} leave_type={leave_type} period={period}",
				)
	finally:
		frappe.set_user(original_user)

	return {
		"period": period,
		"leave_type": leave_type,
		"days_each": days,
		"employees_accrued": accrued,
		"employees_failed": failed,
	}
