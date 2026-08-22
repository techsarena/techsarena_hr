import { useMemo, useState } from 'react';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { useToast } from '../hooks/useToast';
import { Async, Button, Modal, Pill, SearchInput } from '../components/ui';
import { exportCsv } from '../components/DataTable';
import { Icon } from '../components/Icon';
import { fmtDateShort, fmtMoney, fmtRange, initials, monthLabel, toDate } from '../api/format';

const TABS = [
  { id: 'run', label: 'Run' },
  { id: 'register', label: 'Register' },
  { id: 'statutory', label: 'Statutory' },
];

function moneySymbol(currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0)
      .find((part) => part.type === 'currency')?.value || currency || '';
  } catch {
    return currency || '';
  }
}

function compactMoney(value, currency) {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (Number.isNaN(num)) return '—';
  const abs = Math.abs(num);
  const sign = num < 0 ? '-' : '';
  const symbol = moneySymbol(currency);

  if (currency === 'INR') {
    if (abs >= 10000000) return `${sign}${symbol}${(abs / 10000000).toFixed(abs >= 100000000 ? 0 : 2)} Cr`;
    if (abs >= 100000) return `${sign}${symbol}${(abs / 100000).toFixed(abs >= 1000000 ? 0 : 1)} L`;
  }

  if (abs >= 1000000) return `${sign}${symbol}${(abs / 1000000).toFixed(abs >= 10000000 ? 0 : 1)}M`;
  if (abs >= 1000) return `${sign}${symbol}${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}K`;
  return fmtMoney(num, currency);
}

function periodLabel(start, end) {
  const a = toDate(start);
  const b = toDate(end);
  if (!a || !b) return fmtRange(start, end);
  const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
  if (!sameMonth) return fmtRange(start, end);
  const month = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }).format(b);
  return `${a.getDate()} - ${b.getDate()} ${month}`;
}

function monthRunLabel(start) {
  const label = monthLabel(start);
  if (label === '—') return 'Payroll run';
  return `${label.split(' ')[0]} run`;
}

