"""Employee loans over the `lending` app.

View loans and their repayment schedule, and apply a **reschedule** (new tenure)
or **skip / defer** an instalment through lending's formal **Loan Restructure**
flow — a real submittable document that regenerates the schedule and posts the
GL / accrual adjustments on approval. The loan is disbursed on demand so the
restructure has an active balance to work on.
"""

from __future__ import annotations

import contextlib

import frappe
from frappe import _
from frappe.utils import flt, getdate, nowdate

AUDIT_TAG = "[Techsarena Loan]"


@contextlib.contextmanager
def _elevated():
	"""Run loan/GL operations with admin rights the calling HR user lacks.

	Every mutation guarded by this block is HR-gated at the endpoint, but the
	underlying documents (Loan Disbursement, Loan Restructure, the GL entries
	they post) belong to the `lending` app, where an HR Manager holds no rights.

	Both the user switch and the flag are captured **before** and restored
	**inside** a ``finally``. The previous version called ``set_user`` outside
	the ``try``: if that raised — it rebuilds ``frappe.local.session`` and the
	role cache, so it can — the session stayed elevated with no restoration for
	the remainder of the request.

	Never commit inside this block. A commit here would make the elevated writes
	durable before the caller's own guards have finished, and would defeat the
	rollback the endpoint relies on when a later step fails.
	"""
	prev_user = frappe.session.user
	prev_flag = frappe.flags.ignore_permissions
	try:
		frappe.set_user("Administrator")
		frappe.flags.ignore_permissions = True
		yield
	finally:
		frappe.flags.ignore_permissions = prev_flag
		# Restore even if set_user("Administrator") itself failed; set_user is
		# idempotent, so re-setting the user we already are is harmless.
		frappe.set_user(prev_user)


def _require_user() -> str:
	from techsarena_hr.api import _require_hrms, _require_login

	user = _require_login()
	_require_hrms()
	return user


def _hr_or_self(applicant: str) -> tuple[str, str | None]:
	"""Read access: HR, or the employee looking at their own loan."""
	from techsarena_hr.api import HR_ROLES, _current_employee

	user = _require_user()
	own = _current_employee(user, required=False)
	if applicant != own and not set(frappe.get_roles(user)).intersection(HR_ROLES):
		frappe.throw(_("You are not allowed to act on this loan."), frappe.PermissionError)
	return user, own


def _require_loan_admin() -> str:
	"""Write access to the restructure flow: HR only, never the borrower.

	``_apply_restructure`` drives the Loan Restructure straight from Initiated to
	Approved, which regenerates the schedule and books the GL adjustments. That
	is an approval. Letting the applicant reach it — which ``_hr_or_self`` did,
	since ``applicant == own`` passes — let an employee approve their own
	financial restructure, extend their own tenure and defer their own
	instalments without anyone reviewing it.
	"""
	from techsarena_hr.api import HR_ROLES

	user = _require_user()
	if not set(frappe.get_roles(user)).intersection(HR_ROLES):
		frappe.throw(
			_("Only HR can reschedule or defer a loan instalment."), frappe.PermissionError
		)
	return user


def _active_schedule(loan: str) -> str | None:
	"""The current schedule: the Active one after any restructure, else the
	submitted schedule, else whatever exists."""
	return (
		frappe.db.get_value(
			"Loan Repayment Schedule", {"loan": loan, "docstatus": 1, "status": "Active"}, "name"
		)
		or frappe.db.get_value("Loan Repayment Schedule", {"loan": loan, "docstatus": 1}, "name")
		or frappe.db.get_value("Loan Repayment Schedule", {"loan": loan}, "name")
	)


def _rows(schedule: str | None) -> list[dict]:
	if not schedule:
		return []
	return frappe.get_all(
		"Repayment Schedule",
		filters={"parent": schedule},
		fields=[
			"name", "idx", "payment_date", "principal_amount", "interest_amount",
			"total_payment", "balance_loan_amount", "number_of_days",
		],
		order_by="payment_date asc, idx asc",
		limit_page_length=0,
	)


def _loan_summary(loan) -> dict:
	total = flt(loan.total_payment)
	paid = flt(loan.total_amount_paid)
	return {
		"name": loan.name,
		"loan_product": loan.loan_product,
		"applicant": loan.applicant,
		"applicant_name": loan.applicant_name,
		"loan_amount": flt(loan.loan_amount),
		"rate_of_interest": flt(loan.rate_of_interest),
		"status": loan.status,
		"repayment_periods": loan.repayment_periods,
		"monthly_repayment_amount": flt(loan.monthly_repayment_amount),
		"total_payable": total,
		"total_paid": paid,
		"outstanding": total - paid,
	}


