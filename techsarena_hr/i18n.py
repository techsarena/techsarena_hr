"""Localisation for the dashboard.

Translation is Frappe's, not ours: `frappe.translate` already ships catalogues
for every language ERPNext supports, and every `_()` call in this app's Python
already feeds the same machinery. This module is the bridge that hands those
catalogues to the React client and lets a user change their language.

Nothing here defines translations. It exposes what the site already has.
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.translate import get_all_translations

#: Scripts written right-to-left. Frappe's own list, from
#: `frappe.utils.jinja_globals.is_rtl`, plus Urdu and Sindhi — both are
#: Arabic-script and render wrongly LTR, and both matter for this app's
#: Pakistan-facing payroll modules. Kept explicit rather than guessed from the
#: language code, because script does not follow from language family.
RTL_LANGUAGES: frozenset[str] = frozenset({"ar", "he", "fa", "ps", "ur", "sd", "ku", "dv", "yi"})


def is_rtl(lang: str | None) -> bool:
	"""Whether a language code renders right-to-left.

	Matches on the base code so regional variants (`ar-SA`, `fa-IR`) inherit
	their parent's direction.
	"""
	if not lang:
		return False
	return lang.split("-")[0].lower() in RTL_LANGUAGES


def _system_language() -> str:
	return frappe.db.get_single_value("System Settings", "language") or "en"


def resolve_language(user: str | None = None) -> str:
	"""The language this user should see.

	Their own setting wins; otherwise the site default. Mirrors how Frappe
	resolves language for the desk, so the dashboard and the desk agree.
	"""
	user = user or frappe.session.user
	if user and user != "Guest":
		chosen = frappe.db.get_value("User", user, "language")
		if chosen:
			return chosen
	return _system_language()


@frappe.whitelist(allow_guest=True)
def translations(lang: str | None = None) -> dict:
	"""The full message catalogue for one language.

	Guest-accessible so the login screen can be translated before there is a
	session to read a preference from. `lang` is only honoured as an explicit
	override — with none supplied, the caller's own setting decides.
	"""
	language = lang or resolve_language()
	# A code the site does not know would silently return {} and leave the UI
	# in English with no explanation; fall back deliberately instead.
	if not frappe.db.exists("Language", language):
		language = _system_language()

	try:
		messages = get_all_translations(language) or {}
	except Exception:
		frappe.log_error(f"Could not load translations for {language}", "Translation load failed")
		messages = {}

	return {
		"language": language,
		"direction": "rtl" if is_rtl(language) else "ltr",
		"messages": messages,
	}


@frappe.whitelist(allow_guest=True)
def languages() -> dict:
	"""Every language this site offers, for the picker.

	Reads the Language doctype rather than a list of our own, so a site that
	enables or disables a language sees that reflected here.
	"""
	rows = frappe.get_all(
		"Language",
		filters={"enabled": 1},
		fields=["name as code", "language_name as label"],
		order_by="language_name asc",
		limit_page_length=0,
	)
	for row in rows:
		row["direction"] = "rtl" if is_rtl(row["code"]) else "ltr"

	current = resolve_language()
	return {
		"languages": rows,
		"current": current,
		"direction": "rtl" if is_rtl(current) else "ltr",
	}


@frappe.whitelist(methods=["POST"])
def set_language(language: str) -> dict:
	"""Store the signed-in user's language preference.

	Written to the User record, so the desk, printed documents and outgoing
	email follow the same choice rather than the dashboard alone.
	"""
	user = frappe.session.user
	if not user or user == "Guest":
		frappe.throw(_("Please sign in to change your language."), frappe.AuthenticationError)
	if not frappe.db.exists("Language", language):
		frappe.throw(_("{0} is not a language this site offers.").format(language))

	frappe.db.set_value("User", user, "language", language, update_modified=False)
	# The cached catalogue is per-language, not per-user, so nothing to clear —
	# but the client must refetch, which the response tells it to do.
	return {
		"language": language,
		"direction": "rtl" if is_rtl(language) else "ltr",
	}
