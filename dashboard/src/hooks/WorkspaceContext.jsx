import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import hr from '../api/hr';
import { auth, resource } from '../api/client';

/**
 * App-wide store — the React counterpart of WorkspaceController.
 *
 * Holds the bootstrap payload (user, capabilities, profile, directory,
 * notifications, branding, hr_summary) and the session state that gates the
 * whole shell. Screens read capabilities from here; nothing reads role names
 * to decide navigation.
 */
const WorkspaceContext = createContext(null);

const EMPTY_CAPS = {
  employee_self_service: false,
  can_approve_leave: false,
  can_manage_hr: false,
  can_view_directory: false,
  can_manage_users: false,
  can_run_payroll: false,
};

export function WorkspaceProvider({ children }) {
  const [status, setStatus] = useState('checking'); // checking | anonymous | ready | error
  const [boot, setBoot] = useState(null);
  const [error, setError] = useState(null);
  const [summary, setSummary] = useState(null);
  const [currency, setCurrency] = useState(null);

  const load = useCallback(async () => {
    setStatus('checking');
    setError(null);
    try {
      // A logged-out visitor gets 403 here; that is the normal cold-start path,
      // not a failure, so it resolves to `anonymous` rather than an error.
      const user = await auth.currentUser().catch((err) => {
        if (err.isUnauthorized) return 'Guest';
        throw err;
      });
      if (!user || user === 'Guest') {
        setBoot(null);
        setStatus('anonymous');
        return;
      }
      const payload = await hr.bootstrap();
      setBoot(payload);
      setStatus('ready');
    } catch (err) {
      if (err.isUnauthorized) {
        setBoot(null);
        setStatus('anonymous');
        return;
      }
      setError(err);
      setStatus('error');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // The company's currency, so amounts never fall back to a foreign symbol.
  // Read from Company rather than Global Defaults: HR roles can read the former
  // but not the latter, and a 403 per screen is not worth a currency symbol.
  const company = boot?.profile?.company;
  useEffect(() => {
    if (status !== 'ready' || !company) return undefined;
    let cancelled = false;
    resource('Company', {
      filters: JSON.stringify([['name', '=', company]]),
      fields: JSON.stringify(['default_currency']),
      limit_page_length: 1,
    })
      .then((rows) => { if (!cancelled) setCurrency(rows?.[0]?.default_currency || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [status, company]);

  // Dashboard cards load separately: a failure here degrades the cards, never
  // the whole screen — the same contract the Flutter client keeps.
  useEffect(() => {
    if (status !== 'ready' || !boot?.capabilities?.employee_self_service) return;
    let cancelled = false;
    hr.workspaceSummary()
      .then((data) => { if (!cancelled) setSummary(data); })
      .catch(() => { if (!cancelled) setSummary(null); });
    return () => { cancelled = true; };
  }, [status, boot]);

  const signIn = useCallback(async (usr, pwd) => {
    await auth.login(usr, pwd);
    await load();
  }, [load]);

  const signOut = useCallback(async () => {
    try { await auth.logout(); } finally {
      setBoot(null);
      setSummary(null);
      setStatus('anonymous');
    }
  }, []);

  const markNotificationRead = useCallback(async (name) => {
    await hr.markNotificationRead(name);
    setBoot((prev) => prev && {
      ...prev,
      notifications: (prev.notifications || []).map((n) => (n.name === name ? { ...n, read: 1 } : n)),
    });
  }, []);

  const value = useMemo(() => {
    const capabilities = { ...EMPTY_CAPS, ...(boot?.capabilities || {}) };
    const notifications = boot?.notifications || [];
    return {
      status,
      error,
      reload: load,
      signIn,
      signOut,
      boot,
      summary,
      currency,
      user: boot?.user || null,
      capabilities,
      profile: boot?.profile || null,
      branding: boot?.branding || null,
      directory: boot?.directory || [],
      users: boot?.users || [],
      leaveBalances: boot?.leave_balances || [],
      leaveRequests: boot?.leave_requests || [],
      salarySlips: boot?.salary_slips || [],
      holidays: boot?.holidays || [],
      attendance: boot?.attendance || null,
      approvals: boot?.approvals || [],
      hrSummary: boot?.hr_summary || null,
      notifications,
      unreadCount: notifications.filter((n) => !n.read).length,
      markNotificationRead,
    };
  }, [status, error, load, signIn, signOut, boot, summary, currency, markNotificationRead]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used inside <WorkspaceProvider>');
  return ctx;
}
