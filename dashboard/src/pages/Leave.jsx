import { useMemo, useState } from 'react';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { Avatar, Button, Card, EmptyState, Pill, SearchInput } from '../components/ui';
import { exportCsv } from '../components/DataTable';
import { ApplyDrawer } from '../components/ApplyLeaveDrawer';
import { LeaveDetailDrawer } from '../components/LeaveDetailDrawer';
import { Icon } from '../components/Icon';
import { TeamCalendarGrid, TeamCalendarLegend } from '../components/TeamCalendar';
import { fmtDateShort, fmtRange, isoDate, statusTone, toDate } from '../api/format';

/** Leave types map onto the same four swatches the team calendar uses, so a
 *  type reads identically on both surfaces. */
function leaveTone(leaveType) {
  const s = String(leaveType || '').toLowerCase();
  if (s.includes('privilege') || s.includes('earned') || s.includes('annual')) return 'privilege';
  if (s.includes('sick')) return 'sick';
  if (s.includes('casual')) return 'casual';
  return 'other';
}

/** "Privilege Leave" reads as "PRIVILEGE" on a tile — the word "leave" is
 *  redundant on a leave screen and costs the label a line at narrow widths. */
function shortType(leaveType) {
  return String(leaveType || '').replace(/\s*leaves?$/i, '').trim() || leaveType;
}

/** Balances are halves at the finest; 9 stays "9" rather than "9.0". */
function fmtBalance(value) {
  const num = Number(value) || 0;
  return num % 1 ? num.toFixed(1) : String(num);
}

/* A Leave Application is Draft while docstatus is 0 and its status is still
   Open — HRMS reuses "Open" for both, so the saved-but-unsubmitted state has
   to be read off docstatus rather than status alone. */
function displayStatus(row) {
  if (row.docstatus === 2) return 'Cancelled';
  if (row.docstatus === 0 && String(row.status) === 'Open') return 'Draft';
  return String(row.status || 'Open') === 'Open' ? 'Pending' : String(row.status);
}

/** Financial years present in the data, newest first. April-start FY, matching
 *  the HRMS default; derived from the rows so an empty year never appears. */
function fyOf(value) {
  const d = toDate(value);
  if (!d) return null;
  const start = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return { key: String(start), label: `FY ${start}–${String(start + 1).slice(2)}` };
}

const FILTERS = ['All', 'Pending', 'Approved', 'Rejected', 'Cancelled', 'Draft'];

/** Live requests sort above settled ones; everything else falls back to date. */
const RANK = { Pending: 0, Draft: 1 };