#: Fields _loan_summary reads. Selected explicitly so the list view never pulls
#: whole documents.
_LOAN_FIELDS = (
	"name",
	"loan_product",
	"applicant",
	"applicant_name",
	"loan_amount",
	"rate_of_interest",
	"status",
	"repayment_periods",
	"monthly_repayment_amount",
	"total_payment",
	"total_amount_paid",
)


def _active_schedules(loans: list[str]) -> dict[str, str]:
	"""Map each loan to its current schedule in one pass.

	The per-loan ``_active_schedule`` costs up to three queries each; batched
	here it is one query total, with the same precedence — an Active schedule
	wins over a merely submitted one, which wins over a draft.
	"""
	if not loans:
		return {}
	rows = frappe.get_all(
		"Loan Repayment Schedule",
		filters={"loan": ["in", loans]},
		fields=["name", "loan", "docstatus", "status"],
		limit_page_length=0,
	)
	ranked: dict[str, tuple[int, str]] = {}
	for row in rows:
		# Higher rank wins: Active+submitted > submitted > anything else.
		if row.docstatus == 1 and row.status == "Active":
			rank = 2
		elif row.docstatus == 1:
			rank = 1
		else:
			rank = 0
		current = ranked.get(row.loan)
		if current is None or rank > current[0]:
			ranked[row.loan] = (rank, row.name)
	return {loan: name for loan, (_rank, name) in ranked.items()}


def _loans_for(applicant: str) -> list[dict]:
	"""Loan summaries for one applicant, in a fixed number of queries.

	Previously this ran ``frappe.get_doc`` plus up to three schedule look-ups
	plus an instalment query *per loan* — roughly 5N queries. It is now 3 total.
	"""
	loans = frappe.get_all(
		"Loan",
		filters={"applicant": applicant, "applicant_type": "Employee"},
		fields=list(_LOAN_FIELDS),
		order_by="creation desc",
		limit_page_length=0,
	)
	if not loans:
		return []

	schedules = _active_schedules([loan.name for loan in loans])
	schedule_names = [name for name in schedules.values() if name]

	# Earliest future instalment per schedule, in one query.
	next_by_schedule: dict[str, dict] = {}
	if schedule_names:
		for row in frappe.get_all(
			"Repayment Schedule",
			filters={"parent": ["in", schedule_names], "payment_date": [">=", nowdate()]},
			fields=["parent", "payment_date", "total_payment"],
			order_by="payment_date asc",
			limit_page_length=0,
		):
			next_by_schedule.setdefault(
				row.parent, {"payment_date": row.payment_date, "total_payment": row.total_payment}
			)

	out = []
	for loan in loans:
		summary = _loan_summary(loan)
		schedule = schedules.get(loan.name)
		summary["next_installment"] = next_by_schedule.get(schedule) if schedule else None
		out.append(summary)
	return out


@frappe.whitelist()
def my_loans() -> dict:
	from techsarena_hr.api import _current_employee

	employee = _current_employee(_require_user())
	return {"employee": employee, "loans": _loans_for(employee)}


@frappe.whitelist()
def loan_detail(loan: str) -> dict:
	if not frappe.db.exists("Loan", loan):
		frappe.throw(_("Loan {0} was not found.").format(loan), frappe.DoesNotExistError)
	doc = frappe.get_doc("Loan", loan)
	_hr_or_self(doc.applicant)
	return {"loan": _loan_summary(doc), "schedule": _rows(_active_schedule(loan))}


# --------------------------------------------------------------------------- #
# Formal restructure flow
# --------------------------------------------------------------------------- #


def _ensure_disbursed(loan) -> str | None:
	"""Disburse the outstanding sanctioned amount so a restructure has a balance.
	A no-op once fully disbursed. Returns the disbursement name if one was made."""
	pending = flt(loan.loan_amount) - flt(loan.disbursed_amount)
	if pending <= 0:
		return None
	cost_center = frappe.db.get_value("Company", loan.company, "cost_center") or frappe.db.get_value(
		"Cost Center", {"company": loan.company, "is_group": 0}, "name"
	)
	if not cost_center:
		frappe.throw(_("No cost center is configured for {0}.").format(loan.company))
	disbursement = frappe.get_doc(
		{
			"doctype": "Loan Disbursement",
			"against_loan": loan.name,
			"disbursement_date": nowdate(),
			"company": loan.company,
			"disbursed_amount": pending,
			"cost_center": cost_center,
		}
	)
	disbursement.insert(ignore_permissions=True)
	disbursement.submit()
	loan.reload()
	return disbursement.name


