import { useMemo, useState } from 'react';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { useToast } from '../hooks/useToast';
import { Async, Button, Card, EmptyState, Modal, Pill, SearchInput, Stat, Tabs } from '../components/ui';
import { DataTable, exportCsv } from '../components/DataTable';
import { Icon } from '../components/Icon';
import { fmtMoney, fmtRange } from '../api/format';

function SubmitModal({ open, run, onClose, onDone }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!open || !run) return null;

  const submit = async () => {
    setBusy(true);
    try {
      await hr.submitPayrollRun(run.name);
      toast.success('Payroll run submitted.');
      onClose();
      onDone();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Submit this payroll run"
      subtitle={fmtRange(run.start_date, run.end_date)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="indigo" onClick={submit} disabled={busy}>
            {busy ? 'Submitting…' : 'Submit run'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted">
          Submitting posts {run.slips_generated} salary slip{run.slips_generated === 1 ? '' : 's'} totalling{' '}
          <strong>{fmtMoney(run.net, run.currency)}</strong> in net pay. This runs HRMS's own submission, and cannot be
          undone from here.
        </p>
        {run.held > 0 && (
          <div className="card" style={{ background: 'var(--warning-bg)', border: 'none' }}>
            <strong style={{ color: 'var(--warning)' }}>{run.held} employee{run.held === 1 ? '' : 's'} held</strong>
            <p className="small" style={{ color: 'var(--warning)', marginTop: 4 }}>
              Held rows have an unresolved exception and will not be paid in this run. Clear them first if they should be.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function Payroll() {
  const { currency: siteCurrency } = useWorkspace();
  const [runName, setRunName] = useState(null);
  const [tab, setTab] = useState('register');
  const [query, setQuery] = useState('');
  const [submitOpen, setSubmitOpen] = useState(false);

  const state = useAsync(({ signal }) => hr.payrollRun(runName, { signal }), [runName]);
  const data = state.data;
  const run = data?.run;
  const currency = run?.currency || siteCurrency;

  const register = useMemo(() => {
    const rows = data?.register || [];
    if (!query.trim()) return rows;
    const needle = query.toLowerCase();
    return rows.filter((row) =>
      [row.employee_name, row.employee, row.department, row.designation, row.salary_structure]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [data, query]);

  const columns = useMemo(
    () => [
      {
        key: 'employee_name',
        header: 'Employee',
        render: (row) => (
          <div className="truncate">
            <div className="cell-strong truncate">{row.employee_name}</div>
            <div className="small subtle truncate">{[row.employee, row.designation].filter(Boolean).join(' · ')}</div>
          </div>
        ),
        exportValue: (row) => row.employee_name,
      },
      { key: 'department', header: 'Department', render: (row) => row.department || '—' },
      { key: 'salary_structure', header: 'Structure', render: (row) => row.salary_structure || <span className="subtle">Not assigned</span>, exportValue: (row) => row.salary_structure || '' },
      { key: 'gross_pay', header: 'Gross', align: 'right', render: (row) => fmtMoney(row.gross_pay, currency), sortValue: (row) => Number(row.gross_pay) || 0 },
      { key: 'total_deduction', header: 'Deductions', align: 'right', render: (row) => fmtMoney(row.total_deduction, currency), sortValue: (row) => Number(row.total_deduction) || 0 },
      {
        key: 'net_pay',
        header: 'Net pay',
        align: 'right',
        render: (row) => <span className="cell-strong">{fmtMoney(row.net_pay, currency)}</span>,
        sortValue: (row) => Number(row.net_pay) || 0,
      },
      {
        key: 'flags',
        header: 'Flags',
        sortable: false,
        render: (row) => (
          <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
            {row.held && <Pill tone="danger">Held</Pill>}
            {row.changed && !row.held && <Pill tone="warning">Changed</Pill>}
            {row.note && <span className="small subtle truncate" style={{ maxWidth: 180 }}>{row.note}</span>}
          </div>
        ),
        exportValue: (row) => [row.held ? 'Held' : '', row.changed ? 'Changed' : '', row.note].filter(Boolean).join(' · '),
      },
    ],
    [currency],
  );

  return (
    <div className="stack">
      <div className="row row--between page-head" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <div>
          <h1 className="page-head__title">Payroll</h1>
          <p className="page-head__sub">{run ? fmtRange(run.start_date, run.end_date) : 'Payroll runs on this site'}</p>
        </div>
        <div className="row">
          {data?.runs?.length > 0 && (
            <select
              value={run?.name || ''}
              onChange={(e) => setRunName(e.target.value)}
              style={{ width: 'auto', minWidth: 220 }}
              aria-label="Payroll period"
            >
              {data.runs.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {fmtRange(entry.start_date, entry.end_date)} — {entry.status}
                </option>
              ))}
            </select>
          )}
          {run && run.docstatus === 0 && (
            <Button variant="indigo" onClick={() => setSubmitOpen(true)}>Submit run</Button>
          )}
        </div>
      </div>

      <Async state={state} rows={6}>
        {(payload) => {
          if (!payload.run) {
            return (
              <Card>
                <EmptyState
                  title="No payroll runs yet"
                  body="Payroll Entry records created in HRMS will appear here with their full register."
                  icon={<Icon name="payroll" size={22} />}
                />
              </Card>
            );
          }

          const exceptions = payload.exceptions || [];
          const costSplit = payload.cost_split || [];
          const statutory = payload.statutory || [];
          const delta =
            payload.run.previous_net !== null && payload.run.previous_net !== undefined
              ? Number(payload.run.net) - Number(payload.run.previous_net)
              : null;

          return (
            <>
              <div className="grid grid--4">
                <div className="card">
                  <Stat
                    label="Net payout"
                    value={fmtMoney(payload.run.net, currency)}
                    meta={delta !== null ? `${delta >= 0 ? '+' : ''}${fmtMoney(delta, currency)} vs last run` : undefined}
                  />
                </div>
                <div className="card"><Stat label="Gross" value={fmtMoney(payload.run.gross, currency)} meta={`Deductions ${fmtMoney(payload.run.deductions, currency)}`} /></div>
                <div className="card"><Stat label="Slips" value={`${payload.run.slips_generated} / ${payload.run.employees}`} meta={payload.run.slips_submitted ? 'Submitted' : 'Draft'} /></div>
                <div className="card">
                  <Stat
                    label="Held"
                    value={payload.run.held}
                    tone={payload.run.held ? 'danger' : undefined}
                    meta={payload.run.held ? 'Excluded from this run' : 'Nothing blocked'}
                  />
                </div>
              </div>

              <Card flush>
                <div className="row row--between" style={{ padding: 'var(--space-4) var(--space-5) 0', flexWrap: 'wrap' }}>
                  <Tabs
                    value={tab}
                    onChange={setTab}
                    items={[
                      { id: 'register', label: 'Register', count: (payload.register || []).length },
                      { id: 'exceptions', label: 'Exceptions', count: exceptions.length },
                      { id: 'analysis', label: 'Cost & statutory' },
                    ]}
                  />
                  {tab === 'register' && (
                    <div className="row">
                      <SearchInput value={query} onChange={setQuery} placeholder="Filter employees…" />
                      <Button size="sm" onClick={() => exportCsv(`payroll-${payload.run.name}`, columns, register)}>
                        <Icon name="download" size={14} /> CSV
                      </Button>
                    </div>
                  )}
                </div>

                <div style={{ padding: tab === 'register' ? 0 : 'var(--space-5)' }}>
                  {tab === 'register' && (
                    <DataTable
                      columns={columns}
                      rows={register}
                      rowKey={(row, i) => row.name || `${row.employee}-${i}`}
                      initialSort={{ key: 'net_pay', dir: 'desc' }}
                      emptyTitle={query ? 'No employees match that filter' : 'No slips in this run'}
                      maxHeight="62vh"
                      footer={
                        register.length > 0 && (
                          <tr>
                            <td className="cell-strong">{register.length} employees</td>
                            <td /><td />
                            <td className="num cell-strong">{fmtMoney(register.reduce((s, r) => s + (Number(r.gross_pay) || 0), 0), currency)}</td>
                            <td className="num cell-strong">{fmtMoney(register.reduce((s, r) => s + (Number(r.total_deduction) || 0), 0), currency)}</td>
                            <td className="num cell-strong">{fmtMoney(register.reduce((s, r) => s + (Number(r.net_pay) || 0), 0), currency)}</td>
                            <td />
                          </tr>
                        )
                      }
                    />
                  )}

                  {tab === 'exceptions' && (
                    exceptions.length === 0 ? (
                      <EmptyState title="No exceptions" body="Every employee in this run produced a slip cleanly." icon={<Icon name="check" size={22} />} />
                    ) : (
                      <div className="stack">
                        {exceptions.map((row, index) => (
                          <div className="row row--between card card--muted" key={`${row.employee}-${index}`}>
                            <div className="truncate">
                              <div style={{ fontWeight: 600 }} className="truncate">{row.employee_name || row.employee}</div>
                              <div className="small subtle">{row.detail || row.message}</div>
                            </div>
                            <Pill tone="danger">{row.kind || 'Exception'}</Pill>
                          </div>
                        ))}
                      </div>
                    )
                  )}

                  {tab === 'analysis' && (
                    <div className="grid grid--2">
                      <div>
                        <div className="section-heading__label" style={{ marginBottom: 'var(--space-3)' }}>Cost by department</div>
                        {costSplit.length === 0 ? (
                          <EmptyState title="No split available" icon="◷" />
                        ) : (
                          <div className="stack">
                            {costSplit.map((row, index) => {
                              const total = costSplit.reduce((s, r) => s + (Number(r.amount) || 0), 0);
                              const pct = total ? (Number(row.amount) / total) * 100 : 0;
                              return (
                                <div key={`${row.label || row.department}-${index}`}>
                                  <div className="row row--between small" style={{ marginBottom: 4 }}>
                                    <span style={{ fontWeight: 500 }}>{row.label || row.department || 'Unassigned'}</span>
                                    <span className="tabular">{fmtMoney(row.amount, currency)} · {pct.toFixed(0)}%</span>
                                  </div>
                                  <div className="meter"><div className="meter__fill" style={{ width: `${pct}%` }} /></div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div>
                        <div className="section-heading__label" style={{ marginBottom: 'var(--space-3)' }}>Statutory</div>
                        {statutory.length === 0 ? (
                          <EmptyState title="No statutory components" icon="◷" />
                        ) : (
                          <div className="table-wrap">
                            <table className="table">
                              <thead><tr><th>Component</th><th className="num">Amount</th></tr></thead>
                              <tbody>
                                {statutory.map((row, index) => (
                                  <tr key={`${row.label || row.component}-${index}`}>
                                    <td>{row.label || row.component}</td>
                                    <td className="num">{fmtMoney(row.amount, currency)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            </>
          );
        }}
      </Async>

      <SubmitModal open={submitOpen} run={run} onClose={() => setSubmitOpen(false)} onDone={state.reload} />
    </div>
  );
}
