# Copyright (c) 2026, Techs Arena and contributors
# For license information, please see license.txt

"""Arrears Process — clean re-architecture of sowaan_hr's arrears engine.

Computes retroactive salary differences for a period when a pay raise (a new
Salary Structure Assignment, or an Employee Increment) takes effect *within*
the period but the employee was already paid at the old rate.

For each eligible employee the arrears for a component are:

    arrears = correct_earnings_for_period - already_paid_at_old_rate

where ``correct_earnings_for_period`` is the sum of a pre-raise prorated slip
and a post-raise prorated slip, and ``already_paid_at_old_rate`` is a
full-period slip evaluated against the structure in force at ``from_date``.

The pure arithmetic lives in :func:`component_total` so it can be unit-tested
without building real Salary Slips.
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import add_days, add_months, date_diff, flt, getdate


def component_total(slip_rows, components: set[str]) -> float:
	"""Sum ``amount`` over slip rows whose salary_component is in ``components``."""
	return sum(flt(r.amount) for r in slip_rows if r.salary_component in components)


class ArrearsProcess(Document):
	def validate(self):
		self._apply_component_defaults()

	def before_submit(self):
		if not self.arrear_process_detail:
			self.compute()
		if not self.arrear_process_detail:
			frappe.throw(_("No arrears were computed for the given criteria."))

	def on_submit(self):
		if self.create_employee_arrears:
			self._create_employee_arrears()

	def on_cancel(self):
		self._cancel_employee_arrears()

	# ------------------------------------------------------------------ helpers

	def _apply_component_defaults(self):
		"""Fall back to Techsarena Payroll Settings when no components are listed."""
		if self.arrear_earnings or self.arrear_deductions:
			return
		settings = frappe.get_single("Techsarena Payroll Settings")
		for row in settings.default_arrear_earnings:
			self.append("arrear_earnings", {"salary_component": row.salary_component})
		for row in settings.default_arrear_deductions:
			self.append("arrear_deductions", {"salary_component": row.salary_component})

	def _earning_components(self) -> set[str]:
		comps = {r.salary_component for r in self.arrear_earnings}
		# the headline arrears component is always part of the earnings basis
		if self.salary_component:
			comps.add(self.salary_component)
		return comps

	def _deduction_components(self) -> set[str]:
		return {r.salary_component for r in self.arrear_deductions}

	# ------------------------------------------------------------------ compute

	@frappe.whitelist()
	def compute(self):
		"""(Re)build the arrears detail table. Callable from the form button."""
		self.set("arrear_process_detail", [])
		if self.for_new_employees:
			rows = self._compute_new_employees()
		else:
			rows = self._compute_raise_arrears()
		for row in rows:
			self.append("arrear_process_detail", row)
		return len(self.arrear_process_detail)

	def _eligible_raise_employees(self) -> list[str]:
		"""Employees with a Salary Structure Assignment effective inside the period."""
		filters = [
			["from_date", ">", self.from_date],
			["from_date", "<=", self.to_date],
			["docstatus", "=", 1],
		]
		if self.company:
			filters.append(["company", "=", self.company])
		if self.employee:
			filters.append(["employee", "=", self.employee])
		assignments = frappe.get_all(
			"Salary Structure Assignment", filters=filters, fields=["employee"], distinct=True
		)
		employees = {a.employee for a in assignments}
		if self.department:
			employees = {
				e for e in employees
				if frappe.db.get_value("Employee", e, "department") == self.department
			}
		# active employees only, and skip anyone already processed for this window
		return [
			e for e in sorted(employees)
			if frappe.db.get_value("Employee", e, "status") == "Active"
			and not self._already_processed(e)
		]

	def _already_processed(self, employee: str) -> bool:
		return bool(
			frappe.db.exists(
				"Employee Arrears",
				{
					"employee": employee,
					"from_date": self.from_date,
					"to_date": self.to_date,
					"earning_component": self.salary_component,
					"docstatus": 1,
				},
			)
		)

	def _compute_raise_arrears(self) -> list[dict]:
		earnings = self._earning_components()
		deductions = self._deduction_components()
		rows = []
		for employee in self._eligible_raise_employees():
			ssa = self._effective_assignment(employee)
			if not ssa:
				continue
			raise_date = getdate(ssa.from_date)
			try:
				pre = self._slip(employee, self.from_date, add_days(raise_date, -1))
				post = self._slip(employee, raise_date, self.to_date)
				paid = self._slip(employee, self.from_date, self.to_date)
			except Exception:
				frappe.log_error(
					f"Arrears slip build failed for {employee}", "Arrears Process"
				)
				continue

			correct_earn = component_total(pre.earnings, earnings) + component_total(post.earnings, earnings)
			paid_earn = component_total(paid.earnings, earnings)
			correct_ded = component_total(pre.deductions, deductions) + component_total(post.deductions, deductions)
			paid_ded = component_total(paid.deductions, deductions)

			amount = flt(correct_earn - paid_earn) - flt(correct_ded - paid_ded)
			if amount <= 0:
				continue
			rows.append(
				{
					"employee": employee,
					"from_date": self.from_date,
					"to_date": self.to_date,
					"base_salary": flt(ssa.base),
					"amount": amount,
				}
			)
		return rows

	def _compute_new_employees(self) -> list[dict]:
		"""First-month arrears for employees who joined the previous month."""
		prev_from = add_months(getdate(self.from_date), -1)
		prev_to = add_months(getdate(self.to_date), -1)
		filters = [
			["date_of_joining", "between", [prev_from, prev_to]],
			["status", "=", "Active"],
		]
		if self.company:
			filters.append(["company", "=", self.company])
		if self.employee:
			filters.append(["name", "=", self.employee])
		earnings = self._earning_components()
		rows = []
		for emp in frappe.get_all("Employee", filters=filters, pluck="name"):
			if self._already_processed(emp):
				continue
			already_paid = frappe.db.exists(
				"Salary Slip", {"employee": emp, "start_date": prev_from, "end_date": prev_to}
			)
			if already_paid:
				continue
			try:
				slip = self._slip(emp, prev_from, prev_to)
			except Exception:
				continue
			amount = component_total(slip.earnings, earnings)
			if amount <= 0:
				continue
			rows.append(
				{"employee": emp, "from_date": prev_from, "to_date": prev_to, "amount": amount}
			)
		return rows

	def _effective_assignment(self, employee: str):
		names = frappe.get_all(
			"Salary Structure Assignment",
			filters=[
				["employee", "=", employee],
				["from_date", ">", self.from_date],
				["from_date", "<=", self.to_date],
				["docstatus", "=", 1],
			],
			order_by="from_date desc",
			pluck="name",
		)
		return frappe.get_doc("Salary Structure Assignment", names[0]) if names else None

	def _slip(self, employee: str, start, end):
		"""Build an unsaved, validated Salary Slip for a date window."""
		slip = frappe.get_doc(
			{
				"doctype": "Salary Slip",
				"employee": employee,
				"start_date": getdate(start),
				"end_date": getdate(end),
				"posting_date": getdate(end),
			}
		)
		slip.flags.ignore_permissions = True
		slip.validate()
		return slip

	# ---------------------------------------------------------- employee arrears

	def _create_employee_arrears(self):
		for row in self.arrear_process_detail:
			if row.employee_arrears:
				continue
			doc = frappe.get_doc(
				{
					"doctype": "Employee Arrears",
					"employee": row.employee,
					"from_date": row.from_date or self.from_date,
					"to_date": row.to_date or self.to_date,
					"earning_component": self.salary_component,
					"arrears_process": self.name,
					"e_a_earnings": [{"salary_component": self.salary_component, "amount": row.amount}],
				}
			)
			doc.flags.ignore_permissions = True
			doc.insert()
			doc.submit()
			row.db_set("employee_arrears", doc.name)

	def _cancel_employee_arrears(self):
		for name in frappe.get_all(
			"Employee Arrears",
			filters={"arrears_process": self.name, "docstatus": 1},
			pluck="name",
		):
			doc = frappe.get_doc("Employee Arrears", name)
			if doc.paid:
				frappe.throw(
					_("Cannot cancel: Employee Arrears {0} was already paid via a Salary Slip.").format(name)
				)
			doc.cancel()
