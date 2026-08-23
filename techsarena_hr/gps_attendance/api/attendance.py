# Copyright (c) 2026, Techs Arena and contributors
# For license information, please see license.txt
"""
GPS attendance API — the endpoint the mobile app calls to punch in/out.

Security model (every point here is load-bearing):

  * **Identity is never client-supplied.** The employee is derived from
    ``frappe.session.user`` via ``_require_employee_user``. The endpoint takes
    no ``employee`` argument at all, so there is no identifier to spoof.
  * **Time is stamped server-side.** The client cannot supply a timestamp, so a
    punch cannot be back- or post-dated. Frappe stores naive datetimes in the
    *site* timezone; ``now_datetime()`` is exactly that, so the value written is
    directly comparable to every other Employee Checkin on the site.
  * **Devices are enrolled, never auto-registered.** A device the employee has
    not had approved cannot punch. Enrolment raises an HR-approved
    ``Employee Checkin Request``-style flow (see ``request_device_enrolment``);
    only HR can activate a row on ``Employee Device``.
  * **The geofence is enforced server-side**, against coordinates the client
    sends. Note the honest limitation documented in ``mark_checkin``: GPS
    coordinates are inherently client-asserted. The geofence stops an employee
    punching from home by accident or convenience; it does not stop a
    determined attacker with a rooted device. Device binding plus the stored
    coordinates (auditable after the fact) are the compensating controls.
  * All look-ups use the ORM/query builder — no interpolated SQL.
"""

from math import atan2, cos, radians, sin, sqrt

import frappe
from frappe import _
from frappe.utils import cint, flt, now_datetime

EARTH_RADIUS_M = 6_371_000  # mean Earth radius in metres

#: A punch is rejected outright beyond this accuracy (metres) when the client
#: reports one. A 2 km "fix" is a cell-tower triangulation, not a GPS lock, and
#: accepting it would let anyone in the city pass a 100 m geofence.
MAX_ACCURACY_M = 250.0


def haversine_metres(lat1, lon1, lat2, lon2) -> float:
	"""Great-circle distance between two WGS-84 points, in metres."""
	p1, p2 = radians(lat1), radians(lat2)
	d_phi = radians(lat2 - lat1)
	d_lambda = radians(lon2 - lon1)
	a = sin(d_phi / 2) ** 2 + cos(p1) * cos(p2) * sin(d_lambda / 2) ** 2
	return EARTH_RADIUS_M * (2 * atan2(sqrt(a), sqrt(1 - a)))


def _validate_coordinates(latitude, longitude) -> tuple[float, float]:
	"""Parse and range-check a client-supplied fix.

	Rejecting out-of-range values here keeps a malformed payload from silently
	matching nothing and reading as "outside the geofence", which would send the
	employee chasing a location problem that is really a client bug.
	"""
	try:
		latitude, longitude = float(latitude), float(longitude)
	except (TypeError, ValueError):
		frappe.throw(_("A valid GPS location is required to punch."), frappe.ValidationError)

	if not (-90.0 <= latitude <= 90.0) or not (-180.0 <= longitude <= 180.0):
		frappe.throw(_("The GPS coordinates supplied are out of range."), frappe.ValidationError)

	# Exactly (0, 0) is Null Island — the signature of an uninitialised location
	# object, never a real workplace.
	if latitude == 0.0 and longitude == 0.0:
		frappe.throw(
			_("Your device did not return a GPS fix. Enable location and try again."),
			frappe.ValidationError,
		)

	return latitude, longitude


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
	"""Devices HR has approved for this employee. Inactive rows are excluded."""
	registration = frappe.db.exists("Employee Device", {"employee": employee})
	if not registration:
		return []
	return frappe.get_all(
		"Employee Device Item",
		filters={"parent": registration, "parenttype": "Employee Device", "active": 1},
		fields=["device_id", "device_name"],
	)


def is_device_registered(employee: str, device_id: str) -> bool:
	"""True only if HR has already approved this exact device.

	Deliberately does **not** auto-register. The previous behaviour enrolled the
	first device it ever saw, which let an attacker claim an employee's device
	slot before that employee first punched — locking the real employee out and
	handing the attacker a permanently trusted device.
	"""
	if not device_id:
		return False
	return any(row["device_id"] == device_id for row in get_registered_devices(employee))


def match_geofence(employee: str, latitude: float, longitude: float):
	"""Return (location_dict, distance_m) for the nearest geofence in range, else (None, None)."""
	nearest, nearest_distance = None, None
	for loc in get_allowed_locations(employee):
		distance = haversine_metres(latitude, longitude, loc["latitude"], loc["longitude"])
		if distance <= flt(loc["allowed_radius"]) and (
			nearest_distance is None or distance < nearest_distance
		):
			nearest, nearest_distance = loc, distance
	return nearest, nearest_distance


def _geofence_is_enforced(employee: str) -> bool:
	"""Whether this employee is subject to geofencing at all.

	An employee with no Employee Geofence record is unrestricted (remote staff,
	field staff, anyone HR has not fenced). An employee *with* a record must be
	inside one of its active locations — an assigned-but-all-inactive fence is
	treated as a misconfiguration and refused rather than silently opened.
	"""
	return bool(frappe.db.exists("Employee Geofence", {"employee": employee}))


