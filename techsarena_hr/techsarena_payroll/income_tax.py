# Copyright (c) 2026, Techs Arena and contributors
# For license information, please see license.txt

"""Configurable monthly income-tax engine.

Country-agnostic: the brackets live in an hrms **Income Tax Slab** assigned to
the employee (via Salary Structure Assignment). The monthly deduction is the
remaining annual tax spread over the remaining months of the payroll period::

    annual_taxable = monthly_taxable x period_months + previous_taxable_income
    annual_tax     = progressive_tax(annual_taxable, slab)
    monthly_tax    = max(0, annual_tax - already_paid) / remaining_months

Kept fully separate from the (future) funds logic — this module owns only the
tax deduction row. ``progressive_tax`` is pure and unit-testable.
"""

from __future__ import annotations

import frappe
from frappe.utils import add_months, cint, date_diff, flt, getdate


def progressive_tax(annual_taxable: float, slab_rows) -> float:
	"""Progressive tax over slab rows (from_amount, to_amount, percent_deduction).

	A ``to_amount`` of 0 means the top, open-ended bracket.
	"""
	income = flt(annual_taxable)
	tax = 0.0
	for s in slab_rows:
		frm = flt(s.from_amount)
		to = flt(s.to_amount) or income
		if income > frm:
			taxable = min(income, to) - frm
			if taxable > 0:
				tax += taxable * flt(s.percent_deduction) / 100.0
	return flt(tax, 2)


def _period_for(company: str, on_date):
	name = frappe.db.get_value(
		"Payroll Period",
		{"company": company, "start_date": ["<=", on_date], "end_date": [">=", on_date]},
		"name",
	)
	return frappe.get_doc("Payroll Period", name) if name else None


def _months_between(start, end) -> int:
	start, end = getdate(start), getdate(end)
	return (end.year - start.year) * 12 + (end.month - start.month) + 1


def _employee_slab(employee: str, on_date):
	slab = frappe.db.get_value(
		"Salary Structure Assignment",
		{"employee": employee, "from_date": ["<=", on_date], "docstatus": 1},
		"income_tax_slab",
		order_by="from_date desc",
	)
	return frappe.get_doc("Income Tax Slab", slab) if slab else None


def _sum(doctype: str, employee: str, period: str) -> float:
	rows = frappe.get_all(
		doctype,
		filters={"employee": employee, "payroll_period": period, "docstatus": 1},
		pluck="amount",
	)
	return sum(flt(a) for a in rows)


def _tax_already_deducted(doc, component: str) -> float:
	"""Tax posted on earlier submitted slips of the same employee in this period."""
	period = _period_for(doc.company, doc.start_date)
	if not period:
		return 0.0
	slips = frappe.get_all(
		"Salary Slip",
		filters={
			"employee": doc.employee,
			"docstatus": 1,
			"start_date": [">=", period.start_date],
			"end_date": ["<", doc.start_date],
		},
		pluck="name",
	)
	if not slips:
		return 0.0
	total = frappe.db.get_all(
		"Salary Detail",
		filters={"parent": ["in", slips], "parentfield": "deductions", "salary_component": component},
		fields=["sum(amount) as amt"],
	)
	return flt(total[0].amt) if total and total[0].amt else 0.0


def apply_monthly_tax(doc, method=None):
	"""before_save on Salary Slip: compute and post the monthly income-tax row."""
	settings = frappe.get_cached_doc("Techsarena Payroll Settings")
	component = settings.tax_component
	# always clear a previously auto-computed tax row so re-saves stay correct
	if component:
		doc.set("deductions", [d for d in doc.deductions if d.salary_component != component])

	if not cint(settings.enable_income_tax) or not component or not doc.employee:
		return

	slab = _employee_slab(doc.employee, doc.start_date)
	if not slab:
		return
	period = _period_for(doc.company, doc.start_date)
	if not period:
		return

	period_months = _months_between(period.start_date, period.end_date)
	elapsed = _months_between(period.start_date, doc.start_date)
	remaining_months = max(1, period_months - elapsed + 1)

	monthly_taxable = sum(
		flt(e.amount) for e in doc.earnings if cint(getattr(e, "is_tax_applicable", 1))
	)
	previous = _sum("Previous Taxable Income", doc.employee, period.name)
	annual_taxable = monthly_taxable * period_months + previous

	annual_tax = progressive_tax(annual_taxable, slab.slabs)
	already_paid = _sum("Paid Income Tax", doc.employee, period.name) + _tax_already_deducted(doc, component)
	monthly_tax = max(0.0, (annual_tax - already_paid) / remaining_months)
	if monthly_tax <= 0:
		return

	doc.append("deductions", {"salary_component": component, "amount": flt(monthly_tax, 2)})
	if hasattr(doc, "calculate_net_pay"):
		doc.calculate_net_pay()
