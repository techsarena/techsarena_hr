# Techs Arena HR — Handoff / Resume Guide

**Read this first when resuming on a new machine.** Companion: `MERGE_PLAN.md`
(full feature inventory + phase history). Repo primary branch: **`version-15`**.

Last updated: 2026-08-16.

---

## 1. Current state — what's delivered

App = Frappe HR extension. **GitHub `version-15` is the single source of truth**
(the merge of the old `orbit_hr` ESS/API layer + the local Gratuity/GPS rebuild).

| Area | Module | Status |
|---|---|---|
| ESS + mobile API (42 endpoints), role dashboards, HR Announcement | `Techsarena HR` | inherited from base, installed |
| Gratuity (end-of-service KSA/UAE/PK) | `Gratuity` | built earlier, installed |
| GPS geofence attendance | `GPS Attendance` | built earlier, installed |
| **Arrears** (Arrears Process, Employee Arrears + settings/children) | `Techsarena Payroll` | **done, E2E verified** |
| **Income tax** (configurable slab: Previous Taxable Income, Paid Income Tax) | `Techsarena Payroll` | **done, E2E verified** |

Commit trail on `version-15`: merge `5266c25` → arrears `efd7c3c`/`07633a8` →
income tax `ff626dc` (+ doc commits).

### Confirmed decisions (do not re-litigate)
- GitHub is the merge base; app identity = **"Techs Arena HR"**, 3-module split.
- Income tax = **configurable slab engine** (reuse hrms Income Tax Slab), **kept
  separate from funds**.
- Arrears/tax settle cleanly: arrears → **Additional Salary**; tax → a computed
  **before_save deduction** row. No 1600-line sowaan salary-slip tangle.

---

## 2. ⚠️ Critical gotchas (bit us already)

1. **Never name a module after an hrms module.** hrms modules are exactly `HR`
   and `Payroll`. Naming a techsarena_hr module `Payroll` makes `bench migrate`
   delete hrms's payroll doctypes as "orphans" (Salary Slip, Additional Salary,
   Income Tax Slab, …). Metadata only — data/tables survive; recover by renaming
   + re-migrating. That is why the payroll module is **`Techsarena Payroll`**
   (folder `techsarena_hr/techsarena_payroll/`). Module name → folder is the
   scrubbed name; rename the folder whenever you rename a module.
2. **System language must be set.** A blank System Settings `language` makes
   hrms `money_in_words` crash (`num2words(lang=None)`) when building slips in a
   background/console context. It is set to `en` on the dev site.

---

## 3. Environment (dev site used so far)

- Bench: `/home/dell/tarena-bench` — Frappe/ERPNext/hrms **version-15**.
- Site: **`techsarena.hr`** (Administrator). App installed from this repo.
- Redis started manually (ports differ from default): from the bench dir run
  `redis-server config/redis_cache.conf --daemonize yes` and the same for
  `config/redis_queue.conf`, then `bench start` → `http://techsarena.hr:8023`
  (add `127.0.0.1 techsarena.hr` to `/etc/hosts`).

### Resuming on a NEW machine
```bash
# 1. Get a version-15 bench with erpnext + hrms
bench init --frappe-branch version-15 tarena-bench && cd tarena-bench
bench get-app --branch version-15 erpnext
bench get-app --branch version-15 hrms
# 2. Add this app
bench get-app https://github.com/techsarena/techsarena_hr.git --branch version-15
# 3. New site + install
bench new-site techsarena.hr
bench --site techsarena.hr install-app erpnext hrms techsarena_hr
bench --site techsarena.hr set-config -g language en   # gotcha #2
bench --site techsarena.hr migrate
```

### Seeding payroll test data (fresh site has NONE)
A fresh ERPNext site is missing setup masters. Order that worked:
`Warehouse Type "Transit"` → `Fiscal Year 2026` → `Company "Techs Arena"` (PKR,
Pakistan) → salary components (Basic 60%, HRA 40% formulas; Income Tax; Arrears)
→ `Holiday List "TA 2026"` (weekly off Sunday) set as company default →
`Payroll Period` → `Income Tax Slab "PK Slab 2026"` → `Gender` records →
Employees → `Salary Structure "TA Standard"` → Salary Structure Assignments
(include a **mid-period raise** to exercise arrears). The exact console script
lives in the session scratchpad; reproduce from this recipe or ask Claude to
regenerate it.

---

## 4. Remaining plan (Phase 2 backlog, priority order)

Cadence for each cluster: **build → migrate → test on seeded data → commit → push**.

1. **Payroll — finish.** Company-wise components wiring (doctype exists in
   settings; apply it to filter components per company in arrears/tax). Optional:
   salary-slip overrides only if a concrete need appears — prefer hooks over
   override_doctype_class.
2. **Funds** — EOBI / provident: contribution, withdrawal, settings, profit
   fund. New `before_save`/`after_save` Salary Slip logic, **kept separate** from
   the tax hook. Likely a `Techsarena Funds` module (again: non-colliding name).
3. **Leave engine** — adjustment scheduler + balance adjustment + deductions.
4. **Loans** — needs the `lending` app (`bench get-app lending`): reschedule /
   skip instalment / repayment reschedule.
5. **Increments & promotions; health insurance; overtime; shift pattern/roster.**
6. **ESS web page front-end** — the 42 API endpoints exist but
   `techsarena_hr/templates/pages` is empty. Build the portal against
   `HRMS Redesign - standalone.html` (dashboard, attendance & shifts, leave,
   payslips, expense claims, approvals, team, tax, documents).
7. **LinkedIn feature posts** for delivered features (gratuity, GPS, arrears, tax).

Reference spec (spec-only, MIT, no code copied): `mamirbalouch/sowaan_hr`.

---

## 5. How the delivered payroll pieces work (quick map)

- `techsarena_hr/techsarena_payroll/doctype/arrears_process/arrears_process.py`
  — engine: one full-period slip at the OLD base × `(new/old − 1)` ×
  `(days_from_raise / period_days)`. Pure helper `component_total`. Button
  "Compute Arrears"; on submit → Employee Arrears (submitted) → Additional Salary.
- `.../employee_arrears/employee_arrears.py` — raises/cancels Additional Salary
  (same path as Gratuity).
- `techsarena_hr/techsarena_payroll/income_tax.py` — `progressive_tax()` (pure)
  + `apply_monthly_tax` before_save hook (registered in `hooks.py`).
- `Techsarena Payroll Settings` (single) — arrears default components,
  company-wise components, `enable_income_tax` + `tax_component`.
