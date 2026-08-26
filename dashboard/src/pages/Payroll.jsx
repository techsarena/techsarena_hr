import { useMemo, useState } from 'react';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { useToast } from '../hooks/useToast';
import { Async, Button, Modal, Pill, SearchInput } from '../components/ui';
import { exportCsv } from '../components/DataTable';
import { Icon } from '../components/Icon';
import { fmtDateShort, fmtMoney, fmtRange, initials, monthLabel, toDate } from '../api/format';
import { t } from '../api/i18n';

const TABS = [
  { id: 'run', label: t("Run") },
  { id: 'register', label: t("Register") },
  { id: 'statutory', label: t("Statutory") },
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
      title={t("Submit this payroll run")}
      subtitle={fmtRange(run.start_date, run.end_date)}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
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
            <p>{t("Clear held rows before submitting this run.")}</p>
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
      title={t("Create payroll")}
      subtitle={t("Draft only")}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
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
            <span>{t("Employees")}</span>
            <strong>{t("All active staff")}</strong>
          </div>
          <div>
            <span>{t("Pay day")}</span>
            <strong>{fmtDateShort(form.end_date)}</strong>
          </div>
          <p>{t("Nothing is paid or visible to employees until you submit the run.")}</p>
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

/* ---------- Step 1: build (or submit) a salary structure ---------- */
function StructureStep({ onDone }) {
  const toast = useToast();
  const components = useAsync(({ signal }) => hr.salaryComponents({ signal }), []);
  const drafts = useAsync(({ signal }) => hr.draftSalaryStructures({ signal }), []);
  const [name, setName] = useState('');
  const [earnings, setEarnings] = useState([{ salary_component: '', amount: '' }]);
  const [deductions, setDeductions] = useState([]);
  const [busy, setBusy] = useState(false);

  const earningOptions = components.data?.earnings || [];
  const deductionOptions = components.data?.deductions || [];
  const draftRows = drafts.data || [];

  const setRow = (list, setList, index, field, value) =>
    setList(list.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  const addRow = (list, setList) => setList([...list, { salary_component: '', amount: '' }]);
  const dropRow = (list, setList, index) => setList(list.filter((unused, i) => i !== index));

  const submitDraft = async (structure) => {
    setBusy(true);
    try {
      await hr.submitSalaryStructure(structure);
      toast.success(`${structure} submitted — it can now be assigned.`);
      onDone?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      const clean = (list) =>
        list
          .filter((row) => row.salary_component)
          .map((row) => ({ salary_component: row.salary_component, amount: Number(row.amount) || 0 }));
      const result = await hr.createSalaryStructure({
        structure_name: name.trim(),
        earnings: clean(earnings),
        deductions: clean(deductions),
        submit: 1,
      });
      toast.success(`${result.name} created and submitted.`);
      onDone?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const rowsFor = (list, setList, options, label) => (
    <div className="stack">
      <strong className="small">{label}</strong>
      {list.length === 0 && <p className="small subtle">{t("None added.")}</p>}
      {list.map((row, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <div className="payroll-comp-row" key={index}>
          <select
            value={row.salary_component}
            onChange={(event) => setRow(list, setList, index, 'salary_component', event.target.value)}
          >
            <option value="">{t("Select component…")}</option>
            {options.map((option) => (
              <option key={option.name} value={option.name}>{option.name}</option>
            ))}
          </select>
          <input
            type="number"
            min="0"
            placeholder={t("Amount")}
            value={row.amount}
            onChange={(event) => setRow(list, setList, index, 'amount', event.target.value)}
          />
          <Button size="icon" onClick={() => dropRow(list, setList, index)} aria-label={t("Remove")}>
            <Icon name="close" size={14} />
          </Button>
        </div>
      ))}
      <Button size="sm" onClick={() => addRow(list, setList)}>
        <Icon name="plus" size={13} /> Add {label.toLowerCase()}
      </Button>
    </div>
  );

  return (
    <div className="stack">
      {draftRows.length > 0 && (
        <div className="payroll-alert payroll-alert--warning">
          <strong>{t("You already have a draft structure")}</strong>
          <p>Submitting it is faster than building a new one — a draft cannot be assigned.</p>
          <div className="payroll-actions payroll-actions--wrap" style={{ marginTop: 8 }}>
            {draftRows.map((row) => (
              <Button key={row.name} variant="indigo" size="sm" disabled={busy} onClick={() => submitDraft(row.name)}>
                Submit “{row.name}”
              </Button>
            ))}
          </div>
        </div>
      )}

      <label className="payroll-field">
        New structure name
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("e.g. Standard Monthly")} />
      </label>

      {rowsFor(earnings, setEarnings, earningOptions, 'Earnings')}
      {rowsFor(deductions, setDeductions, deductionOptions, 'Deductions')}

      <div className="row row--between">
        <p className="small subtle">{t("Creating submits the structure so it is immediately assignable.")}</p>
        <Button
          variant="indigo"
          disabled={busy || !name.trim() || !earnings.some((row) => row.salary_component)}
          onClick={create}
        >
          {busy ? 'Creating…' : 'Create & submit'}
        </Button>
      </div>
    </div>
  );
}

/** Assigns a salary structure to the employees who have none, without
 *  leaving the dashboard. Structures come from the server already filtered to
 *  submitted+active ones, so an unassignable draft never appears here. */
function AssignStep({ onDone }) {
  const toast = useToast();
  const structures = useAsync(({ signal }) => hr.salaryStructures({ signal }), []);
  const people = useAsync(({ signal }) => hr.unassignedEmployees({ signal }), []);
  const [structure, setStructure] = useState('');
  const [base, setBase] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const rows = people.data || [];
  const options = structures.data || [];

  const toggle = (name) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const assign = async () => {
    setBusy(true);
    // Assign one at a time so a single bad row cannot void the whole batch,
    // and report exactly which employees failed.
    const failed = [];
    for (const employee of picked) {
      try {
        await hr.assignSalaryStructure(employee, structure, base || 0);
      } catch (error) {
        failed.push(`${employee}: ${error.message}`);
      }
    }
    setBusy(false);
    const done = picked.size - failed.length;
    if (done > 0) toast.success(`Assigned ${done} employee${done === 1 ? '' : 's'}.`);
    if (failed.length) toast.error(failed[0]);
    if (done > 0) {
      setPicked(new Set());
      people.reload();
      onDone?.();
    }
  };

  return (
    <div className="stack">
        {options.length === 0 ? (
          <div className="payroll-alert payroll-alert--warning">
            <strong>{t("No submitted salary structure")}</strong>
            <p>
              A salary structure must be created and submitted before it can be assigned.
              Create one in Payroll settings, then come back here.
            </p>
          </div>
        ) : (
          <>
            <label className="payroll-field">
              Salary structure
              <select value={structure} onChange={(event) => setStructure(event.target.value)}>
                <option value="">{t("Select a structure…")}</option>
                {options.map((row) => (
                  <option key={row.name} value={row.name}>
                    {row.name}{row.currency ? ` (${row.currency})` : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className="payroll-field">
              Base amount <span className="subtle">— optional, applies to everyone selected</span>
              <input
                type="number"
                min="0"
                value={base}
                onChange={(event) => setBase(event.target.value)}
                placeholder={t("Leave blank to use the structure's own base")}
              />
            </label>

            {rows.length === 0 ? (
              <p className="small subtle">{t("Every active employee already has an assignment.")}</p>
            ) : (
              <>
                <div className="row row--between">
                  <strong className="small">{rows.length} unassigned</strong>
                  <Button
                    size="sm"
                    onClick={() =>
                      setPicked((prev) =>
                        prev.size === rows.length ? new Set() : new Set(rows.map((r) => r.name)),
                      )
                    }
                  >
                    {picked.size === rows.length ? 'Clear all' : 'Select all'}
                  </Button>
                </div>
                <div className="payroll-assign-list">
                  {rows.map((row) => (
                    <label className="payroll-assign-row" key={row.name}>
                      <input
                        type="checkbox"
                        checked={picked.has(row.name)}
                        onChange={() => toggle(row.name)}
                      />
                      <span className="truncate">
                        <strong>{row.employee_name}</strong>
                        <em className="subtle">{row.department || row.designation || row.name}</em>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="row row--between">
                  <p className="small subtle">
                    Assignments are backdated to each employee&apos;s joining date so the
                    current period is covered.
                  </p>
                  <Button
                    variant="indigo"
                    onClick={assign}
                    disabled={busy || !structure || picked.size === 0}
                  >
                    {busy ? 'Assigning…' : `Assign ${picked.size || ''}`.trim()}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
    </div>
  );
}

/* ---------- Step: add a salary component ---------- */
function ComponentStep({ onDone }) {
  const toast = useToast();
  const components = useAsync(({ signal }) => hr.salaryComponents({ signal }), []);
  const [name, setName] = useState('');
  const [type, setType] = useState('Earning');
  const [busy, setBusy] = useState(false);

  const existing = [...(components.data?.earnings || []), ...(components.data?.deductions || [])];

  const create = async () => {
    setBusy(true);
    try {
      await hr.createSalaryComponent(name.trim(), type);
      toast.success(`${name.trim()} added.`);
      setName('');
      components.reload();
      onDone?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <p className="small subtle">
        {existing.length} component{existing.length === 1 ? '' : 's'} configured:{' '}
        {existing.map((row) => row.name).join(', ') || 'none yet'}
      </p>
      <div className="payroll-comp-row">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("Component name")} />
        <select value={type} onChange={(event) => setType(event.target.value)}>
          <option>{t("Earning")}</option>
          <option>{t("Deduction")}</option>
        </select>
        <Button variant="indigo" disabled={busy || !name.trim()} onClick={create}>
          {busy ? 'Adding…' : 'Add'}
        </Button>
      </div>
    </div>
  );
}

/* ---------- The guided setup, all in-app ---------- */
const STEP_TITLES = {
  components: 'Salary components',
  structures: 'Salary structure',
  assignments: 'Assign employees',
  payable: 'Payment account',
};

function SetupWizard({ open, onClose, checks, onChanged }) {
  const [step, setStep] = useState(null);
  if (!open) return null;

  // Open on the first unfinished step so the user lands where the work is.
  const order = ['components', 'structures', 'assignments', 'payable'];
  const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
  const active = step || order.find((id) => byId[id] && !byId[id].done) || 'components';

  return (
    <Modal
      open
      onClose={onClose}
      title={t("Set up payroll")}
      subtitle={t("Complete each step here — nothing needs the Desk UI")}
      footer={<Button onClick={onClose}>{t("Close")}</Button>}
    >
      <div className="payroll-wizard">
        <div className="payroll-wizard__steps">
          {order.filter((id) => byId[id]).map((id, index) => (
            <button
              type="button"
              key={id}
              className={`payroll-wizard__step${active === id ? ' is-active' : ''}${byId[id].done ? ' is-done' : ''}`}
              onClick={() => setStep(id)}
            >
              <span>{byId[id].done ? <Icon name="check" size={13} /> : index + 1}</span>
              {STEP_TITLES[id]}
            </button>
          ))}
        </div>

        <div className="payroll-wizard__body">
          {active === 'components' && <ComponentStep onDone={onChanged} />}
          {active === 'structures' && <StructureStep onDone={onChanged} />}
          {active === 'assignments' && <AssignStep onDone={onChanged} />}
          {active === 'payable' && (
            <div className="stack">
              <p className="small">
                {byId.payable?.done
                  ? byId.payable.body
                  : 'A default payroll payable account must be set on the Company record before slips can be submitted. This one lives in ERPNext company accounting settings.'}
              </p>
              {!byId.payable?.done && (
                <Button onClick={() => { window.location.href = '/app/payroll-settings'; }}>
                  Open payroll settings
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function EmptyPayroll({ onCreate }) {
  const readiness = useAsync(({ signal }) => hr.payrollReadiness({ signal }), []);
  const [setupOpen, setSetupOpen] = useState(false);
  const data = readiness.data;
  const checks = data?.checks || [];
  const ready = data?.ready ?? false;

  // Every step is completed in-app; the wizard opens on the one that is due.
  const runAction = () => setSetupOpen(true);

  return (
    <div className="payroll-page payroll-page--empty">
      <div className="payroll-head">
        <div className="row">
          <h1>{t("Payroll")}</h1>
          <Pill>{t("No runs yet")}</Pill>
        </div>
        <div className="payroll-actions">
          <Button onClick={() => { window.location.href = '/app/payroll-settings'; }}>{t("Payroll settings")}</Button>
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
              <h2>{t("No payroll has been run yet")}</h2>
              <p>
                {ready
                  ? 'Everything the first run needs is in place. Creating a payroll entry generates a draft salary slip for every employee, which you can review before submitting.'
                  : `${data?.unassigned_employees || 0} of ${data?.active_employees || 0} active employees cannot be paid yet. Finish the steps below, then create the run.`}
              </p>
              <div className="payroll-actions payroll-actions--wrap">
                <Button variant="indigo" onClick={onCreate} disabled={!ready}>
                  <Icon name="plus" size={15} /> Create payroll for this month
                </Button>
                {!ready && (
                  <Button onClick={() => setSetupOpen(true)}>{t("Set up payroll")}</Button>
                )}
              </div>
            </div>
          </section>

          <section className="payroll-panel payroll-checklist">
            <header>
              <h3>{t("Before the first run")}</h3>
              <Pill tone={ready ? 'success' : 'warning'}>
                {readiness.loading ? 'Checking…' : `${data?.ready_count ?? 0} of ${checks.length || 4} ready`}
              </Pill>
            </header>
            <Async state={readiness} rows={4}>
              {() => checks.map((check, index) => (
                <div className={`payroll-check${check.done ? ' is-done' : ' is-warning'}`} key={check.id}>
                  <span>{check.done ? <Icon name="check" size={15} /> : index + 1}</span>
                  <div>
                    <strong>{check.title}</strong>
                    <p>{check.body}</p>
                  </div>
                  {check.done ? (
                    <em>{t("Done")}</em>
                  ) : (
                    <Button size="sm" onClick={runAction}>
                      {check.action_label}
                    </Button>
                  )}
                </div>
              ))}
            </Async>
          </section>
        </div>

        <aside className="payroll-rail">
          <section className="payroll-panel">
            <h3>{t("What the run will cover")}</h3>
            <div className="payroll-facts">
              <span>{t("Period")}</span><strong>{t("This month")}</strong>
              <span>{t("Employees")}</span>
              <strong>
                {data
                  ? `${data.assigned_employees} of ${data.active_employees} assigned`
                  : 'All active'}
              </strong>
              <span>{t("Estimated gross")}</span><strong>{t("Calculated on create")}</strong>
              <span>{t("Pay day")}</span><strong>{t("Period end")}</strong>
            </div>
            <p className="small subtle">Estimate from current structures; draft slips will carry the real figures.</p>
          </section>
          <section className="payroll-panel">
            <h3>{t("What happens next")}</h3>
            {['Payroll Entry is created for the period.', 'Draft Salary Slips are generated.', 'You review the register and clear exceptions.', 'Submitting posts the slips and releases payslips.'].map((step, index) => (
              <div className="payroll-next-step" key={step}>
                <span>{index + 1}</span>
                <p>{step}</p>
              </div>
            ))}
          </section>
          <section className="payroll-panel">
            <h3>{t("Past runs")}</h3>
            <p className="small subtle">No payroll history in this company yet. Runs imported as closed periods stay searchable.</p>
          </section>
        </aside>
      </div>

      <SetupWizard
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        checks={checks}
        onChanged={readiness.reload}
      />
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
        <p>{t("Step 3 of 5 · validation")}</p>
      </div>
      <div className="payroll-run-hero__stats">
        <div><span>{t("Gross")}</span><strong>{compactMoney(run.gross, currency)}</strong><em>{delta === null ? 'Current run' : `${delta >= 0 ? '+' : ''}${compactMoney(delta, currency)} vs last run`}</em></div>
        <div><span>{t("Deductions")}</span><strong>{compactMoney(run.deductions, currency)}</strong><em>{t("PF, tax, loans")}</em></div>
        <div><span>{t("Slips generated")}</span><strong>{run.slips_generated} / {run.employees}</strong><em>{run.held ? `${run.held} held` : 'Ready'}</em></div>
      </div>
    </section>
  );
}

function Workflow({ run, exceptions }) {
  const steps = [
    { title: t("Attendance locked"), meta: fmtDateShort(run.start_date), done: true },
    { title: t("Slips generated"), meta: fmtDateShort(run.posting_date || run.end_date), done: run.slips_generated > 0 },
    { title: t("Validation"), meta: exceptions.length ? `${exceptions.length} exceptions` : 'Clear', active: true },
    { title: t("Approval"), meta: `Due ${fmtDateShort(run.end_date)}` },
    { title: t("Bank file"), meta: fmtDateShort(run.posting_date || run.end_date) },
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
    return <div className="payroll-table-empty">{t("No employees match that filter.")}</div>;
  }

  return (
    <div className="payroll-table-wrap">
      <table className="payroll-table">
        <thead>
          <tr>
            <th>{t("Employee")}</th>
            <th>{t("Structure")}</th>
            <th className="num">{t("Gross")}</th>
            <th className="num">{t("Deductions")}</th>
            <th className="num">{t("Net")}</th>
            <th>{t("Status")}</th>
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
              <td>{row.salary_structure || <em>{t("Missing")}</em>}</td>
              <td className="num">{fmtMoney(row.gross_pay, currency)}</td>
              <td className="num">{fmtMoney(row.total_deduction, currency)}</td>
              <td className="num"><strong>{fmtMoney(row.net_pay, currency)}</strong></td>
              <td>
                {row.held ? <Pill tone="danger">{t("Held")}</Pill> : row.changed ? <Pill tone="warning">{t("Changed")}</Pill> : <Pill tone="success">{t("Ready")}</Pill>}
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
        <p className="small subtle">{t("No payroll exceptions are blocking this run.")}</p>
      )}
    </section>
  );
}

function CostSplit({ rows, currency }) {
  const total = rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  return (
    <section className="payroll-panel">
      <h3>{t("Cost split")}</h3>
      {rows.length ? rows.slice(0, 5).map((row) => {
        const pct = total ? (Number(row.amount || 0) / total) * 100 : 0;
        return (
          <div className="payroll-cost-row" key={row.department || row.label}>
            <div><span>{row.department || row.label || 'Unassigned'} · {row.headcount || 0}</span><strong>{compactMoney(row.amount, currency)}</strong></div>
            <div className="meter"><div className="meter__fill" style={{ width: `${pct}%` }} /></div>
          </div>
        );
      }) : <p className="small subtle">{t("No split available yet.")}</p>}
    </section>
  );
}

function Statutory({ rows, currency }) {
  return (
    <section className="payroll-panel">
      <h3>{t("Statutory")}</h3>
      {rows.length ? rows.slice(0, 5).map((row) => (
        <div className="payroll-line" key={row.component || row.label}>
          <span>{row.component || row.label}</span>
          <strong>{compactMoney(row.amount, currency)}</strong>
        </div>
      )) : <p className="small subtle">{t("No statutory components in this run.")}</p>}
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
      { key: 'employee_name', header: t("Employee"), exportValue: (row) => row.employee_name || row.employee },
      { key: 'salary_structure', header: t("Structure"), exportValue: (row) => row.salary_structure || '' },
      { key: 'gross_pay', header: t("Gross"), exportValue: (row) => row.gross_pay || '' },
      { key: 'total_deduction', header: t("Deductions"), exportValue: (row) => row.total_deduction || '' },
      { key: 'net_pay', header: t("Net"), exportValue: (row) => row.net_pay || '' },
      { key: 'status', header: t("Status"), exportValue: (row) => (row.held ? 'Held' : row.changed ? 'Changed' : 'Ready') },
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
                    <span className="payroll-title-desktop">{t("Payroll")}</span>
                    <span className="payroll-title-mobile">{monthRunLabel(payload.run.start_date)}</span>
                  </h1>
                  <p>{periodLabel(payload.run.start_date, payload.run.end_date)}</p>
                </div>
                <div className="payroll-actions">
                  {payload.runs?.length > 0 && (
                    <select
                      value={payload.run.name || ''}
                      onChange={(event) => setRunName(event.target.value)}
                      aria-label={t("Payroll period")}
                    >
                      {payload.runs.map((entry) => (
                        <option key={entry.name} value={entry.name}>
                          {monthLabel(entry.start_date)} · {entry.status}
                        </option>
                      ))}
                    </select>
                  )}
                  <Button onClick={() => setTab('register')}>{t("Preview register")}</Button>
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
                        <h3>{t("Salary register")}</h3>
                        <div className="payroll-register-tools">
                          <Pill tone="danger">Held {payload.run.held}</Pill>
                          <Pill>All {payload.register?.length || 0}</Pill>
                          <SearchInput value={query} onChange={setQuery} placeholder={t("Filter employees…")} />
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
