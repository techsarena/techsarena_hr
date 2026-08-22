import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { visibleGroups } from './nav';
import { Icon } from '../components/Icon';
import { Avatar } from '../components/ui';
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
  const { notifications, markNotificationRead } = useWorkspace();
  if (!open) return null;
  return (
    <>
      <div className="scrim no-print" style={{ background: 'transparent' }} onClick={onClose} />
      <div className="notif-panel no-print" role="dialog" aria-label="Notifications">
        {notifications.length === 0 ? (
          <div className="state" style={{ padding: 'var(--space-6)' }}>
            <div className="state__title">You're all caught up</div>
            <p className="state__body">New notifications will show here.</p>
          </div>
        ) : (
          notifications.map((item) => (
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
      </div>
    </>
  );
}

const TITLES = {
  '/': 'Home',
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
  '/payroll': 'Payroll',
  '/insights': 'Insights',
  '/leave-admin': 'Leave admin',
  '/announcements': 'Announcements',
  '/hiring': 'Job openings',
  '/onboarding': 'Onboarding',
  '/settings': 'Settings',
  '/users': 'Users & roles',
};

export default function Shell() {
  const { unreadCount, reload } = useWorkspace();
  const [navOpen, setNavOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const location = useLocation();

  // Close the mobile drawer on navigation, and keep the tab title in sync so
  // browser history and bookmarks read properly — plain web affordances.
  useEffect(() => { setNavOpen(false); setNotifOpen(false); }, [location.pathname]);
  useEffect(() => {
    const title = TITLES[location.pathname] || 'Techsarena HCM';
    document.title = `${title} · Techsarena HCM`;
  }, [location.pathname]);

  return (
    <div className="shell">
      {navOpen && <div className="scrim no-print" onClick={() => setNavOpen(false)} />}
      <Sidebar open={navOpen} onNavigate={() => setNavOpen(false)} />

      <div className="main">
        <header className="topbar no-print">
          <button type="button" className="topbar__menu" onClick={() => setNavOpen(true)} aria-label="Open navigation">
            <Icon name="menu" />
          </button>
          <span className="topbar__title">{TITLES[location.pathname] || 'Techsarena HCM'}</span>
          <div className="topbar__search">
            <Icon name="search" size={16} />
            <input type="search" placeholder="Search people, policies, claims..." aria-label="Search" />
            <kbd>⌘K</kbd>
          </div>
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
