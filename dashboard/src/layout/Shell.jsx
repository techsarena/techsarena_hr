import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { visibleGroups } from './nav';
import { Icon } from '../components/Icon';
import { t } from '../api/i18n';
import { useOffline } from '../hooks/useOffline';
import hr from '../api/hr';
import { Avatar } from '../components/ui';
import CommandPalette from '../components/CommandPalette';
import { fmtRelative } from '../api/format';

/** Brand mark: logos arrive inline as data: URIs to dodge static-file CORS. */
function BrandMark({ branding, className }) {
  const logo = branding?.app_logo_data || branding?.app_logo;
  const name = branding?.name || 'Techsarena HCM';
  if (logo) return <span className={className}><img src={logo} alt={name} /></span>;
  return <span className={className}>{name.slice(0, 2).toUpperCase()}</span>;
}

function Sidebar({ open, onNavigate }) {
  const { capabilities, branding, user, profile, approvals, signOut } = useWorkspace();
  const { pathname } = useLocation();
  const groups = visibleGroups(capabilities);
  const badges = { approvals: approvals.length };

  return (
    <nav className={`sidebar${open ? ' is-open' : ''}`} aria-label="Main navigation">
      <div className="sidebar__brand">
        <BrandMark branding={branding} className="sidebar__logo" />
        <div className="truncate">
          <div className="sidebar__name truncate">{branding?.name || 'Techsarena HCM'}</div>
          {profile?.company && <div className="sidebar__role truncate">{profile.company}</div>}
        </div>
      </div>

      <div className="sidebar__nav">
        {groups.map((group) => (
          <div className="nav-group" key={group.id}>
            {group.label && <div className="nav-group__label">{group.label}</div>}
            {group.items.map((item) => {
              const count = item.badge ? badges[item.badge] : 0;
              const inSection = item.children
                ? pathname === item.to || pathname.startsWith(`${item.to}/`)
                : false;
              return (
                <div key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    onClick={onNavigate}
                    className={({ isActive }) => `nav-link${isActive || inSection ? ' is-active' : ''}`}
                  >
                    <Icon name={item.icon} size={17} />
                    <span className="truncate">{item.label}</span>
                    {count > 0 && <span className="nav-link__badge">{count > 99 ? '99+' : count}</span>}
                  </NavLink>
                  {item.children && inSection && (
                    <div className="nav-sub">
                      {item.children.map((child) => (
                        <NavLink
                          key={child.to}
                          to={child.to}
                          end={child.end}
                          onClick={onNavigate}
                          className={({ isActive }) => `nav-sub__link${isActive ? ' is-active' : ''}`}
                        >
                          {child.label}
                        </NavLink>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="sidebar__foot">
        <Avatar name={profile?.employee_name || user?.full_name} src={profile?.image || undefined} size="sm" />
        <div className="sidebar__user truncate">
          <div className="sidebar__user-name truncate">{profile?.employee_name || user?.full_name || '—'}</div>
          <div className="sidebar__user-mail truncate">{user?.id}</div>
        </div>
        <button type="button" className="sidebar__signout" onClick={signOut} title="Sign out" aria-label="Sign out">
          <Icon name="logout" size={16} />
        </button>
      </div>
    </nav>
  );
}

function Notifications({ open, onClose }) {
  const { notifications, unreadCount, markNotificationRead, markAllNotificationsRead } = useWorkspace();
  // Bootstrap carries the first page; anything the user pages past it lives
  // here, so the bell stays instant and the history is only fetched on demand.
  const [extra, setExtra] = useState([]);
  const [nextStart, setNextStart] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);

  // A fresh open should not show stale paging from the last one.
  useEffect(() => {
    if (!open) { setExtra([]); setNextStart(null); setShowPrefs(false); setUnreadOnly(false); }
  }, [open]);

  const rows = [...notifications, ...extra];
  const visible = unreadOnly ? rows.filter((n) => !n.read) : rows;
  const canPage = nextStart !== null || extra.length === 0;

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const start = nextStart ?? notifications.length;
      const page = await hr.notifications({ start, limit: 20 });
      // Bootstrap's page and this one can overlap if something arrived between.
      setExtra((prev) => {
        const seen = new Set([...notifications, ...prev].map((n) => n.name));
        return [...prev, ...page.notifications.filter((n) => !seen.has(n.name))];
      });
      setNextStart(page.next_start);
    } finally {
      setLoadingMore(false);
    }
  }, [nextStart, notifications]);

  // The context clears bootstrap's page; the rows this panel paged in are its
  // own state and have to be cleared alongside them.
  const markAll = useCallback(async () => {
    await markAllNotificationsRead();
    setExtra((prev) => prev.map((n) => ({ ...n, read: 1 })));
  }, [markAllNotificationsRead]);

  if (!open) return null;

  return (
    <>
      <div className="scrim no-print" style={{ background: 'transparent' }} onClick={onClose} />
      <div className="notif-panel no-print" role="dialog" aria-label="Notifications">
        <header className="notif-head">
          <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
            <strong className="notif-head__title">Notifications</strong>
            {unreadCount > 0 && <span className="notif-head__count">{unreadCount}</span>}
          </div>
          <div className="row" style={{ gap: 4 }}>
            <button
              type="button"
              className={`notif-head__btn${unreadOnly ? ' is-on' : ''}`}
              onClick={() => setUnreadOnly((v) => !v)}
            >
              Unread
            </button>
            {unreadCount > 0 && (
              <button type="button" className="notif-head__btn" onClick={markAll}>
                Mark all read
              </button>
            )}
            <button
              type="button"
              className={`notif-head__btn${showPrefs ? ' is-on' : ''}`}
              onClick={() => setShowPrefs((v) => !v)}
              aria-label="Notification settings"
            >
              <Icon name="settings" size={13} />
            </button>
          </div>
        </header>

        {showPrefs ? (
          <NotificationPreferences />
        ) : (
          <div className="notif-list">
            {visible.length === 0 ? (
              <div className="state" style={{ padding: 'var(--space-6)' }}>
                <div className="state__title">
                  {unreadOnly ? 'Nothing unread' : "You're all caught up"}
                </div>
                <p className="state__body">New notifications will show here.</p>
              </div>
            ) : (
              visible.map((item) => (
                <div
                  key={item.name}
                  className={`notif-item${item.read ? '' : ' is-unread'}`}
                  onClick={() => !item.read && markNotificationRead(item.name)}
                >
                  <div className="notif-item__subject">{item.subject}</div>
                  <div className="notif-item__meta">
                    {[item.document_type, fmtRelative(item.creation)].filter(Boolean).join(' · ')}
                  </div>
                </div>
              ))
            )}

            {canPage && visible.length > 0 && (
              <button
                type="button"
                className="notif-more"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading…' : 'Load older'}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** Per-category mute switches, saved as one map. */
function NotificationPreferences() {
  const [categories, setCategories] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    hr.notificationPreferences()
      .then((data) => { if (live) setCategories(data.categories); })
      .catch(() => { if (live) setCategories([]); });
    return () => { live = false; };
  }, []);

  const toggle = async (key) => {
    const next = categories.map((c) => (c.key === key ? { ...c, enabled: !c.enabled } : c));
    setCategories(next);
    setSaving(true);
    try {
      await hr.saveNotificationPreferences(
        Object.fromEntries(next.map((c) => [c.key, c.enabled])),
      );
    } finally {
      setSaving(false);
    }
  };

  if (!categories) return <div className="notif-prefs"><p className="small subtle">Loading…</p></div>;

  return (
    <div className="notif-prefs">
      <p className="small subtle" style={{ marginTop: 0 }}>Choose what you are told about.</p>
      {categories.map((cat) => (
        <label className="notif-pref" key={cat.key}>
          <input
            type="checkbox"
            checked={cat.enabled}
            disabled={saving}
            onChange={() => toggle(cat.key)}
          />
          <span className="small">{cat.label}</span>
        </label>
      ))}
    </div>
  );
}

const TITLES = {
  '/': 'Home',
  '/profile': 'My profile',
  '/attendance': 'Attendance & shifts',
  '/leave': 'My leave',
  '/leave/team': 'Team calendar',
  '/leave/policies': 'Leave policies',
  '/salary': 'Salary',
  '/claims': 'Expense claims',
  '/goals': 'Goals & appraisal',
  '/funds': 'My funds',
  '/loans': 'My loans',
  '/approvals': 'Approval inbox',
  '/people': 'People',
  '/org': 'Org chart',
  '/payroll': 'Payroll',
  '/insights': 'Insights',
  '/leave-admin': 'Leave admin',
  '/announcements': 'Announcements',
  '/helpdesk': 'Help & requests',
  '/policies': 'Policies',
  '/hiring': 'Job openings',
  '/onboarding': 'Onboarding',
  '/settings': 'Settings',
  '/users': 'Users & roles',
};

/** Connection state and any punch still waiting to reach the server. */
function OfflineBar() {
  const { online, queued } = useOffline();
  if (online && !queued) return null;
  return (
    <div className={`offline-bar no-print${online ? ' is-syncing' : ''}`} role="status">
      <span className="offline-bar__dot" aria-hidden="true" />
      {!online && t('Offline — showing what was already loaded.')}
      {queued > 0 && (
        <span>
          {' '}
          {queued === 1
            ? t('1 punch waiting to send.')
            : t('{0} punches waiting to send.', [queued])}
        </span>
      )}
    </div>
  );
}

export default function Shell() {
  const { unreadCount, reload } = useWorkspace();
  const [navOpen, setNavOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();

  // ⌘K on a Mac, Ctrl-K elsewhere. Shown as whichever the user's platform uses,
  // so the hint matches the key they actually press.
  const shortcutHint = useMemo(
    () => (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘K' : 'Ctrl K'),
    [],
  );

  // Close the mobile drawer on navigation, and keep the tab title in sync so
  // browser history and bookmarks read properly — plain web affordances.
  useEffect(() => { setNavOpen(false); setNotifOpen(false); }, [location.pathname]);

  // The palette opens from anywhere, so the shortcut lives on the document.
  // Bound once, and only toggles state — the palette owns its own keys.
  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    const title = t(TITLES[location.pathname] || 'Techsarena HCM');
    document.title = `${title} · Techsarena HCM`;
  }, [location.pathname]);

  return (
    <div className="shell">
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {navOpen && <div className="scrim no-print" onClick={() => setNavOpen(false)} />}
      <Sidebar open={navOpen} onNavigate={() => setNavOpen(false)} />

      <div className="main">
        <OfflineBar />
        <header className="topbar no-print">
          <button type="button" className="topbar__menu" onClick={() => setNavOpen(true)} aria-label="Open navigation">
            <Icon name="menu" />
          </button>
          <span className="topbar__title">{t(TITLES[location.pathname] || 'Techsarena HCM')}</span>
          <button
            type="button"
            className="topbar__search"
            onClick={() => setPaletteOpen(true)}
            aria-label="Search"
          >
            <Icon name="search" size={16} />
            <span className="topbar__search-text">Search people, leave, expenses…</span>
            <kbd>{shortcutHint}</kbd>
          </button>
          <div className="topbar__spacer" />
          <button type="button" className="topbar__btn" onClick={reload} title="Refresh" aria-label="Refresh">
            <Icon name="refresh" size={17} />
          </button>
          <button
            type="button"
            className="topbar__btn"
            onClick={() => setNotifOpen((v) => !v)}
            aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ''}`}
          >
            <Icon name="bell" size={17} />
            {unreadCount > 0 && <span className="topbar__dot">{unreadCount > 9 ? '9+' : unreadCount}</span>}
          </button>
          <Notifications open={notifOpen} onClose={() => setNotifOpen(false)} />
        </header>

        <main className="content">
          <div className="content__inner">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
