# Copyright (c) 2026, Techs Arena and contributors
# For license information, please see license.txt
"""
Gratuity Payment — unified end-of-service gratuity for KSA, UAE and Pakistan.

A single submittable document that computes an employee's end-of-service
benefit from a Frappe HR `Gratuity Rule`, applies any regime-specific cap, and
settles it either as a direct ledger entry or through payroll as an Additional
Salary. It replaces the separate, near-identical `KSA Gratuity` and
`UAE Gratuity` doctypes with one regime-aware document.
"""

import frappe
from frappe import _
from frappe.utils import flt

from erpnext.accounts.general_ledger import make_gl_entries
from erpnext.controllers.accounts_controller import AccountsController

from techsarena_hr.gratuity import gratuity_calculation as engine


class GratuityPayment(AccountsController):
	def validate(self):
		self.compute_amount()
		self.set_status()

	def compute_amount(self):
		period = engine.get_service_period(self.employee, self.gratuity_rule)
		self.current_work_experience = period["current_work_experience"]
		self.years = period["years"]
		self.months = period["months"]
		self.days = period["days"]

		result = engine.calculate_amount(self.employee, self.gratuity_rule, period)
		self.applicable_amount = result["applicable_amount"]
		self.normal_amount = result["amount"]

		self.amount = self.apply_regime_cap(result)

	def apply_regime_cap(self, result):
		"""UAE caps the benefit at a maximum number of months' applicable pay.

		Every other regime pays the computed amount as-is.
		"""
		if self.gratuity_regime == "UAE" and self.max_gratuity_months:
			# Cap = N months of the applicable monthly earnings.
			self.max_gratuity_amount = flt(result["applicable_amount"]) * flt(self.max_gratuity_months)
			if flt(self.normal_amount) > flt(self.max_gratuity_amount):
				return flt(self.max_gratuity_amount)
		else:
			self.max_gratuity_amount = 0

		return flt(self.normal_amount)

	def set_status(self, update=False):
		precision = self.precision("amount")
		if self.docstatus == 0:
			status = "Draft"
		elif self.docstatus == 1:
			if flt(self.paid_amount) > 0 and flt(self.amount, precision) == flt(self.paid_amount, precision):
				status = "Paid"
			else:
				status = "Unpaid"
		else:
			status = "Cancelled"

		if update:
			self.db_set("status", status)
		else:
			self.status = status

	def before_submit(self):
		if flt(self.amount) <= 0:
			frappe.throw(_("Gratuity Payable must be greater than zero before submission."))

	def on_submit(self):
		if self.pay_via_salary_slip:
			self.create_additional_salary()
		else:
			self.make_gl_entries()
		self.set_status(update=True)

	def on_cancel(self):
		self.ignore_linked_doctypes = ["GL Entry", "Additional Salary"]
		if not self.pay_via_salary_slip:
			self.make_gl_entries(cancel=True)
		self.set_status(update=True)

	# --- settlement ------------------------------------------------------

	def create_additional_salary(self):
		additional_salary = frappe.new_doc("Additional Salary")
		additional_salary.employee = self.employee
		additional_salary.salary_component = self.salary_component
		additional_salary.overwrite_salary_structure_amount = 0
		additional_salary.amount = self.amount
		additional_salary.payroll_date = self.payroll_date
		additional_salary.company = self.company
		additional_salary.ref_doctype = self.doctype
		additional_salary.ref_docname = self.name
		additional_salary.submit()

	def make_gl_entries(self, cancel=False):
		if flt(self.amount) <= 0:
			frappe.throw(_("Total amount cannot be zero."))

		gl_entries = [
			self.get_gl_dict(
				{
					"account": self.payable_account,
					"credit": self.amount,
					"credit_in_account_currency": self.amount,
					"against": self.expense_account,
					"party_type": "Employee",
					"party": self.employee,
					"against_voucher_type": self.doctype,
					"against_voucher": self.name,
					"cost_center": self.cost_center,
				},
				item=self,
			),
			self.get_gl_dict(
				{
					"account": self.expense_account,
					"debit": self.amount,
					"debit_in_account_currency": self.amount,
					"against": self.payable_account,
					"cost_center": self.cost_center,
				},
				item=self,
			),
		]
		make_gl_entries(gl_entries, cancel=cancel)


@frappe.whitelist()
def get_gratuity_preview(employee: str, gratuity_rule: str, gratuity_regime: str = None, max_gratuity_months=None):
	"""Live preview for the form's 'Calculate' button — no document required."""
	period = engine.get_service_period(employee, gratuity_rule)
	result = engine.calculate_amount(employee, gratuity_rule, period)

	amount = result["amount"]
	max_amount = 0
	if gratuity_regime == "UAE" and max_gratuity_months:
		max_amount = flt(result["applicable_amount"]) * flt(max_gratuity_months)
		if flt(amount) > flt(max_amount):
			amount = max_amount

	return {
		"current_work_experience": period["current_work_experience"],
		"years": period["years"],
		"months": period["months"],
		"days": period["days"],
		"applicable_amount": result["applicable_amount"],
		"normal_amount": result["amount"],
		"max_gratuity_amount": max_amount,
		"amount": amount,
	}
