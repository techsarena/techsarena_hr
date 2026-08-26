/**
 * Every backend call the dashboard makes, in one place — the React
 * counterpart of the Flutter client's HrRepository. Views never call
 * `client.js` directly.
 *
 * Namespace note: the Frappe app is `techsarena_hr` (the Flutter repo
 * directory is still `techsarena_hcm`; that is cosmetic).
 */
import { call, post, resource, upload } from './client';

const NS = 'techsarena_hr.api';
const LEAVE = 'techsarena_hr.leave_engine';
const FUNDS = 'techsarena_hr.funds';
const LOANS = 'techsarena_hr.loans';
const GPS = 'techsarena_hr.gps_attendance.api.attendance';
const EXIT = 'techsarena_hr.offboarding';
const LIFE = 'techsarena_hr.lifecycle';
const PERF = 'techsarena_hr.performance';
const NOTIF = 'techsarena_hr.notifications';
const I18N = 'techsarena_hr.i18n';
const DESK = 'techsarena_hr.helpdesk';

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

  /* ---- Geofenced attendance (GPS) ----
     Separate from checkInOut: this path enforces an HR-approved device and the
     employee's assigned geofence. The employee is taken from the session — the
     endpoint has no `employee` parameter, by design. */
  gpsCheckIn: ({ logType, latitude, longitude, deviceId, accuracy }) =>
    post(`${GPS}.mark_checkin`, {
      log_type: logType,
      latitude,
      longitude,
      device_id: deviceId,
      accuracy,
    }),
  requestDeviceEnrolment: (deviceId, deviceName) =>
    post(`${GPS}.request_device_enrolment`, { device_id: deviceId, device_name: deviceName }),
  attendanceContext: (opts) => call(`${GPS}.my_attendance_context`, undefined, opts),
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

  /* ---- Leave block lists (blackout dates) ---- */
  myBlockedDates: (fromDate, toDate, opts) =>
    call(`${NS}.my_blocked_dates`, { from_date: fromDate, to_date: toDate }, opts),
  leaveBlockLists: (name, opts) => call(`${NS}.leave_block_lists`, name ? { name } : undefined, opts),
  saveLeaveBlockList: (payload) =>
    post(`${NS}.save_leave_block_list`, {
      ...payload,
      dates: JSON.stringify(payload.dates || []),
      allowed_users: JSON.stringify(payload.allowed_users || []),
    }),
  deleteLeaveBlockList: (name) => post(`${NS}.delete_leave_block_list`, { name }),
  assignBlockListToDepartment: (department, leaveBlockList) =>
    post(`${NS}.assign_block_list_to_department`, {
      department,
      leave_block_list: leaveBlockList,
    }),

  /* ---- Offboarding / separation ---- */
  offboardingQueue: (opts) => call(`${EXIT}.offboarding_queue`, undefined, opts),
  separationDetail: (name, opts) => call(`${EXIT}.separation_detail`, { name }, opts),
  startSeparation: (payload) => post(`${EXIT}.start_separation`, payload),
  completeSeparation: (name, relievingDate, force) =>
    post(`${EXIT}.complete_separation`, {
      name,
      relieving_date: relievingDate,
      force: force ? 1 : 0,
    }),
  // Reports what is owed in both directions; posts nothing.
  exitSummary: (employee, opts) => call(`${EXIT}.exit_summary`, { employee }, opts),
  raiseGratuityPayment: (employee, gratuityRule) =>
    post(`${EXIT}.raise_gratuity_payment`, { employee, gratuity_rule: gratuityRule }),

  /* ---- Payroll ---- */
  payrollRun: (name, opts) => call(`${NS}.payroll_run`, { name }, opts),
  payrollReadiness: (opts) => call(`${NS}.payroll_readiness`, undefined, opts),
  unassignedEmployees: (opts) => call(`${NS}.unassigned_employees`, undefined, opts),
  createPayrollRun: (payload) => post(`${NS}.create_payroll_run`, payload),
  submitPayrollRun: (name) => post(`${NS}.submit_payroll_run`, { name }),
  salaryStructures: (opts) => call(`${NS}.salary_structures`, undefined, opts),
  draftSalaryStructures: (opts) => call(`${NS}.draft_salary_structures`, undefined, opts),
  salaryComponents: (opts) => call(`${NS}.salary_components`, undefined, opts),
  createSalaryComponent: (componentName, componentType) =>
    post(`${NS}.create_salary_component`, { component_name: componentName, component_type: componentType }),
  submitSalaryStructure: (name) => post(`${NS}.submit_salary_structure`, { name }),
  createSalaryStructure: (payload) =>
    post(`${NS}.create_salary_structure`, {
      ...payload,
      earnings: JSON.stringify(payload.earnings || []),
      deductions: JSON.stringify(payload.deductions || []),
    }),
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
  // Receipts are Frappe Files re-pointed at the claim: upload first, attach second.
  attachExpenseReceipt: (claim, fileUrl, fileName) =>
    post(`${NS}.attach_expense_receipt`, { claim, file_url: fileUrl, file_name: fileName }),
  removeExpenseReceipt: (claim, fileUrl) =>
    post(`${NS}.remove_expense_receipt`, { claim, file_url: fileUrl }),

  /* ---- Hiring ---- */
  jobOpenings: (opts) => call(`${NS}.job_openings`, undefined, opts),
  jobOpeningDetail: (name, opts) => call(`${NS}.job_opening_detail`, { name }, opts),
  employeeOnboarding: (opts) => call(`${NS}.employee_onboarding`, undefined, opts),

  /* ---- Localisation ----
     Catalogues are Frappe's own, so every language ERPNext ships works here.
     Guest-accessible: the login screen translates before there is a session. */
  translations: (lang, opts) => call(`${I18N}.translations`, lang ? { lang } : undefined, opts),
  languages: (opts) => call(`${I18N}.languages`, undefined, opts),
  setLanguage: (language) => post(`${I18N}.set_language`, { language }),

  /* ---- Helpdesk ----
     Routine questions for HR. Distinct from grievances: internal notes are
     filtered server-side, so whatever comes back is safe to render. */
  myTickets: (status, opts) => call(`${DESK}.my_tickets`, status ? { status } : undefined, opts),
  ticketQueue: (params, opts) => call(`${DESK}.ticket_queue`, params, opts),
  ticketDetail: (name, opts) => call(`${DESK}.ticket_detail`, { name }, opts),
  raiseTicket: (payload) => post(`${DESK}.raise_ticket`, payload),
  replyToTicket: (name, message, internal) =>
    post(`${DESK}.reply_to_ticket`, { name, message, internal: internal ? 1 : 0 }),
  updateTicket: (name, changes) => post(`${DESK}.update_ticket`, { name, ...changes }),
  helpdeskAgents: (opts) => call(`${DESK}.helpdesk_agents`, undefined, opts),

  /* ---- Org chart ----
     Flat nodes with parent pointers; the client assembles the tree. `root`
     focuses on one person and their descendants. */
  orgChart: (root, opts) => call(`${NS}.org_chart`, root ? { root } : undefined, opts),

  /* ---- Global search ----
     Backs the command palette. Permission filtering is the server's; the
     client renders whatever comes back. */
  globalSearch: (query, opts) => call(`${NS}.global_search`, { query }, opts),

  /* ---- Insights ---- */
  insights: (months, opts) => call(`${NS}.insights`, months ? { months } : undefined, opts),

  /* ---- Goals & appraisal ---- */
  goalsAndAppraisal: (opts) => call(`${NS}.goals_and_appraisal`, undefined, opts),
  // Progress updates and self-assessment now write back; scoring stays HRMS's.
  rateGoal: (name, progress, status) => post(`${PERF}.rate_goal`, { name, progress, status }),
  appraisalDetail: (name, opts) => call(`${PERF}.appraisal_detail`, { name }, opts),
  // `ratings` is [{criteria, rating}] with rating in stars (1..star_count).
  submitSelfAssessment: (name, reflections, ratings) =>
    post(`${PERF}.submit_self_assessment`, {
      name,
      reflections,
      ratings: JSON.stringify(ratings || []),
    }),
  addAppraisalFeedback: (name, feedback, ratings) =>
    post(`${PERF}.add_appraisal_feedback`, {
      name,
      feedback,
      ratings: JSON.stringify(ratings || []),
    }),

  /* ---- Leave encashment ---- */
  encashableLeave: (employee, opts) =>
    call(`${PERF}.encashable_leave`, employee ? { employee } : undefined, opts),
  createLeaveEncashment: (employee, leaveType, leavePeriod, days) =>
    post(`${PERF}.create_leave_encashment`, {
      employee,
      leave_type: leaveType,
      leave_period: leavePeriod,
      encashment_days: days,
    }),

  /* ---- Lifecycle: promotion, transfer, grievance, travel ---- */
  propertyFields: (opts) => call(`${LIFE}.property_fields`, undefined, opts),
  promotions: (employee, opts) => call(`${LIFE}.promotions`, employee ? { employee } : undefined, opts),
  // `changes` is {fieldname: newValue}; the server reads current values itself.
  createPromotion: (payload) =>
    post(`${LIFE}.create_promotion`, { ...payload, changes: JSON.stringify(payload.changes || {}) }),
  transfers: (employee, opts) => call(`${LIFE}.transfers`, employee ? { employee } : undefined, opts),
  createTransfer: (payload) =>
    post(`${LIFE}.create_transfer`, { ...payload, changes: JSON.stringify(payload.changes || {}) }),
  grievances: (status, opts) => call(`${LIFE}.grievances`, status ? { status } : undefined, opts),
  raiseGrievance: (payload) => post(`${LIFE}.raise_grievance`, payload),
  resolveGrievance: (name, status, resolutionDetail, causeOfGrievance) =>
    post(`${LIFE}.resolve_grievance`, {
      name,
      status,
      resolution_detail: resolutionDetail,
      cause_of_grievance: causeOfGrievance,
    }),
  travelRequests: (opts) => call(`${LIFE}.travel_requests`, undefined, opts),
  submitTravelRequest: (payload) =>
    post(`${LIFE}.submit_travel_request`, {
      ...payload,
      itinerary: JSON.stringify(payload.itinerary || []),
    }),

  /* ---- Announcements ---- */
  announcements: (opts) => call(`${NS}.announcements`, undefined, opts),

  /* ---- Notifications ----
     bootstrap carries the first page for the bell; these page beyond it and
     own read-state and per-category preferences. */
  markNotificationRead: (name) => post(`${NS}.mark_notification_read`, { name }),
  notifications: ({ limit, start, unreadOnly } = {}, opts) =>
    call(`${NOTIF}.notifications`, { limit, start, unread_only: unreadOnly ? 1 : 0 }, opts),
  markAllNotificationsRead: () => post(`${NOTIF}.mark_all_read`),
  notificationPreferences: (opts) => call(`${NOTIF}.notification_preferences`, undefined, opts),
  saveNotificationPreferences: (preferences) =>
    post(`${NOTIF}.save_notification_preferences`, { preferences: JSON.stringify(preferences) }),

  /* ---- Profile self-service ----
     Employees propose corrections; HR applies them. The editable field list is
     served by the backend rather than hardcoded here, so the form can never
     offer a field the server would reject. */
  profileChangeOptions: (opts) => call(`${NS}.profile_change_options`, undefined, opts),
  myProfileChangeRequests: (opts) => call(`${NS}.my_profile_change_requests`, undefined, opts),
  submitProfileChange: (changes, reason) =>
    post(`${NS}.submit_profile_change`, { changes: JSON.stringify(changes || {}), reason }),
  withdrawProfileChange: (name) => post(`${NS}.withdraw_profile_change`, { name }),

  /* ---- Employee documents ----
     `uploadFile` moves the bytes through Frappe's own handler; the save call
     then records what the file is. Two steps, because the metadata is ours and
     the storage is Frappe's. */
  uploadFile: (file, options) => upload(file, options),
  employeeDocuments: (employee, opts) =>
    call(`${NS}.employee_documents`, employee ? { employee } : undefined, opts),
  saveEmployeeDocument: (payload) => post(`${NS}.save_employee_document`, payload),
  verifyEmployeeDocument: (name, verified = 1) =>
    post(`${NS}.verify_employee_document`, { name, verified: verified ? 1 : 0 }),
  deleteEmployeeDocument: (name) => post(`${NS}.delete_employee_document`, { name }),
  expiringDocuments: (days, opts) =>
    call(`${NS}.expiring_documents`, days ? { days } : undefined, opts),

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
