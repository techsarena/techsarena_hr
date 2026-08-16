// Copyright (c) 2026, Techs Arena and contributors
// For license information, please see license.txt

frappe.ui.form.on("Techsarena Subscription", {
	refresh: render_usage,
});
frappe.ui.form.on("Techsarena Company License", {
	company: render_usage,
	licensed_employees: render_usage,
	company_licenses_remove: render_usage,
});

async function render_usage(frm) {
	const rows = frm.doc.company_licenses || [];
	if (!rows.length) {
		frm.get_field("usage_html").$wrapper.html(
			'<div class="text-muted" style="padding:8px 0">Add a company license row to see usage.</div>'
		);
		return;
	}
	let html = '<div style="padding:4px 0">';
	for (const r of rows) {
		if (!r.company) continue;
		const n = await frappe.db.count("Employee", {
			filters: { status: "Active", company: r.company },
		});
		const lim = r.licensed_employees || 0;
		const over = lim && n > lim;
		const pct = lim ? Math.min(100, Math.round((n / lim) * 100)) : 0;
		html += `
			<div style="margin-bottom:10px">
				<div style="font-size:14px;font-weight:600">
					${frappe.utils.escape_html(r.company)} — ${n} of ${lim} seats used
					${over ? '<span style="color:#e03131">— over limit</span>' : ""}
				</div>
				<div style="height:9px;background:#eee;border-radius:6px;overflow:hidden;margin-top:5px">
					<div style="height:100%;width:${pct}%;background:${over ? "#e03131" : "#2ec27e"}"></div>
				</div>
			</div>`;
	}
	html += "</div>";
	frm.get_field("usage_html").$wrapper.html(html);
}
