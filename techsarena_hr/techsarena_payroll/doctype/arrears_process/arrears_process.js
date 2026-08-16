// Copyright (c) 2026, Techs Arena and contributors
// For license information, please see license.txt

frappe.ui.form.on("Arrears Process", {
	refresh(frm) {
		if (frm.doc.docstatus === 0) {
			frm.add_custom_button(__("Compute Arrears"), () => {
				frm.call({ doc: frm.doc, method: "compute", freeze: true, freeze_message: __("Computing arrears...") })
					.then((r) => {
						frm.refresh_field("arrear_process_detail");
						frm.dirty();
						frappe.show_alert({
							message: __("Computed arrears for {0} employee(s).", [r.message || 0]),
							indicator: r.message ? "green" : "orange",
						});
					});
			});
		}
	},
});
