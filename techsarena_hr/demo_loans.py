"""Seed a working staff-loan product and a couple of demo term loans (with a
repayment schedule) so the Loans feature can be exercised. Idempotent."""

from __future__ import annotations

import frappe
from frappe.utils import add_months, nowdate


def _acc(company: str, name: str, parent: str, account_type: str) -> str:
	from erpnext.accounts.doctype.account.test_account import create_account

	existing = frappe.db.get_value("Account", {"account_name": name, "company": company})
	if existing:
		return existing
	return create_account(
		account_name=name,
		parent_account=parent,
		company=company,
		account_type=account_type,
	)


def _ensure_loan_accounts(company: str) -> dict:
	abbr = frappe.get_cached_value("Company", company, "abbr")
	la = f"Loans and Advances (Assets) - {abbr}"
	bank = f"Bank Accounts - {abbr}"
	inc = f"Direct Income - {abbr}"
	return {
		"loan_account": _acc(company, "Techsarena Loan Account", la, "Receivable"),
		"payment_account": _acc(company, "Techsarena Loan Payment", bank, "Bank"),
		"disbursement_account": _acc(company, "Techsarena Loan Disbursement", bank, "Bank"),
		"interest_income_account": _acc(company, "Techsarena Loan Interest Income", inc, "Income Account"),
		"penalty_income_account": _acc(company, "Techsarena Loan Penalty Income", inc, "Income Account"),
		"interest_receivable_account": _acc(company, "Techsarena Loan Interest Receivable", la, "Receivable"),
		"penalty_receivable_account": _acc(company, "Techsarena Loan Penalty Receivable", la, "Receivable"),
		"charges_receivable_account": _acc(company, "Techsarena Loan Charges Receivable", la, "Receivable"),
		"suspense_interest_receivable": _acc(company, "Techsarena Loan Suspense Receivable", la, "Receivable"),
		"suspense_interest_income": _acc(company, "Techsarena Loan Suspense Income", inc, "Income Account"),
	}


LOAN_PRODUCT = "Techsarena Staff Loan"


def _ensure_loan_product(company: str) -> str:
	if frappe.db.exists("Loan Product", LOAN_PRODUCT):
		return LOAN_PRODUCT
	accts = _ensure_loan_accounts(company)
	mop = (
		frappe.db.get_value("Mode of Payment", {"type": "Cash"}, "name")
		or frappe.db.get_value("Mode of Payment", "Cash", "name")
		or frappe.db.get_value("Mode of Payment", {}, "name")
	)
	if not mop:
		mop = frappe.get_doc({"doctype": "Mode of Payment", "mode_of_payment": "Cash", "type": "Cash"}).insert(
			ignore_permissions=True
		).name
	doc = frappe.get_doc(
		{
			"doctype": "Loan Product",
			"company": company,
			"product_code": LOAN_PRODUCT,
			"product_name": LOAN_PRODUCT,
			"is_term_loan": 1,
			"repayment_schedule_type": "Monthly as per repayment start date",
			"maximum_loan_amount": 5_000_000,
			"rate_of_interest": 10,
			"penalty_interest_rate": 24,
			"mode_of_payment": mop,
			"min_days_bw_disbursement_first_repayment": 15,
			"write_off_amount": 100,
			"min_auto_closure_tolerance_amount": -100,
			"max_auto_closure_tolerance_amount": 100,
			**accts,
		}
	)
	doc.insert(ignore_permissions=True)
	return LOAN_PRODUCT


def seed_demo_loans() -> dict:
	company = frappe.db.get_single_value("Global Defaults", "default_company") or frappe.db.get_value(
		"Company", {}, "name"
	)
	product = _ensure_loan_product(company)
	targets = [
		("employee@techsarena.local", 600000, 24),
		("demo.eng1@techsarena.local", 300000, 12),
	]
	loans = []
	for email, amount, periods in targets:
		emp = frappe.db.get_value("Employee", {"user_id": email}, "name")
		if not emp:
			continue
		existing = frappe.db.get_value("Loan", {"applicant": emp, "loan_product": product}, "name")
		if existing:
			loans.append(existing)
			continue
		loan = frappe.get_doc(
			{
				"doctype": "Loan",
				"company": company,
				"applicant_type": "Employee",
				"applicant": emp,
				"loan_product": product,
				"is_term_loan": 1,
				"loan_amount": amount,
				"repayment_method": "Repay Over Number of Periods",
				"repayment_periods": periods,
				"repayment_start_date": add_months(nowdate(), 1),
				"posting_date": nowdate(),
			}
		)
		loan.save()
		loan.submit()
		loans.append(loan.name)
	frappe.db.commit()
	# report the schedule length for the first loan
	schedule = None
	if loans:
		sched_name = frappe.db.get_value(
			"Loan Repayment Schedule", {"loan": loans[0], "docstatus": 1}, "name"
		) or frappe.db.get_value("Loan Repayment Schedule", {"loan": loans[0]}, "name")
		if sched_name:
			schedule = frappe.db.count("Repayment Schedule", {"parent": sched_name})
	return {"product": product, "loans": loans, "first_loan_installments": schedule}
