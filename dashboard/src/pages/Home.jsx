import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { useToast } from '../hooks/useToast';
import hr from '../api/hr';
import { Button, EmptyState, Meter, Pill } from '../components/ui';
import { Icon } from '../components/Icon';
import { fmtDate, fmtDateShort, fmtDays, fmtDuration, fmtRange, fmtTime, initials } from '../api/format';
import { t } from '../api/i18n';

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function todayLine(count) {
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date());
  return `${date} · ${count || 'No'} thing${count === 1 ? '' : 's'} need you today`;
}

function shiftLabel(shift) {
  return shift || 'General Shift · 9:00-18:00';
}

function PunchCard() {
  const { attendance, summary, reload } = useWorkspace();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const checkedIn = Boolean(attendance?.checked_in);
  const worked = attendance?.working_seconds || 0;
  const pct = Math.min(100, Math.max(0, (worked / (9 * 60 * 60)) * 100));
  const stats = summary?.attendance_stats || {};

  const punch = async () => {
    setBusy(true);
    try {
      await hr.checkInOut(checkedIn ? 'OUT' : 'IN');
      toast.success(checkedIn ? 'Checked out.' : 'Checked in.');
      await reload();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="home-card home-card--today">
      <header>
        <h2>{t("Today")}</h2>
        <span className="home-shift">{shiftLabel(attendance?.shift)}</span>
      </header>
      <div className="home-punch">
        <div className="home-punch__ring" style={{ '--pct': `${pct}%` }}>
          <strong>{fmtDuration(worked)}</strong>
          <span>of 9:00</span>
        </div>
        <div>
          <span className="home-label">{checkedIn ? 'Checked in' : 'Not checked in'}</span>
          <strong className="home-time">{attendance?.first_in ? fmtTime(attendance.first_in) : '—'}</strong>
          <p>{attendance?.status || 'Office'}{attendance?.shift ? ` · ${attendance.shift}` : ''}</p>
        </div>
      </div>
      <Button variant={checkedIn ? 'indigo' : 'primary'} onClick={punch} disabled={busy || !attendance} className="home-punch__action">
        <Icon name={checkedIn ? 'logout' : 'check'} size={17} />
        {busy ? 'Working…' : checkedIn ? 'Check out' : 'Check in'}
      </Button>
      <div className="home-mini-stats">
        <div><strong>{stats.present ?? '—'}</strong><span>{t("Present")}</span></div>
        <div><strong>{stats.on_leave ?? '—'}</strong><span>{t("On leave")}</span></div>
        <div><strong>{stats.late_entry ?? '—'}</strong><span>{t("Late in")}</span></div>
        <div><strong>{stats.average_hours ? `${Number(stats.average_hours).toFixed(1)}h` : '—'}</strong><span>{t("Avg day")}</span></div>
      </div>
    </section>
  );
}

function LeaveBalanceCard() {
  const { leaveBalances, summary } = useWorkspace();
  const balances = leaveBalances.slice(0, 4);
  const next = summary?.next_leave;

  return (
    <section className="home-card home-card--leave">
      <header>
        <h2>{t("Leave balance")}</h2>
        <Link to="/leave/policies">2026 allocation ↗</Link>
      </header>
      {balances.length ? (
        <div className="home-leave-grid">
          {balances.map((row) => {
            const remaining = Number(row.remaining) || 0;
            const allocated = Number(row.allocated) || 0;
            return (
              <div className="home-leave-tile" key={row.leave_type}>
                <div>
                  <strong>{Number.isInteger(remaining) ? remaining : remaining.toFixed(1)}</strong>
                  <span>/ {Number.isInteger(allocated) ? allocated : allocated.toFixed(1)} days</span>
                </div>
                <h3>{row.leave_type}</h3>
                <Meter value={remaining} total={allocated} tone={allocated > 0 && remaining / allocated < 0.25 ? 'warning' : undefined} />
                {Number(row.pending) > 0 && <p>{fmtDays(row.pending)} pending</p>}
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState title={t("No leave allocation")} body={t("Your leave balances will appear here once HR allocates them.")} icon={<Icon name="calendar" size={20} />} />
      )}
      <footer>
        <span>{t("Next off")}</span>
        <strong>{next ? `${fmtDateShort(next.from_date)} — ${next.leave_type}` : 'No approved leave planned'}</strong>
        {next && <Pill tone={next.status === 'Approved' ? 'success' : 'warning'}>{next.status}</Pill>}
      </footer>
    </section>
  );
}

function NeedsYouCard() {
  const { approvals, notifications, leaveRequests } = useWorkspace();
  const pendingLeave = leaveRequests.find((row) => ['Open', 'Pending'].includes(row.status));
  const items = [
    ...approvals.slice(0, 3).map((row) => ({
      key: `${row.doctype}-${row.id || row.name}`,
      label: `Approval · ${row.kind || row.doctype || 'Request'}`,
      title: row.employee_name ? `${row.employee_name} — ${row.title || 'Request'}` : row.title || 'Approval request',
      meta: row.from_date ? fmtRange(row.from_date, row.to_date) : row.status || 'Pending',
      actions: true,
      tone: 'warning',
    })),
    ...(pendingLeave ? [{
      key: pendingLeave.name,
      label: t("Action · Leave"),
      title: `${pendingLeave.leave_type} request`,
      meta: `${fmtRange(pendingLeave.from_date, pendingLeave.to_date)} · ${pendingLeave.status}`,
      tone: 'info',
    }] : []),
    ...notifications.slice(0, 2).map((row) => ({
      key: row.name,
      label: row.document_type || 'Announcement',
      title: row.subject,
      meta: row.read ? 'Read' : 'Unread',
      tone: row.read ? 'default' : 'info',
    })),
  ].slice(0, 4);

  return (
    <aside className="home-card home-card--needs">
      <header>
        <h2>{t("Needs you")}</h2>
        <span>{items.length}</span>
      </header>
      {items.length ? (
        <div className="home-needs-list">
          {items.map((item) => (
            <div className="home-need" key={item.key}>
              <p>{item.label}</p>
              <strong>{item.title}</strong>
              <span>{item.meta}</span>
              {item.actions && (
                <div>
                  <Link to="/approvals" className="btn btn--indigo btn--sm">{t("Approve")}</Link>
                  <Link to="/approvals" className="btn btn--ghost btn--sm">{t("Reject")}</Link>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title={t("Nothing pending")} body={t("Approvals, acknowledgements and reminders will appear here.")} icon={<Icon name="check" size={20} />} />
      )}
      <footer>
        <span>{t("Announcement")}</span>
        <strong>{notifications[0]?.subject || 'No new company announcements'}</strong>
      </footer>
    </aside>
  );
}

function HolidaysCard() {
  const { holidays } = useWorkspace();
  const rows = holidays.filter((row) => !row.weekly_off).slice(0, 4);

  return (
    <section className="home-card home-card--holidays">
      <header>
        <h2>{t("Upcoming holidays")}</h2>
        <span>{t("Calendar")}</span>
      </header>
      {rows.length ? rows.map((row) => {
        const date = new Date(String(row.holiday_date).replace(' ', 'T'));
        return (
          <div className="home-holiday" key={`${row.holiday_date}-${row.description}`}>
            <div>
              <strong>{Number.isNaN(date.getTime()) ? '—' : String(date.getDate()).padStart(2, '0')}</strong>
              <span>{Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { month: 'short' }).format(date)}</span>
            </div>
            <div>
              <strong>{row.description}</strong>
              <p>{fmtDate(row.holiday_date)}</p>
            </div>
          </div>
        );
      }) : <EmptyState title={t("No holidays listed")} icon={<Icon name="calendar" size={20} />} />}
    </section>
  );
}

const DAY_TONE = {
  approved: 'is-approved',
  pending: 'is-pending',
  none: '',
};

function TeamWeekCard() {
  const { summary, profile } = useWorkspace();
  const team = summary?.team_week;
  const members = team?.members || [];
  // The API caps the grid, so say "5 of 9" rather than implying a 5-person team.
  const total = team?.total_members ?? members.length;
  const dayLabels = (team?.days || []).map((day) =>
    new Date(day).toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 3).toUpperCase(),
  );

  return (
    <section className="home-card home-card--team">
      <header>
        <h2>{t("Your team this week")}</h2>
        <span>
          {profile?.department || team?.department || 'Team'} ·{' '}
          {total > members.length ? `${members.length} of ${total}` : `${total || 0}`} people
        </span>
      </header>
      {members.length ? (
        <>
          <div className="home-team-grid" style={{ '--days': dayLabels.length || 5 }}>
            <div />
            {dayLabels.map((day) => <strong key={day}>{day}</strong>)}
            {members.map((member) => (
              <div className="home-team-row" key={member.employee}>
                <span>{member.employee_name?.split(' ').map((part) => part[0]).join('').slice(0, 2) || initials(member.employee)}</span>
                {(member.days || []).map((state, index) => (
                  <i className={DAY_TONE[state] || ''} key={`${member.employee}-${index}`} />
                ))}
              </div>
            ))}
          </div>
          <div className="home-team-legend">
            <span><i className="is-approved" /> Approved leave</span>
            <span><i className="is-pending" /> Pending</span>
          </div>
        </>
      ) : (
        <EmptyState title={t("No team calendar")} body={t("Team leave will appear once you have access to other employee records.")} icon={<Icon name="people" size={20} />} />
      )}
    </section>
  );
}

export default function Home() {
  const { profile, user, approvals, notifications, leaveRequests, branding } = useWorkspace();
  const name = (profile?.employee_name || user?.full_name || '').split(' ')[0];
  const needsCount = approvals.length + notifications.filter((row) => !row.read).length +
    leaveRequests.filter((row) => ['Open', 'Pending'].includes(row.status)).length;

  return (
    <div className="home-workspace">
      <div className="home-hero">
        <div>
          <h1>{greeting()}{name ? `, ${name}` : ''}</h1>
          <p>{todayLine(needsCount)}</p>
        </div>
        <div className="home-hero__actions">
          <Link to="/leave" className="btn btn--ghost">
            <Icon name="calendar" size={17} /> Apply for leave
          </Link>
          <Link to="/claims" className="btn btn--indigo">
            <Icon name="plus" size={17} /> New request
          </Link>
        </div>
      </div>

      <div className="home-grid">
        <div className="home-grid__main">
          <div className="home-grid__column">
            <PunchCard />
            <HolidaysCard />
          </div>
          <div className="home-grid__column">
            <LeaveBalanceCard />
            <TeamWeekCard />
          </div>
        </div>
        <NeedsYouCard />
      </div>

      <div className="attribution">
         Powered by {branding?.copyright || 'Techsarena HCM'}
      </div>
    </div>
  );
}
