/**
 * Navigation model.
 *
 * Capabilities from bootstrap are the ONLY thing gating navigation — no item
 * reads a role name to decide whether it appears. Anyone holding Employee gets
 * the self-service group; seniority adds groups rather than a separate shell.
 */
import { t } from '../api/i18n';

export const NAV_GROUPS = [
  {
    id: 'workspace',
    label: null,
    items: [
      { to: '/', label: 'Home', icon: 'home', end: true },
      // Read-only for everyone, so it belongs beside Home rather than under an
      // admin group — an employee reads announcements, they do not manage them.
      { to: '/announcements', label: 'Announcements', icon: 'megaphone' },
    ],
  },

  /* Self-service is split into three groups rather than one long list. Eleven
     undifferentiated items is a wall; grouped by the question being asked —
     "my time", "my money", "my record" — each is scannable. */
  {
    id: 'time',
    label: 'Time & attendance',
    capability: 'employee_self_service',
    items: [
      { to: '/attendance', label: 'Attendance', icon: 'clock' },
      {
        to: '/leave',
        label: 'Leave',
        icon: 'calendar',
        children: [
          { to: '/leave', label: 'My leave', end: true },
          { to: '/leave/team', label: 'Team calendar' },
          // Qualified: this is the leave rulebook, not the company handbook,
          // which lives under My record. Two items called "Policies" in one
          // sidebar is a coin toss for the user.
          { to: '/leave/policies', label: 'Leave rules' },
        ],
      },
    ],
  },
  {
    id: 'pay',
    label: 'Pay & benefits',
    capability: 'employee_self_service',
    items: [
      { to: '/salary', label: 'Salary', icon: 'wallet' },
      { to: '/claims', label: 'Expenses', icon: 'receipt' },
      { to: '/funds', label: 'Funds', icon: 'vault' },
      { to: '/loans', label: 'Loans', icon: 'bank' },
    ],
  },
  {
    id: 'me',
    label: 'My record',
    capability: 'employee_self_service',
    items: [
      { to: '/goals', label: 'Goals', icon: 'target' },
      { to: '/training', label: 'Training', icon: 'learn' },
      { to: '/policies', label: 'Company policies', icon: 'policy' },
      { to: '/helpdesk', label: 'Help & requests', icon: 'chat' },
    ],
  },

  {
    id: 'approvals',
    label: 'Approvals',
    capability: 'can_approve_leave',
    items: [
      { to: '/approvals', label: 'Approval inbox', icon: 'inbox', badge: 'approvals' },
    ],
  },

  /* Company splits people-you-look-up from records-you-administer: a manager
     with directory access should not be shown a group that is mostly greyed
     out for them. */
  {
    id: 'directory',
    label: 'Directory',
    items: [
      { to: '/people', label: 'People', icon: 'people', capability: 'can_view_directory' },
      { to: '/org', label: 'Org chart', icon: 'chart', capability: 'can_view_directory' },
    ],
  },
  {
    id: 'manage',
    label: 'Manage',
    items: [
      { to: '/payroll', label: 'Payroll', icon: 'payroll', capability: 'can_run_payroll' },
      { to: '/leave-admin', label: 'Leave admin', icon: 'ledger', capability: 'can_manage_hr' },
      { to: '/lifecycle', label: 'Lifecycle', icon: 'briefcase', capability: 'can_manage_hr' },
      { to: '/insights', label: 'Insights', icon: 'chart', capability: 'can_manage_hr' },
    ],
  },
  {
    id: 'hiring',
    label: 'Hiring & exits',
    capability: 'can_manage_hr',
    items: [
      { to: '/hiring', label: 'Job openings', icon: 'briefcase' },
      { to: '/onboarding', label: 'Onboarding', icon: 'checklist' },
      // Distinct from Onboarding's icon: they are opposite ends of the same
      // journey and were previously easy to mis-click.
      { to: '/offboarding', label: 'Offboarding', icon: 'logout' },
    ],
  },
  // Setup (Settings, Users & roles) is not a sidebar group: it lives in the
  // account menu beside the profile, with the site-level things rather than
  // among the screens people work in daily.
];

/** Filters the model down to what this user's capabilities allow. */
export function visibleGroups(capabilities) {
  return NAV_GROUPS.map((group) => {
    if (group.capability && !capabilities[group.capability]) return null;
    // Labels are translated here, not in NAV_GROUPS: that constant is
    // evaluated at import time, before any catalogue has loaded.
    const items = group.items
      .filter((item) => !item.capability || capabilities[item.capability])
      .map((item) => ({
        ...item,
        label: t(item.label),
        children: item.children
          ? item.children
            .filter((c) => !c.capability || capabilities[c.capability])
            .map((c) => ({ ...c, label: t(c.label) }))
          : undefined,
      }));
    return items.length ? { ...group, items, label: group.label ? t(group.label) : group.label } : null;
  }).filter(Boolean);
}
