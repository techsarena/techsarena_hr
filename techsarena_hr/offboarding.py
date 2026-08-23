"""Employee offboarding — separation, clearance and final settlement.

The gap this closes: the app could hire and onboard but had no exit workflow at
all. An employee simply stopped appearing once someone flipped their status by
hand in Desk, which left leave balances unencashed, loans outstanding, funds
unpaid and gratuity uncalculated — the gratuity module existed with nothing to
trigger it.

Design, in one line: **HRMS's own ``Employee Separation`` is the workflow; this
module is the facade over it plus the settlement HRMS does not compute.**

* Separation creates a Project and a Task per checklist activity (see
  ``EmployeeBoardingController``), so clearance tracking is real project work
  with real assignees — not a bespoke status column.
* ``exit_summary`` is the settlement view: what the company still owes the
  employee (leave encashment, fund balances, gratuity) and what the employee
  still owes the company (outstanding loan principal). It **computes and
  reports; it never posts.** Paying it out is a payroll action taken
  deliberately, not a side effect of opening a screen.
* Marking an employee Left is gated on the checklist actually being complete,
  so the record cannot be closed with clearance outstanding.
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, getdate, nowdate

#: Statuses that mean the person has gone. Kept as a set because several
#: queries need "still here" and the negation is easy to get wrong inline.
DEPARTED_STATUSES = ("Left", "Inactive")


def _hr_user() -> str:
	from techsarena_hr.api import HR_ROLES, _require_hrms, _require_login

	user = _require_login()
	_require_hrms()
	if not set(frappe.get_roles(user)).intersection(HR_ROLES):
		frappe.throw(_("You do not have access to offboarding."), frappe.PermissionError)
	return user


def _separation_available() -> bool:
	return frappe.db.table_exists("Employee Separation")


# --------------------------------------------------------------------------- #
# Separation records
# --------------------------------------------------------------------------- #


@frappe.whitelist()
def offboarding_queue() -> dict:
	"""Every open separation plus its clearance progress. HR only."""
	_hr_user()
	if not _separation_available():
		return {"separations": [], "templates": [], "available": False}

	rows = frappe.get_all(
		"Employee Separation",
		filters={"docstatus": ["!=", 2]},
		fields=[
			"name",
			"employee",
			"employee_name",
			"company",
			"department",
			"designation",
			"boarding_status",
			"boarding_begins_on",
			"resignation_letter_date",
			"employee_separation_template",
			"project",
			"docstatus",
		],
		order_by="boarding_begins_on desc, creation desc",
		limit_page_length=100,
	)
	if rows:
		_attach_progress(rows)
		# The employee's own exit fields live on Employee, not on the
		# separation — surfaced here so the queue can show a relieving date
		# without a round-trip per row.
		employees = {row.employee for row in rows if row.employee}
		exits = {
			row.name: row
			for row in frappe.get_all(
				"Employee",
				filters={"name": ["in", list(employees)]},
				fields=["name", "status", "relieving_date", "reason_for_leaving"],
				limit_page_length=0,
			)
		} if employees else {}
		for row in rows:
			record = exits.get(row.employee)
			row["employee_status"] = record.status if record else None
			row["relieving_date"] = str(record.relieving_date) if record and record.relieving_date else None
			row["reason_for_leaving"] = record.reason_for_leaving if record else None

	templates = frappe.get_all(
		"Employee Separation Template",
		fields=["name", "department", "designation"],
		limit_page_length=0,
	) if frappe.db.table_exists("Employee Separation Template") else []

	return {"separations": rows, "templates": templates, "available": True}


def _attach_progress(rows: list) -> None:
	"""Fold each separation's activities and their Tasks onto its row.

	Three queries total regardless of how many separations are open — the
	activities, their tasks, and nothing per row.
	"""
	names = [row.name for row in rows]
	activities = frappe.get_all(
		"Employee Boarding Activity",
		filters={"parent": ["in", names], "parenttype": "Employee Separation"},
		fields=["name", "parent", "activity_name", "user", "role", "task", "description", "idx"],
		order_by="parent asc, idx asc",
		limit_page_length=0,
	)
	task_names = [a.task for a in activities if a.task]
	tasks = {}
	if task_names:
		tasks = {
			t.name: t
			for t in frappe.get_all(
				"Task",
				filters={"name": ["in", task_names]},
				fields=["name", "status", "exp_start_date", "exp_end_date"],
				limit_page_length=0,
			)
		}

	by_parent: dict[str, list[dict]] = {}
	for activity in activities:
		task = tasks.get(activity.task) if activity.task else None
		by_parent.setdefault(activity.parent, []).append(
			{
				"activity_name": activity.activity_name,
				"user": activity.user,
				"role": activity.role,
				"task": activity.task,
				"description": activity.description,
				"status": (task.status if task else None) or "Pending",
				"exp_end_date": str(task.exp_end_date) if task and task.exp_end_date else None,
			}
		)

	for row in rows:
		items = by_parent.get(row.name, [])
		done = sum(1 for item in items if item["status"] in ("Completed", "Cancelled"))
		row["activities"] = items
		row["activities_total"] = len(items)
		row["activities_done"] = done
		row["clearance_complete"] = bool(items) and done == len(items)


@frappe.whitelist(methods=["POST"])
def start_separation(
	employee: str,
	boarding_begins_on: str | None = None,
	resignation_letter_date: str | None = None,
	relieving_date: str | None = None,
	reason_for_leaving: str | None = None,
	employee_separation_template: str | None = None,
	exit_interview: str | None = None,
) -> dict:
	"""Open a separation for an employee and start the clearance checklist.

	Submitting the Employee Separation is what creates the Project and the per
	-activity Tasks, so this submits rather than leaving a draft: a draft
	checklist assigns nobody and tracks nothing.
	"""
	_hr_user()
	if not _separation_available():
		frappe.throw(_("Employee Separation is not available on this site."), frappe.ValidationError)

	record = frappe.db.get_value(
		"Employee",
		employee,
		["name", "status", "company", "department", "designation", "grade", "date_of_joining"],
		as_dict=True,
	)
	if not record:
		frappe.throw(_("Employee {0} was not found.").format(employee), frappe.DoesNotExistError)
	if record.status in DEPARTED_STATUSES:
		frappe.throw(
			_("{0} has already left the company.").format(employee), frappe.ValidationError
		)

	existing = frappe.db.get_value(
		"Employee Separation", {"employee": employee, "docstatus": ["<", 2]}, "name"
	)
	if existing:
		frappe.throw(
			_("Separation {0} is already open for this employee.").format(existing),
			frappe.ValidationError,
		)

	begins = getdate(boarding_begins_on) if boarding_begins_on else getdate(nowdate())
	doc = frappe.new_doc("Employee Separation")
	doc.employee = employee
	doc.company = record.company
	doc.department = record.department
	doc.designation = record.designation
	doc.employee_grade = record.grade
	doc.boarding_begins_on = begins
	doc.resignation_letter_date = (
		getdate(resignation_letter_date) if resignation_letter_date else begins
	)
	if employee_separation_template:
		doc.employee_separation_template = employee_separation_template
	if exit_interview:
		doc.exit_interview = exit_interview
	doc.insert()
	# Submitting spins up the Project + Tasks via EmployeeBoardingController.
	doc.submit()

	# Record the intended exit on the Employee now, so payroll and the
	# settlement view can see it while clearance is still running. The status
	# itself only changes at complete_separation.
	updates = {}
	if relieving_date:
		updates["relieving_date"] = getdate(relieving_date)
	if reason_for_leaving:
		updates["reason_for_leaving"] = reason_for_leaving
	if resignation_letter_date:
		updates["resignation_letter_date"] = getdate(resignation_letter_date)
	if updates:
		frappe.db.set_value("Employee", employee, updates)

	return {
		"name": doc.name,
		"employee": employee,
		"project": doc.project,
		"boarding_status": doc.boarding_status,
	}


@frappe.whitelist()
def separation_detail(name: str) -> dict:
	"""One separation in full, with its clearance checklist and settlement."""
	_hr_user()
	if not frappe.db.exists("Employee Separation", name):
		frappe.throw(_("Separation {0} was not found.").format(name), frappe.DoesNotExistError)

	doc = frappe.get_doc("Employee Separation", name)
	rows = [
		frappe._dict(
			{
				"name": doc.name,
				"employee": doc.employee,
				"employee_name": doc.employee_name,
				"company": doc.company,
				"department": doc.department,
				"designation": doc.designation,
				"boarding_status": doc.boarding_status,
				"boarding_begins_on": str(doc.boarding_begins_on) if doc.boarding_begins_on else None,
				"resignation_letter_date": str(doc.resignation_letter_date)
				if doc.resignation_letter_date
				else None,
				"employee_separation_template": doc.employee_separation_template,
				"project": doc.project,
				"docstatus": doc.docstatus,
			}
		)
	]
	_attach_progress(rows)
	payload = dict(rows[0])
	payload["exit_interview"] = doc.exit_interview
	payload["settlement"] = exit_summary(doc.employee)
	return payload


@frappe.whitelist(methods=["POST"])
def complete_separation(
	name: str, relieving_date: str | None = None, force: int | str = 0
) -> dict:
	"""Close a separation: mark the employee Left as of their relieving date.

	Refuses while clearance activities are still open unless ``force`` is set,
	so the record cannot be closed with equipment unreturned or accounts still
	provisioned. ``force`` exists because a real exit sometimes has a task
	nobody will ever close; it is recorded on the employee as an explicit
	override rather than silently allowed.
	"""
	user = _hr_user()
	if not frappe.db.exists("Employee Separation", name):
		frappe.throw(_("Separation {0} was not found.").format(name), frappe.DoesNotExistError)

	doc = frappe.get_doc("Employee Separation", name)
	rows = [frappe._dict({"name": doc.name})]
	_attach_progress(rows)
	outstanding = [
		item["activity_name"]
		for item in rows[0]["activities"]
		if item["status"] not in ("Completed", "Cancelled")
	]
	if outstanding and not cint(force):
		frappe.throw(
			_("{0} clearance activities are still open: {1}. Complete them or override.").format(
				len(outstanding), ", ".join(outstanding[:5])
			),
			frappe.ValidationError,
		)

	employee_doc = frappe.get_doc("Employee", doc.employee)
	relieving = (
		getdate(relieving_date)
		if relieving_date
		else (employee_doc.relieving_date or getdate(nowdate()))
	)
	if employee_doc.date_of_joining and relieving < getdate(employee_doc.date_of_joining):
		frappe.throw(
			_("The relieving date cannot be before the date of joining."), frappe.ValidationError
		)

	# Settlement is captured *before* the status flips: several of its inputs
	# (leave balance, the last salary slip) read differently once the employee
	# is no longer Active, and this snapshot is what HR reconciles against.
	settlement = exit_summary(doc.employee)

	employee_doc.relieving_date = relieving
	employee_doc.status = "Left"
	employee_doc.save()

	note = _("Separation {0} completed by {1}.").format(name, user)
	if outstanding:
		note += " " + _("Overridden with {0} activities still open: {1}.").format(
			len(outstanding), ", ".join(outstanding)
		)
	employee_doc.add_comment("Comment", text=note)

	frappe.db.set_value("Employee Separation", name, "boarding_status", "Completed")
	return {
		"name": name,
		"employee": doc.employee,
		"status": "Left",
		"relieving_date": str(relieving),
		"overridden": bool(outstanding),
		"settlement": settlement,
	}


# --------------------------------------------------------------------------- #
# Final settlement
# --------------------------------------------------------------------------- #


def _leave_encashment_due(employee: str) -> dict:
	"""Unused balance on encashable leave types, and its cash value.

	Per-day rate is the last salary slip's gross over 30 — the conventional
	basis. It is reported as an estimate rather than posted, because the real
	rate depends on the company's own encashment component.
	"""
	rows = []
	total_days = 0.0
	if not frappe.db.table_exists("Leave Type"):
		return {"rows": [], "total_days": 0.0, "estimated_amount": 0.0, "per_day": 0.0}

	encashable = frappe.get_all("Leave Type", filters={"allow_encashment": 1}, pluck="name")
	if encashable:
		from hrms.hr.doctype.leave_application.leave_application import get_leave_details

		details = get_leave_details(employee, nowdate()).get("leave_allocation", {})
		for leave_type in encashable:
			remaining = flt(details.get(leave_type, {}).get("remaining_leaves", 0))
			if remaining > 0:
				rows.append({"leave_type": leave_type, "days": remaining})
				total_days += remaining

	slip = frappe.get_all(
		"Salary Slip",
		filters={"employee": employee, "docstatus": 1},
		fields=["gross_pay"],
		order_by="end_date desc",
		limit_page_length=1,
	)
	per_day = flt(slip[0].gross_pay) / 30.0 if slip else 0.0
	return {
		"rows": rows,
		"total_days": total_days,
		"per_day": per_day,
		"estimated_amount": total_days * per_day,
	}


def _outstanding_loans(employee: str) -> dict:
	"""What the employee still owes on any loan. Recovered from settlement."""
	if not frappe.db.table_exists("Loan"):
		return {"rows": [], "total": 0.0}
	rows = frappe.get_all(
		"Loan",
		filters={"applicant": employee, "applicant_type": "Employee", "docstatus": 1},
		fields=["name", "loan_product", "total_payment", "total_amount_paid", "status"],
		limit_page_length=0,
	)
	out = []
	total = 0.0
	for row in rows:
		outstanding = flt(row.total_payment) - flt(row.total_amount_paid)
		if outstanding > 0:
			out.append(
				{
					"loan": row.name,
					"loan_product": row.loan_product,
					"outstanding": outstanding,
					"status": row.status,
				}
			)
			total += outstanding
	return {"rows": out, "total": total}


def _fund_balances(employee: str) -> dict:
	"""EOBI / Provident Fund balances payable on exit."""
	from techsarena_hr.funds import DOCTYPE, FUND_TYPES, _balance

	if not frappe.db.table_exists(DOCTYPE):
		return {"rows": [], "total": 0.0}
	rows = []
	total = 0.0
	for fund_type in FUND_TYPES:
		balance = _balance(employee, fund_type)
		if balance:
			rows.append({"fund_type": fund_type, "balance": balance})
			total += balance
	return {"rows": rows, "total": total}


def _gratuity_estimate(employee: str) -> dict:
	"""Gratuity payable, using the app's own rule engine where one is set up.

	Returns ``{"available": False}`` rather than a zero when no Gratuity Rule is
	configured — an unconfigured rule is not the same as nothing owed, and
	showing 0 would be read as a settled figure.
	"""
	if not frappe.db.table_exists("Gratuity Rule"):
		return {"available": False, "reason": "Gratuity is not set up on this site."}

	existing = frappe.db.get_value(
		"Gratuity Payment",
		{"employee": employee, "docstatus": ["<", 2]},
		["name", "amount", "status"],
		as_dict=True,
	)
	if existing:
		return {
			"available": True,
			"already_raised": True,
			"payment": existing.name,
			"amount": flt(existing.amount),
			"status": existing.status,
		}

	# Employee Grade carries no gratuity rule in this schema, so there is no
	# per-employee default to read: fall back to the single configured rule when
	# there is exactly one, and refuse to guess when there are several.
	rules = frappe.get_all("Gratuity Rule", pluck="name", limit_page_length=0)
	if not rules:
		return {"available": False, "reason": "No Gratuity Rule is configured."}
	if len(rules) > 1:
		return {
			"available": False,
			"reason": "Several Gratuity Rules exist; pick one to compute gratuity.",
			"rules": rules,
		}
	rule = rules[0]

	try:
		from techsarena_hr.gratuity.gratuity_calculation import calculate_amount, get_service_period

		period = get_service_period(employee, rule)
		result = calculate_amount(employee, rule, period)
		return {
			"available": True,
			"already_raised": False,
			"rule": rule,
			"service_years": period.get("years"),
			"service_months": period.get("months"),
			"amount": flt(result.get("amount")),
		}
	except Exception as error:
		# A missing relieving date or salary slip makes gratuity uncomputable;
		# say so rather than failing the whole settlement view.
		return {"available": False, "reason": str(error)}


@frappe.whitelist()
def exit_summary(employee: str) -> dict:
	"""Final settlement for one employee: what is owed, both directions.

	**Reports only — posts nothing.** Every figure here is an input to a payroll
	decision a human makes; computing it is safe, paying it is not.
	"""
	_hr_user()
	record = frappe.db.get_value(
		"Employee",
		employee,
		["name", "employee_name", "status", "date_of_joining", "relieving_date", "company"],
		as_dict=True,
	)
	if not record:
		frappe.throw(_("Employee {0} was not found.").format(employee), frappe.DoesNotExistError)

	encashment = _leave_encashment_due(employee)
	funds = _fund_balances(employee)
	gratuity = _gratuity_estimate(employee)
	loans = _outstanding_loans(employee)

	payable = flt(encashment["estimated_amount"]) + flt(funds["total"])
	if gratuity.get("available"):
		payable += flt(gratuity.get("amount"))
	recoverable = flt(loans["total"])

	# Anything still in flight blocks a clean settlement — an unapproved claim
	# or an unsubmitted slip changes the number after it has been agreed.
	pending = []
	open_claims = frappe.db.count(
		"Expense Claim", {"employee": employee, "docstatus": 0}
	)
	if open_claims:
		pending.append({"kind": "expense_claim", "count": open_claims})
	open_leave = frappe.db.count(
		"Leave Application", {"employee": employee, "status": "Open", "docstatus": 0}
	)
	if open_leave:
		pending.append({"kind": "leave_application", "count": open_leave})
	draft_slips = frappe.db.count("Salary Slip", {"employee": employee, "docstatus": 0})
	if draft_slips:
		pending.append({"kind": "salary_slip", "count": draft_slips})

	return {
		"employee": employee,
		"employee_name": record.employee_name,
		"status": record.status,
		"company": record.company,
		"date_of_joining": str(record.date_of_joining) if record.date_of_joining else None,
		"relieving_date": str(record.relieving_date) if record.relieving_date else None,
		"leave_encashment": encashment,
		"funds": funds,
		"gratuity": gratuity,
		"loans": loans,
		"total_payable": payable,
		"total_recoverable": recoverable,
		"net_settlement": payable - recoverable,
		"pending_items": pending,
		# The figures are estimates until payroll posts them; the client must
		# not present them as a final payslip.
		"is_estimate": True,
	}


@frappe.whitelist(methods=["POST"])
def raise_gratuity_payment(employee: str, gratuity_rule: str | None = None) -> dict:
	"""Create a draft Gratuity Payment for an exiting employee. HR only.

	Deliberately left as a **draft**: submitting it books the liability, which is
	an accounting decision for whoever runs payroll, not for the offboarding
	screen. This closes the audit's "gratuity has no trigger" gap without
	turning offboarding into an unreviewed payment path.
	"""
	_hr_user()
	if not frappe.db.table_exists("Gratuity Payment"):
		frappe.throw(_("Gratuity is not set up on this site."), frappe.ValidationError)

	record = frappe.db.get_value(
		"Employee",
		employee,
		["name", "employee_name", "company", "department", "designation", "relieving_date", "grade"],
		as_dict=True,
	)
	if not record:
		frappe.throw(_("Employee {0} was not found.").format(employee), frappe.DoesNotExistError)
	if not record.relieving_date:
		frappe.throw(
			_("Set a relieving date for {0} before raising gratuity.").format(employee),
			frappe.ValidationError,
		)

	existing = frappe.db.get_value(
		"Gratuity Payment", {"employee": employee, "docstatus": ["<", 2]}, "name"
	)
	if existing:
		frappe.throw(
			_("Gratuity Payment {0} already exists for this employee.").format(existing),
			frappe.ValidationError,
		)

	if not gratuity_rule:
		# No per-grade default exists in this schema; only auto-pick when the
		# choice is unambiguous, rather than silently using an arbitrary rule.
		rules = frappe.get_all("Gratuity Rule", pluck="name", limit_page_length=0)
		if not rules:
			frappe.throw(_("No Gratuity Rule is configured."), frappe.ValidationError)
		if len(rules) > 1:
			frappe.throw(
				_("Several Gratuity Rules exist. Choose which one applies."),
				frappe.ValidationError,
			)
		gratuity_rule = rules[0]
	elif not frappe.db.exists("Gratuity Rule", gratuity_rule):
		frappe.throw(
			_("Gratuity Rule {0} was not found.").format(gratuity_rule), frappe.DoesNotExistError
		)

	from techsarena_hr.gratuity.gratuity_calculation import calculate_amount, get_service_period

	period = get_service_period(employee, gratuity_rule)
	computed = calculate_amount(employee, gratuity_rule, period)

	doc = frappe.new_doc("Gratuity Payment")
	doc.employee = employee
	doc.employee_name = record.employee_name
	doc.company = record.company
	doc.department = record.department
	doc.designation = record.designation
	doc.gratuity_rule = gratuity_rule
	doc.posting_date = nowdate()
	doc.payroll_date = record.relieving_date
	doc.status = "Draft"
	doc.current_work_experience = flt(period.get("current_work_experience"))
	doc.years = cint(period.get("years"))
	doc.months = cint(period.get("months"))
	doc.days = cint(period.get("days"))
	doc.amount = flt(computed.get("amount"))
	doc.insert()

	return {
		"name": doc.name,
		"employee": employee,
		"amount": flt(doc.amount),
		"status": doc.status,
		"submitted": False,
	}
