# Copyright (c) 2026, Techs Arena and contributors
# For license information, please see license.txt

"""Per-company employee-seat licensing for Techs Arena HR.

A single *Techsarena Subscription* record holds one **Company License** row per
company (company, licensed_employees, optional valid_upto). Seats are counted
**within each company**, so a client running several companies buys a separate
seat count for each (e.g. C1=10, C2=200, C3=40) and the limits are enforced
independently.

Enforcement points (wired in ``hooks.py``):

* ``check_new_employee`` — blocks creating/activating an Employee past *its
  company's* seat count (Employee ``validate``).
* ``check_payroll``      — blocks Salary Slip / Payroll Entry when *that
  document's company* is over its seat count or its license has expired.

A company with no license row is not restricted. Everything is a no-op unless
the subscription is enabled.
"""

import frappe
from frappe import _
from frappe.utils import cint, getdate, nowdate


def get_subscription():
	if not frappe.db.exists("DocType", "Techsarena Subscription"):
		return None
	sub = frappe.get_cached_doc("Techsarena Subscription")
	return sub if cint(sub.enabled) else None


def _license_for(sub, company):
	for row in sub.company_licenses:
		if row.company == company:
			return row
	return None


def active_employee_count(company, exclude: str | None = None) -> int:
	filters = {"status": "Active", "company": company}
	if exclude:
		filters["name"] = ["!=", exclude]
	return frappe.db.count("Employee", filters)


def _expired(row) -> bool:
	return bool(row.valid_upto and getdate(nowdate()) > getdate(row.valid_upto))


# ---------------------------------------------------------------- Employee gate
def check_new_employee(doc, method=None):
	sub = get_subscription()
	if not sub or not cint(sub.block_new_employees):
		return
	if (doc.status or "Active") != "Active" or not doc.company:
		return
	row = _license_for(sub, doc.company)
	if not row or not cint(row.licensed_employees):
		return  # company not licensed here -> unrestricted
	current = active_employee_count(doc.company, exclude=doc.name)
	if current + 1 > cint(row.licensed_employees):
		frappe.throw(
			_(
				"Employee seat limit reached for {0}: the Techs Arena Subscription is licensed "
				"for {1} active employees in this company ({2} already active). Upgrade this "
				"company's plan to add more."
			).format(doc.company, cint(row.licensed_employees), current),
			title=_("Subscription Limit"),
		)


# ----------------------------------------------------------------- Payroll gate
def check_payroll(doc, method=None):
	sub = get_subscription()
	if not sub or not cint(sub.block_over_limit):
		return
	company = getattr(doc, "company", None)
	if not company:
		return
	row = _license_for(sub, company)
	if not row:
		return  # company not licensed here -> unrestricted
	if _expired(row):
		frappe.throw(
			_("The Techs Arena Subscription for {0} expired on {1}. Renew it to run payroll.").format(
				company, frappe.format(row.valid_upto, {"fieldtype": "Date"})
			),
			title=_("Subscription Expired"),
		)
	if not cint(row.licensed_employees):
		return
	current = active_employee_count(company)
	if current > cint(row.licensed_employees):
		frappe.throw(
			_(
				"Cannot run payroll for {0}: {1} active employees exceed this company's licensed "
				"limit of {2}. Upgrade the Techs Arena Subscription for this company."
			).format(company, current, cint(row.licensed_employees)),
			title=_("Subscription Limit"),
		)
