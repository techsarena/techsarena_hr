# Copyright (c) 2026, Techs Arena and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class EmployeeDevice(Document):
	def validate(self):
		seen = set()
		for row in self.devices:
			if row.device_id in seen:
				frappe.throw(_("Device ID {0} is listed more than once.").format(row.device_id))
			seen.add(row.device_id)
			if not row.registered_on:
				row.registered_on = frappe.utils.now_datetime()
