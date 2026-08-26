import { useMemo, useState } from 'react';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { Async, Avatar, Button, Card, EmptyState, Pill } from '../components/ui';
import { TeamCalendarGrid, TeamCalendarLegend } from '../components/TeamCalendar';
import { ApplyDrawer } from '../components/ApplyLeaveDrawer';
import { Icon } from '../components/Icon';
import { fmtDateShort, fmtRange, isoDate, monthLabel, toDate } from '../api/format';
import { t } from '../api/i18n';

function monthRange(date) {
  const d = toDate(date) || new Date();
  return {
    from: isoDate(new Date(d.getFullYear(), d.getMonth(), 1)),
    to: isoDate(new Date(d.getFullYear(), d.getMonth() + 1, 0)),
  };
}

function shiftRange(from, delta) {
  const d = toDate(from) || new Date();
  return monthRange(new Date(d.getFullYear(), d.getMonth() + delta, 1));
}

const overlapsToday = (row) => {
  const today = isoDate(new Date());
  return row.from_date <= today && today <= (row.to_date || row.from_date);
};

/** The day inside the range with the most people away — the "thin cover"
 *  warning. Computed from the rows themselves rather than assumed. */
function thinnestCover(rows, from, to) {
  const counts = new Map();
  for (const row of rows) {
    const start = row.from_date < from ? from : row.from_date;
    const end = (row.to_date || row.from_date) > to ? to : (row.to_date || row.from_date);
    for (let d = new Date(`${start}T00:00:00`); isoDate(d) <= end; d.setDate(d.getDate() + 1)) {
      const key = isoDate(d);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  let peak = null;
  for (const [day, n] of counts) {
    if (!peak || n > peak.count) peak = { day, count: n };
  }
  return peak;
}

export default function LeaveTeamCalendar() {
  const { profile } = useWorkspace();
  const [range, setRange] = useState(() => monthRange(new Date()));
  const [department, setDepartment] = useState('all');
  const [applyOpen, setApplyOpen] = useState(false);

  const state = useAsync(
    ({ signal }) => hr.teamCalendar(range.from, range.to, { signal }),
    [range.from, range.to],
  );

  const data = state.data;

  // Rows are assembled before filtering so the department list stays stable
  // while a filter is applied.
  const allRows = useMemo(() => {
    if (!data) return [];
    const own = (data.own_leave || []).map((row) => ({
      ...row,
      employee: data.employee || row.employee || 'me',
      employee_name: profile?.employee_name || 'You',
      department: row.department || profile?.department || null,
    }));
    return [...(data.team_leave || []), ...own];
  }, [data, profile]);

  const departments = useMemo(() => {
    const set = new Set(allRows.map((r) => r.department).filter(Boolean));
    return [...set].sort();
  }, [allRows]);

  const rows = useMemo(
    () => (department === 'all' ? allRows : allRows.filter((r) => r.department === department)),
    [allRows, department],
  );

  return (
    <div className="stack">
      <div className="row row--between page-head" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <div>
          <h1 className="page-head__title">{t("Team calendar")}</h1>
          <p className="page-head__sub">{t("Who is away this month, and where cover runs thin")}</p>
        </div>

        <div className="row" style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          {departments.length > 0 && (
            <select
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              style={{ width: 'auto', minWidth: 150 }}
              aria-label={t("Filter by department")}
            >
              <option value="all">{t("All departments")}</option>
              {departments.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          )}

          <div className="row" style={{ gap: 4 }}>
            <Button size="icon" onClick={() => setRange(shiftRange(range.from, -1))} aria-label={t("Previous month")}>
              <Icon name="chevronLeft" size={15} />
            </Button>
            <span style={{ fontWeight: 600, minWidth: 116, textAlign: 'center' }}>
              {monthLabel(range.from)}
            </span>
            <Button size="icon" onClick={() => setRange(shiftRange(range.from, 1))} aria-label={t("Next month")}>
              <Icon name="chevronRight" size={15} />
            </Button>
          </div>

          <Button variant="primary" onClick={() => setApplyOpen(true)}>
            <Icon name="plus" size={15} /> Request time off
          </Button>
        </div>
      </div>

      <Async state={state} rows={6}>
        {() => {
          const away = rows.filter(overlapsToday);
          const own = rows.filter((r) => r.employee === (data.employee || 'me'));
          const peak = thinnestCover(rows, range.from, range.to);
          const headcount = new Set(rows.map((r) => r.employee)).size;

          return (
            <>
              <Card
                title={`${headcount || 0} ${headcount === 1 ? 'person' : 'people'} · ${monthLabel(range.from)}`}
                subtitle={data.holiday_list ? `Holiday list · ${data.holiday_list}` : undefined}
                action={<TeamCalendarLegend />}
              >
                {rows.length === 0 ? (
                  <EmptyState
                    title={department === 'all' ? 'Nobody is away this month' : `Nobody in ${department} is away`}
                    body={t("Approved and pending leave appears on this grid.")}
                    icon="◷"
                  />
                ) : (
                  <TeamCalendarGrid
                    from={range.from}
                    to={range.to}
                    rows={rows}
                    holidays={data.holidays || []}
                    currentEmployee={data.employee}
                    approverEmployee={data.reports_to}
                  />
                )}
              </Card>

              <div className="grid grid--3">
                <Card
                  title={t("Away today")}
                  action={<span className="pill">{away.length} of {headcount || 0} out</span>}
                >
                  {away.length === 0 ? (
                    <p className="small subtle">{t("Everyone is in today.")}</p>
                  ) : (
                    <div className="stack">
                      {away.map((row, i) => (
                        <div className="row" key={row.name || i}>
                          <Avatar name={row.employee_name} size="sm" />
                          <div className="truncate">
                            <div className="truncate" style={{ fontWeight: 500 }}>{row.employee_name}</div>
                            <div className="small subtle truncate">
                              {row.leave_type} — back {fmtDateShort(row.to_date)}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                <Card
                  title={t("Your request")}
                  action={own.length > 0 ? <Pill tone={own[0].status === 'Open' ? 'warning' : 'success'}>{own[0].status}</Pill> : null}
                >
                  {own.length === 0 ? (
                    <p className="small subtle">{t("You have no leave booked this month.")}</p>
                  ) : (
                    <div className="stack">
                      {own.map((row) => (
                        <div key={row.name}>
                          <div style={{ fontWeight: 500 }}>{fmtRange(row.from_date, row.to_date)}</div>
                          <div className="small subtle">{row.leave_type}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                <Card
                  title={t("Thin cover")}
                  action={peak && peak.count > 1 ? <Pill tone="warning">{fmtDateShort(peak.day)}</Pill> : null}
                >
                  {!peak || peak.count < 2 ? (
                    <p className="small subtle">{t("No day this month has more than one person away.")}</p>
                  ) : (
                    <p className="small">
                      <strong>{peak.count} people</strong> are away on {fmtDateShort(peak.day)}
                      {department !== 'all' ? ` in ${department}` : ''} — the thinnest cover this month.
                    </p>
                  )}
                </Card>
              </div>
            </>
          );
        }}
      </Async>

      <ApplyDrawer open={applyOpen} onClose={() => setApplyOpen(false)} onDone={state.reload} />
    </div>
  );
}
