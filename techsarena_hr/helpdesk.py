"""HR helpdesk — routine questions employees ask HR.

Separate from Employee Grievance by design: a grievance names a party it is
against and carries a formal process, while "my payslip is short" is a query.
Mixing them mis-records the questions and buries the real grievances.

Visibility rule, applied on every endpoint here: an employee sees their own
tickets and the public replies on them. HR sees everything, including internal
notes. There is no middle tier — a manager has no business reading their
report's pay query.
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import cint, now_datetime

from techsarena_hr.api import (
	HR_ROLES,
	_current_employee,
	_require_employee_user,
	_require_hr_access,
	_require_hrms,
	_require_login,
	_publish,
	_publish_to_employee,
)
from techsarena_hr.techsarena_hr.doctype.hr_ticket.hr_ticket import CLOSED_STATUSES

#: Statuses an employee may set themselves. They may close their own ticket or
#: reopen one they disagree with; everything else is HR's to move.
EMPLOYEE_STATUSES = {"Closed", "Open"}


def _is_hr(user: str | None = None) -> bool:
	return bool(set(frappe.get_roles(user or frappe.session.user)).intersection(HR_ROLES))


def _ticket_for(name: str, user: str, *, employee: str | None) -> "frappe.Document":
	"""Load a ticket the caller is allowed to see, or raise."""
	doc = frappe.get_doc("HR Ticket", name)
	if not _is_hr(user) and doc.raised_by != employee:
		frappe.throw(_("You can only view your own requests."), frappe.PermissionError)
	return doc


def _serialise(doc, *, include_internal: bool) -> dict:
	"""One ticket as the client renders it.

	`include_internal` is the whole privacy boundary: an internal note must
	never reach the employee who raised the ticket.
	"""
	replies = []
	for row in doc.get("replies") or []:
		if row.is_internal and not include_internal:
			continue
		replies.append(
			{
				"author": row.author,
				"author_name": row.author_name,
				"posted_on": str(row.posted_on) if row.posted_on else None,
				"is_internal": bool(row.is_internal),
				"message": row.message,
			}
		)

	return {
		"name": doc.name,
		"subject": doc.subject,
		"category": doc.category,
		"status": doc.status,
		"priority": doc.priority,
		"description": doc.description,
		"resolution": doc.resolution,
		"attachment": doc.attachment,
		"raised_by": doc.raised_by,
		"raised_by_name": doc.raised_by_name,
		"assigned_to": doc.assigned_to,
		"opened_on": str(doc.opened_on) if doc.opened_on else None,
		"resolved_on": str(doc.resolved_on) if doc.resolved_on else None,
		"reopen_count": cint(doc.reopen_count),
		"replies": replies,
		"is_open": doc.status not in CLOSED_STATUSES,
	}


@frappe.whitelist()
def my_tickets(status: str | None = None) -> dict:
	"""The signed-in employee's own tickets, newest activity first."""
	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)

	filters: dict = {"raised_by": employee}
	if status:
		filters["status"] = status

	rows = frappe.get_all(
		"HR Ticket",
		filters=filters,
		fields=(
			"name", "subject", "category", "status", "priority",
			"opened_on", "resolved_on", "modified",
		),
		order_by="modified desc",
		limit_page_length=100,
	)
	counts: dict[str, int] = {"all": len(rows)}
	for row in rows:
		key = "open" if row["status"] not in CLOSED_STATUSES else "closed"
		counts[key] = counts.get(key, 0) + 1

	return {"tickets": rows, "counts": counts, "categories": _categories()}


def _categories() -> list[str]:
	meta = frappe.get_meta("HR Ticket")
	field = meta.get_field("category")
	return [choice for choice in (field.options or "").split("\n") if choice]


@frappe.whitelist()
def ticket_queue(status: str | None = None, category: str | None = None, mine: int = 0) -> dict:
	"""The whole helpdesk queue. HR only."""
	user = _require_hr_access()
	_require_hrms()

	filters: dict = {}
	if status:
		filters["status"] = status
	if category:
		filters["category"] = category
	if cint(mine):
		filters["assigned_to"] = user

	rows = frappe.get_all(
		"HR Ticket",
		filters=filters,
		fields=(
			"name", "subject", "category", "status", "priority",
			"raised_by", "raised_by_name", "assigned_to",
			"opened_on", "resolved_on", "modified",
		),
		order_by="modified desc",
		limit_page_length=200,
	)

	# Counts come from the unfiltered table: a queue that recounts only what the
	# current filter matched cannot show what the other tabs hold.
	all_rows = frappe.get_all("HR Ticket", fields=("status", "assigned_to"), limit_page_length=0)
	counts = {
		"all": len(all_rows),
		"open": sum(1 for r in all_rows if r["status"] not in CLOSED_STATUSES),
		"unassigned": sum(
			1 for r in all_rows if not r["assigned_to"] and r["status"] not in CLOSED_STATUSES
		),
		"mine": sum(1 for r in all_rows if r["assigned_to"] == user and r["status"] not in CLOSED_STATUSES),
	}
	return {"tickets": rows, "counts": counts, "categories": _categories()}


@frappe.whitelist()
def ticket_detail(name: str) -> dict:
	"""One ticket in full, with the replies the caller may see."""
	user = _require_login()
	_require_hrms()
	employee = _current_employee(user, required=False)
	doc = _ticket_for(name, user, employee=employee)
	return _serialise(doc, include_internal=_is_hr(user))


