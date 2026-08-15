"""Idempotent local demo accounts for exercising each role dashboard."""

from __future__ import annotations

import frappe
from frappe.utils import getdate, nowdate
from frappe.utils.password import update_password

from orbit_hr.demo_records import provision_role_demo_records

DEMO_PASSWORD = "OrbitDemo@123"

DEMO_USERS = (
	("leave.approver@techsarena.local", "Nikhil", "Varma", "Leave Approver", "Design Lead"),
	("expense.approver@techsarena.local", "Sneha", "Rao", "Expense Approver", "Finance Manager"),
	("shift.approver@techsarena.local", "Arun", "Nair", "Shift Request Approver", "Operations Lead"),
	("hr.user@techsarena.local", "Pooja", "Shetty", "HR User", "HR Executive"),
	("hr.manager@techsarena.local", "Nisha", "Rao", "HR Manager", "HR Manager"),
	("interviewer@techsarena.local", "Dev", "Sharma", "Interviewer", "Engineering Lead"),
	("system.manager@techsarena.local", "Amit", "Raj", "System Manager", "Platform Admin"),
	("employee@techsarena.local", "Aarav", "Mehta", "Employee", "Product Designer"),
)


def provision_role_demo_users(password: str = DEMO_PASSWORD) -> dict:
	"""Create one local User + Employee pair for every dashboard role.

	This is intentionally not whitelisted. Run it from ``bench execute`` on a
	development site so production accounts are never created over HTTP.
	"""
	company = frappe.db.get_single_value("Global Defaults", "default_company")
	if not company:
		company = frappe.db.get_value("Company", {}, "name")
	if not company:
		frappe.throw("Create a Company before provisioning role demo users.")

	_ensure_role("Shift Request Approver")
	_ensure_shift_approver_permissions()
	created_users = []
	created_employees = []
	for email, first_name, last_name, role, designation in DEMO_USERS:
		if not frappe.db.exists("User", email):
			user = frappe.get_doc(
				{
					"doctype": "User",
					"email": email,
					"first_name": first_name,
					"last_name": last_name,
					"enabled": 1,
					"user_type": "System User",
					"send_welcome_email": 0,
				}
			)
			user.insert(ignore_permissions=True)
			created_users.append(email)
		else:
			user = frappe.get_doc("User", email)

		roles = ["Employee", "Employee Self Service"]
		if role != "Employee":
			roles.append(role)
		user.add_roles(*roles)
		update_password(email, password, logout_all_sessions=True)

		if not frappe.db.exists("Employee", {"user_id": email}):
			employee = frappe.get_doc(
				{
					"doctype": "Employee",
					"first_name": first_name,
					"last_name": last_name,
					"employee_name": f"{first_name} {last_name}",
					"gender": _default_gender(),
					"date_of_birth": getdate("1990-01-01"),
					"date_of_joining": getdate(nowdate()),
					"company": company,
					"status": "Active",
					"user_id": email,
					"designation": _ensure_designation(designation),
				}
			)
			employee.insert(ignore_permissions=True)
			created_employees.append(employee.name)

	frappe.db.commit()
	records = provision_role_demo_records(company)
	frappe.db.commit()
	return {
		"password": password,
		"users": [row[0] for row in DEMO_USERS],
		"created_users": created_users,
		"created_employees": created_employees,
		"created_records": records,
	}


def verify_role_demo_users() -> list[dict]:
	"""Return a compact bootstrap check for every provisioned demo account."""
	from orbit_hr.api import bootstrap

	checks = []
	try:
		for email, _first_name, _last_name, expected_role, _designation in DEMO_USERS:
			frappe.set_user(email)
			payload = bootstrap()
			dashboard = payload["role_dashboards"].get(expected_role, {})
			checks.append(
				{
					"user": email,
					"expected_role": expected_role,
					"default_role": payload["default_dashboard_role"],
					"dashboard_roles": payload["dashboard_roles"],
					"has_employee": bool(payload["profile"]),
					"metrics": {metric["label"]: metric["value"] for metric in dashboard.get("metrics", [])},
					"panel_items": {
						panel["title"]: len(panel.get("items", [])) for panel in dashboard.get("panels", [])
					},
					"self_service": {
						"leave_balances": len(payload["leave_balances"]),
						"holidays": len(payload["holidays"]),
						"leave_requests": len(payload["leave_requests"]),
						"salary_slips": len(payload["salary_slips"]),
						"notifications": len(payload["notifications"]),
					},
				}
			)
	finally:
		frappe.set_user("Administrator")
	return checks


def _ensure_role(role: str) -> str:
	if not frappe.db.exists("Role", role):
		frappe.get_doc({"doctype": "Role", "role_name": role, "desk_access": 1}).insert(
			ignore_permissions=True
		)
	return role


def _ensure_designation(designation: str) -> str:
	if not frappe.db.exists("Designation", designation):
		frappe.get_doc({"doctype": "Designation", "designation_name": designation}).insert(
			ignore_permissions=True
		)
	return designation


def _ensure_shift_approver_permissions() -> None:
	from frappe.permissions import add_permission, update_permission_property

	role = "Shift Request Approver"
	if not frappe.db.exists(
		"Custom DocPerm",
		{"parent": "Shift Request", "role": role, "permlevel": 0, "if_owner": 0},
	):
		add_permission("Shift Request", role, ptype="read")
	for permission in ("read", "write", "submit"):
		update_permission_property("Shift Request", role, 0, permission, 1)


def _default_gender() -> str:
	gender = frappe.db.get_value("Gender", {}, "name")
	if not gender:
		frappe.get_doc({"doctype": "Gender", "gender": "Unspecified"}).insert(ignore_permissions=True)
		return "Unspecified"
	return gender
