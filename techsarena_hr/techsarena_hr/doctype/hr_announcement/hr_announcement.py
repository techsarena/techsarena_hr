"""A notice HR broadcasts to employees, read by the app's Announcements screen."""

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import getdate


class HRAnnouncement(Document):
	def validate(self):
		if self.expires_on and self.published_on and getdate(self.expires_on) < getdate(self.published_on):
			frappe.throw(_("The expiry date cannot be before the published date."))