@frappe.whitelist(methods=["POST"])
def mark_checkin(log_type, latitude, longitude, device_id, accuracy=None):
	"""Punch a geofenced, device-bound check-in for the **signed-in** employee.

	The employee is taken from the session; there is no ``employee`` parameter,
	so one user cannot punch as another. The time is stamped server-side, so a
	punch cannot be back- or post-dated.

	``latitude``/``longitude`` are decimal degrees and ``accuracy`` is the
	client's reported horizontal accuracy in metres (optional; rejected beyond
	``MAX_ACCURACY_M`` when supplied).

	Honest limitation: coordinates are asserted by the client and a rooted
	device can lie about them. This enforces the *policy* — it is not an
	anti-tamper guarantee. The coordinates are persisted on the Employee Checkin
	so an audit can catch what enforcement cannot.
	"""
	from techsarena_hr.api import _require_employee_user, _require_hrms, _require_login

	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)

	log_type = (log_type or "").strip().upper()
	if log_type not in ("IN", "OUT"):
		frappe.throw(_("Log Type must be IN or OUT."), frappe.ValidationError)

	latitude, longitude = _validate_coordinates(latitude, longitude)

	if accuracy not in (None, ""):
		accuracy = flt(accuracy)
		if accuracy > MAX_ACCURACY_M:
			frappe.throw(
				_("Your location is only accurate to {0} m. Move outdoors and try again.").format(
					int(accuracy)
				),
				frappe.ValidationError,
			)

	device_id = (device_id or "").strip()
	if not is_device_registered(employee, device_id):
		frappe.throw(
			_(
				"This device is not approved for attendance. Request enrolment and ask HR to "
				"approve it before punching."
			),
			frappe.PermissionError,
		)

	location, distance = None, None
	if _geofence_is_enforced(employee):
		location, distance = match_geofence(employee, latitude, longitude)
		if not location:
			frappe.throw(
				_("You are not inside an allowed work location."), frappe.PermissionError
			)

	# Guard the IN/OUT sequence so a double-tap or a retry cannot open a second
	# unclosed interval. The row lock serialises concurrent punches for this
	# employee; see api.check_in_out, which applies the same discipline.
	frappe.db.get_value("Employee", employee, "name", for_update=True)
	last_log_type = frappe.db.get_value(
		"Employee Checkin",
		{"employee": employee},
		"log_type",
		order_by="time desc, creation desc",
	)
	if log_type == "IN" and last_log_type == "IN":
		frappe.throw(_("You are already checked in."), frappe.ValidationError)
	if log_type == "OUT" and last_log_type != "IN":
		frappe.throw(_("You are not currently checked in."), frappe.ValidationError)

	checkin = frappe.new_doc("Employee Checkin")
	checkin.employee = employee
	checkin.log_type = log_type
	# Site-timezone naive datetime, matching every other Employee Checkin row.
	checkin.time = now_datetime()
	checkin.device_id = device_id
	checkin.latitude = latitude
	checkin.longitude = longitude
	# The employee owns this record and holds create rights on Employee Checkin;
	# inserting as the session user keeps HRMS's own validation and any
	# site-level customisation in force.
	checkin.insert()

	if location:
		message = _("{0} recorded at {1} ({2} m from centre).").format(
			log_type, location["location_name"], round(distance)
		)
	else:
		message = _("{0} recorded.").format(log_type)

	return {
		"success": True,
		"message": message,
		"checkin": checkin.name,
		"time": str(checkin.time),
		"location": location["location_name"] if location else None,
	}


@frappe.whitelist(methods=["POST"])
def request_device_enrolment(device_id, device_name=None):
	"""Ask HR to approve this device for the signed-in employee's attendance.

	Creates (or reuses) the employee's ``Employee Device`` record and appends the
	device **inactive**. Only HR can flip ``active``, so filing a request grants
	nothing on its own — this is the approval gate that replaced the old
	auto-registration.

	Inserted with ``ignore_permissions`` because Employee Device is an HR-owned
	doctype by design (employees hold no create right on it); the employee is
	session-derived and the row lands unusable until HR acts, so this elevation
	cannot be turned into an attendance capability.
	"""
	from techsarena_hr.api import _require_employee_user, _require_hrms, _require_login

	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)

	device_id = (device_id or "").strip()
	if not device_id:
		frappe.throw(_("A device identifier is required."), frappe.ValidationError)

	existing = frappe.db.exists("Employee Device", {"employee": employee})
	if existing:
		registration = frappe.get_doc("Employee Device", existing)
	else:
		registration = frappe.new_doc("Employee Device")
		registration.employee = employee

	for row in registration.get("devices") or []:
		if row.device_id == device_id:
			return {
				"device_id": device_id,
				"active": bool(cint(row.active)),
				"status": "approved" if cint(row.active) else "pending",
				"message": _("This device is already approved.")
				if cint(row.active)
				else _("This device is already awaiting HR approval."),
			}

	registration.append(
		"devices",
		{
			"device_id": device_id,
			"device_name": device_name,
			# Inactive until HR approves — this is the whole point of the flow.
			"active": 0,
			"registered_on": now_datetime(),
		},
	)
	registration.save(ignore_permissions=True)

	return {
		"device_id": device_id,
		"active": False,
		"status": "pending",
		"message": _("Enrolment requested. HR must approve this device before you can punch."),
	}


@frappe.whitelist()
def my_attendance_context():
	"""What the punch screen needs: device approval state and assigned fences.

	Lets the client tell "not enrolled" apart from "outside the fence" before the
	employee taps, rather than surfacing both as a failed punch.
	"""
	from techsarena_hr.api import _require_employee_user, _require_hrms, _require_login

	user = _require_login()
	_require_hrms()
	_unused_user, employee = _require_employee_user(user)

	return {
		"employee": employee,
		"devices": get_registered_devices(employee),
		"geofence_enforced": _geofence_is_enforced(employee),
		"locations": [
			{
				"location_name": loc["location_name"],
				"latitude": loc["latitude"],
				"longitude": loc["longitude"],
				"allowed_radius": loc["allowed_radius"],
			}
			for loc in get_allowed_locations(employee)
		],
		"max_accuracy_m": MAX_ACCURACY_M,
	}
