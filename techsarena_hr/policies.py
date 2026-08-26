"""Policy acknowledgement.

Employees read the policies that apply to them and record that they have. HR
sees who has and who has not. The acknowledgement is versioned evidence: it
names the exact version read, so a later revision does not silently convert an
old confirmation into a new one.

Audience rules match `announcements()` — a policy scoped to a company or
department reaches only those people, and is not merely hidden from the rest.
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import getdate, now_datetime, nowdate

from techsarena_hr.api import (
	HR_ROLES,
	_current_employee,
	_require_employee_user,
	_require_hr_access,
	_require_hrms,
	_require_login,
)

POLICY_FIELDS = (
	"name", "title", "policy_type", "version", "effective_from",
	"summary", "body", "attachment", "requires_acknowledgement",
	"company", "department", "is_published",
)


def _applies_to(policy, profile: dict) -> bool:
	"""Whether a policy's audience covers this employee."""
	if policy.get("company") and policy["company"] != profile.get("company"):
		return False
	if policy.get("department") and policy["department"] != profile.get("department"):
		return False
	return True


def _live_policies() -> list[dict]:
	"""Published policies already in force, newest first."""
	if not frappe.db.table_exists("HR Policy"):
		return []
	return frappe.get_all(
		"HR Policy",
		filters=[
			["is_published", "=", 1],
			["effective_from", "<=", nowdate()],
		],
		fields=POLICY_FIELDS,
		order_by="effective_from desc",
		limit_page_length=0,
	)


@frappe.whitelist()
def my_policies() -> dict:
	"""The policies that apply to this employee, and whether each is confirmed.

	A policy whose version has moved on since the employee confirmed shows as
	outstanding again — that is the point of versioning it.
	"""
	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)

	profile = frappe.db.get_value("Employee", employee, ["company", "department"], as_dict=True) or {}
	policies = [p for p in _live_policies() if _applies_to(p, profile)]
	if not policies:
		return {"policies": [], "outstanding": 0}

	# One query for every acknowledgement this employee has, keyed by policy and
	# version, rather than a query per policy.
	acked = {
		(row["policy"], row["version"]): row["acknowledged_on"]
		for row in frappe.get_all(
			"HR Policy Acknowledgement",
			filters={"employee": employee},
			fields=["policy", "version", "acknowledged_on"],
			limit_page_length=0,
		)
	}

	outstanding = 0
	for policy in policies:
		when = acked.get((policy["name"], policy["version"]))
		policy["acknowledged"] = bool(when)
		policy["acknowledged_on"] = str(when) if when else None
		policy["effective_from"] = str(policy["effective_from"]) if policy["effective_from"] else None
		# Whether an *earlier* version was confirmed: the difference between
		# "new to you" and "this changed since you read it" is worth showing.
		policy["previously_acknowledged"] = any(
			key[0] == policy["name"] for key in acked
		) and not policy["acknowledged"]
		if policy["requires_acknowledgement"] and not policy["acknowledged"]:
			outstanding += 1

	return {"policies": policies, "outstanding": outstanding}


@frappe.whitelist(methods=["POST"])
def acknowledge_policy(policy: str, version: str) -> dict:
	"""Record that the signed-in employee has read this version.

	`version` is supplied by the client and checked against the policy: if HR
	published a new version while the screen was open, the stale confirmation is
	refused rather than recorded against text the employee never saw.
	"""
	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)

	row = frappe.db.get_value(
		"HR Policy", policy,
		["name", "version", "is_published", "effective_from", "company", "department", "requires_acknowledgement"],
		as_dict=True,
	)
	if not row:
		frappe.throw(_("That policy was not found."), frappe.DoesNotExistError)
	if not row.is_published or getdate(row.effective_from) > getdate(nowdate()):
		frappe.throw(_("That policy is not in force."))

	profile = frappe.db.get_value("Employee", employee, ["company", "department"], as_dict=True) or {}
	if not _applies_to(row, profile):
		frappe.throw(_("That policy does not apply to you."), frappe.PermissionError)

	if row.version != version:
		frappe.throw(
			_("This policy has been updated to version {0}. Please read it again.").format(row.version)
		)

	existing = frappe.db.exists(
		"HR Policy Acknowledgement",
		{"employee": employee, "policy": policy, "version": version},
	)
	if existing:
		# Confirming twice is not an error — a double-click, or two tabs.
		return {"policy": policy, "version": version, "status": "Already acknowledged"}

	doc = frappe.get_doc(
		{
			"doctype": "HR Policy Acknowledgement",
			"policy": policy,
			"version": version,
			"employee": employee,
			"acknowledged_on": now_datetime(),
			"acknowledged_by": user,
			# Evidence of where the confirmation came from. Absent outside a
			# real request (a console call, a scheduled job).
			"ip_address": getattr(frappe.local, "request_ip", None),
		}
	)
	doc.insert(ignore_permissions=True)

	return {"policy": policy, "version": version, "status": "Acknowledged", "name": doc.name}


