import { useMemo, useState } from 'react';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { useWorkspace } from '../hooks/WorkspaceContext';
import {
  Async, Button, Card, Drawer, EmptyState, Field, FieldRow, Meter, Pill, SearchInput, Stat,
} from '../components/ui';
import { Icon } from '../components/Icon';
import { fmtDate, fmtDays, fmtMoney, isoDate, statusTone } from '../api/format';

/* Clearance progress is derived from the real HRMS Task rows behind each
   separation activity — nothing here invents a status the backend can't back. */
function progressOf(record) {
  const total = record.activities_total || 0;
  const done = record.activities_done || 0;
  return { total, done, percent: total ? Math.round((done / total) * 100) : 0 };
}

/* ---------- Start a separation ---------- */
function StartDrawer({ open, directory, templates, onClose, onDone }) {
  const toast = useToast();
  const today = isoDate(new Date());
  const [form, setForm] = useState({
    employee: '',
    resignation_letter_date: today,
    boarding_begins_on: today,
    relieving_date: '',
    reason_for_leaving: '',
    employee_separation_template: '',
  });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await hr.startSeparation({
        ...form,
        employee_separation_template: form.employee_separation_template || undefined,
        relieving_date: form.relieving_date || undefined,
      });
      toast.success('Separation started.');
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
      title="Start a separation"
      subtitle="Creates the clearance checklist as real project tasks"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !form.employee}>
            {busy ? 'Starting…' : 'Start separation'}
          </Button>
        </>
      }
    >
      <div className="fields">
        <Field label="Employee">
          <select
            value={form.employee}
            onChange={(e) => setForm({ ...form, employee: e.target.value })}
          >
            <option value="">Select an employee…</option>
            {directory.map((row) => (
              <option key={row.name} value={row.name}>
                {row.employee_name} — {row.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Checklist template" hint="Drives the clearance activities">
          <select
            value={form.employee_separation_template}
            onChange={(e) => setForm({ ...form, employee_separation_template: e.target.value })}
          >
            <option value="">No template</option>
            {templates.map((row) => (
              <option key={row.name} value={row.name}>{row.name}</option>
            ))}
          </select>
        </Field>

        <div className="grid grid--2">
          <Field label="Resignation date">
            <input
              type="date"
              value={form.resignation_letter_date}
              onChange={(e) => setForm({ ...form, resignation_letter_date: e.target.value })}
            />
          </Field>
          <Field label="Clearance begins">
            <input
              type="date"
              value={form.boarding_begins_on}
              onChange={(e) => setForm({ ...form, boarding_begins_on: e.target.value })}
            />
          </Field>
        </div>

        <Field label="Last working day" hint="Can be set later, before completing">
          <input
            type="date"
            value={form.relieving_date}
            onChange={(e) => setForm({ ...form, relieving_date: e.target.value })}
          />
        </Field>

        <Field label="Reason for leaving">
          <textarea
            rows={3}
            value={form.reason_for_leaving}
            onChange={(e) => setForm({ ...form, reason_for_leaving: e.target.value })}
          />
        </Field>
      </div>
    </Drawer>
  );
}

/* ---------- Settlement ---------- */
function Settlement({ settlement, currency, onRaiseGratuity }) {
  if (!settlement) return null;
  const { leave_encashment: leave, funds, gratuity, loans } = settlement;

  return (
    <Card title="Final settlement">
      {/* Every figure here is computed, never posted — paying it out stays a
          deliberate payroll action. The banner keeps that contract visible. */}
      <p className="small subtle" style={{ marginTop: 0 }}>
        Estimates for reconciliation. Nothing on this screen posts a payment.
      </p>

      <FieldRow
        label="Leave encashment"
        value={leave?.total_days ? `${fmtDays(leave.total_days)} · ${fmtMoney(leave.estimated_amount, currency)}` : '—'}
      />
      <FieldRow label="Fund balances" value={funds?.total ? fmtMoney(funds.total, currency) : '—'} />
      <FieldRow
        label="Gratuity"
        value={
          gratuity?.available
            ? gratuity.already_raised
              ? `${fmtMoney(gratuity.amount, currency)} · ${gratuity.status}`
              : fmtMoney(gratuity.amount, currency)
            : gratuity?.reason || '—'
        }
      />
      <FieldRow
        label="Loans outstanding"
        value={loans?.total ? `− ${fmtMoney(loans.total, currency)}` : '—'}
      />

      <div className="divider" style={{ margin: 'var(--space-4) 0' }} />
      <Stat
        label="Net settlement"
        value={fmtMoney(settlement.net_settlement, currency)}
        meta={`${fmtMoney(settlement.total_payable, currency)} payable less ${fmtMoney(settlement.total_recoverable, currency)} recoverable`}
      />

      {(settlement.pending_items || []).length > 0 && (
        <p className="small" style={{ color: 'var(--warning)', marginTop: 'var(--space-3)' }}>
          Unsettled items may change these figures:{' '}
          {settlement.pending_items.map((row) => `${row.count} ${row.kind.replace(/_/g, ' ')}`).join(', ')}.
        </p>
      )}

      {gratuity?.available && !gratuity.already_raised && gratuity.amount > 0 && (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <Button onClick={onRaiseGratuity}>Raise gratuity payment (draft)</Button>
        </div>
      )}
    </Card>
  );
}

/* ---------- Detail ---------- */
function SeparationDrawer({ record, currency, onClose, onChanged }) {
  const toast = useToast();
  const state = useAsync(
    ({ signal }) => (record ? hr.separationDetail(record.name, { signal }) : Promise.resolve(null)),
    [record?.name],
    { immediate: Boolean(record) },
  );
  const [relieving, setRelieving] = useState('');
  const [busy, setBusy] = useState(false);

  if (!record) return null;

  const complete = async (detail, force) => {
    const outstanding = (detail.activities || []).filter(
      (a) => a.status !== 'Completed' && a.status !== 'Cancelled',
    ).length;
    if (force && !window.confirm(
      `${outstanding} clearance activities are still open. Complete this separation anyway?`,
    )) return;

    setBusy(true);
    try {
      await hr.completeSeparation(record.name, relieving || detail.relieving_date || undefined, force);
      toast.success('Separation completed.');
      onClose();
      onChanged?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const raiseGratuity = async (employee) => {
    try {
      const result = await hr.raiseGratuityPayment(employee);
      toast.success(`Draft gratuity payment ${result.name} created.`);
      state.reload();
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title={record.employee_name || record.employee}
      subtitle={record.name}
    >
      <Async state={state} rows={6}>
        {(detail) => {
          const stats = progressOf(detail);
          const outstanding = (detail.activities || []).filter(
            (a) => a.status !== 'Completed' && a.status !== 'Cancelled',
          );
          const alreadyLeft = detail.employee_status === 'Left';

          return (
            <div className="stack">
              <Card className="card--muted">
                <Stat
                  label="Clearance"
                  value={`${stats.percent}%`}
                  meta={`${stats.done} of ${stats.total} activities complete`}
                />
                <div style={{ marginTop: 'var(--space-4)' }}>
                  <Meter
                    value={stats.done}
                    total={stats.total}
                    tone={stats.percent === 100 ? 'success' : undefined}
                  />
                </div>
              </Card>

              <Card title="Details">
                <FieldRow
                  label="Employee status"
                  value={detail.employee_status ? <Pill tone={statusTone(detail.employee_status)}>{detail.employee_status}</Pill> : null}
                />
                <FieldRow label="Department" value={detail.department} />
                <FieldRow label="Designation" value={detail.designation} />
                <FieldRow label="Resignation date" value={detail.resignation_letter_date ? fmtDate(detail.resignation_letter_date) : null} />
                <FieldRow label="Last working day" value={detail.relieving_date ? fmtDate(detail.relieving_date) : null} />
                <FieldRow label="Reason" value={detail.reason_for_leaving} />
                <FieldRow label="Project" value={detail.project} />
              </Card>

              <Card title={`Clearance (${stats.total})`} flush>
                {stats.total === 0 ? (
                  <EmptyState title="No activities" body="This separation has no checklist tasks." icon="◷" />
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr><th>Activity</th><th>Owner</th><th>Due</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {detail.activities.map((activity) => (
                          <tr key={activity.task || activity.activity_name}>
                            <td>{activity.activity_name}</td>
                            <td className="subtle">{activity.user || activity.role || '—'}</td>
                            <td className="subtle">{activity.exp_end_date ? fmtDate(activity.exp_end_date) : '—'}</td>
                            <td><Pill tone={statusTone(activity.status)}>{activity.status}</Pill></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>

              <Settlement
                settlement={detail.settlement}
                currency={currency}
                onRaiseGratuity={() => raiseGratuity(detail.employee)}
              />

              {!alreadyLeft && (
                <Card title="Complete separation">
                  <Field label="Last working day" hint="Marks the employee as Left on this date">
                    <input
                      type="date"
                      value={relieving || detail.relieving_date || ''}
                      onChange={(e) => setRelieving(e.target.value)}
                    />
                  </Field>
                  <div className="row" style={{ gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
                    <Button
                      variant="primary"
                      disabled={busy || outstanding.length > 0}
                      onClick={() => complete(detail, false)}
                    >
                      {busy ? 'Completing…' : 'Complete'}
                    </Button>
                    {/* An override is sometimes the only way to close a real
                        exit, but it is recorded on the employee as one. */}
                    {outstanding.length > 0 && (
                      <Button disabled={busy} onClick={() => complete(detail, true)}>
                        Override ({outstanding.length} open)
                      </Button>
                    )}
                  </div>
                  {outstanding.length > 0 && (
                    <p className="small subtle" style={{ marginTop: 'var(--space-3)' }}>
                      Clearance is incomplete: {outstanding.slice(0, 3).map((a) => a.activity_name).join(', ')}
                      {outstanding.length > 3 ? `, and ${outstanding.length - 3} more` : ''}.
                    </p>
                  )}
                </Card>
              )}
            </div>
          );
        }}
      </Async>
    </Drawer>
  );
}

export default function Offboarding() {
  const { currency, directory } = useWorkspace();
  const state = useAsync(({ signal }) => hr.offboardingQueue({ signal }), []);
  const [open, setOpen] = useState(null);
  const [starting, setStarting] = useState(false);
  const [query, setQuery] = useState('');

  const separations = useMemo(() => state.data?.separations || [], [state.data]);
  const templates = useMemo(() => state.data?.templates || [], [state.data]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return separations;
    return separations.filter((row) =>
      `${row.employee_name || ''} ${row.employee || ''} ${row.department || ''}`.toLowerCase().includes(q));
  }, [separations, query]);

  const active = separations.filter((row) => row.employee_status !== 'Left').length;

  return (
    <div className="stack">
      <div className="row row--between page-head" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <div>
          <h1 className="page-head__title">Offboarding</h1>
          <p className="page-head__sub">Separations, clearance and final settlement</p>
        </div>
        <div className="row" style={{ gap: 'var(--space-3)' }}>
          <SearchInput value={query} onChange={setQuery} placeholder="Search people…" />
          <Button variant="primary" onClick={() => setStarting(true)}>
            <Icon name="checklist" size={15} />
            Start separation
          </Button>
        </div>
      </div>

      <Async state={state} rows={6}>
        {(data) => {
          if (!data.available) {
            return (
              <EmptyState
                title="Separation is unavailable"
                body="Employee Separation is not installed on this site."
                icon="◷"
              />
            );
          }
          if (!visible.length) {
            return (
              <EmptyState
                title={query ? 'No matches' : 'No separations'}
                body={query ? 'No separation matches that search.' : 'Nobody is currently being offboarded.'}
                icon="◷"
              />
            );
          }
          return (
            <>
              <div className="grid grid--3">
                <Card className="card--muted"><Stat label="In progress" value={String(active)} /></Card>
                <Card className="card--muted"><Stat label="Total separations" value={String(separations.length)} /></Card>
                <Card className="card--muted">
                  <Stat
                    label="Clearance complete"
                    value={String(separations.filter((r) => r.clearance_complete).length)}
                  />
                </Card>
              </div>

              <Card title={`Separations (${visible.length})`} flush>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Employee</th><th>Department</th><th>Last day</th>
                        <th>Clearance</th><th>Status</th><th />
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((row) => {
                        const stats = progressOf(row);
                        return (
                          <tr key={row.name}>
                            <td>
                              <div className="cell-strong">{row.employee_name || row.employee}</div>
                              <div className="small subtle">{row.employee}</div>
                            </td>
                            <td className="subtle">{row.department || '—'}</td>
                            <td className="subtle">{row.relieving_date ? fmtDate(row.relieving_date) : '—'}</td>
                            <td style={{ minWidth: 140 }}>
                              <Meter value={stats.done} total={stats.total || 1} tone={stats.percent === 100 ? 'success' : undefined} />
                              <div className="small subtle">{stats.done} / {stats.total}</div>
                            </td>
                            <td>
                              <Pill tone={statusTone(row.employee_status || row.boarding_status)}>
                                {row.employee_status === 'Left' ? 'Left' : row.boarding_status || 'Pending'}
                              </Pill>
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <Button onClick={() => setOpen(row)}>Open</Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          );
        }}
      </Async>

      <StartDrawer
        open={starting}
        directory={directory}
        templates={templates}
        onClose={() => setStarting(false)}
        onDone={state.reload}
      />
      <SeparationDrawer
        record={open}
        currency={currency}
        onClose={() => setOpen(null)}
        onChanged={state.reload}
      />
    </div>
  );
}
