# Copyright (c) 2026, Techs Arena and contributors
# For license information, please see license.txt

"""Employee Arrears — a per-employee arrears record.

On submit it raises an Additional Salary for each arrears component so that
hrms natively includes the amount in the Salary Slip covering ``payroll_date``.
This is the same settlement path the Gratuity module uses, so there is no
custom Salary Slip hook to keep in sync.
"""

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt


class EmployeeArrears(Document):
	def validate(self):
		if self.from_date and self.to_date and self.from_date > self.to_date:
			frappe.throw(_("From Date cannot be after To Date."))
		if not self.payroll_date:
			self.payroll_date = self.to_date
		self.total_earning = sum(flt(r.amount) for r in self.e_a_earnings)
		self.total_deduction = sum(flt(r.amount) for r in self.e_a_deductions)

	def on_submit(self):
		self._create_additional_salaries()

	def on_cancel(self):
		self.ignore_linked_doctypes = ["Additional Salary"]
		self._cancel_additional_salaries()

	# ------------------------------------------------------------------ helpers

	def _create_additional_salaries(self):
		rows = [(r.salary_component, flt(r.amount)) for r in self.e_a_earnings if flt(r.amount)]
		rows += [(r.salary_component, -flt(r.amount)) for r in self.e_a_deductions if flt(r.amount)]
		for component, amount in rows:
			if not component:
				continue
			ad = frappe.new_doc("Additional Salary")
			ad.employee = self.employee
			ad.salary_component = component
			ad.amount = abs(amount)
			ad.overwrite_salary_structure_amount = 0
			ad.payroll_date = self.payroll_date
			ad.company = self.company
			ad.ref_doctype = self.doctype
			ad.ref_docname = self.name
			ad.flags.ignore_permissions = True
			ad.submit()

	def _cancel_additional_salaries(self):
		for name in frappe.get_all(
			"Additional Salary",
			filters={"ref_doctype": self.doctype, "ref_docname": self.name, "docstatus": 1},
			pluck="name",
		):
			doc = frappe.get_doc("Additional Salary", name)
			if doc.salary_slip:
				frappe.throw(
					_("Arrears already consumed by Salary Slip {0}; cancel that slip first.").format(
						doc.salary_slip
					)
				)
			doc.cancel()
