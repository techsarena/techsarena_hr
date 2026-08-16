# Copyright (c) 2026, Techs Arena and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class GeofenceLocation(Document):
	def validate(self):
		if not (-90 <= self.latitude <= 90):
			frappe.throw(_("Latitude must be between -90 and 90."))
		if not (-180 <= self.longitude <= 180):
			frappe.throw(_("Longitude must be between -180 and 180."))
		if self.allowed_radius <= 0:
			frappe.throw(_("Allowed Radius must be greater than zero."))
