# Techs Arena HR — Merge & Feature Plan

_Created 2026-08-16. Decisions: **GitHub is the merge base**, identity **"Techs Arena HR"**
(modules split Gratuity / GPS Attendance / core), inventory-first._

## Situation

The GitHub repo `techsarena/techsarena_hr` (branch `version-15`) and the local folder
`/home/dell/tarena-bench/apps/techsarena_hr` (branch `develop`) are **two different
codebases with unrelated git histories** — not two stages of one app.

- **GitHub** = renamed from `orbit_hr`. A large ESS/mobile **API layer** (42 whitelisted
  endpoints in one ~120KB `api.py`), 7 **role dashboards**, demo data, leave-policy
  custom fields. Only 1 doctype (`HR Announcement`). App title "Techs Arena HCM".
- **Local** = clean rebuild of `sowaan_hr`. **Backend engines**: Gratuity + GPS
  Attendance (7 doctypes, calc/haversine engines, 2 API endpoints). App title
  "Techs Arena HR".

They barely overlap → the job is **integration**, not conflict resolution. Merging gets
most of two `PROGRESS.md` clusters (ESS/API + Gratuity/GPS) into one app.

## Feature inventory

### On GitHub only (keep as base)
| Area | Endpoints / assets |
|---|---|
| Bootstrap/settings | `bootstrap`, `health`, `workspace_summary`, `settings_hub` |
| Attendance & shifts | `attendance_month`, `check_in_out`, `request_regularisation`, `request_shift_change`, `shift_types`, `shift_type_settings`, `save_shift_type_settings`, `create_shift_type`, `team_calendar` |
| Leave | `leave_policies`, `leave_policy_settings`, `assign_leave_policy`, `bulk_assign_leave_policy`, `leave_preview`, `submit_leave`, `decide_leave` |
| Holidays | `holiday_lists`, `holiday_change_impact`, `save_holiday_list`, `duplicate_holiday_list` |
| Payroll (basic) | `salary_structures`, `assign_salary_structure`, `payroll_run`, `create_payroll_run`, `submit_payroll_run` |
| Expense | `expense_claims`, `submit_expense_claim` |
| Approvals | `approval_queue`, `approval_detail`, `decide_request`, `decide_requests` |
| Employee/team | `employee_profile`, `employee_onboarding` |
| Recruitment | `job_openings`, `job_opening_detail` |
| Performance | `goals_and_appraisal` |
| Announcements | `announcements` + `HR Announcement` doctype |
| Notifications | `mark_notification_read` |
| Dashboards | 7 role dashboards (`role_dashboards.py`) |
| Setup | `install.py` leave-policy custom fields; `demo.py` role demo users |

### On Local only (port into base)
| Module | Content |
|---|---|
| Gratuity | `Gratuity Payment` (submittable), `gratuity_calculation.py`, `get_gratuity_preview` |
| GPS Attendance | `Geofence Location`, `Employee Geofence` (+child), `Employee Device` (+child), `Employee Checkin Request`; `mark_checkin` haversine |

### Still missing from BOTH (Phase 2 build backlog, from `sowaan_hr` spec)
- Payroll: **arrears process, income tax (paid/previous taxable), company-wise components, salary-slip overrides** (GitHub payroll is basic run/structure only)
- Funds: contribution/withdrawal/settings, profit fund (EOBI / provident)
- Loans: reschedule / skip instalment / repayment reschedule — needs `lending` app
- Leave engine: adjustment **scheduler**, balance adjustment, deductions (policy-assign is done)
- Increments & promotions; Employee health insurance; Overtime; Shift **pattern/roster**
- ESS **web page** itself — GitHub `templates/pages` is empty; front-end still to build against `HRMS Redesign - standalone.html`
- LinkedIn feature posts (separate track)

## Plan

### Phase 1 — Merge onto GitHub (integration)
1. Add GitHub as a remote of a fresh working clone; branch `feat/merge-gratuity-gps` off `version-15`.
2. Copy local modules `gratuity/` and `gps_attendance/` into the GitHub app tree; add both to `modules.txt`.
3. Reconcile config: `hooks.py` (merge scheduler/doc_events if any), `patches.txt`, `install.py`/`after_migrate`, `pyproject.toml`, `.pre-commit`.
4. Apply chosen identity: set `app_title = "Techs Arena HR"`, keep three-module split.
5. Install on site `techsarena.hr`, `bench migrate`, smoke-test: all doctypes migrate; `mark_checkin` geofence; gratuity preview; a couple of GitHub ESS endpoints (`bootstrap`, `attendance_month`).
6. Commit, push branch, open PR into `version-15` (or fast-forward if solo). Decide long-term branch (`version-15` primary; retire `develop`).

### Phase 2 — Build remaining features (one cluster at a time, priority order)
1. Payroll deep: arrears, income tax, company-wise components, salary-slip overrides
2. Funds: EOBI / provident (contribution/withdrawal/settings/profit)
3. Leave engine: adjustment scheduler + balance adjustment + deductions
4. Loans: `bench get-app lending` → reschedule / skip instalment
5. Increments & promotions; health insurance; overtime; shift pattern/roster
6. ESS web page front-end wired to existing API, against `HRMS Redesign - standalone.html`
7. LinkedIn posts for delivered features

Each cluster: build → install/migrate → test → commit → push.

## Open items to confirm before Phase 1
- Branch policy: keep `version-15` as primary and stop using `develop`? Or rename?
- Does GitHub `version-15` have anything unpushed/newer than this clone at merge time? (re-fetch before starting)
