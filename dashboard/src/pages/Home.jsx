import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { useToast } from '../hooks/useToast';
import hr from '../api/hr';
import { Card, Pill, Button, Stat, Meter, EmptyState, Avatar } from '../components/ui';
import { Icon } from '../components/Icon';
import { fmtDate, fmtDays, fmtDuration, fmtMoney, fmtRange, fmtTime, statusTone } from '../api/format';

/* ---------- Punch clock ---------- */
function PunchCard() {
  const { attendance, reload } = useWorkspace();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!attendance) return null;

  const checkedIn = attendance.checked_in;

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
    <Card>
      <div className="row row--between" style={{ alignItems: 'flex-start' }}>
        <Stat
          label={checkedIn ? 'Checked in' : 'Today'}
          value={fmtDuration(attendance.working_seconds)}
          meta={
            attendance.first_in
              ? `Since ${fmtTime(attendance.first_in)}${attendance.shift ? ` · ${attendance.shift}` : ''}`
              : 'No punch recorded yet'
          }
        />
        <Button variant={checkedIn ? 'danger' : 'primary'} onClick={punch} disabled={busy}>
          {busy ? '…' : checkedIn ? 'Check out' : 'Check in'}
        </Button>
      </div>
      {(attendance.status || attendance.late_entry || attendance.early_exit) && (
        <div className="row" style={{ marginTop: 'var(--space-4)', flexWrap: 'wrap' }}>
          {attendance.status && <Pill>{attendance.status}</Pill>}
          {attendance.late_entry && <Pill tone="warning">Late entry</Pill>}
          {attendance.early_exit && <Pill tone="warning">Early exit</Pill>}
        </div>
      )}
    </Card>
  );
}

