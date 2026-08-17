"""Employee funds: EOBI and Provident Fund.

A thin ledger over ``Techsarena Fund Transaction`` rows. Contributions (employee
+ employer) and profit add to a fund; a withdrawal subtracts. Balances are the
running sum of those rows.

Rates are **configurable** and default to placeholder values — confirm them
against current regulation before real use:

* EOBI: fixed monthly amounts, ``eobi_employee_amount`` (250) and
  ``eobi_employer_amount`` (1500) in site config.
* Provident Fund: a rate of monthly basic, ``pf_employee_rate`` and
  ``pf_employer_rate`` (both 0.0833 ≈ 8.33%).
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import flt, nowdate

FUND_TYPES = ("EOBI", "Provident Fund")
CREDIT_ENTRIES = ("Employee Contribution", "Employer Contribution", "Profit")
DOCTYPE = "Techsarena Fund Transaction"


def _hr_user() -> str:
	from techsarena_hr.api import HR_ROLES, _require_hrms, _require_login

	user = _require_login()
	_require_hrms()
	if not set(frappe.get_roles(user)).intersection(HR_ROLES):
		frappe.throw(_("You do not have access to fund administration."), frappe.PermissionError)
	return user


def _rate(key: str, default: float) -> float:
	value = frappe.conf.get(key)
	return flt(value) if value not in (None, "") else default


def _monthly_basic(employee: str) -> float:
	"""Basic pay used as the Provident Fund base: the latest salary slip's basic
	earning, else 65% of its gross, else 0."""
	slip = frappe.get_all(
		"Salary Slip",
		filters={"employee": employee, "docstatus": ["<", 2]},
		fields=["name", "gross_pay"],
		order_by="posting_date desc",
		limit_page_length=1,
	)
	if not slip:
		return 0.0
	basic = frappe.db.get_value(
		"Salary Detail",
		{"parent": slip[0].name, "parentfield": "earnings", "salary_component": ["like", "%Basic%"]},
		"amount",
	)
	return flt(basic) if basic else flt(slip[0].gross_pay) * 0.65


def _contribution_amounts(employee: str, fund_type: str) -> tuple[float, float]:
	"""(employee_share, employer_share) for one month of a fund."""
	if fund_type == "EOBI":
		return _rate("eobi_employee_amount", 250.0), _rate("eobi_employer_amount", 1500.0)
	basic = _monthly_basic(employee)
	return basic * _rate("pf_employee_rate", 0.0833), basic * _rate("pf_employer_rate", 0.0833)


def _balance(employee: str, fund_type: str) -> float:
	rows = frappe.get_all(
		DOCTYPE,
		filters={"employee": employee, "fund_type": fund_type},
		fields=["entry_type", "amount"],
		limit_page_length=0,
	)
	total = 0.0
	for row in rows:
		total += flt(row.amount) if row.entry_type in CREDIT_ENTRIES else -flt(row.amount)
	return total


def _add(employee, fund_type, entry_type, amount, *, period=None, reference=None, remarks=None):
	company = frappe.db.get_value("Employee", employee, "company")
	doc = frappe.get_doc(
		{
			"doctype": DOCTYPE,
			"employee": employee,
			"company": company,
			"fund_type": fund_type,
			"entry_type": entry_type,
			"amount": flt(amount),
			"posting_date": nowdate(),
			"period": period,
			"reference": reference,
			"remarks": remarks,
		}
	)
	doc.insert(ignore_permissions=True)
	return doc.name


@frappe.whitelist(methods=["POST"])
def record_contribution(employee: str, fund_type: str, period: str | None = None,
                        employee_amount=None, employer_amount=None) -> dict:
	"""Record one month's employee + employer contribution to a fund. HR only.
	Idempotent per employee/fund/period."""
	_hr_user()
	if fund_type not in FUND_TYPES:
		frappe.throw(_("Unknown fund {0}.").format(fund_type))
	period = period or nowdate()[:7]
	if frappe.db.exists(
		DOCTYPE,
		{"employee": employee, "fund_type": fund_type, "period": period,
		 "entry_type": ["in", ["Employee Contribution", "Employer Contribution"]]},
	):
		return {"skipped": f"contribution already recorded for {period}", "balance": _balance(employee, fund_type)}

	emp_share, empr_share = _contribution_amounts(employee, fund_type)
	if employee_amount not in (None, ""):
		emp_share = flt(employee_amount)
	if employer_amount not in (None, ""):
		empr_share = flt(employer_amount)

	created = []
	if emp_share > 0:
		created.append(_add(employee, fund_type, "Employee Contribution", emp_share, period=period))
	if empr_share > 0:
		created.append(_add(employee, fund_type, "Employer Contribution", empr_share, period=period))
	frappe.db.commit()
	return {
		"employee": employee, "fund_type": fund_type, "period": period,
		"employee_share": emp_share, "employer_share": empr_share,
		"rows": created, "balance": _balance(employee, fund_type),
	}


@frappe.whitelist(methods=["POST"])
def record_monthly_contributions(fund_type: str, period: str | None = None) -> dict:
	"""Post one month's contribution for every active employee. HR only."""
	_hr_user()
	period = period or nowdate()[:7]
	posted = 0
	for employee in frappe.get_all("Employee", filters={"status": "Active"}, pluck="name"):
		result = record_contribution(employee, fund_type, period)
		if "skipped" not in result:
			posted += 1
	return {"fund_type": fund_type, "period": period, "employees_posted": posted}


