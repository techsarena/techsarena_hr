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
def _elevated(caller: str):
	"""Run loan/GL operations with admin rights the self-service caller lacks,
	then restore the session. The endpoints are already access-gated."""
	prev_flag = frappe.flags.ignore_permissions
	frappe.set_user("Administrator")
	frappe.flags.ignore_permissions = True
	try:
		yield
	finally:
		frappe.flags.ignore_permissions = prev_flag
		frappe.set_user(caller)


def _require_user() -> str:
	from techsarena_hr.api import _require_hrms, _require_login

	user = _require_login()
	_require_hrms()
	return user


def _hr_or_self(applicant: str) -> tuple[str, str | None]:
	from techsarena_hr.api import HR_ROLES, _current_employee

	user = _require_user()
	own = _current_employee(user, required=False)
	if applicant != own and not set(frappe.get_roles(user)).intersection(HR_ROLES):
		frappe.throw(_("You are not allowed to act on this loan."), frappe.PermissionError)
	return user, own


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


def _loans_for(applicant: str) -> list[dict]:
	rows = frappe.get_all(
		"Loan",
		filters={"applicant": applicant, "applicant_type": "Employee"},
		fields=["name"],
		order_by="creation desc",
		limit_page_length=0,
	)
	out = []
	for row in rows:
		loan = frappe.get_doc("Loan", row.name)
		summary = _loan_summary(loan)
		schedule = _active_schedule(loan.name)
		upcoming = (
			frappe.get_all(
				"Repayment Schedule",
				filters={"parent": schedule, "payment_date": [">=", nowdate()]},
				fields=["payment_date", "total_payment"],
				order_by="payment_date asc",
				limit_page_length=1,
			)
			if schedule
			else []
		)
		summary["next_installment"] = upcoming[0] if upcoming else None
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
	doc = frappe.get_doc("Loan", loan)
	caller, _own = _hr_or_self(doc.applicant)
	new_periods = int(new_periods)
	if new_periods < 1 or new_periods > 600:
		frappe.throw(_("Enter a repayment tenure between 1 and 600 months."))

	# Disbursement + restructure post GL and create Loan documents the caller has
	# no rights on; the endpoint is already access-gated, so run them elevated.
	with _elevated(caller):
		doc = frappe.get_doc("Loan", loan)
		_ensure_disbursed(doc)
		restructure = _apply_restructure(doc, new_periods, reason, "Reschedule")
		_audit(loan, doc.applicant, f"Rescheduled to {new_periods} instalments ({restructure.name})", reason)
		frappe.db.commit()
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
	doc = frappe.get_doc("Loan", loan)
	caller, _own = _hr_or_self(doc.applicant)

	with _elevated(caller):
		doc = frappe.get_doc("Loan", loan)
		current = cint_or_len(doc.repayment_periods, loan)
		_ensure_disbursed(doc)
		restructure = _apply_restructure(doc, current + 1, reason, "Skip / defer one instalment")
		frappe.db.commit()
		doc.reload()
		rows = _rows(_active_schedule(loan))
		deferred_to = str(rows[-1]["payment_date"]) if rows else None
		_audit(loan, doc.applicant, f"Deferred one instalment, tenure +1 ({restructure.name})", reason)
		frappe.db.commit()
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
