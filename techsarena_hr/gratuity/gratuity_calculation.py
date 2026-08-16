# Copyright (c) 2026, Techs Arena and contributors
# For license information, please see license.txt
"""
Shared gratuity calculation engine.

One engine serves every regional regime (KSA, UAE, Pakistan, Custom). The
regime only decides *policy* — a post-calculation cap for the UAE, the minimum
service qualification, and so on — while the core service-period and
slab-amount maths live here, once.

This replaces the ~450 lines of copy-pasted logic that were duplicated
verbatim between `KSA Gratuity` and `UAE Gratuity` in the reference app.
"""

import datetime

import frappe
from dateutil import relativedelta
from frappe import _, bold
from frappe.utils import flt, get_datetime, get_link_to_form


def get_rule(gratuity_rule: str) -> dict:
	rule = frappe.db.get_value(
		"Gratuity Rule",
		gratuity_rule,
		[
			"total_working_days_per_year",
			"minimum_year_for_gratuity",
			"work_experience_calculation_function",
			"calculate_gratuity_amount_based_on",
		],
		as_dict=True,
	)
	if not rule:
		frappe.throw(_("Gratuity Rule {0} not found").format(bold(gratuity_rule)))
	return rule


def get_service_period(employee: str, gratuity_rule: str) -> dict:
	"""Completed service, as a float number of years plus a calendar breakdown.

	Non-working days (unpaid leave or absence, per Payroll Settings) are removed
	from the tenure so the employee is not credited for time not worked.
	"""
	rule = get_rule(gratuity_rule)
	doj, relieving = frappe.db.get_value(
		"Employee", employee, ["date_of_joining", "relieving_date"]
	)
	if not doj:
		frappe.throw(
			_("Please set Date of Joining for employee {0}").format(
				bold(get_link_to_form("Employee", employee))
			)
		)
	if not relieving:
		frappe.throw(
			_("Please set Relieving Date for employee {0}").format(
				bold(get_link_to_form("Employee", employee))
			)
		)

	total_days, non_working_days = _total_working_days(employee, doj, relieving)
	per_year = flt(rule.total_working_days_per_year) or 365.0
	experience = total_days / per_year if per_year else 0.0
	experience = _apply_experience_method(
		rule.work_experience_calculation_function,
		experience,
		flt(rule.minimum_year_for_gratuity),
		employee,
	)

	# Calendar breakdown for display/proration, net of non-working days.
	end = get_datetime(relieving) + datetime.timedelta(days=1 - non_working_days)
	diff = relativedelta.relativedelta(end, get_datetime(doj))

	return {
		"current_work_experience": experience,
		"years": diff.years,
		"months": diff.months,
		"days": diff.days,
	}


def _total_working_days(employee, doj, relieving):
	total_days = (get_datetime(relieving) - get_datetime(doj)).days
	non_working_days = 0

	payroll_based_on = (
		frappe.db.get_single_value("Payroll Settings", "payroll_based_on") or "Leave"
	)
	if payroll_based_on == "Leave":
		non_working_days = _count_attendance(employee, relieving, "On Leave")
	elif payroll_based_on == "Attendance":
		non_working_days = _count_attendance(employee, relieving, "Absent")

	return total_days - non_working_days, non_working_days


def _count_attendance(employee, relieving_date, status):
	filters = {
		"docstatus": 1,
		"status": status,
		"employee": employee,
		"attendance_date": ("<=", get_datetime(relieving_date)),
	}
	if status == "On Leave":
		lwp = frappe.get_all("Leave Type", filters={"is_lwp": 1}, pluck="name")
		if not lwp:
			return 0
		filters["leave_type"] = ("in", lwp)

	return frappe.db.count("Attendance", filters)


