"""Site setup for Techs Arena HCM.

The Policies screen shows employees the rules that actually bind them.  Stock
HRMS records the mechanics of a leave type (how much, how it accrues, whether it
carries forward) but not the administrative facts an employee asks about first:
which revision of the policy is in force, when it took effect, how much notice
they owe, and how long an approver may sit on the request.  Those live here as
custom fields so the app reads them from the site rather than inventing them.
"""

from __future__ import annotations

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

LEAVE_TYPE_FIELDS = {
	"Leave Type": [
		{
			"fieldname": "orbit_policy_section",
			"fieldtype": "Section Break",
			"label": "Policy Communication",
			"insert_after": "include_holiday",
			"collapsible": 1,
		},
		{
			"fieldname": "orbit_policy_version",
			"fieldtype": "Data",
			"label": "Policy Version",
			"insert_after": "orbit_policy_section",
			"description": "Shown to employees as the revision in force, e.g. v3.",
		},
		{
			"fieldname": "orbit_effective_from",
			"fieldtype": "Date",
			"label": "Policy Effective From",
			"insert_after": "orbit_policy_version",
			"description": "The date this revision of the policy took effect.",
		},
		{
			"fieldname": "orbit_applies_to",
			"fieldtype": "Data",
			"label": "Applies To",
			"insert_after": "orbit_effective_from",
			"description": "Who the policy covers, e.g. Design, full-time.",
		},
		{
			"fieldname": "orbit_policy_column",
			"fieldtype": "Column Break",
			"insert_after": "orbit_applies_to",
		},
		{
			"fieldname": "orbit_notice_days",
			"fieldtype": "Int",
			"label": "Notice Required (Days)",
			"insert_after": "orbit_policy_column",
			"non_negative": 1,
			"description": "How far ahead an employee is expected to apply.",
		},
		{
			"fieldname": "orbit_escalation_days",
			"fieldtype": "Int",
			"label": "Auto-escalate After (Working Days)",
			"insert_after": "orbit_notice_days",
			"non_negative": 1,
			"description": "How long an approver may hold a request before it escalates.",
		},
		{
			"fieldname": "orbit_secondary_approver_above",
			"fieldtype": "Float",
			"label": "Second Approval Above (Days)",
			"insert_after": "orbit_escalation_days",
			"non_negative": 1,
			"description": "Requests longer than this also need HR sign-off. 0 disables the second step.",
		},
	]
}


def after_install() -> None:
	create_policy_fields()


def after_migrate() -> None:
	create_policy_fields()


def create_policy_fields() -> None:
	"""Add the policy-communication fields, but only where HRMS is present."""
	if not frappe.db.table_exists("Leave Type"):
		return
	create_custom_fields(LEAVE_TYPE_FIELDS, ignore_validate=True)
