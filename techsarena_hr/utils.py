"""Request-level fixups that the framework gives no other hook for."""

import frappe

#: The one path whose response headers we adjust. Kept explicit rather than
#: pattern-matched so this can never affect another route by accident.
SERVICE_WORKER_PATH = "/dashboard/sw.js"


def set_service_worker_headers(response=None, request=None):
	"""Give the service worker the content type and scope a browser demands.

	Frappe's website layer decides the MIME type from the resolved template, and
	offers a page controller no way to override it, so it is corrected here.
	`Service-Worker-Allowed` lets the worker claim /dashboard even though this
	route sits at /dashboard/sw.js.
	"""
	if not request or request.path != SERVICE_WORKER_PATH or response is None:
		return
	response.headers["Content-Type"] = "text/javascript; charset=utf-8"
	response.headers["Service-Worker-Allowed"] = "/dashboard"
	# A worker cached for long keeps a fixed bug alive in every installed client
	# until the file happens to expire.
	response.headers["Cache-Control"] = "no-cache, must-revalidate"
