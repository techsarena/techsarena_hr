"""Training calendar and certification tracking.

Deliberately thin. HRMS already models training properly — Training Program,
Training Event with its attendee child table, Training Result and Training
Feedback — and duplicating that would leave two sources of truth for whether
somebody attended a course. What was missing is a self-service surface: an
employee had no way to see what they are booked on, and HR had no roster view
outside the desk.

Certifications reuse Employee Document, which already carries issue and expiry
dates and feeds the daily renewal sweep in `notifications.py`. A certificate is
a document with an expiry; it does not need a doctype of its own.
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import cint, getdate, now_datetime, nowdate

from techsarena_hr.api import (
	EXPIRY_WARNING_DAYS,
	HR_ROLES,
	_current_employee,
	_publish,
	_publish_to_employee,
	_require_employee_user,
	_require_hr_access,
	_require_hrms,
	_require_login,
)

#: Employee Document types that represent a qualification rather than an ID or
#: a contract. Kept here so the certifications view and the document vault stay
#: in agreement about what counts.
CERTIFICATION_TYPES = ("Professional Certification", "Educational Certificate")

#: Attendee statuses HRMS itself defines on Training Event Employee.
ATTENDEE_OPEN = ("Open", "Invited")

EVENT_FIELDS = (
	"name", "event_name", "training_program", "event_status", "type", "level",
	"course", "location", "start_time", "end_time", "introduction",
	"trainer_name", "has_certificate", "docstatus",
)


def _is_hr(user: str | None = None) -> bool:
	return bool(set(frappe.get_roles(user or frappe.session.user)).intersection(HR_ROLES))


def _attendee_rows(events: list[str]) -> dict[str, list[dict]]:
	"""Attendees grouped by event, in one query rather than one per event."""
	if not events:
		return {}
	grouped: dict[str, list[dict]] = {}
	for row in frappe.get_all(
		"Training Event Employee",
		filters={"parent": ["in", events]},
		fields=[
			"parent", "employee", "employee_name", "department",
			"status", "attendance", "is_mandatory",
		],
		order_by="idx asc",
		limit_page_length=0,
	):
		grouped.setdefault(row.parent, []).append(row)
	return grouped


@frappe.whitelist()
def my_training() -> dict:
	"""What this employee is booked on, and what they have completed.

	Split by time rather than status: "what is coming" and "what I have done"
	are different questions, and an event's own status does not answer either on
	its own — a Scheduled event in the past is a data problem, not something
	upcoming.
	"""
	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)

	if not frappe.db.table_exists("Training Event"):
		return {"upcoming": [], "past": [], "counts": {}, "unavailable": True}

	booked = frappe.get_all(
		"Training Event Employee",
		filters={"employee": employee},
		fields=["parent", "status", "attendance", "is_mandatory"],
		limit_page_length=0,
	)
	if not booked:
		return {"upcoming": [], "past": [], "counts": {"upcoming": 0, "past": 0, "mandatory": 0}}

	by_event = {row.parent: row for row in booked}
	events = frappe.get_all(
		"Training Event",
		filters={"name": ["in", list(by_event)], "docstatus": ["<", 2]},
		fields=EVENT_FIELDS,
		order_by="start_time desc",
		limit_page_length=0,
	)

	now = now_datetime()
	upcoming, past = [], []
	for event in events:
		mine = by_event[event["name"]]
		event["my_status"] = mine.status
		event["my_attendance"] = mine.attendance
		event["is_mandatory"] = bool(mine.is_mandatory)
		event["start_time"] = str(event["start_time"]) if event["start_time"] else None
		event["end_time"] = str(event["end_time"]) if event["end_time"] else None
		event["can_give_feedback"] = bool(
			event["docstatus"] == 1
			and mine.attendance == "Present"
			and mine.status != "Feedback Submitted"
		)

		starts = getdate(event["start_time"]) if event["start_time"] else None
		is_past = event["event_status"] == "Completed" or (
			event["start_time"] is not None and str(event["start_time"]) < str(now)
		)
		(past if is_past else upcoming).append(event)

	upcoming.sort(key=lambda e: e["start_time"] or "")
	return {
		"upcoming": upcoming,
		"past": past,
		"counts": {
			"upcoming": len(upcoming),
			"past": len(past),
			"mandatory": sum(1 for e in upcoming if e["is_mandatory"]),
		},
	}


@frappe.whitelist()
def training_calendar(from_date: str | None = None, to_date: str | None = None) -> dict:
	"""Every scheduled event in a window, with its roster. HR only."""
	_require_hr_access()
	_require_hrms()
	if not frappe.db.table_exists("Training Event"):
		return {"events": [], "unavailable": True}

	filters: list = [["docstatus", "<", 2]]
	if from_date:
		filters.append(["start_time", ">=", from_date])
	if to_date:
		filters.append(["start_time", "<=", f"{to_date} 23:59:59"])

	events = frappe.get_all(
		"Training Event",
		filters=filters,
		fields=EVENT_FIELDS,
		order_by="start_time asc",
		limit_page_length=200,
	)
	attendees = _attendee_rows([e["name"] for e in events])

	for event in events:
		rows = attendees.get(event["name"], [])
		event["start_time"] = str(event["start_time"]) if event["start_time"] else None
		event["end_time"] = str(event["end_time"]) if event["end_time"] else None
		event["attendees"] = rows
		event["attendee_count"] = len(rows)
		# Attendance is only meaningful once the event has been submitted and
		# marked up; before that every row reads as absent, which is misleading.
		event["present_count"] = sum(1 for r in rows if r["attendance"] == "Present")
		event["pending_count"] = sum(1 for r in rows if r["status"] in ATTENDEE_OPEN)

	return {"events": events, "programs": _programs()}


def _programs() -> list[dict]:
	if not frappe.db.table_exists("Training Program"):
		return []
	return frappe.get_all(
		"Training Program",
		fields=["name", "training_program", "status", "trainer_name"],
		order_by="modified desc",
		limit_page_length=100,
	)


@frappe.whitelist()
def training_event_detail(name: str) -> dict:
	"""One event in full.

	An employee may read an event they are booked on; HR may read any. Rosters
	are HR-only either way — who else is on a course is not self-service data.
	"""
	user = _require_login()
	_require_hrms()
	employee = _current_employee(user, required=False)
	is_hr = _is_hr(user)

	event = frappe.db.get_value("Training Event", name, EVENT_FIELDS, as_dict=True)
	if not event:
		frappe.throw(_("That training event was not found."), frappe.DoesNotExistError)

	rows = _attendee_rows([name]).get(name, [])
	mine = next((r for r in rows if r["employee"] == employee), None)
	if not is_hr and not mine:
		frappe.throw(_("You are not booked on this training."), frappe.PermissionError)

	event["start_time"] = str(event["start_time"]) if event["start_time"] else None
	event["end_time"] = str(event["end_time"]) if event["end_time"] else None
	event["attendees"] = rows if is_hr else []
	event["my_status"] = mine["status"] if mine else None
	event["my_attendance"] = mine["attendance"] if mine else None
	event["is_mandatory"] = bool(mine["is_mandatory"]) if mine else False
	return event


@frappe.whitelist(methods=["POST"])
def mark_attendance(event: str, records: str) -> dict:
	"""Record who turned up. HR only.

	`records` is a JSON list of {employee, attendance}. Written through the
	parent document so HRMS's own validation runs.
	"""
	_require_hr_access()
	_require_hrms()

	try:
		wanted = {row["employee"]: row.get("attendance") for row in frappe.parse_json(records) or []}
	except Exception:
		frappe.throw(_("Those attendance records could not be read."))
	if not wanted:
		frappe.throw(_("Nothing to record."))

	doc = frappe.get_doc("Training Event", event)
	changed = 0
	for row in doc.get("employees") or []:
		if row.employee in wanted and wanted[row.employee] in ("Present", "Absent"):
			row.attendance = wanted[row.employee]
			# Attending completes the booking; HRMS's own status list already
			# distinguishes this from "Feedback Submitted".
			if row.attendance == "Present" and row.status in ATTENDEE_OPEN:
				row.status = "Completed"
			changed += 1

	if not changed:
		frappe.throw(_("None of those employees are on this event."))

	doc.flags.ignore_permissions = True
	doc.save()
	_publish("training_changed", {"name": event})
	return {"event": event, "updated": changed}


@frappe.whitelist(methods=["POST"])
def submit_training_feedback(event: str, feedback: str) -> dict:
	"""The attendee's own feedback on a course they attended."""
	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)

	if not (feedback or "").strip():
		frappe.throw(_("Write your feedback before sending."))

	row = frappe.db.get_value(
		"Training Event Employee",
		{"parent": event, "employee": employee},
		["name", "attendance", "status"],
		as_dict=True,
	)
	if not row:
		frappe.throw(_("You are not booked on this training."), frappe.PermissionError)
	# Feedback on a course you did not attend is not feedback.
	if row.attendance != "Present":
		frappe.throw(_("Feedback is only open to attendees marked present."))
	if row.status == "Feedback Submitted":
		frappe.throw(_("You have already given feedback on this training."))

	event_doc = frappe.db.get_value(
		"Training Event", event, ["event_name", "course", "trainer_name"], as_dict=True
	) or {}

	doc = frappe.get_doc(
		{
			"doctype": "Training Feedback",
			"employee": employee,
			"training_event": event,
			"event_name": event_doc.get("event_name"),
			"course": event_doc.get("course"),
			"trainer_name": event_doc.get("trainer_name"),
			"feedback": feedback.strip(),
		}
	)
	doc.insert(ignore_permissions=True)
	doc.submit()

	frappe.db.set_value("Training Event Employee", row.name, "status", "Feedback Submitted")
	_publish_to_employee(employee, "training_changed", {"name": event})
	return {"name": doc.name, "event": event, "status": "Feedback Submitted"}


