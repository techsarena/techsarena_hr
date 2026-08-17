"""Employee loans over the `lending` app: view loans and their repayment
schedule, and request a reschedule (new tenure) or skip (defer) an instalment.

Reschedule/skip regenerate the loan's active Loan Repayment Schedule using
lending's own amortisation (``get_monthly_repayment_amount`` + the flat monthly
interest formula). These are facade-level schedule adjustments intended for the
pre-disbursement demo flow — they do not post the GL/accrual entries a full
Loan Restructure would; HR would formalise an approved change through lending's
restructure flow.
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import flt, getdate, nowdate

from lending.loan_management.doctype.loan_repayment_schedule.loan_repayment_schedule import (
	add_single_month,
	get_monthly_repayment_amount,
)

AUDIT_TAG = "[Techsarena Loan]"


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
	return frappe.db.get_value(
		"Loan Repayment Schedule", {"loan": loan, "docstatus": 1}, "name"
	) or frappe.db.get_value("Loan Repayment Schedule", {"loan": loan}, "name")


def _rows(schedule: str) -> list[dict]:
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
		upcoming = frappe.get_all(
			"Repayment Schedule",
			filters={"parent": schedule, "payment_date": [">=", nowdate()]},
			fields=["payment_date", "total_payment"],
			order_by="payment_date asc",
			limit_page_length=1,
		) if schedule else []
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
	schedule = _active_schedule(loan)
	return {"loan": _loan_summary(doc), "schedule": _rows(schedule)}


def _amortise(loan_amount: float, rate: float, periods: int, start_date) -> tuple[float, list[dict]]:
	"""Replicate lending's 'Monthly as per repayment start date' schedule."""
	emi = get_monthly_repayment_amount(loan_amount, rate, periods)
	monthly_rate = flt(rate) / (12 * 100)
	balance = flt(loan_amount)
	date = getdate(start_date)
	rows: list[dict] = []
	for index in range(periods):
		interest = flt(balance * monthly_rate)
		principal = emi - interest
		balance = flt(balance + interest - emi)
		if index == periods - 1 or balance < 0:
			principal += balance
			balance = 0.0
		rows.append(
			{
				"payment_date": date,
				"principal_amount": flt(principal),
				"interest_amount": flt(interest),
				"total_payment": flt(principal + interest),
				"balance_loan_amount": flt(balance),
				"number_of_days": 1,
			}
		)
		date = add_single_month(date)
		if balance <= 0:
			break
	return emi, rows


def _replace_rows(schedule: str, rows: list[dict]) -> None:
	frappe.db.delete("Repayment Schedule", {"parent": schedule})
	for idx, values in enumerate(rows, start=1):
		child = frappe.get_doc(
			{
				"doctype": "Repayment Schedule",
				"parent": schedule,
				"parenttype": "Loan Repayment Schedule",
				"parentfield": "repayment_schedule",
				"idx": idx,
				"docstatus": 1,
				**values,
			}
		)
		child.db_insert()


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
	"""Rebuild the loan's schedule over a new number of monthly instalments."""
	if not frappe.db.exists("Loan", loan):
		frappe.throw(_("Loan {0} was not found.").format(loan), frappe.DoesNotExistError)
	doc = frappe.get_doc("Loan", loan)
	_hr_or_self(doc.applicant)
	new_periods = int(new_periods)
	if new_periods < 1 or new_periods > 600:
		frappe.throw(_("Enter a repayment tenure between 1 and 600 months."))

	schedule = _active_schedule(loan)
	if not schedule:
		frappe.throw(_("This loan has no repayment schedule to reschedule."))
	start = frappe.db.get_value("Loan Repayment Schedule", schedule, "repayment_start_date")
	emi, rows = _amortise(doc.loan_amount, doc.rate_of_interest, new_periods, start or nowdate())
	_replace_rows(schedule, rows)
	frappe.db.set_value(
		"Loan Repayment Schedule", schedule,
		{"repayment_periods": new_periods, "monthly_repayment_amount": emi},
	)
	frappe.db.set_value(
		"Loan", loan, {"repayment_periods": new_periods, "monthly_repayment_amount": emi}
	)
	_audit(loan, doc.applicant, f"Rescheduled to {new_periods} instalments (EMI {emi:g})", reason)
	frappe.db.commit()
	return {"loan": loan, "new_periods": new_periods, "new_emi": emi, "schedule": _rows(schedule)}


@frappe.whitelist(methods=["POST"])
def skip_installment(loan: str, reason: str | None = None) -> dict:
	"""Defer the next upcoming instalment to the end of the schedule."""
	if not frappe.db.exists("Loan", loan):
		frappe.throw(_("Loan {0} was not found.").format(loan), frappe.DoesNotExistError)
	doc = frappe.get_doc("Loan", loan)
	_hr_or_self(doc.applicant)
	schedule = _active_schedule(loan)
	rows = _rows(schedule)
	if not rows:
		frappe.throw(_("This loan has no repayment schedule."))
	upcoming = [r for r in rows if getdate(r["payment_date"]) >= getdate(nowdate())]
	if not upcoming:
		frappe.throw(_("There is no upcoming instalment to skip."))
	target = upcoming[0]
	new_date = add_single_month(getdate(rows[-1]["payment_date"]))
	frappe.db.set_value("Repayment Schedule", target["name"], "payment_date", new_date)
	periods = (doc.repayment_periods or len(rows)) + 1
	frappe.db.set_value("Loan", loan, "repayment_periods", periods)
	frappe.db.set_value("Loan Repayment Schedule", schedule, "repayment_periods", periods)
	_audit(
		loan, doc.applicant,
		f"Skipped instalment due {target['payment_date']}, deferred to {new_date}", reason,
	)
	frappe.db.commit()
	return {
		"loan": loan,
		"skipped_date": str(target["payment_date"]),
		"deferred_to": str(new_date),
		"schedule": _rows(schedule),
	}

