"""Employee lifecycle events: promotion, transfer, grievance and travel.

The remaining HCM surfaces the dashboard had no endpoint for. Each one wraps an
existing HRMS submittable document rather than modelling the change itself —
promotion and transfer in particular carry real consequences (work history,
CTC, leave reallocation, a new employee id) that HRMS's own ``on_submit`` and
``update_employee_work_history`` already implement correctly.

The pattern throughout: **build the document, let HRMS validate and apply it.**
What this module adds is the access boundary, the field-change plumbing that a
JSON client cannot express, and read endpoints shaped for the screens.

Property changes (the ``Employee Property History`` rows behind a promotion or
transfer) need the *current* value alongside the new one, and the current value
has to be read from the Employee at build time rather than trusted from the
client — otherwise a stale form silently rewrites a field someone else changed.
``_property_rows`` is that guard.
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import flt, getdate, nowdate

#: Employee fields a promotion or transfer may change. Anything outside this set
#: is refused: the child table takes an arbitrary fieldname, and without a
#: whitelist a client could rewrite `user_id`, `status` or `company` through a
#: promotion and bypass every other guard in the app.
ALLOWED_PROPERTY_FIELDS = {
	"designation": "Designation",
	"department": "Department",
	"branch": "Branch",
	"grade": "Employee Grade",
	"employment_type": "Employment Type",
	"reports_to": "Reports to",
	"shift_request_approver": "Shift Request Approver",
	"leave_approver": "Leave Approver",
	"expense_approver": "Expense Approver",
	"holiday_list": "Holiday List",
	"salary_mode": "Salary Mode",
}


def _hr_user() -> str:
	from techsarena_hr.api import HR_ROLES, _require_hrms, _require_login

	user = _require_login()
	_require_hrms()
	if not set(frappe.get_roles(user)).intersection(HR_ROLES):
		frappe.throw(_("You do not have access to employee lifecycle records."), frappe.PermissionError)
	return user


def _employee_or_throw(employee: str) -> frappe._dict:
	record = frappe.db.get_value(
		"Employee",
		employee,
		["name", "employee_name", "status", "company", "department", "designation"],
		as_dict=True,
	)
	if not record:
		frappe.throw(_("Employee {0} was not found.").format(employee), frappe.DoesNotExistError)
	return record


def _property_rows(employee: str, changes) -> list[dict]:
	"""Turn ``{fieldname: new_value}`` into Employee Property History rows.

	The ``current`` side is read from the Employee here, never taken from the
	client: a form opened ten minutes ago would otherwise write back a stale
	"current" value and HRMS would record the wrong before-state in the work
	history (and restore the wrong value on cancel).
	"""
	changes = frappe.parse_json(changes) if isinstance(changes, str) else (changes or {})
	if not isinstance(changes, dict):
		frappe.throw(_("Property changes must be supplied as an object."), frappe.ValidationError)

	doc = frappe.get_doc("Employee", employee)
	rows = []
	for fieldname, new_value in changes.items():
		if fieldname not in ALLOWED_PROPERTY_FIELDS:
			frappe.throw(
				_("{0} cannot be changed through this request.").format(fieldname),
				frappe.PermissionError,
			)
		current = doc.get(fieldname)
		# A no-op row still gets written into work history on submit, which
		# makes the record read as though something changed. Drop it.
		if (current or None) == (new_value or None):
			continue
		rows.append(
			{
				"property": ALLOWED_PROPERTY_FIELDS[fieldname],
				"fieldname": fieldname,
				"current": current,
				"new": new_value,
			}
		)
	if not rows:
		frappe.throw(_("Nothing would change. Set at least one new value."), frappe.ValidationError)
	return rows


@frappe.whitelist()
def property_fields() -> dict:
	"""Fields a promotion or transfer may change, for the form's picker."""
	_hr_user()
	return {
		"fields": [
			{"fieldname": key, "label": label} for key, label in sorted(
				ALLOWED_PROPERTY_FIELDS.items(), key=lambda item: item[1]
			)
		]
	}


