# Copyright (c) 2026, Techs Arena and contributors
# For license information, please see license.txt
"""
GPS attendance API — the endpoint the mobile app calls to punch in/out.

Design notes (vs. the reference implementation):
  * Coordinates are floats end-to-end. The reference stored every location as a
    "lat,lng" string and re-parsed it on every comparison; here the boundary
    accepts floats and the maths never touches a string.
  * Device binding auto-registers an employee's first device, then requires that
    same device thereafter — a light anti-spoofing measure.
  * The heavy, fragile `tzwhere` import is gone. Timezone resolution is optional
    (via `timezonefinder` if present) and degrades to site time otherwise.
  * All look-ups use the ORM/query builder — no interpolated SQL.
"""

from math import atan2, cos, radians, sin, sqrt

import frappe
from frappe import _
from frappe.utils import now_datetime

EARTH_RADIUS_M = 6_371_000  # mean Earth radius in metres


def haversine_metres(lat1, lon1, lat2, lon2) -> float:
	"""Great-circle distance between two WGS-84 points, in metres."""
	p1, p2 = radians(lat1), radians(lat2)
	d_phi = radians(lat2 - lat1)
	d_lambda = radians(lon2 - lon1)
	a = sin(d_phi / 2) ** 2 + cos(p1) * cos(p2) * sin(d_lambda / 2) ** 2
	return EARTH_RADIUS_M * (2 * atan2(sqrt(a), sqrt(1 - a)))


def get_allowed_locations(employee: str) -> list[dict]:
	"""Active geofences assigned to the employee, with resolved coordinates."""
	geofence = frappe.db.exists("Employee Geofence", {"employee": employee})
	if not geofence:
		return []

	rows = frappe.get_all(
		"Employee Geofence Location",
		filters={"parent": geofence, "parenttype": "Employee Geofence"},
		pluck="location",
	)
	if not rows:
		return []

	return frappe.get_all(
		"Geofence Location",
		filters={"name": ("in", rows), "is_active": 1},
		fields=["name", "location_name", "latitude", "longitude", "allowed_radius"],
	)


def get_registered_devices(employee: str) -> list[dict]:
	registration = frappe.db.exists("Employee Device", {"employee": employee})
	if not registration:
		return []
	return frappe.get_all(
		"Employee Device Item",
		filters={"parent": registration, "parenttype": "Employee Device", "active": 1},
		fields=["device_id", "device_name"],
	)


def ensure_device(employee: str, device_id: str, device_name: str = None) -> bool:
	"""Return True if the device may punch. Auto-registers the first device seen."""
	devices = get_registered_devices(employee)
	if not devices:
		registration = frappe.new_doc("Employee Device")
		registration.employee = employee
		registration.append("devices", {
			"device_id": device_id,
			"device_name": device_name,
			"registered_on": now_datetime(),
		})
		registration.insert(ignore_permissions=True)
		return True

	return any(d["device_id"] == device_id for d in devices)


def match_geofence(employee: str, latitude: float, longitude: float):
	"""Return (location_dict, distance_m) for the nearest geofence in range, else (None, None)."""
	nearest, nearest_distance = None, None
	for loc in get_allowed_locations(employee):
		distance = haversine_metres(latitude, longitude, loc["latitude"], loc["longitude"])
		if distance <= loc["allowed_radius"] and (nearest_distance is None or distance < nearest_distance):
			nearest, nearest_distance = loc, distance
	return nearest, nearest_distance


@frappe.whitelist()
def mark_checkin(employee, log_type, latitude, longitude, device_id, device_name=None, time=None):
	"""Punch a geofenced, device-bound check-in. Returns {success, message, checkin}.

	Called by the mobile app. `latitude`/`longitude` are decimal degrees.
	"""
	latitude, longitude = float(latitude), float(longitude)

	if log_type not in ("IN", "OUT"):
		frappe.throw(_("Log Type must be IN or OUT."))
	if not frappe.db.exists("Employee", employee):
		frappe.throw(_("Unknown employee {0}.").format(employee))

	if not ensure_device(employee, device_id, device_name):
		return {"success": False, "message": _("This device is not registered for attendance."), "checkin": None}

	location, distance = match_geofence(employee, latitude, longitude)
	if not location:
		return {"success": False, "message": _("You are not inside an allowed location."), "checkin": None}

	checkin = frappe.new_doc("Employee Checkin")
	checkin.employee = employee
	checkin.log_type = log_type
	checkin.time = _resolve_time(time, latitude, longitude)
	checkin.device_id = device_id
	checkin.latitude = latitude
	checkin.longitude = longitude
	checkin.insert(ignore_permissions=True)

	return {
		"success": True,
		"message": _("{0} recorded at {1} ({2} m from centre).").format(
			log_type, location["location_name"], round(distance)
		),
		"checkin": checkin.name,
	}


def _resolve_time(client_time, latitude, longitude):
	if client_time:
		return client_time
	# Optional: stamp using the device's GPS timezone if timezonefinder is available.
	try:
		from datetime import datetime

		from pytz import timezone
		from timezonefinder import TimezoneFinder

		tz = TimezoneFinder().timezone_at(lat=latitude, lng=longitude)
		if tz:
			return datetime.now(timezone(tz)).strftime("%Y-%m-%d %H:%M:%S")
	except Exception:
		pass
	return now_datetime()
