/**
 * Every backend call the dashboard makes, in one place — the React
 * counterpart of the Flutter client's HrRepository. Views never call
 * `client.js` directly.
 *
 * Namespace note: the Frappe app is `techsarena_hr` (the Flutter repo
 * directory is still `techsarena_hcm`; that is cosmetic).
 */
import { call, post, resource } from './client';

const NS = 'techsarena_hr.api';
const LEAVE = 'techsarena_hr.leave_engine';
const FUNDS = 'techsarena_hr.funds';
const LOANS = 'techsarena_hr.loans';

export const hr = {
  /* ---- Bootstrap & profile ---- */
  bootstrap: (opts) => call(`${NS}.bootstrap`, undefined, opts),
  workspaceSummary: (opts) => call(`${NS}.workspace_summary`, undefined, opts),
  employeeProfile: (employee, opts) => call(`${NS}.employee_profile`, { employee }, opts),
  appBranding: (opts) => call(`${NS}.app_branding`, undefined, opts),

  /* ---- Attendance ---- */
  attendanceMonth: (month, opts) => call(`${NS}.attendance_month`, { month }, opts),
  shiftTypes: (opts) => call(`${NS}.shift_types`, undefined, opts),
  checkInOut: (logType) => post(`${NS}.check_in_out`, { log_type: logType }),
  requestRegularisation: (payload) => post(`${NS}.request_regularisation`, payload),
  requestShiftChange: (payload) => post(`${NS}.request_shift_change`, payload),

  /* ---- Leave ---- */
  teamCalendar: (fromDate, toDate, opts) =>
    call(`${NS}.team_calendar`, { from_date: fromDate, to_date: toDate }, opts),
  // Working-day maths is HRMS's own — never recompute it client-side, or the
  // preview will disagree with what actually gets deducted.
  leavePreview: (leaveType, fromDate, toDate, halfDay = 0) =>
    call(`${NS}.leave_preview`, {
      leave_type: leaveType,
      from_date: fromDate,
      to_date: toDate,
      half_day: halfDay ? 1 : 0,
    }),
  submitLeave: (payload) => post(`${NS}.submit_leave`, payload),
  decideLeave: (name, decision, comment) => post(`${NS}.decide_leave`, { name, decision, comment }),

  /** Falls back to the resource API so the Policies screen survives a backend
   *  without the endpoint — mirrors loadLeavePolicies() in the Flutter client. */
  async leavePolicies(opts) {
    try {
      return await call(`${NS}.leave_policies`, undefined, opts);
    } catch (error) {
      if (error.status !== 404) throw error;
      const leaveTypes = await resource(
        'Leave Type',
        { fields: JSON.stringify(['name', 'max_leaves_allowed', 'is_lwp', 'is_carry_forward']), limit_page_length: 0 },
        opts,
      );
      return { leave_types: leaveTypes, approval_chain: [], documents: [], holiday_list: null, policy_set: null };
    }
  },

  /* ---- Payroll ---- */
  payrollRun: (name, opts) => call(`${NS}.payroll_run`, { name }, opts),
  createPayrollRun: (payload) => post(`${NS}.create_payroll_run`, payload),
  submitPayrollRun: (name) => post(`${NS}.submit_payroll_run`, { name }),
  salaryStructures: (opts) => call(`${NS}.salary_structures`, undefined, opts),
  assignSalaryStructure: (employee, salaryStructure, base) =>
    post(`${NS}.assign_salary_structure`, { employee, salary_structure: salaryStructure, base }),

  /* ---- Approvals ---- */
  approvalQueue: (opts) => call(`${NS}.approval_queue`, undefined, opts),
  approvalDetail: (doctype, name, opts) => call(`${NS}.approval_detail`, { doctype, name }, opts),
  decideRequest: (doctype, name, decision, comment) =>
    post(`${NS}.decide_request`, { doctype, name, decision, comment }),
  // Bulk decisions return failed[] so the UI can name what didn't go through.
  decideRequests: (requests, decision, comment) =>
    post(`${NS}.decide_requests`, { requests: JSON.stringify(requests), decision, comment }),

  /* ---- Expenses ---- */
  expenseClaims: (opts) => call(`${NS}.expense_claims`, undefined, opts),
  submitExpenseClaim: (expenses, remark) =>
    post(`${NS}.submit_expense_claim`, { expenses: JSON.stringify(expenses), remark }),
  withdrawExpenseClaim: (name) => post(`${NS}.withdraw_expense_claim`, { name }),

  /* ---- Hiring ---- */
  jobOpenings: (opts) => call(`${NS}.job_openings`, undefined, opts),
  jobOpeningDetail: (name, opts) => call(`${NS}.job_opening_detail`, { name }, opts),
  employeeOnboarding: (opts) => call(`${NS}.employee_onboarding`, undefined, opts),

  /* ---- Insights ---- */
  insights: (months, opts) => call(`${NS}.insights`, months ? { months } : undefined, opts),

  /* ---- Goals & appraisal ----
     Returns only {goals, appraisals}; rate_goal / submit_self_assessment are
     not implemented server-side, so the screen stays read-only. */
  goalsAndAppraisal: (opts) => call(`${NS}.goals_and_appraisal`, undefined, opts),

  /* ---- Announcements ---- */
  announcements: (opts) => call(`${NS}.announcements`, undefined, opts),
  markNotificationRead: (name) => post(`${NS}.mark_notification_read`, { name }),

  /* ---- Settings ---- */
  settingsHub: (opts) => call(`${NS}.settings_hub`, undefined, opts),
  assignLeavePolicy: (employee, leavePolicy) =>
    post(`${NS}.assign_leave_policy`, { employee, leave_policy: leavePolicy }),
  leavePolicySettings: (name, opts) => call(`${NS}.leave_policy_settings`, { name }, opts),
  bulkAssignLeavePolicy: (leavePolicy, employees) =>
    post(`${NS}.bulk_assign_leave_policy`, { leave_policy: leavePolicy, employees: JSON.stringify(employees) }),
  holidayLists: (name, opts) => call(`${NS}.holiday_lists`, { name }, opts),
  holidayChangeImpact: (name, holidays, weeklyOffDays) =>
    post(`${NS}.holiday_change_impact`, {
      name,
      holidays: JSON.stringify(holidays),
      weekly_off_days: JSON.stringify(weeklyOffDays),
    }),
  saveHolidayList: (name, holidays, weeklyOffDays) =>
    post(`${NS}.save_holiday_list`, {
      name,
      holidays: JSON.stringify(holidays),
      weekly_off_days: JSON.stringify(weeklyOffDays),
    }),
  duplicateHolidayList: (name) => post(`${NS}.duplicate_holiday_list`, { name }),
  shiftTypeSettings: (name, opts) => call(`${NS}.shift_type_settings`, { name }, opts),
  saveShiftTypeSettings: (name, values) =>
    post(`${NS}.save_shift_type_settings`, { name, values: JSON.stringify(values) }),
  createShiftType: (name, startTime, endTime) =>
    post(`${NS}.create_shift_type`, { name, start_time: startTime, end_time: endTime }),
  seedDemoData: () => post(`${NS}.seed_demo_data`),

  /* ---- Leave admin (leave_engine) ---- */
  adjustLeaveBalance: (employee, leaveType, days, reason) =>
    post(`${LEAVE}.adjust_leave_balance`, { employee, leave_type: leaveType, days, reason }),
  leaveAdjustments: (employee, opts) => call(`${LEAVE}.leave_adjustments`, { employee }, opts),
  leaveDeductions: (fromDate, toDate, opts) =>
    call(`${LEAVE}.leave_deductions`, { from_date: fromDate, to_date: toDate }, opts),

  /* ---- Funds (EOBI / provident) ---- */
  myFunds: (opts) => call(`${FUNDS}.my_funds`, undefined, opts),
  fundSummary: (fundType, opts) => call(`${FUNDS}.fund_summary`, { fund_type: fundType }, opts),
  fundStatement: (employee, fundType, opts) =>
    call(`${FUNDS}.fund_statement`, { employee, fund_type: fundType }, opts),
  recordContribution: (payload) => post(`${FUNDS}.record_contribution`, payload),
  recordMonthlyContributions: (fundType, period) =>
    post(`${FUNDS}.record_monthly_contributions`, { fund_type: fundType, period }),
  recordWithdrawal: (payload) => post(`${FUNDS}.record_withdrawal`, payload),
  allocateProfit: (fundType, rate, period) =>
    post(`${FUNDS}.allocate_profit`, { fund_type: fundType, rate, period }),

  /* ---- Loans ----
     Backed by the optional `lending` app. A site without it raises on the
     missing Loan table, so surface that as an unavailable module rather than
     letting a raw SQL error reach the screen. */
  myLoans: (opts) =>
    call(`${LOANS}.my_loans`, undefined, opts).catch((error) => {
      if (/DocType.*Loan|Loan.*does not exist|ProgrammingError/i.test(error.message || '')) {
        return { employee: null, loans: [], unavailable: true };
      }
      throw error;
    }),
  loanDetail: (loan, opts) => call(`${LOANS}.loan_detail`, { loan }, opts),
  rescheduleLoan: (loan, newPeriods, reason) =>
    post(`${LOANS}.reschedule_loan`, { loan, new_periods: newPeriods, reason }),
  skipInstallment: (loan, reason) => post(`${LOANS}.skip_installment`, { loan, reason }),
};

export default hr;
