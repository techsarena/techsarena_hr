"""Evidence that one employee confirmed one version of one policy.

Immutable once written. This is the record an auditor or a tribunal would rely
on, so it must not be editable after the fact — not by the employee, and not by
HR. Correcting a mistake means the employee acknowledges again, which leaves
both records visible rather than rewriting history.
"""

import frappe
from frappe import _
from frappe.model.document import Document


class HRPolicyAcknowledgement(Document):
	def validate(self):
		if not self.is_new():
			frappe.throw(
				_("An acknowledgement cannot be changed once recorded."), frappe.PermissionError
			)

	def on_trash(self):
		"""Deleting evidence defeats the point of keeping it.

		Checked against the *employee's own* roles rather than a blanket role
		test: an employee who also holds System Manager (common on small sites,
		and true of several users here) must still not be able to erase their own
		acknowledgement. Someone else with System Manager can, deliberately, from
		the desk.
		"""
		own = frappe.db.get_value("Employee", {"user_id": frappe.session.user}, "name")
		if own and own == self.employee:
			frappe.throw(
				_("You cannot remove your own acknowledgement."), frappe.PermissionError
			)
		if "System Manager" not in frappe.get_roles(frappe.session.user):
			frappe.throw(
				_("Acknowledgement records are kept as evidence and cannot be removed."),
				frappe.PermissionError,
			)
