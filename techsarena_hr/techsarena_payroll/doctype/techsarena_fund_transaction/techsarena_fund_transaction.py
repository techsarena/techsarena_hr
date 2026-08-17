# Copyright (c) 2026, Techs Arena and contributors
# For license information, please see license.txt

"""Techsarena Fund Transaction — one row of an employee's EOBI / Provident Fund
ledger. Contributions (employee and employer) and profit add to the fund; a
withdrawal subtracts from it. The running balance is the sum of these rows, so
the document itself stays deliberately simple and carries no GL posting."""

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt


class TechsarenaFundTransaction(Document):
	def validate(self):
		if flt(self.amount) <= 0:
			frappe.throw(_("Amount must be greater than zero."))
		if not self.company:
			self.company = frappe.db.get_value("Employee", self.employee, "company")
