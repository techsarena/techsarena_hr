import { useCallback, useMemo, useState } from 'react';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { Async, Button, Card, Drawer, Field, Pill, Tabs } from '../components/ui';
import { DataTable, exportCsv } from '../components/DataTable';
import { AttendanceMonth, AttendanceMonthLegend } from '../components/AttendanceMonth';
import PunchHero from '../components/PunchHero';
import { Icon } from '../components/Icon';
import {
  fmtDate, fmtDateShort, fmtNumber, fmtRange, fmtTime,
  isoDate, monthKey, monthLabel, shiftMonth, statusTone, toDate,
} from '../api/format';

/* ---------- Regularisation drawer ---------- */
function RegulariseDrawer({ open, onClose, prefill, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ from_date: '', to_date: '', reason: 'Work From Home', explanation: '' });
  const [busy, setBusy] = useState(false);

  // Reset when the drawer reopens against a different day.
  const key = prefill?.date || 'blank';
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    setForm({
      from_date: prefill?.date || isoDate(new Date()),
      to_date: prefill?.date || isoDate(new Date()),
      reason: 'Work From Home',
      explanation: '',
    });
  }

  const submit = async () => {
    setBusy(true);
    try {
      await hr.requestRegularisation(form);
      toast.success('Regularisation requested.');
      onClose();
      onDone?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Request regularisation"
      subtitle="Goes to your approver as an Attendance Request"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !form.from_date || !form.to_date}>
            {busy ? 'Sending…' : 'Send request'}
          </Button>
        </>
      }
    >
      <div className="fields">
        <div className="grid grid--2">
          <Field label="From">
            <input type="date" value={form.from_date} onChange={(e) => setForm({ ...form, from_date: e.target.value })} />
          </Field>
          <Field label="To">
            <input type="date" value={form.to_date} onChange={(e) => setForm({ ...form, to_date: e.target.value })} />
          </Field>
        </div>
        <Field label="Reason">
          <select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
            <option>Work From Home</option>
            <option>On Duty</option>
          </select>
        </Field>
        <Field label="Explanation" hint="What happened on these days?">
          <textarea
            rows={4}
            value={form.explanation}
            onChange={(e) => setForm({ ...form, explanation: e.target.value })}
          />
        </Field>
      </div>
    </Drawer>
  );
}

