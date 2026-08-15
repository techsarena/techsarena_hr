"""Carry sites created under the old `orbit_hr` name over to `techsarena_hr`.

The app was renamed wholesale, which leaves three kinds of stale reference on a
site that was already live: the Module Def row that doctypes point at, the
Custom Field docs on Leave Type, and the physical `orbit_*` columns those
fields created in `tabLeave Type`.  Renaming the code alone would strand all
three -- `after_migrate` would happily create a second, parallel set of
`techsarena_*` fields and leave the originals sitting beside them.

Each step below is written to be re-runnable and to no-op on a site that never
had the old name, so this is safe on fresh installs too.
"""

from __future__ import annotations

import frappe

FIELD_SUFFIXES = (
	"policy_section",
	"policy_version",
	"effective_from",
	"applies_to",
	"policy_column",
	"notice_days",
	"escalation_days",
	"secondary_approver_above",
)

DOCTYPE = "Leave Type"


def execute() -> None:
	rename_module_def()
	rename_custom_fields()
	frappe.clear_cache()


def rename_module_def() -> None:
	"""Point the module at the new app, renaming the row if it still exists."""
	if frappe.db.exists("Module Def", "Orbit HR"):
		if frappe.db.exists("Module Def", "Techsarena HR"):
			# Both present (a migrate already created the new one) -- drop the old.
			frappe.delete_doc("Module Def", "Orbit HR", force=True, ignore_permissions=True)
		else:
			frappe.rename_doc("Module Def", "Orbit HR", "Techsarena HR", force=True)

	if frappe.db.exists("Module Def", "Techsarena HR"):
		frappe.db.set_value("Module Def", "Techsarena HR", "app_name", "techsarena_hr")

	# Any doctype still filed under the old module name follows it across.
	frappe.db.sql(
		"""UPDATE `tabDocType` SET module = 'Techsarena HR' WHERE module = 'Orbit HR'"""
	)


def rename_custom_fields() -> None:
	"""Rename the Leave Type policy fields and the columns backing them."""
	if not frappe.db.table_exists(DOCTYPE):
		return

	table = f"tab{DOCTYPE}"
	columns = {c.get("Field") for c in frappe.db.sql(f"DESCRIBE `{table}`", as_dict=True)}

	for suffix in FIELD_SUFFIXES:
		old_field = f"orbit_{suffix}"
		new_field = f"techsarena_{suffix}"

		_rename_column(table, old_field, new_field, columns)
		_rename_custom_field_doc(old_field, new_field)

	_repoint_insert_after()


def _rename_column(table: str, old_field: str, new_field: str, columns: set[str]) -> None:
	"""Move the physical column, preserving whatever type it was created with."""
	if old_field not in columns or new_field in columns:
		return

	definition = frappe.db.sql(
		f"""SELECT COLUMN_TYPE FROM information_schema.COLUMNS
			WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND COLUMN_NAME = %s""",
		(table, old_field),
	)
	if not definition:
		return

	column_type = definition[0][0]

	# DDL commits implicitly in MariaDB, and Frappe blocks that mid-transaction.
	# Land the work done so far first, then rename outside the guard.
	frappe.db.commit()
	frappe.db.sql_ddl(f"ALTER TABLE `{table}` CHANGE `{old_field}` `{new_field}` {column_type}")


def _rename_custom_field_doc(old_field: str, new_field: str) -> None:
	"""Rename the Custom Field doc itself; its name embeds the fieldname."""
	old_name = f"{DOCTYPE}-{old_field}"
	new_name = f"{DOCTYPE}-{new_field}"

	if not frappe.db.exists("Custom Field", old_name):
		return

	if frappe.db.exists("Custom Field", new_name):
		# A migrate already recreated it under the new name -- the old one is a duplicate.
		frappe.delete_doc("Custom Field", old_name, force=True, ignore_permissions=True)
		return

	frappe.db.set_value("Custom Field", old_name, "fieldname", new_field, update_modified=False)
	frappe.rename_doc("Custom Field", old_name, new_name, force=True, show_alert=False)


def _repoint_insert_after() -> None:
	"""Fix `insert_after` links that still name the old fields, so order survives."""
	for suffix in FIELD_SUFFIXES:
		frappe.db.set_value(
			"Custom Field",
			{"dt": DOCTYPE, "insert_after": f"orbit_{suffix}"},
			"insert_after",
			f"techsarena_{suffix}",
			update_modified=False,
		)
