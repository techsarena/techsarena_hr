/**
 * My profile — the employee's own record, and the two things they can do to it:
 * request a correction, and file a document.
 *
 * Contact and bank details feed payroll and statutory filings, so nothing here
 * writes to Employee directly. A change is staged as a request and applied by
 * HR on approval; the form is built from what the server says is editable, so
 * it can never offer a field the backend would reject.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { hr } from '../api/hr';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { useAsync, useMutation } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import {
  Async, Avatar, Button, Card, Drawer, EmptyState, Field, FieldRow, Pill, Tabs,
} from '../components/ui';

/** True when at least one of these values is worth rendering a card for. */
const hasAny = (...values) => values.some((v) => v !== null && v !== undefined && v !== '');
import { Icon } from '../components/Icon';
import { fmtDate, fmtDateShort } from '../api/format';

const TABS = [
  { id: 'details', label: 'Details' },
  { id: 'documents', label: 'Documents' },
  { id: 'requests', label: 'Change requests' },
];

const EXPIRY_LABEL = (doc) => {
  if (doc.expiry_state === 'expired') return `Expired ${fmtDateShort(doc.expires_on)}`;
  if (doc.expiry_state === 'expiring') return `Expires in ${doc.days_to_expiry}d`;
  if (doc.expiry_state === 'valid') return `Valid to ${fmtDateShort(doc.expires_on)}`;
  return null;
};

export default function Profile() {
  const { profile } = useWorkspace();
  const [tab, setTab] = useState('details');

  const detail = useAsync(({ signal }) => hr.employeeProfile(undefined, { signal }), []);
  const docs = useAsync(({ signal }) => hr.employeeDocuments(undefined, { signal }), []);
  const requests = useAsync(({ signal }) => hr.myProfileChangeRequests({ signal }), []);

  const pendingCount = requests.data?.pending || 0;
  const alertCount = (docs.data?.counts?.expiring || 0) + (docs.data?.counts?.expired || 0);

  const tabs = useMemo(
    () => TABS.map((t) => ({
      ...t,
      // A zero count would render an empty badge; only show a live figure.
      count: t.id === 'requests' ? (pendingCount || undefined)
        : t.id === 'documents' ? (alertCount || undefined)
        : undefined,
    })),
    [pendingCount, alertCount],
  );

  return (
    <div className="stack">
      <div className="page-head">
        <h1 className="page-head__title">My profile</h1>
        <p className="page-head__sub">Your record, documents, and any corrections you have asked for</p>
      </div>

      <Card>
        <div className="row" style={{ gap: 'var(--space-4)', alignItems: 'center' }}>
          <Avatar name={profile?.employee_name} src={profile?.image} size="lg" />
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            <h2 className="card__title truncate">{profile?.employee_name}</h2>
            <p className="card__sub truncate">
              {[profile?.designation, profile?.department].filter(Boolean).join(' · ')}
            </p>
            {profile?.date_of_joining && (
              <p className="small subtle">Joined {fmtDate(profile.date_of_joining)}</p>
            )}
          </div>
        </div>
      </Card>

      <Tabs items={tabs} value={tab} onChange={setTab} />

      {tab === 'details' && <DetailsTab state={detail} onChanged={requests.reload} />}
      {tab === 'documents' && <DocumentsTab state={docs} />}
      {tab === 'requests' && <RequestsTab state={requests} onChanged={() => { requests.reload(); detail.reload(); }} />}
    </div>
  );
}

/* ---------------------------------------------------------------- Details */