/* ---------- Shift change drawer ---------- */
function ShiftDrawer({ open, onClose, onDone }) {
  const toast = useToast();
  const shifts = useAsync(({ signal }) => hr.shiftTypes({ signal }), [], { immediate: open });
  const [form, setForm] = useState({ shift_type: '', from_date: isoDate(new Date()), to_date: isoDate(new Date()) });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await hr.requestShiftChange(form);
      toast.success('Shift change requested.');
      onClose();
      onDone?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const options = shifts.data || [];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Request a shift change"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !form.shift_type}>
            {busy ? 'Sending…' : 'Send request'}
          </Button>
        </>
      }
    >
      <div className="fields">
        <Field label="Shift">
          <select value={form.shift_type} onChange={(e) => setForm({ ...form, shift_type: e.target.value })}>
            <option value="">Select a shift…</option>
            {options.map((shift) => (
              <option key={shift.name} value={shift.name}>
                {shift.name}
                {shift.start_time && shift.end_time ? ` (${shift.start_time} – ${shift.end_time})` : ''}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid--2">
          <Field label="From">
            <input type="date" value={form.from_date} onChange={(e) => setForm({ ...form, from_date: e.target.value })} />
          </Field>
          <Field label="To">
            <input type="date" value={form.to_date} onChange={(e) => setForm({ ...form, to_date: e.target.value })} />
          </Field>
        </div>
      </div>
    </Drawer>
  );
}

/** "AUGUST SO FAR · 1–7" — the eyebrow the summary card wears. The range ends
 *  on the last day actually recorded, so a past month reads 1–31 while the
 *  current one stops at today. */
function monthSoFarLabel(month, monthStart, days) {
  const name = monthLabel(month).replace(/\s+\d{4}$/, '');
  const last = days.length ? toDate(days[days.length - 1].attendance_date) : null;
  const start = toDate(monthStart || month);
  if (!last || !start) return `${name} so far`;
  return `${name} so far · ${start.getDate()}–${last.getDate()}`;
}

/** Decimal hours as "8h 24m" — the same voice as the punch clock. */
function fmtHours(hours) {
  const total = Math.round(Number(hours) * 60);
  if (!Number.isFinite(total) || total <= 0) return '—';
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
}

export default function Attendance() {
  const [month, setMonth] = useState(() => monthKey());
  const [view, setView] = useState('calendar');
  const [regularise, setRegularise] = useState(null);
  const [shiftOpen, setShiftOpen] = useState(false);

  const state = useAsync(({ signal }) => hr.attendanceMonth(month, { signal }), [month]);
  const reload = useCallback(() => state.reload(), [state]);

  const columns = useMemo(
    () => [
      {
        key: 'attendance_date',
        header: 'Date',
        render: (row) => <span className="cell-strong">{fmtDate(row.attendance_date)}</span>,
        sortValue: (row) => row.attendance_date,
      },
      {
        key: 'status',
        header: 'Status',
        render: (row) => (row.status ? <Pill tone={statusTone(row.status)}>{row.status}</Pill> : '—'),
      },
      { key: 'in_time', header: 'In', render: (row) => (row.in_time ? fmtTime(row.in_time) : '—') },
      { key: 'out_time', header: 'Out', render: (row) => (row.out_time ? fmtTime(row.out_time) : '—') },
      {
        key: 'working_hours',
        header: 'Hours',
        align: 'right',
        render: (row) => (row.working_hours ? fmtNumber(row.working_hours) : '—'),
        sortValue: (row) => Number(row.working_hours) || 0,
      },
      { key: 'shift', header: 'Shift', render: (row) => row.shift || '—' },
      {
        key: 'flags',
        header: 'Flags',
        sortable: false,
        render: (row) => (
          <div className="row" style={{ gap: 4 }}>
            {row.late_entry ? <Pill tone="warning">Late</Pill> : null}
            {row.early_exit ? <Pill tone="warning">Early</Pill> : null}
          </div>
        ),
        exportValue: (row) => [row.late_entry ? 'Late' : '', row.early_exit ? 'Early' : ''].filter(Boolean).join(' '),
      },
    ],
    [],
  );

  return (
    <div className="stack">
      <div className="row row--between page-head" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <div>
          <h1 className="page-head__title">Attendance &amp; shifts</h1>
          <p className="page-head__sub">Your punches, your shifts, and anything needing a correction</p>
        </div>
        <div className="row" style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <div className="row" style={{ gap: 4 }}>
            <Button size="icon" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">
              <Icon name="chevronLeft" size={15} />
            </Button>
            <span style={{ fontWeight: 600, minWidth: 116, textAlign: 'center' }}>{monthLabel(month)}</span>
            <Button size="icon" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">
              <Icon name="chevronRight" size={15} />
            </Button>
          </div>
          <Button onClick={() => setRegularise({ date: isoDate(new Date()) })}>Regularise</Button>
          <Button variant="primary" onClick={() => setShiftOpen(true)}>
            <Icon name="plus" size={15} /> Request shift change
          </Button>
        </div>
      </div>

      <Async state={state} rows={6}>
        {(data) => {
          const days = data.days || [];
          const summary = data.summary || {};
          const needsAction = data.needs_action || [];
          const requests = data.requests || [];
          const upcoming = data.upcoming_shifts || [];

          return (
            <>
              <PunchHero today={data.today} defaultShift={data.default_shift} onDone={reload} />

              <div className="split">
                <Card flush>
                  <div className="row row--between" style={{ padding: 'var(--space-4) var(--space-5) 0', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
                    <Tabs
                      value={view}
                      onChange={setView}
                      items={[
                        { id: 'calendar', label: monthLabel(month) },
                        { id: 'ledger', label: 'Ledger', count: days.length },
                      ]}
                    />
                    {view === 'ledger' ? (
                      <Button size="sm" onClick={() => exportCsv(`attendance-${month}`, columns, days)}>
                        <Icon name="download" size={14} /> CSV
                      </Button>
                    ) : (
                      <AttendanceMonthLegend />
                    )}
                  </div>
                  <div style={{ padding: '0 var(--space-5) var(--space-5)' }}>
                    {view === 'calendar' ? (
                      <AttendanceMonth
                        month={month}
                        days={days}
                        holidays={data.holidays || []}
                        needsAction={needsAction}
                        onPick={(date) => setRegularise({ date })}
                      />
                    ) : (
                      <DataTable
                        columns={columns}
                        rows={days}
                        rowKey={(row) => String(row.attendance_date)}
                        initialSort={{ key: 'attendance_date', dir: 'desc' }}
                        emptyTitle="No attendance in this month"
                        maxHeight="60vh"
                      />
                    )}
                  </div>
                </Card>

                <div className="split__rail">
                  <Card
                    title={monthSoFarLabel(month, data.month_start, days)}
                    className="card--eyebrow"
                    action={
                      summary.average_hours
                        ? <span className="stat-aside tabular">{fmtHours(summary.average_hours)} avg</span>
                        : null
                    }
                  >
                    <div className="row" style={{ gap: 'var(--space-6)', flexWrap: 'wrap' }}>
                      <div>
                        <div className="stat__value" style={{ fontSize: 22 }}>{summary.days_present ?? 0}</div>
                        <div className="stat__label">Present</div>
                      </div>
                      <div>
                        <div className="stat__value" style={{ fontSize: 22 }}>{summary.work_from_home ?? 0}</div>
                        <div className="stat__label">WFH</div>
                      </div>
                      <div>
                        <div className="stat__value" style={{ fontSize: 22, color: summary.on_leave ? 'var(--warning)' : undefined }}>
                          {summary.on_leave ?? 0}
                        </div>
                        <div className="stat__label">On leave</div>
                      </div>
                    </div>
                  </Card>

                  {needsAction.length > 0 && (
                    <Card
                      title="Needs your action"
                      action={<Pill tone="danger">{needsAction.length}</Pill>}
                    >
                      <div className="stack">
                        {needsAction.map((row) => (
                          <div className="callout callout--danger" key={row.date} style={{ display: 'block' }}>
                            <div style={{ fontWeight: 600 }}>{row.reason} · {fmtDateShort(row.date)}</div>
                            <p className="small" style={{ marginTop: 3 }}>
                              {row.in_time ? `Checked in ${fmtTime(row.in_time)}, no closing punch.` : 'No closing punch recorded.'}
                            </p>
                            <Button
                              variant="primary"
                              size="sm"
                              style={{ marginTop: 8 }}
                              onClick={() => setRegularise({ date: row.date })}
                            >
                              Regularise this day
                            </Button>
                          </div>
                        ))}
                      </div>
                    </Card>
                  )}

                  <Card title="Your shifts" action={<span className="small subtle">Next 7 days</span>}>
                    {upcoming.length === 0 ? (
                      <p className="small subtle">No scheduled shifts in the next week.</p>
                    ) : (
                      <div className="stack">
                        {upcoming.map((row) => (
                          <div className="row row--between" key={row.date}>
                            <div className="truncate">
                              <div className="small" style={{ fontWeight: 600 }}>{fmtDateShort(row.date)}</div>
                              {row.holiday ? null : (
                                <div className="small subtle truncate">
                                  {row.shift?.shift_type || 'No shift assigned'}
                                </div>
                              )}
                            </div>
                            {row.holiday ? (
                              <Pill tone="warning">
                                {row.weekly_off
                                  ? 'Weekly off'
                                  : `Holiday${row.holiday.description ? ` · ${row.holiday.description}` : ''}`}
                              </Pill>
                            ) : row.shift?.start_time && row.shift?.end_time ? (
                              <span className="small subtle tabular">
                                {String(row.shift.start_time).slice(0, 5)} – {String(row.shift.end_time).slice(0, 5)}
                              </span>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>

                  <Card title="Requests">
                    {requests.length === 0 ? (
                      <p className="small subtle">No regularisation or shift requests open.</p>
                    ) : (
                      <div className="stack">
                        {requests.map((row) => (
                          <div className="row row--between" key={row.name}>
                            <div className="truncate">
                              <div className="small truncate" style={{ fontWeight: 600 }}>
                                {row.kind || 'Request'} · {fmtRange(row.from_date, row.to_date)}
                              </div>
                              <div className="small subtle truncate">{row.detail || row.explanation || '—'}</div>
                            </div>
                            <Pill tone={statusTone(row.status)}>{row.status || 'Pending'}</Pill>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                </div>
              </div>
            </>
          );
        }}
      </Async>

      <RegulariseDrawer
        open={Boolean(regularise)}
        prefill={regularise}
        onClose={() => setRegularise(null)}
        onDone={reload}
      />
      <ShiftDrawer open={shiftOpen} onClose={() => setShiftOpen(false)} onDone={reload} />
    </div>
  );
}