def _apply_restructure(loan, new_periods: int, reason: str | None, kind: str):
	"""Create, submit and approve a Normal Loan Restructure with a new tenure."""
	if frappe.db.exists(
		"Loan Restructure", {"loan": loan.name, "docstatus": 1, "status": "Initiated"}
	):
		frappe.throw(_("Another restructure is already pending approval on this loan."))

	restructure_date = getdate(nowdate())
	last_due = frappe.db.get_value("Loan Interest Accrual", {"loan": loan.name}, "max(due_date)")
	if last_due and getdate(last_due) > restructure_date:
		restructure_date = getdate(last_due)

	restructure = frappe.get_doc(
		{
			"doctype": "Loan Restructure",
			"loan": loan.name,
			"restructure_type": "Normal Restructure",
			"restructure_date": restructure_date,
			"new_repayment_period_in_months": new_periods,
			"reason_for_restructure": f"{kind}: {reason or 'no reason given'}",
		}
	)
	restructure.insert(ignore_permissions=True)
	restructure.submit()
	# Initiated -> Approved applies the new schedule and books the adjustments.
	restructure.status = "Approved"
	restructure.save(ignore_permissions=True)
	return restructure


def _audit(loan: str, applicant: str, summary: str, reason: str | None) -> None:
	frappe.get_doc(
		{
			"doctype": "Comment",
			"comment_type": "Info",
			"reference_doctype": "Loan",
			"reference_name": loan,
			"content": f"{AUDIT_TAG} {summary}. {('Reason: ' + reason) if reason else ''}".strip(),
		}
	).insert(ignore_permissions=True)


@frappe.whitelist(methods=["POST"])
def reschedule_loan(loan: str, new_periods, reason: str | None = None) -> dict:
	"""Reschedule the loan over a new number of monthly instalments via a formal
	Loan Restructure (real schedule regeneration + GL on approval)."""
	if not frappe.db.exists("Loan", loan):
		frappe.throw(_("Loan {0} was not found.").format(loan), frappe.DoesNotExistError)
	# HR only: this approves a restructure and posts GL. The borrower can read
	# their loan (loan_detail) but must not be able to restructure it.
	_require_loan_admin()
	new_periods = int(new_periods)
	if new_periods < 1 or new_periods > 600:
		frappe.throw(_("Enter a repayment tenure between 1 and 600 months."))

	# Disbursement + restructure post GL and create Loan documents the caller has
	# no rights on; the endpoint is already access-gated, so run them elevated.
	# No commit inside the block — the request's own transaction carries these,
	# so a failure after this point still rolls the whole restructure back.
	with _elevated():
		doc = frappe.get_doc("Loan", loan)
		_ensure_disbursed(doc)
		restructure = _apply_restructure(doc, new_periods, reason, "Reschedule")
		_audit(loan, doc.applicant, f"Rescheduled to {new_periods} instalments ({restructure.name})", reason)
		doc.reload()
		result = {
			"loan": loan,
			"new_periods": doc.repayment_periods,
			"new_emi": flt(doc.monthly_repayment_amount),
			"restructure": restructure.name,
			"schedule": _rows(_active_schedule(loan)),
		}
	return result


@frappe.whitelist(methods=["POST"])
def skip_installment(loan: str, reason: str | None = None) -> dict:
	"""Defer one instalment: restructure the loan to one extra month, lowering the
	instalment and pushing the schedule out (a payment-relief moratorium)."""
	if not frappe.db.exists("Loan", loan):
		frappe.throw(_("Loan {0} was not found.").format(loan), frappe.DoesNotExistError)
	# HR only, for the same reason as reschedule_loan: deferring an instalment is
	# a payment-relief decision, and it was repeatable without limit by the
	# borrower themselves.
	_require_loan_admin()

	with _elevated():
		doc = frappe.get_doc("Loan", loan)
		current = cint_or_len(doc.repayment_periods, loan)
		_ensure_disbursed(doc)
		restructure = _apply_restructure(doc, current + 1, reason, "Skip / defer one instalment")
		doc.reload()
		rows = _rows(_active_schedule(loan))
		deferred_to = str(rows[-1]["payment_date"]) if rows else None
		_audit(loan, doc.applicant, f"Deferred one instalment, tenure +1 ({restructure.name})", reason)
		result = {
			"loan": loan,
			"deferred_to": deferred_to,
			"restructure": restructure.name,
			"schedule": rows,
		}
	return result


def cint_or_len(periods, loan: str) -> int:
	if periods:
		return int(periods)
	return len(_rows(_active_schedule(loan))) or 12
