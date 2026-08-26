"""One document held against an employee — contract, ID, visa, certificate.

Kept as its own doctype rather than a bare File attachment because the fields
that make a document vault useful (type, number, issue and expiry dates,
verification) have nowhere to live on a File.
"""

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import getdate, nowdate


class EmployeeDocument(Document):
	def validate(self):
		self.title = self.title or self.document_type
		if self.issued_on and self.expires_on and getdate(self.expires_on) < getdate(self.issued_on):
			frappe.throw(_("The expiry date cannot be before the issue date."))
		# Verification is HR's statement that they sighted the original, so an
		# employee replacing the file must not carry the old tick forward.
		if not self.is_new() and self.has_value_changed("attachment"):
			self.is_verified = 0

	@property
	def days_to_expiry(self) -> int | None:
		if not self.expires_on:
			return None
		return (getdate(self.expires_on) - getdate(nowdate())).days
