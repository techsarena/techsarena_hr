import { useMemo, useState } from 'react';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { useToast } from '../hooks/useToast';
import { Async, Button, Card, Drawer, EmptyState, Field, Pill } from '../components/ui';
import { exportCsv } from '../components/DataTable';
import { Icon } from '../components/Icon';
import { fmtDate, fmtDateShort, fmtMoney, isoDate, toDate } from '../api/format';

/** April-start financial year, matching the HRMS default. */
function fyOf(value) {
  const d = toDate(value);
  if (!d) return null;
  const start = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return { key: String(start), label: `FY ${start}–${String(start + 1).slice(2)}` };
}

/* HRMS keeps approval and payment on two separate fields, and a draft is only
   distinguishable by docstatus. Collapsing them into one word is what makes the
   list readable — but the mapping stays explicit so nothing is guessed. */
function displayStatus(claim) {
  if (claim.docstatus === 2) return 'Cancelled';
  if (claim.docstatus === 0) return 'Draft';
  if (claim.approval_status === 'Rejected') return 'Rejected';
  if (Number(claim.total_amount_reimbursed) > 0 || claim.is_paid) return 'Paid';
  if (claim.approval_status === 'Approved') return 'Approved';
  return 'Pending';
}

const STATUS_TONE = {
  Paid: 'success',
  Approved: 'success',
  Pending: 'warning',
  Draft: 'warning',
  Rejected: 'danger',
  Cancelled: 'danger',
};

const FILTERS = ['All', 'Pending', 'Approved', 'Paid', 'Rejected', 'Draft', 'Cancelled'];

/* "Pending" alone does not say who is holding a claim. Where the document
   names an approver, the pill says so; the wording never claims a stage the
   record does not evidence. */
function stageLabel(claim) {
  if (claim._status !== 'Pending') return claim._status;
  const who = claim.expense_approver_name || claim.expense_approver;
  if (!who) return 'Pending';
  return `With ${String(who).split(/[\s@]/)[0]}`;
}

/* The line under a claim's name says why it looks the way it does: settled
   against an advance, or how many lines and receipts back it up. */
function claimSubtitle(claim) {
  const lines = (claim.expenses || []).length;
  const parts = [claim.name];
  if (Number(claim.total_advance_amount) > 0) parts.push('settled against advance');
  else parts.push(`${lines} line${lines === 1 ? '' : 's'}`);
  if (claim.receipts?.length) parts.push(`${claim.receipts.length} receipt${claim.receipts.length === 1 ? '' : 's'}`);
  else if (claim.docstatus === 0) parts.push('receipt missing');
  return parts.join(' · ');
}

/* What to call a claim. The remark is what the employee actually typed, so it
   names the claim; the first line's description, then its category, stand in
   when there is no remark. Never a bare doc name — that is already shown. */
function claimTitle(claim) {
  const lines = claim.expenses || [];
  // On a rejected claim the remark is the approver's reason, not the claim's
  // name, so the line description takes precedence there.
  const remark = claim.approval_status === 'Rejected' ? null : claim.remark?.trim();
  return remark
    || lines[0]?.description?.trim()
    || claim._categories?.[0]
    || 'Expense claim';
}

/** Live claims sort above settled ones; date breaks the tie. */
const RANK = { Pending: 0, Draft: 1 };

const fmtBytes = (n) => {
  const num = Number(n) || 0;
  if (!num) return null;
  return num >= 1048576 ? `${(num / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(num / 1024))} KB`;
};

