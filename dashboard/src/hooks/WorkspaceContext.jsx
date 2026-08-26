import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import hr from '../api/hr';
import { auth, onSessionLost, resource, setCsrfToken, setSessionEstablished } from '../api/client';
import { useRealtime } from './useRealtime';

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
        setSessionEstablished(false);
        setStatus('anonymous');
        return;
      }
      const payload = await hr.bootstrap();
      // Under `vite dev` this is the only place a valid CSRF token reaches the
      // client, and every POST needs it.
      setCsrfToken(payload?.csrf_token);
      setBoot(payload);
      // From here a 401/403 means the session died, not that the user was never
      // signed in — arm the transport to report it.
      setSessionEstablished(true);
      setStatus('ready');
    } catch (err) {
      if (err.isUnauthorized) {
        setBoot(null);
        setSessionEstablished(false);
        setStatus('anonymous');
        return;
      }
      setError(err);
      setStatus('error');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // A session that expires mid-use drops the app back to the login screen
  // instead of leaving the user on a dead workspace collecting "Not permitted"
  // toasts from every background refresh.
  useEffect(
    () =>
      onSessionLost(() => {
        setBoot(null);
        setSummary(null);
        setError(null);
        setStatus('anonymous');
      }),
    [],
  );

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

  /* Live updates.
     Coalesced: a bulk approval fires one event per request, and refetching
     bootstrap for each would stampede the server. The first event schedules a
     single refresh shortly after, and any event arriving inside that window
     rides along with it. */
  const refreshTimer = useRef(null);
  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      load();
    }, 400);
  }, [load]);

  const onRealtime = useCallback(
    (payload) => {
      switch (payload?.event) {
        case 'attendance_updated':
          // Carries its own state, so patch it in rather than refetching.
          if (payload.today) setBoot((prev) => prev && { ...prev, attendance: payload.today });
          break;
        case 'leave_decided':
        case 'request_decided':
        case 'approval_queue_changed':
          scheduleRefresh();
          break;
        case 'notification':
          // The payload is the whole row, so the bell updates without a
          // bootstrap refetch. Guarded against a duplicate arriving twice.
          setBoot((prev) => {
            if (!prev) return prev;
            const list = prev.notifications || [];
            if (list.some((n) => n.name === payload.name)) return prev;
            return {
              ...prev,
              notifications: [
                {
                  name: payload.name,
                  subject: payload.subject,
                  document_type: payload.document_type,
                  document_name: payload.document_name,
                  read: 0,
                  creation: new Date().toISOString(),
                },
                ...list,
              ],
            };
          });
          break;
        case 'notifications_read':
          // Another tab cleared them; match it rather than showing a stale count.
          setBoot((prev) => prev && {
            ...prev,
            notifications: (prev.notifications || []).map((n) => ({ ...n, read: 1 })),
          });
          break;
        default:
          break;
      }
    },
    [scheduleRefresh],
  );

  useRealtime(onRealtime, { enabled: status === 'ready' });

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

  const markAllNotificationsRead = useCallback(async () => {
    await hr.markAllNotificationsRead();
    setBoot((prev) => prev && {
      ...prev,
      notifications: (prev.notifications || []).map((n) => ({ ...n, read: 1 })),
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
      markAllNotificationsRead,
    };
  }, [status, error, load, signIn, signOut, boot, summary, currency, markNotificationRead, markAllNotificationsRead]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used inside <WorkspaceProvider>');
  return ctx;
}
