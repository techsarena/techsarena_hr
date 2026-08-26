"""Serves the service worker from inside the app's own scope.

A worker may only control paths at or below where it was served from. The bundle
lives under /assets, which Frappe hands to Werkzeug's static middleware — that
path bypasses the request hooks, so there is nowhere to add the
`Service-Worker-Allowed` header a broader scope would need.

Serving the same bytes from /dashboard/sw.js sidesteps the problem entirely: the
worker is already inside the scope it wants, so no header is required. The file
itself stays in the built asset directory, so `yarn build` remains its single
source; this only re-serves it at a URL the browser will accept.
"""

import os

import frappe

no_cache = 1


def get_context(context):
	context.worker_source = _worker_source()
	return context


def _worker_source() -> str:
	path = os.path.join(frappe.get_app_path("techsarena_hr"), "public", "dashboard", "sw.js")
	try:
		with open(path, encoding="utf-8") as handle:
			return handle.read()
	except OSError:
		# A site whose dashboard has not been built yet gets an inert worker
		# rather than a 500 — offline support is optional, the app is not.
		return "/* dashboard not built */\n"
