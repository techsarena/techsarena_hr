# Copyright (c) 2026, Techs Arena and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class EmployeeGeofence(Document):
	def validate(self):
		seen = set()
		for row in self.locations:
			if row.location in seen:
				frappe.throw(_("Location {0} is listed more than once.").format(row.location))
			seen.add(row.location)