# --------------------------------------------------------------------------- #
# Promotion
# --------------------------------------------------------------------------- #


@frappe.whitelist()
def promotions(employee: str | None = None) -> dict:
	"""Promotion records, newest first. HR only."""
	_hr_user()
	if not frappe.db.table_exists("Employee Promotion"):
		return {"promotions": [], "available": False}

	filters: dict = {"docstatus": ["<", 2]}
	if employee:
		filters["employee"] = employee
	rows = frappe.get_all(
		"Employee Promotion",
		filters=filters,
		fields=[
			"name", "employee", "employee_name", "department", "company",
			"promotion_date", "current_ctc", "revised_ctc", "salary_currency", "docstatus",
		],
		order_by="promotion_date desc, creation desc",
		limit_page_length=100,
	)
	_attach_property_details(rows, "Employee Promotion", "promotion_details")
	return {"promotions": rows, "available": True}


def _attach_property_details(rows: list, parenttype: str, parentfield: str) -> None:
	"""Fold each record's property-change rows on, in one query."""
	if not rows:
		return
	names = [row.name for row in rows]
	details: dict[str, list[dict]] = {}
	for row in frappe.get_all(
		"Employee Property History",
		filters={"parent": ["in", names], "parenttype": parenttype, "parentfield": parentfield},
		fields=["parent", "property", "fieldname", "current", "new", "idx"],
		order_by="parent asc, idx asc",
		limit_page_length=0,
	):
		details.setdefault(row.parent, []).append(
			{"property": row.property, "fieldname": row.fieldname, "current": row.current, "new": row.new}
		)
	for row in rows:
		row["changes"] = details.get(row.name, [])


@frappe.whitelist(methods=["POST"])
def create_promotion(
	employee: str,
	promotion_date: str,
	changes=None,
	revised_ctc=None,
	submit: int | str = 0,
) -> dict:
	"""Promote an employee, optionally submitting it. HR only.

	Submitting is what applies the change to the Employee and writes the work
	history (HRMS ``on_submit`` → ``update_employee_work_history``), so a draft
	changes nothing until someone submits it deliberately.

	HRMS refuses to submit a promotion dated in the future, so a forward-dated
	promotion is created as a draft regardless of ``submit`` — with that said in
	the response rather than failing the request.
	"""
	_hr_user()
	if not frappe.db.table_exists("Employee Promotion"):
		frappe.throw(_("Employee Promotion is not available on this site."), frappe.ValidationError)

	record = _employee_or_throw(employee)
	if record.status != "Active":
		frappe.throw(_("{0} is not an active employee.").format(employee), frappe.ValidationError)

	rows = _property_rows(employee, changes)
	promo_date = getdate(promotion_date)

	doc = frappe.new_doc("Employee Promotion")
	doc.employee = employee
	doc.company = record.company
	doc.department = record.department
	doc.promotion_date = promo_date
	for row in rows:
		doc.append("promotion_details", row)
	if revised_ctc not in (None, ""):
		doc.current_ctc = flt(frappe.db.get_value("Employee", employee, "ctc"))
		doc.revised_ctc = flt(revised_ctc)
	doc.insert()

	deferred = promo_date > getdate(nowdate())
	submitted = False
	if frappe.utils.cint(submit) and not deferred:
		doc.submit()
		submitted = True

	return {
		"name": doc.name,
		"employee": employee,
		"promotion_date": str(promo_date),
		"submitted": submitted,
		"deferred": deferred,
		"message": _("Saved as a draft: a promotion cannot be submitted before its date.")
		if deferred and frappe.utils.cint(submit)
		else None,
		"changes": rows,
	}


# --------------------------------------------------------------------------- #
# Transfer
# --------------------------------------------------------------------------- #