def _apply_experience_method(method, experience, minimum_years, employee):
	if method == "Round off Work Experience":
		experience = round(experience)
	# "Take Exact Completed Years" / "Manual" -> keep the raw fractional value.

	if experience < minimum_years:
		frappe.throw(
			_("Employee {0} must complete at least {1} year(s) of service to qualify for gratuity").format(
				bold(employee), minimum_years
			)
		)
	return experience


def get_applicable_amount(employee: str, gratuity_rule: str) -> float:
	"""Sum of the last salary slip's earnings that the rule marks as applicable."""
	components = frappe.get_all(
		"Gratuity Applicable Component",
		filters={"parent": gratuity_rule},
		pluck="salary_component",
	)
	if not components:
		frappe.throw(
			_("No applicable earning components set on Gratuity Rule {0}").format(
				bold(get_link_to_form("Gratuity Rule", gratuity_rule))
			)
		)

	slip = _last_salary_slip(employee)
	if not slip:
		frappe.throw(
			_("No submitted Salary Slip found for employee {0}; gratuity needs the last drawn salary").format(
				bold(get_link_to_form("Employee", employee))
			)
		)

	amounts = frappe.get_all(
		"Salary Detail",
		filters={
			"docstatus": 1,
			"parent": slip,
			"parentfield": "earnings",
			"salary_component": ("in", components),
		},
		pluck="amount",
	)
	return flt(sum(amounts))


def _last_salary_slip(employee):
	slips = frappe.get_all(
		"Salary Slip",
		filters={"employee": employee, "docstatus": 1},
		order_by="start_date desc",
		limit=1,
		pluck="name",
	)
	return slips[0] if slips else None


def calculate_amount(employee: str, gratuity_rule: str, period: dict) -> dict:
	"""Return the uncapped gratuity amount and the per-year applicable base.

	Supports both rule modes:
	  * "Current Slab" — one slab applies to the whole tenure.
	  * "Sum of all previous slabs" — each band contributes, with the final
	     partial band prorated down to months and days.
	"""
	base = get_applicable_amount(employee, gratuity_rule)
	if base == 0:
		return {"amount": 0.0, "applicable_amount": 0.0, "per_month": 0.0}

	rule = get_rule(gratuity_rule)
	slabs = frappe.get_all(
		"Gratuity Rule Slab",
		filters={"parent": gratuity_rule},
		fields=["from_year", "to_year", "fraction_of_applicable_earnings"],
		order_by="idx",
	)
	if not slabs:
		frappe.throw(
			_("No slabs defined on Gratuity Rule {0}").format(bold(gratuity_rule))
		)

	experience = period["current_work_experience"]
	amount = 0.0
	found = False

	if rule.calculate_gratuity_amount_based_on == "Current Slab":
		for slab in slabs:
			if experience >= slab.from_year and (slab.to_year == 0 or experience < slab.to_year):
				amount = base * experience * flt(slab.fraction_of_applicable_earnings)
				found = True
				break
	else:  # Sum of all previous slabs
		years_left = period["years"]
		for slab in slabs:
			per_year = base * flt(slab.fraction_of_applicable_earnings)
			open_ended = slab.to_year == 0

			if experience >= slab.to_year and experience > slab.from_year and not open_ended:
				# Fully-completed band.
				amount += (slab.to_year - slab.from_year) * per_year
				years_left -= slab.to_year - slab.from_year
				found = True
			elif slab.from_year <= experience and (experience < slab.to_year or open_ended):
				# Final, partial band — prorate the remainder to months and days.
				amount += years_left * per_year
				amount += (per_year / 12) * period["months"]
				amount += (per_year / 12 / 30) * period["days"]
				found = True
				break

	if not found:
		frappe.throw(
			_("No matching slab found in Gratuity Rule {0} for {1} year(s) of service").format(
				bold(gratuity_rule), flt(experience, 2)
			)
		)

	# Per-month figure is used by the UAE cap (e.g. "24 months' pay maximum").
	per_month = base / 12
	return {"amount": flt(amount), "applicable_amount": base, "per_month": flt(per_month)}