export default function Claims() {
  const { currency: siteCurrency } = useWorkspace();
  const state = useAsync(({ signal }) => hr.expenseClaims({ signal }), []);
  const [newOpen, setNewOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('All');
  const [category, setCategory] = useState('all');
  const [fy, setFy] = useState('all');

  const data = state.data;
  const currency = data?.currency || siteCurrency;

  const claims = useMemo(
    () => (data?.claims || []).map((c) => ({
      ...c,
      _status: displayStatus(c),
      _fy: fyOf(c.posting_date),
      _categories: [...new Set((c.expenses || []).map((e) => e.expense_type).filter(Boolean))],
    })),
    [data],
  );

  const categories = useMemo(
    () => [...new Set(claims.flatMap((c) => c._categories))].sort(),
    [claims],
  );

  const years = useMemo(() => {
    const seen = new Map();
    for (const c of claims) if (c._fy) seen.set(c._fy.key, c._fy.label);
    return [...seen].sort((a, b) => b[0].localeCompare(a[0]));
  }, [claims]);

  // Category and year narrow the set the status chips count against, so a
  // chip's number always matches what clicking it shows.
  const scoped = useMemo(
    () => claims.filter((c) => {
      if (category !== 'all' && !c._categories.includes(category)) return false;
      if (fy !== 'all' && c._fy?.key !== fy) return false;
      return true;
    }),
    [claims, category, fy],
  );

  const counts = useMemo(() => {
    const map = { All: scoped.length };
    for (const c of scoped) map[c._status] = (map[c._status] || 0) + 1;
    return map;
  }, [scoped]);

  const visible = useMemo(
    () => (filter === 'All' ? scoped : scoped.filter((c) => c._status === filter))
      .slice()
      .sort((a, b) => {
        const ra = RANK[a._status] ?? 2;
        const rb = RANK[b._status] ?? 2;
        if (ra !== rb) return ra - rb;
        return String(b.posting_date).localeCompare(String(a.posting_date));
      }),
    [scoped, filter],
  );

  const active = useMemo(
    () => visible.find((c) => c.name === selected) || visible[0] || null,
    [visible, selected],
  );

  const totals = useMemo(() => {
    const currentFy = fyOf(new Date())?.key;
    const inFy = claims.filter((c) => c._fy?.key === currentFy);
    return {
      reimbursed: inFy.reduce((n, c) => n + (Number(c.total_amount_reimbursed) || 0), 0),
      awaiting: claims
        .filter((c) => c._status === 'Pending')
        .reduce((n, c) => n + (Number(c.total_claimed_amount) || 0), 0),
      pendingCount: claims.filter((c) => c._status === 'Pending').length,
      advance: claims.reduce((n, c) => n + (Number(c.total_advance_amount) || 0), 0),
    };
  }, [claims]);

  const csvColumns = [
    { key: 'name', header: 'Claim' },
    { key: 'posting_date', header: 'Submitted' },
    { key: '_status', header: 'Status' },
    { key: 'total_claimed_amount', header: 'Claimed' },
    { key: 'total_sanctioned_amount', header: 'Sanctioned' },
    { key: 'total_amount_reimbursed', header: 'Reimbursed' },
  ];

  return (
    <div className="stack">
      <div className="row row--between page-head" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <div>
          <h1 className="page-head__title">Expense claims</h1>
          <p className="page-head__sub">What you&apos;ve claimed, what&apos;s sanctioned, and what&apos;s been paid back</p>
        </div>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          {years.length > 1 && (
            <select value={fy} onChange={(e) => setFy(e.target.value)} style={{ width: 'auto' }} aria-label="Financial year">
              <option value="all">All years</option>
              {years.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          )}
          <Button variant="primary" onClick={() => setNewOpen(true)}>
            <Icon name="plus" size={15} /> New claim
          </Button>
        </div>
      </div>

      <Async state={state} rows={6}>
        {() => (
          <>
            {/* ---- Headline figures ---- */}
            <div className="grid grid--auto">
              <SummaryTile label="Reimbursed this FY" value={fmtMoney(totals.reimbursed, currency)} />
              <SummaryTile
                label="Awaiting approval"
                value={fmtMoney(totals.awaiting, currency)}
                meta={totals.pendingCount ? `${totals.pendingCount} claim${totals.pendingCount === 1 ? '' : 's'}` : null}
              />
              {/* Advances are read off the claims that were settled against one;
                  this site has no Employee Advance endpoint, so nothing here is
                  an outstanding-balance figure it cannot back up. */}
              <SummaryTile label="Settled against advance" value={fmtMoney(totals.advance, currency)} />
              <SummaryTile label="Claims on record" value={String(claims.length)} />
            </div>

            {claims.length === 0 ? (
              <Card>
                <EmptyState
                  title="No claims yet"
                  body="Submit a claim and it will show here with its approval trail."
                  icon={<Icon name="receipt" size={22} />}
                  action={<Button variant="primary" onClick={() => setNewOpen(true)}>New claim</Button>}
                />
              </Card>
            ) : (
              <>
                {/* ---- Filter bar ---- */}
                <Card flush>
                  <div className="leave-toolbar">
                    <div className="chips" role="tablist" aria-label="Filter by status">
                      {FILTERS.filter((f) => f === 'All' || counts[f]).map((f) => (
                        <button
                          key={f}
                          type="button"
                          role="tab"
                          aria-selected={filter === f}
                          className={`chip${filter === f ? ' is-active' : ''}${f !== 'All' ? ` chip--${STATUS_TONE[f]}` : ''}`}
                          onClick={() => setFilter(f)}
                        >
                          {f}
                          {counts[f] ? <span className="chip__count">{counts[f]}</span> : null}
                        </button>
                      ))}
                    </div>
                    <div className="leave-toolbar__right">
                      {categories.length > 0 && (
                        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by category">
                          <option value="all">All categories</option>
                          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      )}
                    </div>
                  </div>
                </Card>

                {/* ---- Claim list + detail ---- */}
                <div className="claim-layout">
                  <ClaimList
                    claims={visible}
                    total={claims.length}
                    activeName={active?.name}
                    currency={currency}
                    onSelect={setSelected}
                    onClear={() => { setFilter('All'); setCategory('all'); setFy('all'); }}
                    onExport={() => exportCsv('expense-claims', csvColumns, visible)}
                  />
                  {active && (
                    <ClaimDetail
                      key={active.name}
                      claim={active}
                      currency={currency}
                      onChanged={state.reload}
                    />
                  )}
                </div>
              </>
            )}
          </>
        )}
      </Async>

      <ClaimDrawer
        open={newOpen}
        onClose={() => setNewOpen(false)}
        claimTypes={data?.claim_types || []}
        currency={currency}
        onDone={state.reload}
      />
    </div>
  );
}

function SummaryTile({ label, value, meta }) {
  return (
    <div className="card balance-tile">
      <div className="balance-tile__label">{label}</div>
      <div className="balance-tile__figure">
        <span className="balance-tile__value">{value}</span>
        {meta && <span className="balance-tile__of">{meta}</span>}
      </div>
    </div>
  );
}

function ClaimList({ claims, total, activeName, currency, onSelect, onClear, onExport }) {
  if (claims.length === 0) {
    return (
      <Card>
        <EmptyState
          title="Nothing matches these filters"
          body="Clear a filter to see the rest of your claims."
          icon="▦"
          action={<Button onClick={onClear}>Clear filters</Button>}
        />
      </Card>
    );
  }

  return (
    <Card flush className="claim-table-card">
      <div className="table-wrap">
        <table className="table claim-table">
          <thead>
            <tr>
              <th>Claim</th>
              <th>Category</th>
              <th className="num">Amount</th>
              <th>Status</th>
              <th className="claim-table__submitted">Submitted</th>
            </tr>
          </thead>
          <tbody>
            {claims.map((claim) => (
              <tr
                key={claim.name}
                className={`is-clickable${claim.name === activeName ? ' is-open' : ''}`}
                aria-current={claim.name === activeName}
                onClick={() => onSelect(claim.name)}
              >
                <td>
                  <div className="cell-strong truncate">{claimTitle(claim)}</div>
                  {/* A rejection reason is why the row looks the way it does,
                      so it replaces the usual metadata and is toned to match. */}
                  {claim._status === 'Rejected' && claim.remark ? (
                    <div className="small truncate claim-table__sub claim-table__reason">{claim.remark}</div>
                  ) : (
                    <div className="small subtle truncate claim-table__sub">{claimSubtitle(claim)}</div>
                  )}
                </td>
                <td className="subtle">{claim._categories[0] || '—'}</td>
                <td className="num">{fmtMoney(claim.total_claimed_amount, currency)}</td>
                <td><Pill tone={STATUS_TONE[claim._status]}>{stageLabel(claim)}</Pill></td>
                <td className="subtle claim-table__submitted">
                  {claim.docstatus === 0 ? '—' : fmtDateShort(claim.posting_date)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="leave-foot">
        <span className="small subtle">Showing {claims.length} of {total}</span>
        <Button size="sm" onClick={onExport}>
          <Icon name="download" size={14} /> Export CSV
        </Button>
      </footer>
    </Card>
  );
}

/* ---------- Claim detail ---------- */
function ClaimDetail({ claim, currency, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const lines = claim.expenses || [];
  const receipts = claim.receipts || [];

  // Only offered where the backend will actually allow it — an approved or
  // reimbursed claim is an accounting reversal, not a withdrawal.
  const canWithdraw = claim.docstatus < 2
    && claim.approval_status !== 'Approved'
    && !(Number(claim.total_amount_reimbursed) > 0);

  const withdraw = async () => {
    setBusy(true);
    try {
      await hr.withdrawExpenseClaim(claim.name);
      toast.success('Claim withdrawn.');
      await onChanged?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const steps = [
    {
      key: 'submitted',
      title: claim._status === 'Draft' ? 'Not submitted' : 'Submitted by you',
      meta: claim._status === 'Draft' ? 'Saved as a draft' : fmtDate(claim.posting_date),
      state: claim._status === 'Draft' ? 'todo' : 'done',
    },
    {
      key: 'approver',
      title: claim.expense_approver_name || claim.expense_approver || 'Approver',
      meta: claim.approval_status === 'Approved'
        ? 'Approved'
        : claim.approval_status === 'Rejected'
          ? 'Rejected'
          : claim._status === 'Cancelled' ? 'Withdrawn before a decision' : 'Awaiting a decision',
      state: claim.approval_status === 'Approved'
        ? 'done'
        : claim.approval_status === 'Rejected' || claim._status === 'Cancelled' ? 'stop' : 'active',
    },
    {
      key: 'payout',
      title: 'Reimbursement',
      meta: Number(claim.total_amount_reimbursed) > 0
        ? `${fmtMoney(claim.total_amount_reimbursed, currency)} paid`
        : 'On approval',
      state: Number(claim.total_amount_reimbursed) > 0 ? 'done' : 'todo',
    },
  ];

  return (
    <Card className="claim-detail">
      <header className="row row--between" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
        <div style={{ minWidth: 0 }}>
          <h3 className="card__title">{claimTitle(claim)}</h3>
          <p className="card__sub">{claim.name} · submitted {fmtDate(claim.posting_date)}</p>
        </div>
        <Pill tone={STATUS_TONE[claim._status]}>{claim._status}</Pill>
      </header>

      <ul className="pay-lines">
        {lines.map((line, i) => (
          <li className="pay-line" key={`${line.expense_type}-${i}`}>
            <span className="pay-line__name">
              {line.description || line.expense_type}
              {line.description && line.expense_type ? <span className="subtle"> · {line.expense_type}</span> : null}
            </span>
            <span className="pay-line__amount">{fmtMoney(line.amount, currency)}</span>
          </li>
        ))}
        <li className="pay-line claim-detail__total">
          <span className="pay-line__name">Claimed</span>
          <span className="pay-line__amount">{fmtMoney(claim.total_claimed_amount, currency)}</span>
        </li>
        {/* Sanctioned is only stated when it differs — repeating the claimed
            figure would imply a decision that has not been made. */}
        {Number(claim.total_sanctioned_amount) > 0
          && Number(claim.total_sanctioned_amount) !== Number(claim.total_claimed_amount) && (
          <li className="pay-line">
            <span className="pay-line__name">Sanctioned</span>
            <span className="pay-line__amount">{fmtMoney(claim.total_sanctioned_amount, currency)}</span>
          </li>
        )}
      </ul>

      {receipts.length > 0 && (
        <section className="claim-receipts">
          <div className="section-heading__label">Receipts</div>
          {receipts.map((file) => (
            <a
              className="claim-receipt"
              key={file.file_url}
              href={file.file_url}
              target="_blank"
              rel="noreferrer"
            >
              <Icon name="receipt" size={15} />
              <span className="claim-receipt__name truncate">{file.file_name}</span>
              {fmtBytes(file.file_size) && <span className="small subtle">{fmtBytes(file.file_size)}</span>}
            </a>
          ))}
        </section>
      )}

      {/* The remark titles the card, so it is only repeated here when the
          title came from somewhere else. */}
      {claim.remark && claimTitle(claim) !== claim.remark.trim() && (
        <p className="muted" style={{ marginTop: 'var(--space-4)' }}>{claim.remark}</p>
      )}

      <section className="claim-where">
        <div className="section-heading__label" style={{ marginBottom: 'var(--space-3)' }}>Where it is</div>
        <ol className="steps">
          {steps.map((step, i) => (
            <li key={step.key} className={`steps__item steps__item--${step.state}`}>
              <span className="steps__marker">{step.state === 'done' ? '✓' : i + 1}</span>
              <div>
                <div className="steps__title">{step.title}</div>
                <div className="small subtle">{step.meta}</div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <div className="claim-actions">
        {/* Attachments are added against the document itself, so this opens the
            claim in Frappe's own form rather than half-implementing an
            uploader that would bypass its validation. */}
        <a className="btn btn--ghost" href={`/app/expense-claim/${encodeURIComponent(claim.name)}`} target="_blank" rel="noreferrer">
          <Icon name="plus" size={15} /> Add a receipt
        </a>
        {canWithdraw && (
          <Button variant="danger" onClick={withdraw} disabled={busy}>
            {busy ? 'Withdrawing…' : 'Withdraw claim'}
          </Button>
        )}
      </div>
    </Card>
  );
}

/* ---------- New claim ---------- */
function ClaimDrawer({ open, onClose, claimTypes, currency, onDone }) {
  const toast = useToast();
  const blank = () => ({ expense_date: isoDate(new Date()), expense_type: claimTypes[0] || '', description: '', amount: '' });
  const [lines, setLines] = useState([blank()]);
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState(false);

  const total = lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0);
  const valid = lines.every((line) => line.expense_date && line.expense_type && Number(line.amount) > 0);

  const update = (index, patch) =>
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  const submit = async () => {
    setBusy(true);
    try {
      await hr.submitExpenseClaim(
        lines.map((line) => ({
          expense_date: line.expense_date,
          expense_type: line.expense_type,
          description: line.description,
          amount: Number(line.amount),
        })),
        remark || undefined,
      );
      toast.success('Expense claim submitted.');
      setLines([blank()]);
      setRemark('');
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
      title="New expense claim"
      subtitle="Composed against this site's own claim types"
      footer={
        <>
          <span className="row" style={{ marginRight: 'auto', fontWeight: 600 }}>
            Total {fmtMoney(total, currency)}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !valid}>
            {busy ? 'Submitting…' : 'Submit claim'}
          </Button>
        </>
      }
    >
      <div className="stack">
        {lines.map((line, index) => (
          <Card key={index} className="card--muted">
            <div className="row row--between" style={{ marginBottom: 'var(--space-3)' }}>
              <span className="section-heading__label">Line {index + 1}</span>
              {lines.length > 1 && (
                <Button size="sm" variant="link" onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}>
                  Remove
                </Button>
              )}
            </div>
            <div className="fields">
              <div className="grid grid--2">
                <Field label="Date">
                  <input type="date" value={line.expense_date} onChange={(e) => update(index, { expense_date: e.target.value })} />
                </Field>
                <Field label="Amount">
                  <input type="number" min="0" step="0.01" value={line.amount} onChange={(e) => update(index, { amount: e.target.value })} />
                </Field>
              </div>
              <Field label="Type">
                <select value={line.expense_type} onChange={(e) => update(index, { expense_type: e.target.value })}>
                  <option value="">Select…</option>
                  {claimTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </Field>
              <Field label="Description">
                <input value={line.description} onChange={(e) => update(index, { description: e.target.value })} />
              </Field>
            </div>
          </Card>
        ))}

        <Button onClick={() => setLines((prev) => [...prev, blank()])}>
          <Icon name="plus" size={15} /> Add line
        </Button>

        <Field label="Remark">
          <textarea rows={3} value={remark} onChange={(e) => setRemark(e.target.value)} />
        </Field>
      </div>
    </Drawer>
  );
}
