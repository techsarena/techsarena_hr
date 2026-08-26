"""A policy employees are asked to read and confirm.

Versioned on purpose. An acknowledgement is evidence that a specific person
read specific text on a specific date; if the text can change underneath that
record, the evidence is worthless. So a material change means a new version,
and a new version asks everyone to confirm again.
"""

import frappe
from frappe import _
from frappe.model.document import Document


class HRPolicy(Document):
	def validate(self):
		if not (self.version or "").strip():
			frappe.throw(_("Give this policy a version."))
		self.version = self.version.strip()

		# Publishing something nobody can read is a configuration mistake worth
		# catching here rather than leaving employees an empty screen.
		if self.is_published and not (self.body or "").strip() and not self.attachment:
			frappe.throw(_("Add the policy text or attach a document before publishing."))

	def on_update(self):
		self._warn_on_silent_edit()

	def _warn_on_silent_edit(self):
		"""Flag a body change that did not come with a version bump.

		Not blocked — a typo fix should not force a re-acknowledgement of the
		whole workforce. But it is recorded, so an audit can tell a correction
		from a material change that should have been versioned.
		"""
		previous = self.get_doc_before_save()
		if not previous or not self.is_published:
			return
		body_changed = (previous.body or "") != (self.body or "")
		version_same = (previous.version or "") == (self.version or "")
		if body_changed and version_same:
			self.add_comment(
				"Comment",
				text=_(
					"Body edited without a version change. Existing acknowledgements still "
					"refer to version {0}."
				).format(self.version),
			)