@frappe.whitelist()
def policy_compliance(policy: str | None = None) -> dict:
	"""Who has confirmed and who has not. HR only.

	Reported per policy against the employees it actually applies to, so a
	department-scoped policy is not counted against the whole company.
	"""
	_require_hr_access()
	_require_hrms()

	policies = _live_policies()
	if policy:
		policies = [p for p in policies if p["name"] == policy]
	if not policies:
		return {"policies": [], "total_employees": 0}

	staff = frappe.get_all(
		"Employee",
		filters={"status": "Active"},
		fields=["name", "employee_name", "company", "department"],
		limit_page_length=0,
	)

	acked: dict[tuple[str, str], set[str]] = {}
	for row in frappe.get_all(
		"HR Policy Acknowledgement",
		filters={"policy": ["in", [p["name"] for p in policies]]},
		fields=["policy", "version", "employee"],
		limit_page_length=0,
	):
		acked.setdefault((row["policy"], row["version"]), set()).add(row["employee"])

	out = []
	for item in policies:
		audience = [e for e in staff if _applies_to(item, e)]
		confirmed = acked.get((item["name"], item["version"]), set())
		pending = [
			{"employee": e["name"], "employee_name": e["employee_name"], "department": e["department"]}
			for e in audience
			if e["name"] not in confirmed
		]
		out.append(
			{
				"name": item["name"],
				"title": item["title"],
				"policy_type": item["policy_type"],
				"version": item["version"],
				"effective_from": str(item["effective_from"]) if item["effective_from"] else None,
				"requires_acknowledgement": bool(item["requires_acknowledgement"]),
				"audience": len(audience),
				"acknowledged": len(audience) - len(pending),
				"pending": pending,
				# Reported as None rather than 0% when there is nobody to ask, so
				# the client can omit the figure instead of showing a false zero.
				"percent": round(((len(audience) - len(pending)) / len(audience)) * 100)
				if audience else None,
			}
		)

	return {"policies": out, "total_employees": len(staff)}


@frappe.whitelist()
def policy_detail(name: str) -> dict:
	"""One policy's full text, for reading before confirming."""
	user = _require_login()
	_require_hrms()
	employee = _current_employee(user, required=False)

	row = frappe.db.get_value("HR Policy", name, POLICY_FIELDS, as_dict=True)
	if not row:
		frappe.throw(_("That policy was not found."), frappe.DoesNotExistError)

	# HR may read a draft; everyone else only sees what is published and in
	# force, and only if its audience covers them.
	is_hr = bool(set(frappe.get_roles(user)).intersection(HR_ROLES))
	if not is_hr:
		if not row.get("is_published") or getdate(row["effective_from"]) > getdate(nowdate()):
			frappe.throw(_("That policy is not available."), frappe.PermissionError)
		profile = frappe.db.get_value("Employee", employee, ["company", "department"], as_dict=True) or {}
		if not _applies_to(row, profile):
			frappe.throw(_("That policy does not apply to you."), frappe.PermissionError)

	row["effective_from"] = str(row["effective_from"]) if row["effective_from"] else None
	if employee:
		when = frappe.db.get_value(
			"HR Policy Acknowledgement",
			{"employee": employee, "policy": name, "version": row["version"]},
			"acknowledged_on",
		)
		row["acknowledged"] = bool(when)
		row["acknowledged_on"] = str(when) if when else None
	return row