@frappe.whitelist()
def transfers(employee: str | None = None) -> dict:
	"""Transfer records, newest first. HR only."""
	_hr_user()
	if not frappe.db.table_exists("Employee Transfer"):
		return {"transfers": [], "available": False}

	filters: dict = {"docstatus": ["<", 2]}
	if employee:
		filters["employee"] = employee
	rows = frappe.get_all(
		"Employee Transfer",
		filters=filters,
		fields=[
			"name", "employee", "employee_name", "department", "company", "new_company",
			"transfer_date", "reallocate_leaves", "create_new_employee_id",
			"new_employee_id", "docstatus",
		],
		order_by="transfer_date desc, creation desc",
		limit_page_length=100,
	)
	_attach_property_details(rows, "Employee Transfer", "transfer_details")
	return {"transfers": rows, "available": True}


@frappe.whitelist(methods=["POST"])
def create_transfer(
	employee: str,
	transfer_date: str,
	changes=None,
	new_company: str | None = None,
	reallocate_leaves: int | str = 0,
	create_new_employee_id: int | str = 0,
	submit: int | str = 0,
) -> dict:
	"""Transfer an employee between departments, branches or companies. HR only.

	``create_new_employee_id`` makes HRMS issue a fresh Employee record and mark
	the old one Left — a genuinely destructive change, so it is never inferred
	from a company change; the caller has to ask for it explicitly.
	"""
	_hr_user()
	if not frappe.db.table_exists("Employee Transfer"):
		frappe.throw(_("Employee Transfer is not available on this site."), frappe.ValidationError)

	record = _employee_or_throw(employee)
	if record.status != "Active":
		frappe.throw(_("{0} is not an active employee.").format(employee), frappe.ValidationError)

	if new_company and not frappe.db.exists("Company", new_company):
		frappe.throw(_("Company {0} was not found.").format(new_company), frappe.DoesNotExistError)
	if new_company and new_company == record.company:
		new_company = None

	rows = _property_rows(employee, changes)
	move_date = getdate(transfer_date)

	doc = frappe.new_doc("Employee Transfer")
	doc.employee = employee
	doc.company = record.company
	doc.department = record.department
	doc.transfer_date = move_date
	if new_company:
		doc.new_company = new_company
	doc.reallocate_leaves = frappe.utils.cint(reallocate_leaves)
	doc.create_new_employee_id = frappe.utils.cint(create_new_employee_id)
	for row in rows:
		doc.append("transfer_details", row)
	doc.insert()

	# HRMS applies a transfer only from its date onward.
	deferred = move_date > getdate(nowdate())
	submitted = False
	if frappe.utils.cint(submit) and not deferred:
		doc.submit()
		submitted = True
		doc.reload()

	return {
		"name": doc.name,
		"employee": employee,
		"transfer_date": str(move_date),
		"new_company": doc.new_company,
		"new_employee_id": doc.new_employee_id,
		"submitted": submitted,
		"deferred": deferred,
		"message": _("Saved as a draft: a transfer cannot be submitted before its date.")
		if deferred and frappe.utils.cint(submit)
		else None,
		"changes": rows,
	}


# --------------------------------------------------------------------------- #
# Grievance
# --------------------------------------------------------------------------- #


@frappe.whitelist()
def grievances(status: str | None = None) -> dict:
	"""Grievances. HR sees all; anyone else sees only the ones they raised.

	A grievance is frequently *about* the reporting line, so manager visibility
	is deliberately not granted here — only HR and the raiser.
	"""
	from techsarena_hr.api import HR_ROLES, _current_employee, _require_hrms, _require_login

	user = _require_login()
	_require_hrms()
	if not frappe.db.table_exists("Employee Grievance"):
		return {"grievances": [], "available": False, "types": []}

	is_hr = bool(set(frappe.get_roles(user)).intersection(HR_ROLES))
	filters: dict = {"docstatus": ["<", 2]}
	if status:
		filters["status"] = status
	if not is_hr:
		own = _current_employee(user, required=False)
		if not own:
			return {"grievances": [], "available": True, "types": [], "can_manage": False}
		filters["raised_by"] = own

	rows = frappe.get_all(
		"Employee Grievance",
		filters=filters,
		fields=[
			"name", "subject", "grievance_type", "date", "status", "raised_by",
			"employee_name", "grievance_against", "grievance_against_party",
			"resolution_date", "resolved_by", "docstatus",
		],
		order_by="date desc, creation desc",
		limit_page_length=100,
	)
	return {
		"grievances": rows,
		"available": True,
		"can_manage": is_hr,
		"types": frappe.get_all("Grievance Type", pluck="name", order_by="name asc")
		if frappe.db.table_exists("Grievance Type")
		else [],
	}