@frappe.whitelist(methods=["POST"])
def raise_ticket(
	subject: str,
	category: str,
	description: str,
	priority: str = "Normal",
	attachment: str | None = None,
) -> dict:
	"""File a ticket as the signed-in employee.

	`raised_by` comes from the session, never the client — a ticket filed in
	someone else's name would be worse than no helpdesk at all.
	"""
	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)

	if not (subject or "").strip():
		frappe.throw(_("Give your request a subject."))
	if not (description or "").strip():
		frappe.throw(_("Describe what you need help with."))
	if category not in _categories():
		frappe.throw(_("{0} is not a category you can file under.").format(category))

	doc = frappe.get_doc(
		{
			"doctype": "HR Ticket",
			"subject": subject.strip(),
			"category": category,
			"description": description.strip(),
			# Urgency is HR's call, not the requester's — everything arrives
			# Normal and HR re-prioritises.
			"priority": "Normal",
			"attachment": attachment,
			"raised_by": employee,
			"status": "Open",
			"opened_on": now_datetime(),
		}
	)
	doc.insert(ignore_permissions=True)

	_publish("helpdesk_changed", {"name": doc.name})
	return {"name": doc.name, "status": doc.status}


@frappe.whitelist(methods=["POST"])
def reply_to_ticket(name: str, message: str, internal: int = 0) -> dict:
	"""Add a message to a ticket's conversation."""
	user = _require_login()
	_require_hrms()
	employee = _current_employee(user, required=False)
	doc = _ticket_for(name, user, employee=employee)

	if not (message or "").strip():
		frappe.throw(_("Write a message before sending."))

	is_hr = _is_hr(user)
	# Only HR can write a note the employee cannot see. Without this an employee
	# could hide their own message from the person meant to read it.
	internal_flag = 1 if (cint(internal) and is_hr) else 0

	doc.append(
		"replies",
		{
			"author": user,
			"author_name": frappe.utils.get_fullname(user),
			"posted_on": now_datetime(),
			"is_internal": internal_flag,
			"message": message.strip(),
		},
	)

	# A reply moves the ticket back into play: HR answering puts the ball with
	# the employee, and the employee answering puts it back with HR.
	if not internal_flag:
		if is_hr and doc.status == "Open":
			doc.status = "Waiting on Employee"
		elif not is_hr and doc.status == "Waiting on Employee":
			doc.status = "In Progress"

	doc.flags.ignore_permissions = True
	doc.save()

	if not internal_flag:
		if is_hr:
			_publish_to_employee(doc.raised_by, "helpdesk_changed", {"name": doc.name})
			from techsarena_hr.notifications import notify

			raiser = frappe.db.get_value("Employee", doc.raised_by, "user_id")
			if raiser:
				notify(
					raiser,
					_("HR replied to your request"),
					category="approvals",
					document_type="HR Ticket",
					document_name=doc.name,
					message=doc.subject,
				)
		else:
			_publish("helpdesk_changed", {"name": doc.name})

	return _serialise(doc, include_internal=is_hr)


@frappe.whitelist(methods=["POST"])
def update_ticket(
	name: str,
	status: str | None = None,
	priority: str | None = None,
	assigned_to: str | None = None,
	resolution: str | None = None,
) -> dict:
	"""Move a ticket along.

	HR may set anything. The employee who raised it may only close it or reopen
	it — priority and assignment are the helpdesk's to manage.
	"""
	user = _require_login()
	_require_hrms()
	employee = _current_employee(user, required=False)
	doc = _ticket_for(name, user, employee=employee)
	is_hr = _is_hr(user)

	if not is_hr:
		if priority or assigned_to or resolution:
			frappe.throw(_("Only HR can change those details."), frappe.PermissionError)
		if status and status not in EMPLOYEE_STATUSES:
			frappe.throw(_("You can close or reopen your request, nothing more."), frappe.PermissionError)

	if status and status != doc.status:
		# Counting reopens makes a ticket that keeps bouncing visible as a
		# process problem rather than just churn on one record.
		if doc.status in CLOSED_STATUSES and status not in CLOSED_STATUSES:
			doc.reopen_count = cint(doc.reopen_count) + 1
		doc.status = status
	if priority:
		doc.priority = priority
	if assigned_to is not None:
		doc.assigned_to = assigned_to or None
	if resolution is not None:
		doc.resolution = resolution

	doc.flags.ignore_permissions = True
	doc.save()

	_publish("helpdesk_changed", {"name": doc.name})
	return _serialise(doc, include_internal=is_hr)


@frappe.whitelist()
def helpdesk_agents() -> dict:
	"""HR users a ticket can be assigned to."""
	_require_hr_access()
	users = set()
	for role in HR_ROLES:
		if role == "Administrator":
			continue
		users.update(
			frappe.get_all("Has Role", filters={"role": role, "parenttype": "User"}, pluck="parent")
		)
	rows = frappe.get_all(
		"User",
		filters={"name": ["in", sorted(users) or ["__none__"]], "enabled": 1},
		fields=["name", "full_name"],
		order_by="full_name asc",
		limit_page_length=0,
	)
	return {"agents": rows}