@frappe.whitelist(methods=["POST"])
def record_withdrawal(employee: str, fund_type: str, amount, remarks: str | None = None) -> dict:
	"""Withdraw from a fund, never below zero. HR only."""
	_hr_user()
	amount = flt(amount)
	if amount <= 0:
		frappe.throw(_("Enter a withdrawal amount greater than zero."))
	balance = _balance(employee, fund_type)
	if amount > balance:
		frappe.throw(_("Withdrawal of {0} exceeds the {1} balance of {2}.").format(amount, fund_type, balance))
	name = _add(employee, fund_type, "Withdrawal", amount, remarks=remarks or "Fund withdrawal")
	frappe.db.commit()
	return {"employee": employee, "fund_type": fund_type, "withdrawn": amount,
	        "row": name, "balance": _balance(employee, fund_type)}


@frappe.whitelist(methods=["POST"])
def allocate_profit(fund_type: str, rate, period: str | None = None) -> dict:
	"""Credit profit at ``rate`` (fraction, e.g. 0.08) of each employee's current
	balance in a fund. HR only. Idempotent per fund/period."""
	_hr_user()
	rate = flt(rate)
	if rate <= 0:
		frappe.throw(_("Enter a profit rate greater than zero (e.g. 0.08 for 8%)."))
	period = period or nowdate()[:7]
	employees = {
		row.employee
		for row in frappe.get_all(DOCTYPE, filters={"fund_type": fund_type}, fields=["employee"], limit_page_length=0)
	}
	credited = 0
	total = 0.0
	for employee in employees:
		if frappe.db.exists(DOCTYPE, {"employee": employee, "fund_type": fund_type, "period": period, "entry_type": "Profit"}):
			continue
		balance = _balance(employee, fund_type)
		profit = flt(balance) * rate
		if profit > 0:
			_add(employee, fund_type, "Profit", profit, period=period, remarks=f"Profit @ {rate:.4g}")
			credited += 1
			total += profit
	frappe.db.commit()
	return {"fund_type": fund_type, "period": period, "rate": rate,
	        "employees_credited": credited, "total_profit": total}


def _summary_rows(fund_type: str | None, employees: list[str] | None) -> list[dict]:
	filters: dict = {}
	if fund_type:
		filters["fund_type"] = fund_type
	if employees is not None:
		filters["employee"] = ["in", employees]
	rows = frappe.get_all(
		DOCTYPE, filters=filters,
		fields=["employee", "employee_name", "fund_type", "entry_type", "amount"],
		limit_page_length=0,
	)
	agg: dict[tuple, dict] = {}
	for row in rows:
		key = (row.employee, row.fund_type)
		entry = agg.setdefault(key, {
			"employee": row.employee, "employee_name": row.employee_name, "fund_type": row.fund_type,
			"contributions": 0.0, "profit": 0.0, "withdrawals": 0.0, "balance": 0.0,
		})
		if row.entry_type == "Withdrawal":
			entry["withdrawals"] += flt(row.amount)
			entry["balance"] -= flt(row.amount)
		else:
			if row.entry_type == "Profit":
				entry["profit"] += flt(row.amount)
			else:
				entry["contributions"] += flt(row.amount)
			entry["balance"] += flt(row.amount)
	return sorted(agg.values(), key=lambda r: (r["employee_name"] or "", r["fund_type"]))


@frappe.whitelist()
def fund_summary(fund_type: str | None = None) -> dict:
	"""Per-employee fund balances across the company. HR only."""
	_hr_user()
	return {"fund_type": fund_type, "funds": FUND_TYPES, "rows": _summary_rows(fund_type, None)}


@frappe.whitelist()
def fund_statement(employee: str, fund_type: str | None = None) -> dict:
	"""Full transaction list + balances for one employee. HR, or the employee for
	their own funds."""
	from techsarena_hr.api import HR_ROLES, _current_employee, _require_login

	user = _require_login()
	own = _current_employee(user, required=False)
	if employee != own and not set(frappe.get_roles(user)).intersection(HR_ROLES):
		frappe.throw(_("You are not allowed to view these funds."), frappe.PermissionError)
	filters: dict = {"employee": employee}
	if fund_type:
		filters["fund_type"] = fund_type
	transactions = frappe.get_all(
		DOCTYPE, filters=filters,
		fields=["name", "fund_type", "entry_type", "amount", "posting_date", "period", "remarks"],
		order_by="posting_date desc, creation desc", limit_page_length=0,
	)
	balances = {ft: _balance(employee, ft) for ft in FUND_TYPES}
	return {"employee": employee, "balances": balances, "transactions": transactions}


@frappe.whitelist()
def my_funds() -> dict:
	"""The signed-in employee's own EOBI + Provident Fund balances and statement."""
	from techsarena_hr.api import _current_employee, _require_login

	user = _require_login()
	employee = _current_employee(user)
	return fund_statement(employee)
