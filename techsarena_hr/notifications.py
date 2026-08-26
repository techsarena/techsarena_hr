"""Notification service.

Two halves:

* **Emit** — `notify()` writes a Notification Log row and pushes it down the
  existing realtime channel, so a connected client updates without polling.
  The document hooks below call it on the events an employee actually cares
  about: a decision on something they asked for, and a document of theirs that
  is about to expire.
* **Read** — the endpoints an inbox needs: a paginated list, unread counts,
  mark-one, mark-all, and per-category preferences.

Notification Log is Frappe's own doctype, so anything raised here also shows up
in the desk UI rather than living only in this app.
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import cint, getdate, nowdate

from techsarena_hr.api import (
	_publish_to_employee,
	_require_login,
	EXPIRY_WARNING_DAYS,
)

#: Categories a user can mute, and what each covers. Kept here rather than on a
#: doctype so a new category ships with the code that raises it.
CATEGORIES: dict[str, str] = {
	"approvals": "Decisions on requests you submitted",
	"documents": "Documents of yours that are expiring",
	"payroll": "Payslips and payroll events",
	"announcements": "Company announcements",
}

#: Where an employee's preference is stored. A single JSON blob on the User
#: rather than a child table: it is read on every notify() call, and one field
#: read is cheaper than a join for something this small.
PREFERENCE_FIELD = "techsarena_notification_prefs"


def _muted(user: str) -> set[str]:
	"""Categories this user has switched off."""
	try:
		raw = frappe.db.get_value("User", user, PREFERENCE_FIELD)
	except Exception:
		# The custom field may not exist yet on a site that has not migrated.
		return set()
	if not raw:
		return set()
	try:
		parsed = frappe.parse_json(raw)
	except Exception:
		return set()
	if not isinstance(parsed, dict):
		return set()
	return {key for key, enabled in parsed.items() if not enabled}


def notify(
	user: str,
	subject: str,
	*,
	category: str = "approvals",
	document_type: str | None = None,
	document_name: str | None = None,
	message: str | None = None,
) -> str | None:
	"""Raise one notification for one user.

	Returns the new row's name, or None when nothing was written — the user
	muted the category, or there is no user to tell. Deliberately never raises:
	a notification failing must not roll back the business event that caused it.
	"""
	if not user or user == "Guest" or category in _muted(user):
		return None
	try:
		doc = frappe.get_doc(
			{
				"doctype": "Notification Log",
				"for_user": user,
				"subject": subject,
				"email_content": message,
				"type": "Alert",
				"document_type": document_type,
				"document_name": document_name,
			}
		).insert(ignore_permissions=True)
	except Exception:
		frappe.log_error(f"Could not notify {user}: {subject}", "Notification failed")
		return None

	# Same channel the rest of the app already listens on, so the bell updates
	# without the client polling for it.
	frappe.publish_realtime(
		event="techsarena_hr",
		message={
			"event": "notification",
			"name": doc.name,
			"subject": subject,
			"category": category,
			"document_type": document_type,
			"document_name": document_name,
		},
		user=user,
		after_commit=True,
	)
	return doc.name


def _employee_user(employee: str | None) -> str | None:
	return frappe.db.get_value("Employee", employee, "user_id") if employee else None


# ---------------------------------------------------------------------------
# Document hooks
#
# Registered in hooks.py. Each one answers "who asked for this, and what do
# they now need to know" — nothing is broadcast to a whole company.
# ---------------------------------------------------------------------------


def on_leave_decision(doc, method=None):
	"""Tell the applicant their leave was approved or rejected."""
	if doc.status not in ("Approved", "Rejected"):
		return
	user = _employee_user(doc.employee)
	if not user:
		return
	# on_submit and on_update_after_submit can both fire for one decision.
	if frappe.db.exists(
		"Notification Log",
		{"for_user": user, "document_type": "Leave Application", "document_name": doc.name},
	):
		return
	notify(
		user,
		_("Your leave request was {0}").format(_(doc.status.lower())),
		category="approvals",
		document_type="Leave Application",
		document_name=doc.name,
		message=_("{0} to {1}").format(doc.from_date, doc.to_date),
	)


def on_expense_decision(doc, method=None):
	"""Tell the claimant their expense claim was decided."""
	if doc.approval_status not in ("Approved", "Rejected"):
		return
	user = _employee_user(doc.employee)
	if not user:
		return
	if frappe.db.exists(
		"Notification Log",
		{"for_user": user, "document_type": "Expense Claim", "document_name": doc.name},
	):
		return
	notify(
		user,
		_("Your expense claim was {0}").format(_(doc.approval_status.lower())),
		category="approvals",
		document_type="Expense Claim",
		document_name=doc.name,
		message=_("Claimed {0}").format(doc.total_claimed_amount),
	)


def on_salary_slip_submit(doc, method=None):
	"""Tell the employee their payslip is available."""
	user = _employee_user(doc.employee)
	if not user:
		return
	notify(
		user,
		_("Your payslip for {0} is ready").format(doc.get("start_date") or ""),
		category="payroll",
		document_type="Salary Slip",
		document_name=doc.name,
	)


def on_profile_change_decided(doc, method=None):
	"""Tell the employee whether their profile correction was applied.

	Fires from both on_submit and on_update, so it guards against telling the
	same person the same thing twice: any later edit to a decided request must
	not re-raise the notification.
	"""
	if doc.status not in ("Approved", "Rejected"):
		return
	user = _employee_user(doc.employee)
	if not user:
		return
	if frappe.db.exists(
		"Notification Log",
		{
			"for_user": user,
			"document_type": "Employee Profile Change Request",
			"document_name": doc.name,
		},
	):
		return
	notify(
		user,
		_("Your profile change request was {0}").format(_(doc.status.lower())),
		category="approvals",
		document_type="Employee Profile Change Request",
		document_name=doc.name,
		message=doc.get("decision_comment"),
	)


def notify_expiring_documents() -> dict:
	"""Daily sweep: warn employees whose documents are about to lapse.

	Idempotent by design — it only fires on the exact day-counts in MILESTONES,
	so a document raises at most one notification per milestone rather than one
	every day for two months.
	"""
	MILESTONES = {EXPIRY_WARNING_DAYS, 30, 14, 7, 1, 0}
	if not frappe.db.table_exists("Employee Document"):
		return {"checked": 0, "notified": 0}

	today = getdate(nowdate())
	rows = frappe.get_all(
		"Employee Document",
		filters=[["expires_on", "is", "set"]],
		fields=["name", "employee", "document_type", "title", "expires_on"],
		limit_page_length=0,
	)

	sent = 0
	for row in rows:
		days = (getdate(row["expires_on"]) - today).days
		if days not in MILESTONES:
			continue
		user = _employee_user(row["employee"])
		if not user:
			continue
		label = row.get("title") or row["document_type"]
		subject = (
			_("Your {0} expires today").format(label)
			if days == 0
			else _("Your {0} expires in {1} days").format(label, days)
		)
		# The milestone check alone only dedupes across days; this also covers
		# the sweep being run twice on the same day (a manual run, or a retry).
		if frappe.db.exists(
			"Notification Log",
			{
				"for_user": user,
				"document_type": "Employee Document",
				"document_name": row["name"],
				"subject": subject,
			},
		):
			continue
		if notify(
			user,
			subject,
			category="documents",
			document_type="Employee Document",
			document_name=row["name"],
		):
			sent += 1

	return {"checked": len(rows), "notified": sent}


# ---------------------------------------------------------------------------
# Read API
# ---------------------------------------------------------------------------


@frappe.whitelist()
def notifications(limit: int = 20, start: int = 0, unread_only: int = 0) -> dict:
	"""One page of this user's notifications, newest first."""
	user = _require_login()
	limit, start = cint(limit) or 20, cint(start)

	filters: dict = {"for_user": user}
	if cint(unread_only):
		filters["read"] = 0

	rows = frappe.get_all(
		"Notification Log",
		filters=filters,
		fields=["name", "subject", "email_content", "type", "document_type", "document_name", "read", "creation"],
		order_by="creation desc",
		# One extra row answers "is there another page" without a second count.
		limit_page_length=limit + 1,
		limit_start=start,
	)
	has_more = len(rows) > limit
	return {
		"notifications": rows[:limit],
		"has_more": has_more,
		"next_start": start + limit if has_more else None,
		"unread": frappe.db.count("Notification Log", {"for_user": user, "read": 0}),
	}


