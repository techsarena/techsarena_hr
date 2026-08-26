"""One message in a ticket's conversation.

No validation of its own — the parent decides who may post and whether a note
is internal, because those rules depend on the ticket, not the row.
"""

from frappe.model.document import Document


class HRTicketReply(Document):
	pass