@frappe.whitelist(methods=["POST"])
def raise_grievance(
	subject: str,
	grievance_type: str,
	description: str,
	grievance_against: str | None = None,
	grievance_against_party: str = "Employee",
	date: str | None = None,
) -> dict:
	"""File a grievance as the signed-in employee.

	``raised_by`` is taken from the session, never the client — a grievance
	filed in someone else's name would be worse than no grievance system.
	"""
	from techsarena_hr.api import _require_employee_user, _require_hrms, _require_login

	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)
	if not frappe.db.table_exists("Employee Grievance"):
		frappe.throw(_("Employee Grievance is not available on this site."), frappe.ValidationError)

	if grievance_against_party not in ("Employee", "Department", "Company"):
		frappe.throw(_("Unsupported grievance target."), frappe.ValidationError)

	doc = frappe.new_doc("Employee Grievance")
	doc.subject = subject
	doc.grievance_type = grievance_type
	doc.description = description
	doc.raised_by = employee
	doc.date = getdate(date) if date else getdate(nowdate())
	doc.status = "Open"
	doc.grievance_against_party = grievance_against_party
	# Defaults to the employee's own company so the mandatory dynamic link is
	# satisfied without the client having to know the field pair.
	doc.grievance_against = grievance_against or frappe.db.get_value(
		"Employee", employee, "company" if grievance_against_party == "Company" else "department"
	)
	if not doc.grievance_against:
		frappe.throw(_("Name who or what this grievance is about."), frappe.ValidationError)
	doc.insert(ignore_permissions=True)
	return {"name": doc.name, "status": doc.status}


@frappe.whitelist(methods=["POST"])
def resolve_grievance(
	name: str,
	status: str,
	resolution_detail: str | None = None,
	cause_of_grievance: str | None = None,
) -> dict:
	"""Investigate, resolve or dismiss a grievance. HR only."""
	user = _hr_user()
	if not frappe.db.exists("Employee Grievance", name):
		frappe.throw(_("Grievance {0} was not found.").format(name), frappe.DoesNotExistError)
	if status not in ("Open", "Investigated", "Resolved", "Invalid"):
		frappe.throw(_("Unsupported grievance status."), frappe.ValidationError)

	doc = frappe.get_doc("Employee Grievance", name)
	doc.status = status
	if cause_of_grievance:
		doc.cause_of_grievance = cause_of_grievance
	if status in ("Resolved", "Invalid"):
		doc.resolution_detail = resolution_detail
		doc.resolution_date = getdate(nowdate())
		doc.resolved_by = user
	doc.save()
	return {"name": doc.name, "status": doc.status}


# --------------------------------------------------------------------------- #
# Travel requests
# --------------------------------------------------------------------------- #


