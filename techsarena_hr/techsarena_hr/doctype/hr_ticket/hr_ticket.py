"""An employee's question for HR.

Distinct from Employee Grievance on purpose. A grievance is a formal complaint
that must name who or what it is against and carries an investigation process;
"my payslip is short" is neither. Forcing routine questions through the
grievance workflow both mis-records them and buries the real grievances.
"""

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime

#: Statuses that mean the ticket needs no further work from HR.
CLOSED_STATUSES = ("Resolved", "Closed")


class HRTicket(Document):
	def validate(self):
		self.opened_on = self.opened_on or now_datetime()

		# Stamp the moment it stopped needing work, and clear it if reopened, so
		# "how long did this take" stays answerable from the record alone.
		if self.status in CLOSED_STATUSES:
			if not self.resolved_on:
				self.resolved_on = now_datetime()
		else:
			self.resolved_on = None

		if self.status == "Resolved" and not (self.resolution or "").strip():
			frappe.throw(_("Say what the resolution was before marking this resolved."))

	def on_update(self):
		self._notify_status_change()

	def _notify_status_change(self):
		"""Tell the employee when HR moves their ticket, and only then.

		Skipped on insert (they just filed it) and when the employee is the one
		who changed it, so nobody is notified about their own action.
		"""
		previous = self.get_doc_before_save()
		if not previous or previous.status == self.status:
			return

		raiser = frappe.db.get_value("Employee", self.raised_by, "user_id")
		if not raiser or raiser == frappe.session.user:
			return

		from techsarena_hr.notifications import notify

		notify(
			raiser,
			_("Your HR request is now {0}").format(_(self.status)),
			category="approvals",
			document_type="HR Ticket",
			document_name=self.name,
			message=self.subject,
		)