@frappe.whitelist(methods=["POST"])
def mark_all_read() -> dict:
	"""Clear the whole unread count in one write."""
	user = _require_login()
	frappe.db.set_value(
		"Notification Log", {"for_user": user, "read": 0}, "read", 1, update_modified=False
	)
	frappe.publish_realtime(
		event="techsarena_hr", message={"event": "notifications_read"}, user=user, after_commit=True
	)
	return {"unread": 0}


@frappe.whitelist()
def notification_preferences() -> dict:
	"""Which categories this user still wants, with their descriptions."""
	user = _require_login()
	muted = _muted(user)
	return {
		"categories": [
			{"key": key, "label": _(label), "enabled": key not in muted}
			for key, label in CATEGORIES.items()
		]
	}


@frappe.whitelist(methods=["POST"])
def save_notification_preferences(preferences: str) -> dict:
	"""Store the on/off state for each category.

	Unknown keys are dropped rather than stored, so a stale client cannot write
	preferences the server would never read back.
	"""
	user = _require_login()
	try:
		parsed = frappe.parse_json(preferences) or {}
	except Exception:
		frappe.throw(_("Those preferences could not be read."))
	if not isinstance(parsed, dict):
		frappe.throw(_("Those preferences could not be read."))

	clean = {key: bool(parsed.get(key, True)) for key in CATEGORIES}
	frappe.db.set_value("User", user, PREFERENCE_FIELD, frappe.as_json(clean), update_modified=False)
	return {"preferences": clean}
