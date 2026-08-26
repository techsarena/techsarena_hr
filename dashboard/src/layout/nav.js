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
    ],
  },
  {
    id: 'me',
    label: 'My workspace',
    capability: 'employee_self_service',
    items: [
      { to: '/profile', label: 'My profile', icon: 'people' },
      { to: '/attendance', label: 'Attendance', icon: 'clock' },
      {
        to: '/leave',
        label: 'Leave',
        icon: 'calendar',
        children: [
          { to: '/leave', label: 'My leave', end: true },
          { to: '/leave/team', label: 'Team calendar' },
          { to: '/leave/policies', label: 'Policies' },
        ],
      },
      { to: '/salary', label: 'Salary', icon: 'wallet' },
      { to: '/claims', label: 'Expenses', icon: 'receipt' },
      { to: '/goals', label: 'Goals', icon: 'target' },
      { to: '/helpdesk', label: 'Help & requests', icon: 'inbox' },
      { to: '/policies', label: 'Policies', icon: 'checklist' },
      { to: '/funds', label: 'Funds', icon: 'vault' },
      { to: '/loans', label: 'Loans', icon: 'bank' },
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
  {
    id: 'company',
    label: 'Company',
    items: [
      { to: '/people', label: 'People', icon: 'people', capability: 'can_view_directory' },
      { to: '/org', label: 'Org chart', icon: 'chart', capability: 'can_view_directory' },
      { to: '/lifecycle', label: 'Lifecycle', icon: 'briefcase', capability: 'can_manage_hr' },
      { to: '/payroll', label: 'Payroll', icon: 'payroll', capability: 'can_run_payroll' },
      { to: '/insights', label: 'Insights', icon: 'chart', capability: 'can_manage_hr' },
      { to: '/leave-admin', label: 'Leave admin', icon: 'ledger', capability: 'can_manage_hr' },
      { to: '/announcements', label: 'Announcements', icon: 'megaphone' },
    ],
  },
  {
    id: 'hiring',
    label: 'Hiring',
    capability: 'can_manage_hr',
    items: [
      { to: '/hiring', label: 'Job openings', icon: 'briefcase' },
      { to: '/onboarding', label: 'Onboarding', icon: 'checklist' },
      { to: '/offboarding', label: 'Offboarding', icon: 'inbox' },
    ],
  },
  {
    id: 'setup',
    label: 'Setup',
    capability: 'can_manage_hr',
    items: [
      { to: '/settings', label: 'Settings', icon: 'settings' },
      { to: '/users', label: 'Users & roles', icon: 'shield', capability: 'can_manage_users' },
    ],
  },
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
