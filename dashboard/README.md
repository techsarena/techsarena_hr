# Techsarena HCM — Web Dashboard

A React client for **Frappe HRMS**, served by the `techsarena_hr` app at
`/dashboard`. It is the desktop-web counterpart to the Flutter mobile client:
the same backend, the same design language, but built on real DOM so the dense
HR surfaces behave like a web app.

## Why React here

The mobile client is Flutter. This surface is not, deliberately:

- **Real DOM.** Table text selects, `Ctrl+F` finds it, links inside cells get
  the browser's own context menu, and `<th>` is genuinely sticky. A canvas
  renderer has to reimplement all of that.
- **Data density.** Company-wide registers (payroll, attendance, directory)
  are plain `<table>` markup the browser is already good at.
- **Load time.** ~110 KB gzipped on first paint. The charting library is
  code-split behind the Insights route, so only an HR user viewing analytics
  pays for it.

## Running

```sh
# Dev server on :8080, proxying /api to the bench on :8000
yarn dev

# Production build → ../techsarena_hr/public/dashboard, then copy the
# Jinja entry point into www/
yarn build

yarn lint
```

`yarn build` runs `copy-html-entry`, which copies the built `index.html` to
`techsarena_hr/www/dashboard.html`. Frappe renders that through Jinja to inject
`window.csrf_token`, so **the copy step is required** — a build without it
leaves the deployed page on the previous asset hashes.

The route is registered in `hooks.py`:

```python
website_route_rules = [{'from_route': '/dashboard/<path:app_path>', 'to_route': 'dashboard'}]
```

which is what makes client-side deep links (`/dashboard/approvals`) survive a
refresh.

## Architecture

```text
src/
├── api/
│   ├── client.js     fetch + CSRF + Frappe's error envelope
│   ├── hr.js         every backend call (the HrRepository counterpart)
│   └── format.js     dates, money, pluralisation, status→tone
├── hooks/
│   ├── WorkspaceContext.jsx   app-wide store (the WorkspaceController counterpart)
│   ├── useAsync.js            {data, error, loading} + AbortSignal
│   └── useToast.jsx
├── components/       ui.jsx · DataTable.jsx · Icon.jsx
├── layout/           Shell.jsx (sidebar + topbar) · nav.js
├── pages/            one file per route
└── styles/           components.css · shell.css   (tokens live in index.css)
```

**Data.** Every backend call lives in `api/hr.js`. Pages never call
`client.js` directly. Frappe wraps whitelisted results in `{"message": ...}`
while `/api/resource` wraps rows in `{"data": [...]}` — `call()` handles the
first, `resource()` the second.

**State.** `WorkspaceContext` holds the `bootstrap` payload (user,
capabilities, profile, directory, notifications, branding, hr_summary) and the
session gate. Per-screen data is fetched by `useAsync` in the page itself.

**Navigation** is gated on `bootstrap.capabilities` alone — no component reads
a role name to decide what to show. `nav.js` filters the menu and `App.jsx`
redirects a route the user's capabilities don't cover. The two must agree.

## Conventions

These match the Flutter client, and matter:

- **Null means "unset", not zero.** An unrated goal is "Not scored", an
  unallocated leave type is "Not allocated" — never a rendered `0` that reads
  as real data. `FieldRow` omits an unset row entirely.
- **Show only what the server returns.** Where a field is absent, drop the row
  rather than inventing a plausible default.
- **Never recompute server maths.** Leave day counts come from
  `leave_preview`, which is HRMS's own working-day calculation. Computing it
  here would disagree with what actually gets deducted.
- **Optional modules degrade honestly.** Goals, Loans and Recruitment are
  optional on a stock site; they show an explanatory empty state rather than an
  error. Loans specifically needs the `lending` app.
- Comments explain **why**, not what.

## Currency

Read from the profile's `Company.default_currency`, not `Global Defaults` — HR
roles can read the former but not the latter, and a 403 per screen is not worth
a currency symbol. Endpoints that return their own currency win over it.

## Verified against

Frappe 15.79, with the demo dataset seeded (`hr.manager@techsarena.local` /
`employee@techsarena.local`, password `OrbitDemo@123`). Payload shapes in
`api/hr.js` were checked against the live site rather than inferred — several
differ from what the endpoint names suggest, notably:

| Field | Actual shape |
|---|---|
| `leave_preview` | `working_days` (not `total_leave_days`); null balances for LWP |
| `approval_detail` | request fields **flat**, plus `coverage[]` / `history{}` |
| `team_week` | per-member grid; markers are `approved` / `pending` / `none` |
| `team_calendar` | `team_leave` / `own_leave` / `team_size` |
| `upcoming_shifts[].shift` | an object `{shift_type, start_time, end_time}` |
| `branding` | `name`, not `app_name` |
| `settings_hub.editors` | `{id, name, initials, role}` — no `full_name` |