# ---------------------------------------------------------------------------
# Certifications
#
# Not a new doctype: a certificate is an Employee Document with an expiry, and
# that already carries issue/expiry dates, verification, and the daily renewal
# sweep. This is a filtered view of the same records.
# ---------------------------------------------------------------------------


@frappe.whitelist()
def my_certifications() -> dict:
	"""This employee's qualifications, with renewal state."""
	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)

	if not frappe.db.table_exists("Employee Document"):
		return {"certifications": [], "counts": {}}

	rows = frappe.get_all(
		"Employee Document",
		filters={"employee": employee, "document_type": ["in", CERTIFICATION_TYPES]},
		fields=(
			"name", "document_type", "title", "document_number",
			"issued_on", "expires_on", "is_verified", "attachment",
		),
		order_by="expires_on asc, creation desc",
		limit_page_length=100,
	)
	return {"certifications": _with_expiry(rows), "counts": _expiry_counts(rows)}


@frappe.whitelist()
def certification_matrix(days: int = EXPIRY_WARNING_DAYS) -> dict:
	"""Who holds what, and what is lapsing. HR only."""
	_require_hr_access()
	_require_hrms()
	if not frappe.db.table_exists("Employee Document"):
		return {"employees": [], "counts": {}}

	rows = frappe.get_all(
		"Employee Document",
		filters={"document_type": ["in", CERTIFICATION_TYPES]},
		fields=(
			"name", "employee", "employee_name", "document_type", "title",
			"issued_on", "expires_on", "is_verified",
		),
		order_by="employee_name asc, expires_on asc",
		limit_page_length=0,
	)
	rows = _with_expiry(rows)

	grouped: dict[str, dict] = {}
	for row in rows:
		entry = grouped.setdefault(
			row["employee"],
			{"employee": row["employee"], "employee_name": row["employee_name"], "certifications": []},
		)
		entry["certifications"].append(row)

	# Employees holding none are worth seeing: a certification matrix that only
	# lists holders cannot answer "who is missing this".
	holders = set(grouped)
	for row in frappe.get_all(
		"Employee",
		filters={"status": "Active"},
		fields=["name", "employee_name", "department"],
		order_by="employee_name asc",
		limit_page_length=0,
	):
		if row["name"] not in holders:
			grouped[row["name"]] = {
				"employee": row["name"],
				"employee_name": row["employee_name"],
				"certifications": [],
			}

	return {
		"employees": sorted(grouped.values(), key=lambda e: e["employee_name"] or ""),
		"counts": _expiry_counts(rows),
		"horizon_days": cint(days),
	}


def _with_expiry(rows: list[dict]) -> list[dict]:
	"""Adds days-to-expiry and a state the client colours by."""
	today = getdate(nowdate())
	for row in rows:
		if row.get("expires_on"):
			days = (getdate(row["expires_on"]) - today).days
			row["days_to_expiry"] = days
			row["expiry_state"] = (
				"expired" if days < 0 else "expiring" if days <= EXPIRY_WARNING_DAYS else "valid"
			)
		else:
			# A qualification with no expiry is normal, not missing data.
			row["days_to_expiry"] = None
			row["expiry_state"] = "none"
		row["issued_on"] = str(row["issued_on"]) if row.get("issued_on") else None
		row["expires_on"] = str(row["expires_on"]) if row.get("expires_on") else None
	return rows


def _expiry_counts(rows: list[dict]) -> dict:
	return {
		"all": len(rows),
		"expired": sum(1 for r in rows if r.get("expiry_state") == "expired"),
		"expiring": sum(1 for r in rows if r.get("expiry_state") == "expiring"),
		"verified": sum(1 for r in rows if r.get("is_verified")),
	}