/* ---------- Leave balances ---------- */
function LeaveBalances() {
  const { leaveBalances } = useWorkspace();
  if (!leaveBalances.length) return null;

  return (
    <Card
      title="Leave balance"
      action={<Link to="/leave" className="btn btn--link">Apply</Link>}
    >
      <div className="stack">
        {leaveBalances.slice(0, 5).map((row) => (
          <div key={row.leave_type}>
            <div className="row row--between small" style={{ marginBottom: 5 }}>
              <span style={{ fontWeight: 500 }}>{row.leave_type}</span>
              <span className="tabular subtle">
                <strong style={{ color: 'var(--ink)' }}>{Number(row.remaining).toFixed(1)}</strong> / {Number(row.allocated).toFixed(1)}
              </span>
            </div>
            <Meter
              value={row.remaining}
              total={row.allocated}
              tone={row.allocated > 0 && row.remaining / row.allocated < 0.25 ? 'warning' : undefined}
            />
            {Number(row.pending) > 0 && (
              <p className="small subtle" style={{ marginTop: 4 }}>{fmtDays(row.pending)} awaiting approval</p>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ---------- Month attendance from workspace_summary ---------- */
function MonthStats() {
  const { summary } = useWorkspace();
  const stats = summary?.attendance_stats;
  if (!stats) return null;
  return (
    <Card title="This month">
      <div className="grid grid--2">
        <Stat label="Present" value={stats.present ?? '—'} />
        <Stat label="On leave" value={stats.on_leave ?? '—'} />
        <Stat label="Late entries" value={stats.late_entry ?? '—'} tone={stats.late_entry ? 'warning' : undefined} />
        <Stat label="Avg hours" value={stats.average_hours ? Number(stats.average_hours).toFixed(1) : '—'} />
      </div>
    </Card>
  );
}

/* ---------- Requests ---------- */
function MyRequests() {
  const { leaveRequests } = useWorkspace();
  return (
    <Card
      title="My leave requests"
      action={<Link to="/leave" className="btn btn--link">See all</Link>}
      flush
    >
      {leaveRequests.length === 0 ? (
        <EmptyState title="No requests" body="Leave you apply for will appear here." icon="◷" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Type</th><th>Dates</th><th className="num">Days</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {leaveRequests.slice(0, 6).map((row) => (
                <tr key={row.name}>
                  <td className="cell-strong">{row.leave_type}</td>
                  <td className="subtle">{fmtRange(row.from_date, row.to_date)}</td>
                  <td className="num">{Number(row.total_leave_days).toFixed(1)}</td>
                  <td><Pill tone={statusTone(row.status)}>{row.status}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ---------- Upcoming ---------- */
function Upcoming() {
  const { holidays, summary } = useWorkspace();
  const nextLeave = summary?.next_leave;
  const rows = holidays.slice(0, 5);

  if (!rows.length && !nextLeave) return null;

  return (
    <Card title="Coming up">
      <div className="stack">
        {nextLeave && (
          <div className="row" style={{ gap: 10 }}>
            <span className="pill pill--primary">Leave</span>
            <div>
              <div style={{ fontWeight: 500 }}>{nextLeave.leave_type}</div>
              <div className="small subtle">{fmtRange(nextLeave.from_date, nextLeave.to_date)}</div>
            </div>
          </div>
        )}
        {rows.map((row) => (
          <div className="row" key={`${row.holiday_date}-${row.description}`} style={{ gap: 10 }}>
            <span className="pill">{row.weekly_off ? 'Weekly off' : 'Holiday'}</span>
            <div className="truncate">
              <div className="truncate" style={{ fontWeight: 500 }}>{row.description}</div>
              <div className="small subtle">{fmtDate(row.holiday_date)}</div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ---------- Latest payslip ---------- */
function LatestPayslip() {
  const { salarySlips } = useWorkspace();
  const slip = salarySlips[0];
  if (!slip) return null;
  return (
    <Card title="Latest payslip" action={<Link to="/salary" className="btn btn--link">All payslips</Link>}>
      <Stat
        label={fmtRange(slip.start_date, slip.end_date)}
        value={fmtMoney(slip.net_pay, slip.currency)}
        meta={`Gross ${fmtMoney(slip.gross_pay, slip.currency)} · Deductions ${fmtMoney(slip.total_deduction, slip.currency)}`}
      />
    </Card>
  );
}

/* ---------- Team this week ---------- */
/* team_week is a Mon–Fri grid: members[].days[] holds one marker per weekday
   ('approved' | 'pending' | 'none'), aligned to team.days[]. */
const DAY_TONE = {
  approved: { bg: 'var(--info-bg)', fg: 'var(--secondary-800)', label: 'L', title: 'On approved leave' },
  pending: { bg: 'var(--warning-bg)', fg: 'var(--warning)', label: '?', title: 'Leave awaiting approval' },
  none: { bg: 'var(--success-bg)', fg: 'var(--success)', label: '·', title: 'Available' },
};

function TeamWeek() {
  const { summary } = useWorkspace();
  const team = summary?.team_week;
  const members = team?.members || [];
  if (!team || !members.length) return null;

  const dayLabels = (team.days || []).map((day) =>
    new Date(day).toLocaleDateString(undefined, { weekday: 'narrow' }),
  );

  return (
    <Card title="Team this week" subtitle={team.department || undefined}>
      <div className="row" style={{ gap: 6, paddingLeft: 34, marginBottom: 6 }}>
        {dayLabels.map((day, i) => (
          <span key={i} className="small subtle" style={{ width: 20, textAlign: 'center', fontWeight: 600 }}>
            {day}
          </span>
        ))}
      </div>
      <div className="stack">
        {members.slice(0, 8).map((member) => (
          <div className="row" key={member.employee} style={{ gap: 8 }}>
            <Avatar name={member.employee_name} size="sm" />
            <div className="row" style={{ gap: 6 }}>
              {(member.days || []).map((marker, i) => {
                const tone = DAY_TONE[marker] || DAY_TONE.none;
                return (
                  <span
                    key={i}
                    title={`${member.employee_name} · ${team.days?.[i] || ''} · ${tone.title}`}
                    style={{
                      width: 20, height: 20, borderRadius: 5, display: 'grid', placeItems: 'center',
                      background: tone.bg, color: tone.fg, fontSize: 10, fontWeight: 700,
                    }}
                  >
                    {tone.label}
                  </span>
                );
              })}
            </div>
            <span className="small truncate" style={{ flex: 1, fontWeight: member.is_self ? 600 : 400 }}>
              {member.employee_name}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ---------- HR overview (can_manage_hr) ---------- */
function HrOverview() {
  const { hrSummary, approvals } = useWorkspace();
  if (!hrSummary) return null;
  return (
    <>
      <div className="grid grid--4">
        <div className="card"><Stat label="Headcount" value={hrSummary.headcount ?? '—'} /></div>
        <div className="card"><Stat label="New this month" value={hrSummary.new_this_month ?? '—'} /></div>
        <div className="card">
          <Stat
            label="Open leave requests"
            value={hrSummary.open_leave_requests ?? '—'}
            tone={hrSummary.open_leave_requests ? 'warning' : undefined}
          />
        </div>
        <div className="card"><Stat label="Payslips this month" value={hrSummary.salary_slips_this_month ?? '—'} /></div>
      </div>
      {approvals.length > 0 && (
        <Card
          title="Waiting on you"
          subtitle={`${approvals.length} request${approvals.length === 1 ? '' : 's'} pending`}
          action={<Link to="/approvals" className="btn btn--primary btn--sm">Open inbox</Link>}
          style={{ marginTop: 'var(--space-4)' }}
        >
          <div className="stack">
            {approvals.slice(0, 4).map((row) => (
              <div className="row" key={`${row.doctype}-${row.id || row.name}`}>
                <Avatar name={row.employee_name} size="sm" />
                <div className="truncate" style={{ flex: 1 }}>
                  <div className="truncate" style={{ fontWeight: 500 }}>{row.employee_name}</div>
                  <div className="small subtle truncate">
                    {[row.title, row.from_date ? fmtRange(row.from_date, row.to_date) : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <Pill tone="warning">{row.kind || 'Pending'}</Pill>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function Home() {
  const { profile, user, capabilities, branding } = useWorkspace();
  const name = (profile?.employee_name || user?.full_name || '').split(' ')[0];
  const ess = capabilities.employee_self_service;

  return (
    <div className="stack">
      <div className="page-head">
        <h1 className="page-head__title">{greeting()}{name ? `, ${name}` : ''}</h1>
        <p className="page-head__sub">
          {profile?.designation ? `${profile.designation}${profile.department ? ` · ${profile.department}` : ''}` : 'Your workspace at a glance'}
        </p>
      </div>

      {capabilities.can_manage_hr && <HrOverview />}

      {ess ? (
        <>
          <div className="grid grid--3">
            <PunchCard />
            <MonthStats />
            <LatestPayslip />
          </div>
          <div className="grid grid--3">
            <LeaveBalances />
            <Upcoming />
            <TeamWeek />
          </div>
          <MyRequests />
        </>
      ) : (
        !capabilities.can_manage_hr && (
          <Card>
            <EmptyState
              title="No self-service on this account"
              body="This login isn't linked to an active Employee record, so there's no personal workspace to show. Use the navigation for the areas you administer."
              icon={<Icon name="people" size={22} />}
            />
          </Card>
        )
      )}

      <div className="attribution">
        {branding?.copyright || 'Techsarena HCM'} · powered by Frappe HRMS
      </div>
    </div>
  );
}