function DetailsTab({ state, onChanged }) {
  const [editing, setEditing] = useState(false);

  return (
    <Async state={state} rows={6}>
      {(data) => (
        <div className="stack">
          <div className="row row--between" style={{ flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            <p className="small subtle" style={{ margin: 0 }}>
              Contact and bank details are checked by HR before they take effect.
            </p>
            <Button variant="indigo" size="sm" onClick={() => setEditing(true)}>
              <Icon name="plus" size={14} /> Request a change
            </Button>
          </div>

          <div className="grid grid--2">
            <Card title="Personal">
              <FieldRow label="Date of birth" value={fmtDate(data.personal?.date_of_birth)} />
              <FieldRow label="Gender" value={data.personal?.gender} />
              <FieldRow label="Marital status" value={data.personal?.marital_status} />
              <FieldRow label="Blood group" value={data.personal?.blood_group} />
              <FieldRow label="Mobile" value={data.personal?.cell_number} />
              <FieldRow label="Personal email" value={data.personal?.personal_email} />
              <FieldRow label="Company email" value={data.personal?.company_email} />
              <FieldRow label="Current address" value={data.personal?.current_address} />
              <FieldRow label="Permanent address" value={data.personal?.permanent_address} />
            </Card>

            {/* An all-empty card reads as a broken panel; when nothing is on
                file, say so and point at the action that fixes it. */}
            <Card title="Emergency contact">
              {hasAny(
                data.personal?.person_to_be_contacted,
                data.personal?.relation,
                data.personal?.emergency_phone_number,
              ) ? (
                <>
                  <FieldRow label="Contact" value={data.personal?.person_to_be_contacted} />
                  <FieldRow label="Relation" value={data.personal?.relation} />
                  <FieldRow label="Phone" value={data.personal?.emergency_phone_number} />
                </>
              ) : (
                <p className="small subtle" style={{ margin: 0 }}>
                  Nothing on file. Use “Request a change” to add one.
                </p>
              )}
            </Card>

            <Card title="Employment">
              <FieldRow label="Employee ID" value={data.identity?.name} />
              <FieldRow label="Designation" value={data.identity?.designation} />
              <FieldRow label="Department" value={data.identity?.department} />
              <FieldRow label="Joined" value={fmtDate(data.job?.date_of_joining)} />
              <FieldRow label="Employment type" value={data.job?.employment_type} />
              <FieldRow label="Grade" value={data.job?.grade} />
              <FieldRow label="Manager" value={data.manager?.employee_name} />
            </Card>

            {data.can_view_statutory && (
              <Card title="Bank & statutory">
                {hasAny(
                  data.statutory?.bank_name,
                  data.statutory?.bank_ac_no,
                  data.statutory?.ifsc_code,
                  data.statutory?.pan_number,
                  data.statutory?.provident_fund_account,
                ) ? (
                  <>
                    <FieldRow label="Bank" value={data.statutory?.bank_name} />
                    <FieldRow label="Account number" value={data.statutory?.bank_ac_no} />
                    <FieldRow label="IFSC" value={data.statutory?.ifsc_code} />
                    <FieldRow label="Tax number" value={data.statutory?.pan_number} />
                    <FieldRow label="Provident fund" value={data.statutory?.provident_fund_account} />
                  </>
                ) : (
                  <p className="small subtle" style={{ margin: 0 }}>
                    No bank details on file. Payroll needs these before it can pay you.
                  </p>
                )}
              </Card>
            )}
          </div>

          <ChangeRequestDrawer
            open={editing}
            onClose={() => setEditing(false)}
            onDone={() => { setEditing(false); onChanged(); }}
          />
        </div>
      )}
    </Async>
  );
}

/* -------------------------------------------------- Change request drawer */

function ChangeRequestDrawer({ open, onClose, onDone }) {
  const toast = useToast();
  // Loaded lazily: the options call also returns current values, so fetching it
  // only when the drawer opens keeps the form seeded with fresh data.
  const options = useAsync(
    ({ signal }) => (open ? hr.profileChangeOptions({ signal }) : Promise.resolve(null)),
    [open],
  );
  const [draft, setDraft] = useState({});
  const [reason, setReason] = useState('');

  const submit = useMutation(async () => {
    const changed = Object.fromEntries(
      Object.entries(draft).filter(([, value]) => value !== undefined && value !== null),
    );
    if (Object.keys(changed).length === 0) {
      toast.error('Change at least one detail first.');
      return;
    }
    await hr.submitProfileChange(changed, reason);
    toast.success('Sent to HR for approval.');
    setDraft({});
    setReason('');
    onDone();
  });

  const set = (fieldname, value) => setDraft((d) => ({ ...d, [fieldname]: value }));

  // Only fields the user actually touched count as edits, so an untouched form
  // submits nothing even though every input is populated.
  const dirtyCount = Object.keys(draft).length;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Request a profile change"
      subtitle="HR reviews these before they take effect"
      footer={
        <div className="row row--between" style={{ width: '100%' }}>
          <span className="small subtle">
            {dirtyCount ? `${dirtyCount} field${dirtyCount === 1 ? '' : 's'} changed` : 'Nothing changed yet'}
          </span>
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="indigo" onClick={submit.mutate} disabled={submit.pending || !dirtyCount}>
              {submit.pending ? 'Sending…' : 'Send request'}
            </Button>
          </div>
        </div>
      }
    >
      <Async state={options} rows={5}>
        {(data) => (
          <div className="stack">
            {(data?.groups || []).map((group) => (
              <div className="col" style={{ gap: 'var(--space-3)' }} key={group.group}>
                <h4 className="card__title" style={{ textTransform: 'capitalize' }}>
                  {group.group === 'statutory' ? 'Bank & statutory' : group.group}
                </h4>
                {group.fields.map((field) => (
                  <ChangeField
                    key={field.fieldname}
                    field={field}
                    value={draft[field.fieldname] ?? field.value ?? ''}
                    dirty={field.fieldname in draft}
                    onChange={(v) => set(field.fieldname, v)}
                  />
                ))}
              </div>
            ))}

            <Field label="Reason (optional)" hint="Helps HR verify the change faster.">
              <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
        )}
      </Async>
    </Drawer>
  );
}

/** One editable field, rendered from the server's fieldtype. */
function ChangeField({ field, value, dirty, onChange }) {
  const label = (
    <>
      {field.label}
      {dirty && <span className="small" style={{ color: 'var(--indigo)' }}> · changed</span>}
    </>
  );

  if (field.fieldtype === 'Select') {
    const choices = (field.options || '').split('\n').filter(Boolean);
    return (
      <Field label={label}>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
        </select>
      </Field>
    );
  }

  if (field.fieldtype === 'Small Text' || field.fieldtype === 'Text') {
    return (
      <Field label={label}>
        <textarea rows={2} value={value} onChange={(e) => onChange(e.target.value)} />
      </Field>
    );
  }

  return (
    <Field label={label}>
      <input
        type={field.fieldtype === 'Date' ? 'date' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

/* -------------------------------------------------------------- Documents */

function DocumentsTab({ state }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);

  const remove = useMutation(async (name) => {
    await hr.deleteEmployeeDocument(name);
    toast.success('Document removed.');
    state.reload();
  });

  return (
    <Async state={state} rows={5}>
      {(data) => (
        <div className="stack">
          <div className="row row--between" style={{ flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            <div className="row" style={{ gap: 'var(--space-2)' }}>
              {data.counts.expired > 0 && <Pill tone="danger">{data.counts.expired} expired</Pill>}
              {data.counts.expiring > 0 && <Pill tone="warning">{data.counts.expiring} expiring soon</Pill>}
            </div>
            <Button variant="indigo" size="sm" onClick={() => setAdding(true)}>
              <Icon name="plus" size={14} /> Add document
            </Button>
          </div>

          {data.documents.length === 0 ? (
            <Card>
              <EmptyState
                title="No documents yet"
                body="Add your ID, passport, or certificates so HR has them on file."
                icon={<Icon name="checklist" size={22} />}
              />
            </Card>
          ) : (
            <Card flush>
              <ul className="doc-list">
                {data.documents.map((doc) => (
                  <li className={`doc-row doc-row--${doc.expiry_state}`} key={doc.name}>
                    <div className="col" style={{ gap: 2, minWidth: 0 }}>
                      <span className="row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
                        <strong className="truncate">{doc.title || doc.document_type}</strong>
                        {doc.is_verified
                          ? <Pill tone="success" dot>Verified</Pill>
                          : <Pill dot>Awaiting check</Pill>}
                      </span>
                      <span className="small subtle truncate">
                        {doc.document_type}
                        {doc.document_number ? ` · ${doc.document_number}` : ''}
                      </span>
                      {EXPIRY_LABEL(doc) && (
                        <span className={`small doc-row__expiry doc-row__expiry--${doc.expiry_state}`}>
                          {EXPIRY_LABEL(doc)}
                        </span>
                      )}
                    </div>
                    <div className="row" style={{ gap: 'var(--space-2)' }}>
                      {doc.attachment && (
                        <a className="btn btn--sm" href={doc.attachment} target="_blank" rel="noreferrer">
                          <Icon name="external" size={13} /> View
                        </a>
                      )}
                      {/* A verified document is HR's record; only they retire it. */}
                      {!doc.is_verified && (
                        <Button
                          size="sm"
                          onClick={() => remove.mutate(doc.name)}
                          disabled={remove.pending}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <AddDocumentDrawer
            open={adding}
            types={data.document_types}
            onClose={() => setAdding(false)}
            onDone={() => { setAdding(false); state.reload(); }}
          />
        </div>
      )}
    </Async>
  );
}

const MAX_UPLOAD_MB = 10;

function AddDocumentDrawer({ open, types, onClose, onDone }) {
  const toast = useToast();
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [progress, setProgress] = useState(0);
  const [form, setForm] = useState({
    document_type: '', title: '', document_number: '', issued_on: '', expires_on: '',
  });

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const reset = useCallback(() => {
    setFile(null);
    setProgress(0);
    setForm({ document_type: '', title: '', document_number: '', issued_on: '', expires_on: '' });
    if (fileRef.current) fileRef.current.value = '';
  }, []);

  const pick = (event) => {
    const chosen = event.target.files?.[0];
    if (!chosen) return;
    // Caught here as well as server-side so the user is told before a slow
    // upload rather than after it.
    if (chosen.size > MAX_UPLOAD_MB * 1024 * 1024) {
      toast.error(`That file is over ${MAX_UPLOAD_MB}MB. Please attach a smaller scan.`);
      event.target.value = '';
      return;
    }
    setFile(chosen);
    if (!form.title) set('title', chosen.name.replace(/\.[^.]+$/, ''));
  };

  const submit = useMutation(async () => {
    if (!file) return toast.error('Choose a file first.');
    if (!form.document_type) return toast.error('Pick a document type.');

    // Two steps: the bytes go through Frappe's upload handler, then we record
    // what the file is. A failure in the second step leaves an orphaned File
    // rather than a half-written document row.
    const uploaded = await hr.uploadFile(file, { isPrivate: true, onProgress: setProgress });
    await hr.saveEmployeeDocument({ ...form, attachment: uploaded.file_url });

    toast.success('Document added.');
    reset();
    onDone();
  });

  const close = () => { reset(); onClose(); };

  return (
    <Drawer
      open={open}
      onClose={close}
      title="Add a document"
      subtitle="Stored privately against your employee record"
      footer={
        <div className="row row--end" style={{ width: '100%', gap: 'var(--space-2)' }}>
          <Button onClick={close}>Cancel</Button>
          <Button variant="indigo" onClick={submit.mutate} disabled={submit.pending || !file}>
            {submit.pending ? (progress < 100 ? `Uploading ${progress}%` : 'Saving…') : 'Add document'}
          </Button>
        </div>
      }
    >
      <div className="stack">
        <Field label="File" hint={`PDF or image, up to ${MAX_UPLOAD_MB}MB.`}>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.webp"
            onChange={pick}
          />
          {file && (
            <p className="small subtle" style={{ marginTop: 4 }}>
              {file.name} · {(file.size / 1024 / 1024).toFixed(1)}MB
            </p>
          )}
          {submit.pending && progress > 0 && (
            <div className="upload-bar" aria-hidden="true">
              <span style={{ width: `${progress}%` }} />
            </div>
          )}
        </Field>

        <Field label="Document type">
          <select value={form.document_type} onChange={(e) => set('document_type', e.target.value)}>
            <option value="">Choose…</option>
            {(types || []).map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </Field>

        <Field label="Title">
          <input value={form.title} onChange={(e) => set('title', e.target.value)} />
        </Field>

        <Field label="Document number">
          <input value={form.document_number} onChange={(e) => set('document_number', e.target.value)} />
        </Field>

        <div className="grid grid--2">
          <Field label="Issued on">
            <input type="date" value={form.issued_on} onChange={(e) => set('issued_on', e.target.value)} />
          </Field>
          <Field label="Expires on" hint="Leave blank if it does not expire.">
            <input type="date" value={form.expires_on} onChange={(e) => set('expires_on', e.target.value)} />
          </Field>
        </div>
      </div>
    </Drawer>
  );
}

/* --------------------------------------------------------- Change requests */

const STATUS_TONE = { Pending: 'warning', Approved: 'success', Rejected: 'danger' };

function RequestsTab({ state, onChanged }) {
  const toast = useToast();

  const withdraw = useMutation(async (name) => {
    await hr.withdrawProfileChange(name);
    toast.success('Request withdrawn.');
    onChanged();
  });

  return (
    <Async
      state={state}
      rows={4}
      empty={
        <Card>
          <EmptyState
            title="No change requests"
            body="Corrections you ask for will show here with their approval status."
            icon={<Icon name="inbox" size={22} />}
          />
        </Card>
      }
    >
      {(data) => (data.requests.length === 0 ? null : (
        <Card flush>
          <ul className="doc-list">
            {data.requests.map((req) => (
              <li className="doc-row" key={req.name}>
                <div className="col" style={{ gap: 4, minWidth: 0 }}>
                  <span className="row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
                    <strong>{req.name}</strong>
                    <Pill tone={STATUS_TONE[req.status]} dot>{req.status}</Pill>
                  </span>
                  <ul className="change-list">
                    {req.changes.map((change) => (
                      <li className="small" key={change.fieldname}>
                        <span className="subtle">{change.label}:</span> {String(change.value)}
                      </li>
                    ))}
                  </ul>
                  <span className="small subtle">
                    Requested {fmtDate(req.requested_on || req.creation)}
                    {req.decided_on ? ` · decided ${fmtDate(req.decided_on)}` : ''}
                  </span>
                  {req.decision_comment && (
                    <span className="small">“{req.decision_comment}”</span>
                  )}
                </div>
                {req.status === 'Pending' && (
                  <Button size="sm" onClick={() => withdraw.mutate(req.name)} disabled={withdraw.pending}>
                    Withdraw
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </Async>
  );
}