@frappe.whitelist()
def travel_requests() -> dict:
	"""Travel requests: own for an employee, all for HR."""
	from techsarena_hr.api import HR_ROLES, _current_employee, _require_hrms, _require_login

	user = _require_login()
	_require_hrms()
	if not frappe.db.table_exists("Travel Request"):
		return {"requests": [], "available": False, "purposes": []}

	is_hr = bool(set(frappe.get_roles(user)).intersection(HR_ROLES))
	filters: dict = {"docstatus": ["<", 2]}
	if not is_hr:
		own = _current_employee(user, required=False)
		if not own:
			return {"requests": [], "available": True, "purposes": [], "can_manage": False}
		filters["employee"] = own

	rows = frappe.get_all(
		"Travel Request",
		filters=filters,
		fields=[
			"name", "employee", "employee_name", "travel_type", "travel_funding",
			"purpose_of_travel", "description", "company", "docstatus", "creation",
		],
		order_by="creation desc",
		limit_page_length=100,
	)
	if rows:
		_attach_itineraries(rows)
	return {
		"requests": rows,
		"available": True,
		"can_manage": is_hr,
		"purposes": frappe.get_all("Purpose of Travel", pluck="name", order_by="name asc")
		if frappe.db.table_exists("Purpose of Travel")
		else [],
	}


def _attach_itineraries(rows: list) -> None:
	"""Fold itinerary legs and their total cost on, in two queries."""
	names = [row.name for row in rows]
	legs: dict[str, list[dict]] = {}
	for leg in frappe.get_all(
		"Travel Itinerary",
		filters={"parent": ["in", names], "parenttype": "Travel Request"},
		fields=[
			"parent", "travel_from", "travel_to", "departure_date",
			"arrival_date", "mode_of_travel", "idx",
		],
		order_by="parent asc, idx asc",
		limit_page_length=0,
	):
		legs.setdefault(leg.parent, []).append(
			{
				"travel_from": leg.travel_from,
				"travel_to": leg.travel_to,
				"departure_date": str(leg.departure_date) if leg.departure_date else None,
				"arrival_date": str(leg.arrival_date) if leg.arrival_date else None,
				"mode_of_travel": leg.mode_of_travel,
			}
		)

	costs: dict[str, float] = {}
	for row in frappe.get_all(
		"Travel Request Costing",
		filters={"parent": ["in", names], "parenttype": "Travel Request"},
		fields=["parent", "sum(total_amount) as total"],
		group_by="parent",
		limit_page_length=0,
	):
		costs[row.parent] = flt(row.total)

	for row in rows:
		row["itinerary"] = legs.get(row.name, [])
		row["estimated_cost"] = costs.get(row.name, 0.0)


@frappe.whitelist(methods=["POST"])
def submit_travel_request(
	purpose_of_travel: str,
	travel_type: str = "Domestic",
	travel_funding: str | None = None,
	description: str | None = None,
	itinerary=None,
) -> dict:
	"""File a travel request for the signed-in employee.

	``itinerary`` is a JSON list of
	``{travel_from, travel_to, departure_date, arrival_date, mode_of_travel}``.
	Left as a draft: approving travel is a decision, and HRMS has no approver
	field on this doctype for the app to route it through.
	"""
	from techsarena_hr.api import _require_employee_user, _require_hrms, _require_login

	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)
	if not frappe.db.table_exists("Travel Request"):
		frappe.throw(_("Travel Request is not available on this site."), frappe.ValidationError)

	if travel_type not in ("Domestic", "International"):
		frappe.throw(_("Travel type must be Domestic or International."), frappe.ValidationError)

	legs = frappe.parse_json(itinerary) if isinstance(itinerary, str) else (itinerary or [])

	employee_doc = frappe.get_doc("Employee", employee)
	doc = frappe.new_doc("Travel Request")
	doc.employee = employee
	doc.company = employee_doc.company
	doc.travel_type = travel_type
	doc.purpose_of_travel = purpose_of_travel
	if travel_funding:
		doc.travel_funding = travel_funding
	doc.description = description
	for leg in legs:
		if not leg.get("travel_from") and not leg.get("travel_to"):
			continue
		doc.append(
			"itinerary",
			{
				"travel_from": leg.get("travel_from"),
				"travel_to": leg.get("travel_to"),
				"departure_date": leg.get("departure_date"),
				"arrival_date": leg.get("arrival_date"),
				"mode_of_travel": leg.get("mode_of_travel"),
			},
		)
	doc.insert()
	return {"name": doc.name, "docstatus": doc.docstatus, "submitted": False}
