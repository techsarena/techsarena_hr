# Copyright (c) 2026, Techs Arena and contributors
# For license information, please see license.txt
"""
Employee Checkin Request — a self-service correction for a missed punch.

An employee (or HR on their behalf) records the time they actually checked in
or out; on submission an approved `Employee Checkin` is created and linked back.
"""

import frappe
from frappe import _
from frappe.model.document import Document


class EmployeeCheckinRequest(Document):
	def on_submit(self):
		checkin = frappe.new_doc("Employee Checkin")
		checkin.employee = self.employee
		checkin.log_type = self.log_type
		checkin.time = self.time
		checkin.insert(ignore_permissions=True)
		self.db_set("checkin", checkin.name)
		frappe.msgprint(
			_("Check-in {0} created.").format(frappe.utils.get_link_to_form("Employee Checkin", checkin.name)),
			alert=True,
		)

	def on_cancel(self):
		if self.checkin:
			frappe.delete_doc("Employee Checkin", self.checkin, ignore_permissions=True, force=True)
			self.db_set("checkin", None)
