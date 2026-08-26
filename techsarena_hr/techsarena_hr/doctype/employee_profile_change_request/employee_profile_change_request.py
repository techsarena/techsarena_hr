"""An employee's request to correct their own Employee record.

Self-service edits do not write to Employee directly: contact and bank details
feed payroll and statutory filings, so a change is proposed here and applied by
HR on approval. Submitting the document *is* the approval — the same shape the
attendance and comp-off requests in the approvals inbox already use.
"""

import json

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import now_datetime

#: Fields self-service may propose, grouped the way the profile screen shows
#: them. Anything absent — status, salary, designation, reports_to — stays an
#: HR-only edit on the Employee record itself, so a crafted payload cannot
#: promote someone or reroute their approvals.
EDITABLE_FIELDS: dict[str, tuple[str, ...]] = {
	"personal": (
		"cell_number",
		"personal_email",
		"current_address",
		"permanent_address",
		"marital_status",
		"blood_group",
		"person_to_be_contacted",
		"relation",
		"emergency_phone_number",
	),
	"statutory": (
		"bank_name",
		"bank_ac_no",
		"ifsc_code",
		"pan_number",
		"provident_fund_account",
	),
}

#: Flattened for membership tests.
ALLOWED_FIELDNAMES: frozenset[str] = frozenset(
	field for names in EDITABLE_FIELDS.values() for field in names
)


class EmployeeProfileChangeRequest(Document):
	def validate(self):
		self.requested_on = self.requested_on or now_datetime()
		self.changes = json.dumps(self._clean_changes(), indent=2, default=str)

	def _clean_changes(self) -> dict:
		"""Keeps only allowed fields that actually differ from the record.

		Runs on every save rather than only on insert: an HR user editing a
		pending request cannot widen it into a field self-service may not touch.
		"""
		try:
			raw = json.loads(self.changes or "{}")
		except (TypeError, ValueError):
			frappe.throw(_("The requested changes could not be read."))
		if not isinstance(raw, dict):
			frappe.throw(_("The requested changes could not be read."))

		meta = frappe.get_meta("Employee")
		current = frappe.db.get_value("Employee", self.employee, "*", as_dict=True) or {}

		cleaned = {}
		for fieldname, value in raw.items():
			if fieldname not in ALLOWED_FIELDNAMES:
				frappe.throw(
					_("{0} is not a field you can request a change to.").format(frappe.bold(fieldname))
				)
			if not meta.has_field(fieldname):
				# Regional/custom builds may not carry every field.
				continue
			value = value.strip() if isinstance(value, str) else value
			# Compare as text so 0 vs "0" and None vs "" do not read as edits.
			if str(value or "") == str(current.get(fieldname) or ""):
				continue
			cleaned[fieldname] = value

		if not cleaned:
			frappe.throw(_("Nothing has changed — update at least one detail before submitting."))
		return cleaned

	def before_submit(self):
		"""Submission is the approval: apply the changes to the Employee record."""
		self.status = "Approved"
		self.decided_by = frappe.session.user
		self.decided_on = now_datetime()

		changes = json.loads(self.changes or "{}")
		employee = frappe.get_doc("Employee", self.employee)
		for fieldname, value in changes.items():
			employee.set(fieldname, value)
		# The employee proposing the change is not the one allowed to write it,
		# so the write runs with HR's permissions after their explicit approval.
		employee.flags.ignore_permissions = True
		employee.save()

		employee.add_comment(
			"Comment",
			text=_("Profile change request {0} approved by {1}.").format(self.name, frappe.session.user),
		)

	def on_cancel(self):
		self.status = "Rejected"
		self.decided_by = frappe.session.user
		self.decided_on = now_datetime()

	@property
	def parsed_changes(self) -> dict:
		try:
			return json.loads(self.changes or "{}")
		except (TypeError, ValueError):
			return {}