export default function Leave() {
  const { leaveBalances, leaveRequests, holidays } = useWorkspace();
  const [applyOpen, setApplyOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [view, setView] = useState('list');
  const [filter, setFilter] = useState('All');
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [fy, setFy] = useState('all');

  const rows = useMemo(
    () => leaveRequests.map((row) => ({ ...row, _status: displayStatus(row), _fy: fyOf(row.from_date) })),
    [leaveRequests],
  );

  const leaveTypes = useMemo(
    () => [...new Set(rows.map((r) => r.leave_type).filter(Boolean))].sort(),
    [rows],
  );

  const years = useMemo(() => {
    const seen = new Map();
    for (const row of rows) if (row._fy) seen.set(row._fy.key, row._fy.label);
    return [...seen].sort((a, b) => b[0].localeCompare(a[0]));
  }, [rows]);

  // Type, year and search narrow the set the status chips count against, so a
  // chip's number always matches what clicking it shows.
  const scoped = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (type !== 'all' && row.leave_type !== type) return false;
      if (fy !== 'all' && row._fy?.key !== fy) return false;
      if (q && !`${row.leave_type} ${row.description || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, type, fy, query]);

  const counts = useMemo(() => {
    const map = { All: scoped.length };
    for (const row of scoped) map[row._status] = (map[row._status] || 0) + 1;
    return map;
  }, [scoped]);

  /* Newest first, except that a request still needing something from you or
     your approver floats above settled history — the list's job is to surface
     what is live, not to be a strict date ledger. */
  const visible = useMemo(
    () => (filter === 'All' ? scoped : scoped.filter((r) => r._status === filter))
      .slice()
      .sort((a, b) => {
        const ra = RANK[a._status] ?? 2;
        const rb = RANK[b._status] ?? 2;
        if (ra !== rb) return ra - rb;
        return String(b.from_date).localeCompare(String(a.from_date));
      }),
    [scoped, filter],
  );

  const takenThisFy = useMemo(() => {
    const current = fyOf(new Date())?.key;
    return rows
      .filter((r) => r._fy?.key === current && ['Approved', 'Pending'].includes(r._status))
      .reduce((sum, r) => sum + Number(r.total_leave_days || 0), 0);
  }, [rows]);

  const csvColumns = [
    { key: 'leave_type', header: 'Type' },
    { key: 'from_date', header: 'From' },
    { key: 'to_date', header: 'To' },
    { key: 'total_leave_days', header: 'Days' },
    { key: '_status', header: 'Status' },
    { key: 'leave_approver_name', header: 'Approver' },
    { key: 'description', header: 'Reason' },
  ];

  return (
    <div className="stack">
      <div className="row row--between page-head" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <div>
          <h1 className="page-head__title">Leave</h1>
          <p className="page-head__sub">Your balance and every request you have made</p>
        </div>

        <div className="row" style={{ gap: 'var(--space-3)' }}>
          <div className="segmented" role="tablist" aria-label="View">
            {['calendar', 'list'].map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={view === id}
                className={`segmented__btn${view === id ? ' is-active' : ''}`}
                onClick={() => setView(id)}
              >
                {id === 'calendar' ? 'Calendar' : 'List'}
              </button>
            ))}
          </div>
          <Button variant="primary" onClick={() => setApplyOpen(true)}>
            <Icon name="plus" size={15} /> Request time off
          </Button>
        </div>
      </div>

      {/* ---- Balance tiles ----
           Deliberately just the figure: how many days are left, out of how
           many. The breakdown behind it lives in the list below, so the tiles
           stay scannable at a glance. */}
      <div className="grid grid--auto">
        {leaveBalances.map((row) => (
          <div className="card balance-tile" key={row.leave_type}>
            <div className="balance-tile__label">{shortType(row.leave_type)}</div>
            <div className="balance-tile__figure">
              <span className="balance-tile__value">{fmtBalance(row.remaining)}</span>
              <span className="balance-tile__of">of {fmtBalance(row.allocated)} left</span>
            </div>
          </div>
        ))}

        {/* Totals the per-type tiles cannot show: what this year has cost. */}
        <div className="card balance-tile">
          <div className="balance-tile__label">Taken this FY</div>
          <div className="balance-tile__figure">
            <span className="balance-tile__value">{fmtBalance(takenThisFy)}</span>
            <span className="balance-tile__of">days</span>
          </div>
        </div>
      </div>

      {view === 'calendar' ? (
        <LeaveCalendar rows={rows} holidays={holidays} onOpen={setDetail} />
      ) : (
        <Card flush>
          {/* ---- Filter bar ---- */}
          <div className="leave-toolbar">
            <div className="chips" role="tablist" aria-label="Filter by status">
              {FILTERS.filter((f) => f === 'All' || counts[f]).map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={filter === f}
                  className={`chip${filter === f ? ' is-active' : ''}${f !== 'All' ? ` chip--${statusTone(f === 'Pending' ? 'open' : f)}` : ''}`}
                  onClick={() => setFilter(f)}
                >
                  {f}
                  {counts[f] ? <span className="chip__count">{counts[f]}</span> : null}
                </button>
              ))}
            </div>

            <div className="leave-toolbar__right">
              <SearchInput value={query} onChange={setQuery} placeholder="Search reason" />
              <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by leave type">
                <option value="all">All types</option>
                {leaveTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              {years.length > 1 && (
                <select value={fy} onChange={(e) => setFy(e.target.value)} aria-label="Filter by year">
                  <option value="all">All years</option>
                  {years.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                </select>
              )}
            </div>
          </div>

          {/* ---- Request list ---- */}
          {visible.length === 0 ? (
            <EmptyState
              icon="▦"
              title={rows.length ? 'Nothing matches these filters' : 'No leave requests'}
              body={rows.length ? 'Clear a filter to see the rest of your history.' : 'Requests you submit will be listed here.'}
              action={rows.length
                ? <Button onClick={() => { setFilter('All'); setQuery(''); setType('all'); setFy('all'); }}>Clear filters</Button>
                : <Button variant="primary" onClick={() => setApplyOpen(true)}>Request time off</Button>}
            />
          ) : (
            <div className="table-wrap">
              <table className="table leave-table">
                <thead>
                  <tr>
                    <th>Leave type</th>
                    <th>Dates</th>
                    <th className="num">Days</th>
                    <th>Status</th>
                    <th>Approver</th>
                    <th>Applied</th>
                    <th aria-label="Open" style={{ width: 32 }} />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <tr key={row.name} onClick={() => setDetail(row)} className="is-clickable">
                      <td>
                        <div className="leave-cell">
                          <span className={`leave-cell__stripe leave-cell__stripe--${leaveTone(row.leave_type)}`} />
                          <div>
                            <div className="cell-strong">{row.leave_type}</div>
                            {/* A draft is called out here rather than only in the
                                status column — it is the reason the row has no
                                approver, and that should not read as missing data. */}
                            <div className="small subtle truncate leave-cell__sub">
                              {row._status === 'Draft'
                                ? 'Draft · not submitted'
                                : row.description || '—'}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>{fmtRange(row.from_date, row.to_date)}</td>
                      <td className="num">{Number(row.total_leave_days).toFixed(1)}</td>
                      <td><Pill tone={statusTone(row._status === 'Pending' ? 'open' : row._status)}>{row._status}</Pill></td>
                      <td>
                        {row.leave_approver_name ? (
                          <span className="row" style={{ gap: 8 }}>
                            <Avatar name={row.leave_approver_name} size="sm" />
                            <span className="truncate">{row.leave_approver_name}</span>
                          </span>
                        ) : <span className="subtle">—</span>}
                      </td>
                      <td className="subtle">{fmtDateShort(row.creation)}</td>
                      <td className="subtle" style={{ textAlign: 'right' }}>
                        <Icon name="chevronRight" size={14} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <footer className="leave-foot">
            <span className="small subtle">
              Showing {visible.length} of {rows.length}
              {/* The bootstrap payload caps history at 12 rows; saying so keeps
                  an older request's absence from reading as data loss. */}
              {rows.length >= 12 ? ' most recent requests' : ` request${rows.length === 1 ? '' : 's'}`}
            </span>
            <Button size="sm" onClick={() => exportCsv('my-leave', csvColumns, visible)}>
              <Icon name="download" size={14} /> Export CSV
            </Button>
          </footer>
        </Card>
      )}

      <ApplyDrawer open={applyOpen} onClose={() => setApplyOpen(false)} />
      <LeaveDetailDrawer row={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

/* ---------- Calendar view ----------
   Reuses the team-calendar grid with a single row — your own leave — so the
   two surfaces render a month identically. */
function LeaveCalendar({ rows, holidays, onOpen }) {
  const [month, setMonth] = useState(() => new Date());

  const range = useMemo(() => ({
    from: isoDate(new Date(month.getFullYear(), month.getMonth(), 1)),
    to: isoDate(new Date(month.getFullYear(), month.getMonth() + 1, 0)),
  }), [month]);

  const inMonth = useMemo(
    () => rows.filter((r) => r._status !== 'Cancelled' && r._status !== 'Draft'
      && String(r.from_date) <= range.to && String(r.to_date || r.from_date) >= range.from),
    [rows, range],
  );

  const label = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(month);

  return (
    <Card
      title={label}
      subtitle={`${inMonth.length} request${inMonth.length === 1 ? '' : 's'} this month`}
      action={
        <div className="row" style={{ gap: 'var(--space-3)' }}>
          <TeamCalendarLegend />
          <div className="row" style={{ gap: 4 }}>
            <Button size="icon" aria-label="Previous month"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
              <Icon name="chevronLeft" size={15} />
            </Button>
            <Button size="icon" aria-label="Next month"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
              <Icon name="chevronRight" size={15} />
            </Button>
          </div>
        </div>
      }
    >
      {inMonth.length === 0 ? (
        <EmptyState icon="▦" title="No leave this month" body="Approved and pending leave appears on this grid." />
      ) : (
        <>
          <TeamCalendarGrid
            rows={inMonth.map((r) => ({ ...r, employee: 'me', employee_name: 'You' }))}
            from={range.from}
            to={range.to}
            holidays={holidays}
          />
          {/* The grid draws bars but exposes no click target of its own, so the
              month's requests are listed under it to stay reachable. */}
          <div className="leave-monthlist">
            {inMonth.map((row) => (
              <button type="button" key={row.name} className="leave-monthlist__row" onClick={() => onOpen(row)}>
                <span className={`leave-cell__stripe leave-cell__stripe--${leaveTone(row.leave_type)}`} />
                <span className="cell-strong">{row.leave_type}</span>
                <span className="subtle">{fmtRange(row.from_date, row.to_date)}</span>
                <Pill tone={statusTone(row._status === 'Pending' ? 'open' : row._status)}>{row._status}</Pill>
              </button>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
