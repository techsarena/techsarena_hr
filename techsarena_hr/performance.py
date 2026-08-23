"""Performance: goal progress, self-assessment and reviewer feedback.

Closes the audit's read-only gap. ``hr.js`` previously carried the note that
``rate_goal`` and ``submit_self_assessment`` "are not implemented server-side,
so the screen stays read-only" — an appraisal you cannot respond to is not an
appraisal cycle, it is a report.

Scoring is **never computed here.** HRMS's ``Appraisal`` owns the arithmetic
(``calculate_self_appraisal_score`` weights each rating by its criteria
weightage and the configured star count; ``calculate_final_score`` may run a
site-defined formula off the Appraisal Cycle). This module writes the inputs
and lets the document recalculate, so the dashboard and Desk always agree.

Rating scale note: HRMS stores ``Employee Feedback Rating.rating`` as a
**0–1 fraction** and multiplies by the star count when scoring. The endpoints
here accept a 1–5 star value because that is what a UI collects, and convert —
see ``_to_fraction``. Sending a raw 0.6 would silently score as 0.6 stars.
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import cint, flt, nowdate

#: Goal statuses HRMS allows. Progress drives the first three automatically;
#: the rest are explicit choices.
GOAL_STATUSES = ("Pending", "In Progress", "Completed", "Archived", "Closed")


def _employee_user() -> tuple[str, str]:
	from techsarena_hr.api import _require_employee_user, _require_hrms, _require_login

	user = _require_login()
	_require_hrms()
	return _require_employee_user(user)


def _star_count() -> int:
	"""How many stars a rating field offers on this site (default 5)."""
	try:
		meta = frappe.get_meta("Employee Feedback Rating")
		return cint(meta.get_options("rating")) or 5
	except Exception:
		return 5


def _to_fraction(rating) -> float:
	"""Convert a 1–N star rating to the 0–1 fraction HRMS stores.

	Accepts a value already expressed as a fraction (<= 1) unchanged, so a
	client that sends HRMS's native form is not double-converted.
	"""
	value = flt(rating)
	if value <= 0:
		return 0.0
	stars = _star_count()
	if value <= 1:
		return min(1.0, value)
	return min(1.0, value / stars)


# --------------------------------------------------------------------------- #
# Goals
# --------------------------------------------------------------------------- #


@frappe.whitelist(methods=["POST"])
def rate_goal(name: str, progress, status: str | None = None) -> dict:
	"""Update progress on one of the signed-in employee's own goals.

	Ownership is checked against the session's employee rather than the Goal's
	``user`` field: ``user`` is a plain Data field on Goal, so it is not a
	trustworthy authorisation key.

    Status follows progress unless the caller names one explicitly, which keeps
    a goal at 100% from sitting on "In Progress" forever.
	"""
	_unused_user, employee = _employee_user()
	if not frappe.db.table_exists("Goal"):
		frappe.throw(_("Goals are not available on this site."), frappe.ValidationError)
	if not frappe.db.exists("Goal", name):
		frappe.throw(_("Goal {0} was not found.").format(name), frappe.DoesNotExistError)

	doc = frappe.get_doc("Goal", name)
	if doc.employee != employee:
		frappe.throw(_("You can only update your own goals."), frappe.PermissionError)
	if doc.is_group:
		frappe.throw(
			_("This is a parent goal; its progress is rolled up from its children."),
			frappe.ValidationError,
		)

	value = flt(progress)
	if value < 0 or value > 100:
		frappe.throw(_("Progress must be between 0 and 100."), frappe.ValidationError)

	if status and status not in GOAL_STATUSES:
		frappe.throw(_("Unsupported goal status."), frappe.ValidationError)
	if doc.status in ("Archived", "Closed") and not status:
		frappe.throw(
			_("This goal is {0} and can no longer be updated.").format(doc.status),
			frappe.ValidationError,
		)

	doc.progress = value
	doc.status = status or (
		"Completed" if value >= 100 else "In Progress" if value > 0 else "Pending"
	)
	doc.save()
	return {"name": doc.name, "progress": flt(doc.progress), "status": doc.status}


# --------------------------------------------------------------------------- #
# Appraisal: self-assessment
# --------------------------------------------------------------------------- #


@frappe.whitelist()
def appraisal_detail(name: str) -> dict:
	"""One appraisal with everything the self-assessment screen needs.

	Readable by the appraisee, their reporting manager, and HR — a reviewer
	needs the rating criteria to leave feedback against.
	"""
	from techsarena_hr.api import HR_ROLES, _current_employee, _require_hrms, _require_login

	user = _require_login()
	_require_hrms()
	if not frappe.db.exists("Appraisal", name):
		frappe.throw(_("Appraisal {0} was not found.").format(name), frappe.DoesNotExistError)

	doc = frappe.get_doc("Appraisal", name)
	own = _current_employee(user, required=False)
	is_hr = bool(set(frappe.get_roles(user)).intersection(HR_ROLES))
	manages = own and frappe.db.get_value("Employee", doc.employee, "reports_to") == own
	if doc.employee != own and not is_hr and not manages:
		frappe.throw(_("You cannot view this appraisal."), frappe.PermissionError)

	stars = _star_count()
	return {
		"name": doc.name,
		"employee": doc.employee,
		"employee_name": doc.employee_name,
		"appraisal_cycle": doc.appraisal_cycle,
		"start_date": str(doc.start_date) if doc.start_date else None,
		"end_date": str(doc.end_date) if doc.end_date else None,
		"docstatus": doc.docstatus,
		"reflections": doc.reflections,
		"remarks": doc.remarks,
		"scores": {
			"goal_score": flt(doc.total_score),
			"self_score": flt(doc.self_score),
			"avg_feedback_score": flt(doc.avg_feedback_score),
			"final_score": flt(doc.final_score),
			"goal_score_percentage": flt(doc.goal_score_percentage),
		},
		"kras": [
			{
				"kra": row.kra,
				"per_weightage": flt(row.per_weightage),
				"goal_completion": flt(row.goal_completion),
				"goal_score": flt(row.goal_score),
			}
			for row in (doc.get("appraisal_kra") or [])
		],
		# Criteria the employee rates themselves against, with whatever they
		# have already saved. `rating` is echoed back in stars, matching what
		# the write endpoints accept.
		"self_ratings": [
			{
				"criteria": row.criteria,
				"per_weightage": flt(row.per_weightage),
				"rating": flt(row.rating) * stars,
			}
			for row in (doc.get("self_ratings") or [])
		],
		"star_count": stars,
		"is_self": doc.employee == own,
		"can_review": bool(is_hr or manages),
		"feedback": _feedback_for(doc.name),
	}


def _feedback_for(appraisal: str) -> list[dict]:
	"""Submitted reviewer feedback on an appraisal."""
	if not frappe.db.table_exists("Employee Performance Feedback"):
		return []
	return [
		{
			"name": row.name,
			"reviewer": row.reviewer,
			"reviewer_name": row.reviewer_name,
			"reviewer_designation": row.reviewer_designation,
			"feedback": row.feedback,
			"total_score": flt(row.total_score),
			"added_on": str(row.added_on) if row.added_on else None,
		}
		for row in frappe.get_all(
			"Employee Performance Feedback",
			filters={"appraisal": appraisal, "docstatus": 1},
			fields=[
				"name", "reviewer", "reviewer_name", "reviewer_designation",
				"feedback", "total_score", "added_on",
			],
			order_by="added_on desc",
			limit_page_length=50,
		)
	]


@frappe.whitelist(methods=["POST"])
def submit_self_assessment(name: str, reflections: str | None = None, ratings=None) -> dict:
	"""Save the signed-in employee's self-assessment on their own appraisal.

	``ratings`` is a JSON list of ``{criteria, rating}`` where ``rating`` is in
	stars (1–N). Weightage is taken from the appraisal's existing criteria rows,
	never from the client — a self-assessment that could set its own weightings
	could inflate its own score.

	Recalculation is HRMS's: setting the rows and saving triggers
	``calculate_self_appraisal_score``, so Desk and the dashboard never diverge.
	"""
	_unused_user, employee = _employee_user()
	if not frappe.db.exists("Appraisal", name):
		frappe.throw(_("Appraisal {0} was not found.").format(name), frappe.DoesNotExistError)

	doc = frappe.get_doc("Appraisal", name)
	if doc.employee != employee:
		frappe.throw(_("You can only complete your own self-assessment."), frappe.PermissionError)
	if doc.docstatus != 0:
		frappe.throw(
			_("This appraisal has been submitted and can no longer be edited."),
			frappe.ValidationError,
		)

	rows = frappe.parse_json(ratings) if isinstance(ratings, str) else (ratings or [])
	if rows:
		# Weightage comes from what is already on the document; the client only
		# gets to say how it rated each criterion.
		weightage = {
			row.criteria: flt(row.per_weightage) for row in (doc.get("self_ratings") or [])
		}
		supplied = {row.get("criteria"): row.get("rating") for row in rows if row.get("criteria")}
		unknown = set(supplied) - set(weightage)
		if unknown and weightage:
			frappe.throw(
				_("Unknown rating criteria: {0}").format(", ".join(sorted(unknown))),
				frappe.ValidationError,
			)

		if weightage:
			# Update in place so criteria the employee did not touch keep their
			# existing rating rather than being reset to zero.
			for row in doc.get("self_ratings"):
				if row.criteria in supplied:
					row.rating = _to_fraction(supplied[row.criteria])
		else:
			# No criteria configured on the cycle: accept what was sent, with an
			# even weighting, so the feature still works on a minimal setup.
			even = 100.0 / len(rows)
			doc.set("self_ratings", [])
			for row in rows:
				doc.append(
					"self_ratings",
					{
						"criteria": row.get("criteria"),
						"rating": _to_fraction(row.get("rating")),
						"per_weightage": even,
					},
				)

	if reflections is not None:
		doc.reflections = reflections
	doc.save()
	doc.reload()

	return {
		"name": doc.name,
		"self_score": flt(doc.self_score),
		"final_score": flt(doc.final_score),
		"reflections": doc.reflections,
	}


@frappe.whitelist(methods=["POST"])
def add_appraisal_feedback(name: str, feedback: str, ratings=None) -> dict:
	"""Leave reviewer feedback on someone's appraisal. Manager or HR.

	Delegates to HRMS's own ``Appraisal.add_feedback``, which creates and submits
	the Employee Performance Feedback and refreshes the average — reimplementing
	that would drift from Desk the first time HRMS changes the scoring.
	"""
	from techsarena_hr.api import HR_ROLES, _current_employee, _require_hrms, _require_login

	user = _require_login()
	_require_hrms()
	if not frappe.db.exists("Appraisal", name):
		frappe.throw(_("Appraisal {0} was not found.").format(name), frappe.DoesNotExistError)

	doc = frappe.get_doc("Appraisal", name)
	own = _current_employee(user, required=False)
	is_hr = bool(set(frappe.get_roles(user)).intersection(HR_ROLES))
	manages = own and frappe.db.get_value("Employee", doc.employee, "reports_to") == own
	if not is_hr and not manages:
		frappe.throw(
			_("Only this employee's manager or HR can leave feedback."), frappe.PermissionError
		)
	if own and doc.employee == own:
		frappe.throw(
			_("Use the self-assessment to record your own reflections."), frappe.ValidationError
		)
	if not feedback or not str(feedback).strip():
		frappe.throw(_("Write your feedback before submitting."), frappe.ValidationError)

	rows = frappe.parse_json(ratings) if isinstance(ratings, str) else (ratings or [])
	weightage = {row.criteria: flt(row.per_weightage) for row in (doc.get("self_ratings") or [])}
	payload = []
	for row in rows:
		criteria = row.get("criteria")
		if not criteria:
			continue
		payload.append(
			{
				"criteria": criteria,
				"rating": _to_fraction(row.get("rating")),
				"per_weightage": weightage.get(criteria, flt(row.get("per_weightage"))),
			}
		)

	created = doc.add_feedback(feedback, payload)
	doc.reload()
	return {
		"name": created.name,
		"appraisal": doc.name,
		"total_score": flt(created.total_score),
		"avg_feedback_score": flt(doc.avg_feedback_score),
	}


# --------------------------------------------------------------------------- #
# Leave encashment
# --------------------------------------------------------------------------- #


@frappe.whitelist()
def encashable_leave(employee: str | None = None) -> dict:
	"""Encashable balance per leave type for the current leave period. HR, or self.

	Phase 3's exit settlement estimated encashment at gross ÷ 30. This is the
	real thing: a Leave Encashment document computes the encashable days against
	the leave type's own ``max_encashable_leaves`` / ``non_encashable_leaves``
	caps and prices it off the salary structure's encashment component.
	"""
	from techsarena_hr.api import HR_ROLES, _current_employee, _require_hrms, _require_login

	user = _require_login()
	_require_hrms()
	own = _current_employee(user, required=False)
	employee = employee or own
	if not employee:
		frappe.throw(_("No employee to report on."), frappe.ValidationError)
	if employee != own and not set(frappe.get_roles(user)).intersection(HR_ROLES):
		frappe.throw(_("You cannot view this employee's leave."), frappe.PermissionError)

	if not frappe.db.table_exists("Leave Encashment"):
		return {"employee": employee, "rows": [], "leave_period": None, "available": False}

	today = nowdate()
	period = frappe.db.get_value(
		"Leave Period",
		{"from_date": ["<=", today], "to_date": [">=", today]},
		["name", "from_date", "to_date"],
		as_dict=True,
	)

	encashable = frappe.get_all(
		"Leave Type",
		filters={"allow_encashment": 1},
		fields=["name", "max_encashable_leaves", "non_encashable_leaves"],
		limit_page_length=0,
	)
	rows = []
	if encashable:
		from hrms.hr.doctype.leave_application.leave_application import get_leave_details

		balances = get_leave_details(employee, today).get("leave_allocation", {})
		for leave_type in encashable:
			balance = flt(balances.get(leave_type.name, {}).get("remaining_leaves", 0))
			# Mirror HRMS's own caps so the figure shown matches what a Leave
			# Encashment would actually pay out.
			encashable_days = max(0.0, balance - flt(leave_type.non_encashable_leaves))
			if leave_type.max_encashable_leaves:
				encashable_days = min(encashable_days, flt(leave_type.max_encashable_leaves))
			if balance > 0 or encashable_days > 0:
				rows.append(
					{
						"leave_type": leave_type.name,
						"balance": balance,
						"encashable_days": encashable_days,
						"non_encashable_leaves": flt(leave_type.non_encashable_leaves),
						"max_encashable_leaves": flt(leave_type.max_encashable_leaves),
					}
				)

	existing = frappe.get_all(
		"Leave Encashment",
		filters={"employee": employee, "docstatus": ["<", 2]},
		fields=["name", "leave_type", "encashment_days", "encashment_amount", "status", "encashment_date"],
		order_by="creation desc",
		limit_page_length=20,
	)
	return {
		"employee": employee,
		"leave_period": period,
		"rows": rows,
		"encashments": existing,
		"available": True,
	}


@frappe.whitelist(methods=["POST"])
def create_leave_encashment(
	employee: str, leave_type: str, leave_period: str | None = None, encashment_days=None
) -> dict:
	"""Raise a Leave Encashment as a draft. HR only.

	Left unsubmitted deliberately: submitting creates an Additional Salary and
	writes the encashed days back against the Leave Allocation — a payroll
	action, not a reporting one. The same contract Phase 3 applied to gratuity.
	"""
	from techsarena_hr.api import HR_ROLES, _require_hrms, _require_login

	user = _require_login()
	_require_hrms()
	if not set(frappe.get_roles(user)).intersection(HR_ROLES):
		frappe.throw(_("Only HR can raise a leave encashment."), frappe.PermissionError)
	if not frappe.db.table_exists("Leave Encashment"):
		frappe.throw(_("Leave Encashment is not available on this site."), frappe.ValidationError)

	record = frappe.db.get_value("Employee", employee, ["name", "company"], as_dict=True)
	if not record:
		frappe.throw(_("Employee {0} was not found.").format(employee), frappe.DoesNotExistError)

	if not leave_period:
		today = nowdate()
		leave_period = frappe.db.get_value(
			"Leave Period", {"from_date": ["<=", today], "to_date": [">=", today]}, "name"
		)
	if not leave_period:
		frappe.throw(
			_("No active Leave Period. Create one before encashing leave."), frappe.ValidationError
		)

	doc = frappe.new_doc("Leave Encashment")
	doc.employee = employee
	doc.company = record.company
	doc.leave_type = leave_type
	doc.leave_period = leave_period
	doc.encashment_date = nowdate()
	doc.insert()

	# Set the day count *after* insert, deliberately.
	#
	# Leave Encashment.validate() calls get_leave_details_for_encashment(),
	# which recomputes encashment_days from the balance — so a value assigned
	# before insert is silently overwritten. Saving again re-runs validate,
	# which caps the request at actual_encashable_days and reprices it, so the
	# override is still bounded by HRMS's own rules rather than trusted.
	if encashment_days not in (None, "") and flt(encashment_days) != flt(doc.encashment_days):
		doc.encashment_days = flt(encashment_days)
		doc.save()
		doc.reload()

	return {
		"name": doc.name,
		"employee": employee,
		"leave_type": leave_type,
		"leave_balance": flt(doc.leave_balance),
		"actual_encashable_days": flt(doc.actual_encashable_days),
		"encashment_days": flt(doc.encashment_days),
		"encashment_amount": flt(doc.encashment_amount),
		"status": doc.status,
		"submitted": False,
	}