function defaultPeriod() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const iso = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return { start_date: iso(start), end_date: iso(end) };
}

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
          <strong>{fmtMoney(run.net, run.currency)}</strong> in net pay.
        </p>
        {run.held > 0 && (
          <div className="payroll-alert payroll-alert--warning">
            <strong>{run.held} blocking exception{run.held === 1 ? '' : 's'}</strong>
            <p>Clear held rows before submitting this run.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

function CreatePayrollModal({ open, onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState(defaultPeriod);
  const [busy, setBusy] = useState(false);
  if (!open) return null;

  const update = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));
  const create = async () => {
    setBusy(true);
    try {
      const result = await hr.createPayrollRun({
        start_date: form.start_date,
        end_date: form.end_date,
        payroll_frequency: 'Monthly',
      });
      toast.success(`Payroll run created with ${result.slips_generated || 0} draft slips.`);
      onClose();
      onCreated(result.name);
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
      title="Create payroll"
      subtitle="Draft only"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="indigo" onClick={create} disabled={busy || !form.start_date || !form.end_date}>
            {busy ? 'Generating…' : 'Generate draft slips'}
          </Button>
        </>
      }
    >
      <div className="payroll-create-form">
        <label>
          Period start
          <input type="date" value={form.start_date} onChange={(event) => update('start_date', event.target.value)} />
        </label>
        <label>
          Period end
          <input type="date" value={form.end_date} onChange={(event) => update('end_date', event.target.value)} />
        </label>
        <div className="payroll-create-summary">
          <div>
            <span>Employees</span>
            <strong>All active staff</strong>
          </div>
          <div>
            <span>Pay day</span>
            <strong>{fmtDateShort(form.end_date)}</strong>
          </div>
          <p>Nothing is paid or visible to employees until you submit the run.</p>
        </div>
      </div>
    </Modal>
  );
}

function PayrollTabs({ value, onChange, registerCount }) {
  return (
    <div className="payroll-tabs" role="tablist">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`payroll-tab${value === tab.id ? ' is-active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.id === 'register' && registerCount ? <span>{registerCount}</span> : null}
        </button>
      ))}
    </div>
  );
}

function EmptyPayroll({ onCreate }) {
  const checks = [
    ['Salary structures assigned', 'Employees with salary assignments are ready.', true],
    ['Attendance locked for the period', 'Closed attendance keeps loss-of-pay days final.', true],
    ['Salary components configured', 'Earnings and deductions are ready to calculate.', true],
    ['Payment account not set', 'A payable account is needed before submission.', false],
  ];

  return (
    <div className="payroll-page payroll-page--empty">
      <div className="payroll-head">
        <div className="row">
          <h1>Payroll</h1>
          <Pill>No runs yet</Pill>
        </div>
        <div className="payroll-actions">
          <Button onClick={() => { window.location.href = '/app/payroll-settings'; }}>Payroll settings</Button>
          <Button variant="indigo" onClick={onCreate}>
            <Icon name="plus" size={15} /> Create payroll
          </Button>
        </div>
      </div>

      <div className="payroll-layout">
        <div className="payroll-main">
          <section className="payroll-empty-hero">
            <div className="payroll-icon payroll-icon--large"><Icon name="payroll" size={38} /></div>
            <div className="payroll-empty-copy">
              <h2>No payroll has been run yet</h2>
              <p>
                Everything the first run needs is already in place. Creating a payroll entry generates a draft salary
                slip for every employee, which you can review before submitting.
              </p>
              <div className="payroll-actions payroll-actions--wrap">
                <Button variant="indigo" onClick={onCreate}>
                  <Icon name="plus" size={15} /> Create payroll for this month
                </Button>
                <Button>Import last year&apos;s runs</Button>
              </div>
            </div>
          </section>

          <section className="payroll-panel payroll-checklist">
            <header>
              <h3>Before the first run</h3>
              <Pill tone="info">3 of 4 ready</Pill>
            </header>
            {checks.map(([title, body, done], index) => (
              <div className={`payroll-check${done ? ' is-done' : ' is-warning'}`} key={title}>
                <span>{done ? <Icon name="check" size={15} /> : index + 1}</span>
                <div>
                  <strong>{title}</strong>
                  <p>{body}</p>
                </div>
                <em>{done ? 'Done' : 'Set account'}</em>
              </div>
            ))}
          </section>
        </div>

        <aside className="payroll-rail">
          <section className="payroll-panel">
            <h3>What the run will cover</h3>
            <div className="payroll-facts">
              <span>Period</span><strong>This month</strong>
              <span>Employees</span><strong>All active</strong>
              <span>Estimated gross</span><strong>Calculated on create</strong>
              <span>Pay day</span><strong>Period end</strong>
            </div>
            <p className="small subtle">Estimate from current structures; draft slips will carry the real figures.</p>
          </section>
          <section className="payroll-panel">
            <h3>What happens next</h3>
            {['Payroll Entry is created for the period.', 'Draft Salary Slips are generated.', 'You review the register and clear exceptions.', 'Submitting posts the slips and releases payslips.'].map((step, index) => (
              <div className="payroll-next-step" key={step}>
                <span>{index + 1}</span>
                <p>{step}</p>
              </div>
            ))}
          </section>
          <section className="payroll-panel">
            <h3>Past runs</h3>
            <p className="small subtle">No payroll history in this company yet. Runs imported as closed periods stay searchable.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}

function PayrollHero({ run, currency }) {
  const delta =
    run.previous_net !== null && run.previous_net !== undefined
      ? Number(run.net || 0) - Number(run.previous_net || 0)
      : null;
  const progress = run.employees ? Math.min(100, Math.round((run.slips_generated / run.employees) * 100)) : 0;

  return (
    <section className="payroll-run-hero">
      <div className="payroll-run-hero__lead">
        <span>{monthRunLabel(run.start_date)} · credits due {fmtDateShort(run.posting_date || run.end_date)}</span>
        <strong>{compactMoney(run.net, currency)}</strong>
        <em>net payable · {run.employees} employees</em>
        <div className="payroll-run-meter"><span style={{ width: `${progress}%` }} /></div>
        <p>Step 3 of 5 · validation</p>
      </div>
      <div className="payroll-run-hero__stats">
        <div><span>Gross</span><strong>{compactMoney(run.gross, currency)}</strong><em>{delta === null ? 'Current run' : `${delta >= 0 ? '+' : ''}${compactMoney(delta, currency)} vs last run`}</em></div>
        <div><span>Deductions</span><strong>{compactMoney(run.deductions, currency)}</strong><em>PF, tax, loans</em></div>
        <div><span>Slips generated</span><strong>{run.slips_generated} / {run.employees}</strong><em>{run.held ? `${run.held} held` : 'Ready'}</em></div>
      </div>
    </section>
  );
}

function Workflow({ run, exceptions }) {
  const steps = [
    { title: 'Attendance locked', meta: fmtDateShort(run.start_date), done: true },
    { title: 'Slips generated', meta: fmtDateShort(run.posting_date || run.end_date), done: run.slips_generated > 0 },
    { title: 'Validation', meta: exceptions.length ? `${exceptions.length} exceptions` : 'Clear', active: true },
    { title: 'Approval', meta: `Due ${fmtDateShort(run.end_date)}` },
    { title: 'Bank file', meta: fmtDateShort(run.posting_date || run.end_date) },
  ];

  return (
    <div className="payroll-workflow">
      {steps.map((step, index) => (
        <div className={`payroll-stage${step.done ? ' is-done' : ''}${step.active ? ' is-active' : ''}`} key={step.title}>
          <span>{step.done ? <Icon name="check" size={14} /> : index + 1}</span>
          <div>
            <strong>{step.title}</strong>
            <p>{step.meta}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function RegisterTable({ rows, currency }) {
  if (!rows.length) {
    return <div className="payroll-table-empty">No employees match that filter.</div>;
  }

  return (
    <div className="payroll-table-wrap">
      <table className="payroll-table">
        <thead>
          <tr>
            <th>Employee</th>
            <th>Structure</th>
            <th className="num">Gross</th>
            <th className="num">Deductions</th>
            <th className="num">Net</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr className={row.held ? 'is-held' : ''} key={row.name || `${row.employee}-${index}`}>
              <td>
                <div className="payroll-person">
                  <span>{initials(row.employee_name || row.employee)}</span>
                  <div>
                    <strong>{row.employee_name || row.employee}</strong>
                    {row.note || row.designation ? <p>{row.note || row.designation}</p> : null}
                  </div>
                </div>
              </td>
              <td>{row.salary_structure || <em>Missing</em>}</td>
              <td className="num">{fmtMoney(row.gross_pay, currency)}</td>
              <td className="num">{fmtMoney(row.total_deduction, currency)}</td>
              <td className="num"><strong>{fmtMoney(row.net_pay, currency)}</strong></td>
              <td>
                {row.held ? <Pill tone="danger">Held</Pill> : row.changed ? <Pill tone="warning">Changed</Pill> : <Pill tone="success">Ready</Pill>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExceptionRail({ exceptions }) {
  return (
    <section className={`payroll-panel payroll-blockers${exceptions.length ? ' has-blockers' : ''}`}>
      <header>
        <h3>{exceptions.length ? 'Blocking submission' : 'Ready to submit'}</h3>
        {exceptions.length ? <strong>{exceptions.length}</strong> : <Icon name="check" size={16} />}
      </header>
      {exceptions.length ? (
        exceptions.map((row, index) => (
          <div className="payroll-blocker" key={`${row.employee}-${index}`}>
            <strong>{row.title} · {row.employee_name || row.employee}</strong>
            <p>{row.detail}</p>
            <Button size="sm" variant={row.action === 'assign_structure' ? 'indigo' : 'ghost'}>
              {row.action === 'assign_structure' ? 'Assign structure' : 'Request details'}
            </Button>
          </div>
        ))
      ) : (
        <p className="small subtle">No payroll exceptions are blocking this run.</p>
      )}
    </section>
  );
}

function CostSplit({ rows, currency }) {
  const total = rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  return (
    <section className="payroll-panel">
      <h3>Cost split</h3>
      {rows.length ? rows.slice(0, 5).map((row) => {
        const pct = total ? (Number(row.amount || 0) / total) * 100 : 0;
        return (
          <div className="payroll-cost-row" key={row.department || row.label}>
            <div><span>{row.department || row.label || 'Unassigned'} · {row.headcount || 0}</span><strong>{compactMoney(row.amount, currency)}</strong></div>
            <div className="meter"><div className="meter__fill" style={{ width: `${pct}%` }} /></div>
          </div>
        );
      }) : <p className="small subtle">No split available yet.</p>}
    </section>
  );
}

function Statutory({ rows, currency }) {
  return (
    <section className="payroll-panel">
      <h3>Statutory</h3>
      {rows.length ? rows.slice(0, 5).map((row) => (
        <div className="payroll-line" key={row.component || row.label}>
          <span>{row.component || row.label}</span>
          <strong>{compactMoney(row.amount, currency)}</strong>
        </div>
      )) : <p className="small subtle">No statutory components in this run.</p>}
    </section>
  );
}

export default function Payroll() {
  const { currency: siteCurrency } = useWorkspace();
  const [runName, setRunName] = useState(null);
  const [tab, setTab] = useState('run');
  const [query, setQuery] = useState('');
  const [submitOpen, setSubmitOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const state = useAsync(({ signal }) => hr.payrollRun(runName, { signal }), [runName]);
  const data = state.data;
  const run = data?.run;
  const currency = run?.currency || siteCurrency;

  const register = useMemo(() => {
    const rows = data?.register || [];
    if (!query.trim()) return rows;
    const needle = query.toLowerCase();
    return rows.filter((row) =>
      [row.employee_name, row.employee, row.department, row.designation, row.salary_structure, row.note]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [data, query]);

  const columns = useMemo(
    () => [
      { key: 'employee_name', header: 'Employee', exportValue: (row) => row.employee_name || row.employee },
      { key: 'salary_structure', header: 'Structure', exportValue: (row) => row.salary_structure || '' },
      { key: 'gross_pay', header: 'Gross', exportValue: (row) => row.gross_pay || '' },
      { key: 'total_deduction', header: 'Deductions', exportValue: (row) => row.total_deduction || '' },
      { key: 'net_pay', header: 'Net', exportValue: (row) => row.net_pay || '' },
      { key: 'status', header: 'Status', exportValue: (row) => (row.held ? 'Held' : row.changed ? 'Changed' : 'Ready') },
    ],
    [],
  );

  const onCreated = (name) => {
    if (name) setRunName(name);
    else state.reload();
  };

  return (
    <>
      <Async state={state} rows={8}>
        {(payload) => {
          if (!payload.run) return <EmptyPayroll onCreate={() => setCreateOpen(true)} />;

          const exceptions = payload.exceptions || [];
          const costSplit = payload.cost_split || [];
          const statutory = payload.statutory || [];

          return (
            <div className="payroll-page">
              <div className="payroll-head">
                <div>
                  <h1>
                    <span className="payroll-title-desktop">Payroll</span>
                    <span className="payroll-title-mobile">{monthRunLabel(payload.run.start_date)}</span>
                  </h1>
                  <p>{periodLabel(payload.run.start_date, payload.run.end_date)}</p>
                </div>
                <div className="payroll-actions">
                  {payload.runs?.length > 0 && (
                    <select
                      value={payload.run.name || ''}
                      onChange={(event) => setRunName(event.target.value)}
                      aria-label="Payroll period"
                    >
                      {payload.runs.map((entry) => (
                        <option key={entry.name} value={entry.name}>
                          {monthLabel(entry.start_date)} · {entry.status}
                        </option>
                      ))}
                    </select>
                  )}
                  <Button onClick={() => setTab('register')}>Preview register</Button>
                  <Button onClick={() => setCreateOpen(true)}><Icon name="plus" size={15} /> Create payroll</Button>
                  <Button
                    variant="indigo"
                    disabled={payload.run.docstatus !== 0 || payload.run.held > 0}
                    onClick={() => setSubmitOpen(true)}
                  >
                    Submit run
                  </Button>
                </div>
              </div>

              <PayrollTabs value={tab} onChange={setTab} registerCount={payload.register?.length || 0} />

              <div className="payroll-layout">
                <div className="payroll-main">
                  <PayrollHero run={payload.run} currency={currency} />
                  <Workflow run={payload.run} exceptions={exceptions} />

                  {(tab === 'run' || tab === 'register') && (
                    <section className="payroll-panel payroll-register">
                      <header>
                        <h3>Salary register</h3>
                        <div className="payroll-register-tools">
                          <Pill tone="danger">Held {payload.run.held}</Pill>
                          <Pill>All {payload.register?.length || 0}</Pill>
                          <SearchInput value={query} onChange={setQuery} placeholder="Filter employees…" />
                          <Button size="sm" onClick={() => exportCsv(`payroll-${payload.run.name}`, columns, register)}>
                            <Icon name="download" size={14} /> CSV
                          </Button>
                        </div>
                      </header>
                      <RegisterTable rows={register} currency={currency} />
                      <footer>
                        <span>Showing {register.length} of {payload.register?.length || 0}</span>
                        <strong>Net total {compactMoney(payload.run.net, currency)}</strong>
                      </footer>
                    </section>
                  )}

                  {tab === 'statutory' && (
                    <div className="payroll-mobile-panels">
                      <CostSplit rows={costSplit} currency={currency} />
                      <Statutory rows={statutory} currency={currency} />
                    </div>
                  )}
                </div>

                <aside className="payroll-rail">
                  <ExceptionRail exceptions={exceptions} />
                  <CostSplit rows={costSplit} currency={currency} />
                  <Statutory rows={statutory} currency={currency} />
                </aside>
              </div>

              <div className="payroll-mobile-submit">
                <Button
                  variant="indigo"
                  disabled={payload.run.docstatus !== 0 || payload.run.held > 0}
                  onClick={() => setSubmitOpen(true)}
                >
                  Submit run
                </Button>
              </div>
            </div>
          );
        }}
      </Async>

      <CreatePayrollModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={onCreated} />
      <SubmitModal open={submitOpen} run={run} onClose={() => setSubmitOpen(false)} onDone={state.reload} />
    </>
  );
}
