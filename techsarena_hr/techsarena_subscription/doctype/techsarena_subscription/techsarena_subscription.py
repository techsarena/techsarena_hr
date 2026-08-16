# Copyright (c) 2026, Techs Arena and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class TechsarenaSubscription(Document):
	def validate(self):
		if not self.license_key:
			self.license_key = frappe.generate_hash(length=20).upper()
