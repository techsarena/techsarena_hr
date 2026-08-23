import { useMemo, useState } from 'react';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { useWorkspace } from '../hooks/WorkspaceContext';
import {
  Async, Button, Card, Drawer, EmptyState, Field, Pill, SearchInput, Tabs,
} from '../components/ui';
import { Icon } from '../components/Icon';
import { fmtDate, fmtMoney, isoDate, statusTone } from '../api/format';

/**
 * Employee lifecycle: promotions, transfers and grievances.
 *
 * Promotion and transfer changes are expressed as {fieldname: newValue}; the
 * server reads each field's *current* value itself, so a stale form cannot
 * write back a wrong before-state.
 */

/* ---------- Shared: property-change editor ---------- */
function ChangeEditor({ fields, changes, onChange }) {
  const [field, setField] = useState('');
  const [value, setValue] = useState('');

  const add = () => {
    if (!field || !value) return;
    onChange({ ...changes, [field]: value });
    setField('');
    setValue('');
  };

  const remove = (key) => {
    const next = { ...changes };
    delete next[key];
    onChange(next);
  };

  const labelFor = (key) => fields.find((f) => f.fieldname === key)?.label || key;

  return (
    <Card title="What changes" className="card--muted">
      {Object.keys(changes).length === 0 ? (
        <p className="small subtle" style={{ marginTop: 0 }}>
          Add at least one field to change.
        </p>
      ) : (
        <div className="stack" style={{ marginBottom: 'var(--space-3)' }}>
          {Object.entries(changes).map(([key, val]) => (
            <div key={key} className="row row--between">
              <span className="small">
                <strong>{labelFor(key)}</strong> → {val}
              </span>
              <Button size="sm" onClick={() => remove(key)}>Remove</Button>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid--2">
        <Field label="Field">
          <select value={field} onChange={(e) => setField(e.target.value)}>
            <option value="">Select…</option>
            {fields
              .filter((f) => !(f.fieldname in changes))
              .map((f) => (
                <option key={f.fieldname} value={f.fieldname}>{f.label}</option>
              ))}
          </select>
        </Field>
        <Field label="New value">
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="New value" />
        </Field>
      </div>
      <Button size="sm" onClick={add} disabled={!field || !value}>Add change</Button>
    </Card>
  );
}

/* ---------- Promotion ---------- */
function PromotionDrawer({ open, directory, fields, currency, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ employee: '', promotion_date: isoDate(new Date()), revised_ctc: '' });
  const [changes, setChanges] = useState({});
  const [busy, setBusy] = useState(false);

  const submit = async (andSubmit) => {
    setBusy(true);
    try {
      const result = await hr.createPromotion({
        employee: form.employee,
        promotion_date: form.promotion_date,
        revised_ctc: form.revised_ctc || undefined,
        changes,
        submit: andSubmit ? 1 : 0,
      });
      toast.success(result.message || (result.submitted ? 'Promotion applied.' : 'Promotion saved as a draft.'));
      setChanges({});
      onClose();
      onDone?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const ready = form.employee && Object.keys(changes).length > 0;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Promote an employee"
      subtitle="Submitting applies the change and writes work history"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button onClick={() => submit(false)} disabled={busy || !ready}>Save draft</Button>
          <Button variant="primary" onClick={() => submit(true)} disabled={busy || !ready}>
            {busy ? 'Saving…' : 'Promote'}
          </Button>
        </>
      }
    >
      <div className="fields">
        <Field label="Employee">
          <select value={form.employee} onChange={(e) => setForm({ ...form, employee: e.target.value })}>
            <option value="">Select an employee…</option>
            {directory.map((row) => (
              <option key={row.name} value={row.name}>{row.employee_name} — {row.name}</option>
            ))}
          </select>
        </Field>
        <div className="grid grid--2">
          <Field label="Effective date">
            <input
              type="date"
              value={form.promotion_date}
              onChange={(e) => setForm({ ...form, promotion_date: e.target.value })}
            />
          </Field>
          <Field label="Revised CTC" hint="Optional">
            <input
              type="number"
              value={form.revised_ctc}
              onChange={(e) => setForm({ ...form, revised_ctc: e.target.value })}
              placeholder={currency || ''}
            />
          </Field>
        </div>
        <ChangeEditor fields={fields} changes={changes} onChange={setChanges} />
        <p className="small subtle">
          A promotion dated in the future is saved as a draft — HRMS applies it on or after its date.
        </p>
      </div>
    </Drawer>
  );
}

/* ---------- Transfer ---------- */
function TransferDrawer({ open, directory, fields, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({
    employee: '',
    transfer_date: isoDate(new Date()),
    new_company: '',
    reallocate_leaves: false,
    create_new_employee_id: false,
  });
  const [changes, setChanges] = useState({});
  const [busy, setBusy] = useState(false);

  const submit = async (andSubmit) => {
    if (andSubmit && form.create_new_employee_id && !window.confirm(
      'Creating a new employee ID marks the current record as Left and issues a new one. Continue?',
    )) return;

    setBusy(true);
    try {
      const result = await hr.createTransfer({
        employee: form.employee,
        transfer_date: form.transfer_date,
        new_company: form.new_company || undefined,
        reallocate_leaves: form.reallocate_leaves ? 1 : 0,
        create_new_employee_id: form.create_new_employee_id ? 1 : 0,
        changes,
        submit: andSubmit ? 1 : 0,
      });
      toast.success(result.message || (result.submitted ? 'Transfer applied.' : 'Transfer saved as a draft.'));
      setChanges({});
      onClose();
      onDone?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const ready = form.employee && Object.keys(changes).length > 0;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Transfer an employee"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button onClick={() => submit(false)} disabled={busy || !ready}>Save draft</Button>
          <Button variant="primary" onClick={() => submit(true)} disabled={busy || !ready}>
            {busy ? 'Saving…' : 'Transfer'}
          </Button>
        </>
      }
    >
      <div className="fields">
        <Field label="Employee">
          <select value={form.employee} onChange={(e) => setForm({ ...form, employee: e.target.value })}>
            <option value="">Select an employee…</option>
            {directory.map((row) => (
              <option key={row.name} value={row.name}>{row.employee_name} — {row.name}</option>
            ))}
          </select>
        </Field>
        <div className="grid grid--2">
          <Field label="Effective date">
            <input
              type="date"
              value={form.transfer_date}
              onChange={(e) => setForm({ ...form, transfer_date: e.target.value })}
            />
          </Field>
          <Field label="New company" hint="Only for an inter-company move">
            <input
              value={form.new_company}
              onChange={(e) => setForm({ ...form, new_company: e.target.value })}
            />
          </Field>
        </div>

        <label className="row" style={{ gap: 8, marginBottom: 0, cursor: 'pointer' }}>
          <input
            type="checkbox"
            className="checkbox"
            checked={form.reallocate_leaves}
            onChange={(e) => setForm({ ...form, reallocate_leaves: e.target.checked })}
          />
          <span style={{ fontWeight: 500, color: 'var(--ink)' }}>Reallocate leave balances</span>
        </label>

        <label className="row" style={{ gap: 8, marginBottom: 0, cursor: 'pointer' }}>
          <input
            type="checkbox"
            className="checkbox"
            checked={form.create_new_employee_id}
            onChange={(e) => setForm({ ...form, create_new_employee_id: e.target.checked })}
          />
          <span style={{ fontWeight: 500, color: 'var(--ink)' }}>Issue a new employee ID</span>
        </label>
        {form.create_new_employee_id && (
          <p className="small" style={{ color: 'var(--warning)', margin: 0 }}>
            The current employee record will be marked Left and a new one created.
          </p>
        )}

        <ChangeEditor fields={fields} changes={changes} onChange={setChanges} />
      </div>
    </Drawer>
  );
}

/* ---------- Grievance resolution ---------- */
function GrievanceDrawer({ record, onClose, onDone }) {
  const toast = useToast();
  const [status, setStatus] = useState(record?.status || 'Investigated');
  const [detail, setDetail] = useState('');
  const [cause, setCause] = useState('');
  const [busy, setBusy] = useState(false);

  if (!record) return null;

  const save = async () => {
    setBusy(true);
    try {
      await hr.resolveGrievance(record.name, status, detail || undefined, cause || undefined);
      toast.success('Grievance updated.');
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
      open
      onClose={onClose}
      title={record.subject}
      subtitle={`${record.grievance_type} · raised ${fmtDate(record.date)}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Update'}
          </Button>
        </>
      }
    >
      <div className="fields">
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {['Open', 'Investigated', 'Resolved', 'Invalid'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Cause" hint="What was found">
          <textarea rows={3} value={cause} onChange={(e) => setCause(e.target.value)} />
        </Field>
        <Field label="Resolution" hint="Recorded when resolving or dismissing">
          <textarea rows={4} value={detail} onChange={(e) => setDetail(e.target.value)} />
        </Field>
      </div>
    </Drawer>
  );
}

export default function Lifecycle() {
  const { currency, directory } = useWorkspace();
  const [tab, setTab] = useState('promotions');
  const [query, setQuery] = useState('');
  const [promoting, setPromoting] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [grievance, setGrievance] = useState(null);

  const fieldsState = useAsync(({ signal }) => hr.propertyFields({ signal }), []);
  const promotionsState = useAsync(({ signal }) => hr.promotions(undefined, { signal }), []);
  const transfersState = useAsync(({ signal }) => hr.transfers(undefined, { signal }), []);
  const grievancesState = useAsync(({ signal }) => hr.grievances(undefined, { signal }), []);

  const fields = fieldsState.data?.fields || [];

  const filterRows = (rows, keys) => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => keys.map((k) => row[k] || '').join(' ').toLowerCase().includes(q));
  };

  const tabs = useMemo(
    () => [
      { id: 'promotions', label: 'Promotions' },
      { id: 'transfers', label: 'Transfers' },
      { id: 'grievances', label: 'Grievances' },
    ],
    [],
  );

  return (
    <div className="stack">
      <div className="row row--between page-head" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <div>
          <h1 className="page-head__title">Lifecycle</h1>
          <p className="page-head__sub">Promotions, transfers and grievances</p>
        </div>
        <div className="row" style={{ gap: 'var(--space-3)' }}>
          <SearchInput value={query} onChange={setQuery} placeholder="Search people…" />
          {tab === 'promotions' && (
            <Button variant="primary" onClick={() => setPromoting(true)}>
              <Icon name="target" size={15} />
              Promote
            </Button>
          )}
          {tab === 'transfers' && (
            <Button variant="primary" onClick={() => setTransferring(true)}>
              <Icon name="external" size={15} />
              Transfer
            </Button>
          )}
        </div>
      </div>

      <Tabs items={tabs} value={tab} onChange={setTab} />

      {tab === 'promotions' && (
        <Async state={promotionsState} rows={5}>
          {(data) => {
            const rows = filterRows(data.promotions || [], ['employee_name', 'employee', 'department']);
            if (!data.available) {
              return <EmptyState title="Unavailable" body="Employee Promotion is not installed." icon="◷" />;
            }
            if (!rows.length) {
              return <EmptyState title="No promotions" body="Promotions will appear here." icon="◎" />;
            }
            return (
              <Card flush>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr><th>Employee</th><th>Date</th><th>Changes</th><th>Revised CTC</th><th>State</th></tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.name}>
                          <td>
                            <div className="cell-strong">{row.employee_name || row.employee}</div>
                            <div className="small subtle">{row.department || '—'}</div>
                          </td>
                          <td className="subtle">{fmtDate(row.promotion_date)}</td>
                          <td className="small">
                            {(row.changes || []).map((c) => `${c.property}: ${c.current || '—'} → ${c.new}`).join('; ') || '—'}
                          </td>
                          <td className="subtle">{row.revised_ctc ? fmtMoney(row.revised_ctc, row.salary_currency || currency) : '—'}</td>
                          <td><Pill tone={row.docstatus === 1 ? 'success' : 'warning'}>{row.docstatus === 1 ? 'Applied' : 'Draft'}</Pill></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            );
          }}
        </Async>
      )}

      {tab === 'transfers' && (
        <Async state={transfersState} rows={5}>
          {(data) => {
            const rows = filterRows(data.transfers || [], ['employee_name', 'employee', 'department']);
            if (!data.available) {
              return <EmptyState title="Unavailable" body="Employee Transfer is not installed." icon="◷" />;
            }
            if (!rows.length) {
              return <EmptyState title="No transfers" body="Transfers will appear here." icon="◎" />;
            }
            return (
              <Card flush>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr><th>Employee</th><th>Date</th><th>Changes</th><th>New company</th><th>State</th></tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.name}>
                          <td>
                            <div className="cell-strong">{row.employee_name || row.employee}</div>
                            <div className="small subtle">{row.department || '—'}</div>
                          </td>
                          <td className="subtle">{fmtDate(row.transfer_date)}</td>
                          <td className="small">
                            {(row.changes || []).map((c) => `${c.property}: ${c.current || '—'} → ${c.new}`).join('; ') || '—'}
                          </td>
                          <td className="subtle">{row.new_company || '—'}</td>
                          <td><Pill tone={row.docstatus === 1 ? 'success' : 'warning'}>{row.docstatus === 1 ? 'Applied' : 'Draft'}</Pill></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            );
          }}
        </Async>
      )}

      {tab === 'grievances' && (
        <Async state={grievancesState} rows={5}>
          {(data) => {
            const rows = filterRows(data.grievances || [], ['subject', 'employee_name', 'grievance_type']);
            if (!data.available) {
              return <EmptyState title="Unavailable" body="Employee Grievance is not installed." icon="◷" />;
            }
            if (!rows.length) {
              return <EmptyState title="No grievances" body="Nothing has been raised." icon="◎" />;
            }
            return (
              <Card flush>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr><th>Subject</th><th>Type</th><th>Raised by</th><th>Date</th><th>Status</th><th /></tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.name}>
                          <td className="cell-strong">{row.subject}</td>
                          <td className="subtle">{row.grievance_type}</td>
                          <td className="subtle">{row.employee_name || row.raised_by}</td>
                          <td className="subtle">{fmtDate(row.date)}</td>
                          <td><Pill tone={statusTone(row.status)}>{row.status}</Pill></td>
                          <td style={{ textAlign: 'right' }}>
                            {data.can_manage && (
                              <Button size="sm" onClick={() => setGrievance(row)}>Review</Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            );
          }}
        </Async>
      )}

      <PromotionDrawer
        open={promoting}
        directory={directory}
        fields={fields}
        currency={currency}
        onClose={() => setPromoting(false)}
        onDone={promotionsState.reload}
      />
      <TransferDrawer
        open={transferring}
        directory={directory}
        fields={fields}
        onClose={() => setTransferring(false)}
        onDone={transfersState.reload}
      />
      <GrievanceDrawer
        record={grievance}
        onClose={() => setGrievance(null)}
        onDone={grievancesState.reload}
      />
    </div>
  );
}
