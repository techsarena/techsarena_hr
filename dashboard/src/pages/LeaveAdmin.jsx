import { useMemo, useState } from 'react';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { Async, Button, Card, EmptyState, Field, Modal, SearchInput, Stat, Tabs } from '../components/ui';
import { DataTable, exportCsv } from '../components/DataTable';
import { Icon } from '../components/Icon';
import { fmtDate, fmtDays, fmtNumber, fmtRelative, isoDate } from '../api/format';
import { t } from '../api/i18n';

/* Adjustments post a real Leave Ledger Entry plus an audit comment server-side —
   the balance moves through HRMS's own ledger, not a side table. */
function AdjustModal({ open, onClose, employees, leaveTypes, employee, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ employee: employee || '', leave_type: '', days: '', reason: '' });
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await hr.adjustLeaveBalance(form.employee, form.leave_type, Number(form.days), form.reason || undefined);
      toast.success(`Balance adjusted by ${fmtDays(Number(form.days))}.`);
      setForm({ employee: '', leave_type: '', days: '', reason: '' });
      onClose();
      onDone();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  const days = Number(form.days);

  return (
    <Modal
      open
      onClose={onClose}
      title={t("Adjust a leave balance")}
      subtitle={t("Posts a Leave Ledger Entry and an audit comment")}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="indigo" onClick={submit} disabled={busy || !form.employee || !form.leave_type || !days}>
            {busy ? 'Posting…' : days > 0 ? 'Grant days' : 'Deduct days'}
          </Button>
        </>
      }
    >
      <div className="fields">
        <Field label={t("Employee")}>
          <select value={form.employee} onChange={(e) => setForm({ ...form, employee: e.target.value })}>
            <option value="">{t("Select an employee…")}</option>
            {employees.map((row) => (
              <option key={row.name} value={row.name}>
                {row.employee_name}{row.department ? ` — ${row.department}` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("Leave type")}>
          <select value={form.leave_type} onChange={(e) => setForm({ ...form, leave_type: e.target.value })}>
            <option value="">{t("Select a leave type…")}</option>
            {leaveTypes.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </Field>
        <Field label={t("Days")} hint="Positive grants days; negative deducts them.">
          <input type="number" step="0.5" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} />
        </Field>
        <Field label={t("Reason")}>
          <textarea rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function Adjustments() {
  const [employee, setEmployee] = useState('');
  const [adjustOpen, setAdjustOpen] = useState(false);
  const state = useAsync(({ signal }) => hr.leaveAdjustments(employee || undefined, { signal }), [employee]);

  const data = state.data;
  const employees = data?.employees || [];
  const history = data?.history || [];

  return (
    <div className="stack">
      <Card>
        <div className="toolbar" style={{ margin: 0 }}>
          <div style={{ minWidth: 260 }}>
            <label htmlFor="adj-emp">{t("Inspect an employee's balances")}</label>
            <select id="adj-emp" value={employee} onChange={(e) => setEmployee(e.target.value)}>
              <option value="">{t("Select an employee…")}</option>
              {employees.map((row) => (
                <option key={row.name} value={row.name}>
                  {row.employee_name}{row.department ? ` — ${row.department}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="toolbar__spacer" />
          <Button variant="indigo" onClick={() => setAdjustOpen(true)}>
            <Icon name="plus" size={15} /> Adjust balance
          </Button>
        </div>
      </Card>

      <Async state={state} rows={4}>
        {() => (
          <div className="grid grid--2">
            <Card title={t("Balances")} subtitle={employee || 'Select an employee above'} flush>
              {(data.balances || []).length === 0 ? (
                <EmptyState
                  title={employee ? 'No allocations' : 'No employee selected'}
                  body={employee ? 'This employee has no leave allocated.' : 'Pick someone to see their current balances.'}
                  icon="◷"
                />
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>{t("Leave type")}</th><th className="num">{t("Allocated")}</th><th className="num">{t("Taken")}</th><th className="num">{t("Remaining")}</th></tr></thead>
                    <tbody>
                      {data.balances.map((row) => (
                        <tr key={row.leave_type}>
                          <td className="cell-strong">{row.leave_type}</td>
                          <td className="num">{fmtNumber(row.allocated)}</td>
                          <td className="num">{fmtNumber(row.taken)}</td>
                          <td className="num cell-strong">{fmtNumber(row.remaining)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card title={t("Adjustment trail")} subtitle={`${history.length} recent adjustments`}>
              {history.length === 0 ? (
                <EmptyState title={t("No adjustments yet")} body={t("Manual grants and deductions are recorded here.")} icon="◷" />
              ) : (
                <div className="stack">
                  {history.map((row, index) => (
                    <div key={`${row.employee}-${index}`}>
                      <div className="row row--between">
                        <span style={{ fontWeight: 500 }}>{row.employee}</span>
                        <span className="small subtle">{fmtRelative(row.creation)}</span>
                      </div>
                      <p className="small muted">{row.content}</p>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}
      </Async>

      <AdjustModal
        open={adjustOpen}
        onClose={() => setAdjustOpen(false)}
        employees={employees}
        leaveTypes={data?.leave_types || []}
        employee={employee}
        onDone={state.reload}
      />
    </div>
  );
}

function Deductions() {
  const [range, setRange] = useState(() => {
    const now = new Date();
    return {
      from: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)),
      to: isoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
    };
  });
  const [query, setQuery] = useState('');
  const state = useAsync(({ signal }) => hr.leaveDeductions(range.from, range.to, { signal }), [range.from, range.to]);

  const rows = useMemo(() => {
    const list = state.data?.deductions || [];
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((row) => String(row.employee_name || row.employee).toLowerCase().includes(needle));
  }, [state.data, query]);

  const columns = useMemo(
    () => [
      { key: 'employee_name', header: t("Employee"), render: (row) => <span className="cell-strong">{row.employee_name}</span> },
      { key: 'employee', header: 'ID', render: (row) => <span className="subtle tabular">{row.employee}</span> },
      {
        key: 'lwp_days',
        header: t("LWP days"),
        align: 'right',
        render: (row) => <span className="cell-strong" style={{ color: 'var(--warning)' }}>{fmtNumber(row.lwp_days)}</span>,
        sortValue: (row) => Number(row.lwp_days),
      },
    ],
    [],
  );

  return (
    <div className="stack">
      <Card>
        <div className="toolbar" style={{ margin: 0 }}>
          <Field label={t("From")}>
            <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          </Field>
          <Field label="To">
            <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </Field>
          <div className="toolbar__spacer" />
          <SearchInput value={query} onChange={setQuery} placeholder={t("Filter employees…")} />
        </div>
      </Card>

      <Async state={state} rows={5}>
        {(data) => (
          <>
            <div className="grid grid--3">
              <div className="card"><Stat label={t("Total LWP days")} value={fmtNumber(data.total_lwp_days)} tone={data.total_lwp_days ? 'warning' : undefined} /></div>
              <div className="card"><Stat label={t("Employees affected")} value={(data.deductions || []).length} /></div>
              <div className="card"><Stat label={t("LWP leave types")} value={(data.lwp_leave_types || []).length} meta={(data.lwp_leave_types || []).join(', ') || undefined} /></div>
            </div>

            <Card
              flush
              title={t("Unpaid leave")}
              subtitle={`${fmtDate(data.from_date)} – ${fmtDate(data.to_date)}`}
              action={
                rows.length > 0 && (
                  <Button size="sm" onClick={() => exportCsv(`lwp-${data.from_date}`, columns, rows)}>
                    <Icon name="download" size={14} /> CSV
                  </Button>
                )
              }
            >
              <DataTable
                columns={columns}
                rows={rows}
                initialSort={{ key: 'lwp_days', dir: 'desc' }}
                emptyTitle="No unpaid leave in this period"
                emptyBody="Nothing will be deducted from payroll for leave in this range."
                maxHeight="58vh"
              />
            </Card>
          </>
        )}
      </Async>
    </div>
  );
}

export default function LeaveAdmin() {
  const [tab, setTab] = useState('adjustments');
  return (
    <div className="stack">
      <div className="page-head">
        <h1 className="page-head__title">{t("Leave admin")}</h1>
        <p className="page-head__sub">{t("Grant or deduct balances, and see what unpaid leave costs payroll")}</p>
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'adjustments', label: t("Adjustments") },
          { id: 'deductions', label: t("Unpaid leave") },
        ]}
      />

      {tab === 'adjustments' ? <Adjustments /> : <Deductions />}
    </div>
  );
}
