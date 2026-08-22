import { useMemo, useState } from 'react';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { useToast } from '../hooks/useToast';
import { Async, Button, Card, Drawer, Field, FieldRow, Pill, Stat } from '../components/ui';
import { DataTable, exportCsv } from '../components/DataTable';
import { Icon } from '../components/Icon';
import { fmtDate, fmtMoney, isoDate, statusTone } from '../api/format';

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
                <Button
                  size="sm"
                  variant="link"
                  onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                >
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
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={line.amount}
                    onChange={(e) => update(index, { amount: e.target.value })}
                  />
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

/* ---------- Claim detail ---------- */
function ClaimDetail({ claim, currency, onClose }) {
  if (!claim) return null;
  const lines = claim.expenses || [];
  return (
    <Drawer open onClose={onClose} title={claim.name} subtitle={fmtDate(claim.posting_date)}>
      <div className="stack">
        <Card className="card--muted">
          <Stat label="Claimed" value={fmtMoney(claim.total_claimed_amount, currency)} />
          <div style={{ marginTop: 'var(--space-4)' }}>
            <FieldRow label="Sanctioned" value={claim.total_sanctioned_amount ? fmtMoney(claim.total_sanctioned_amount, currency) : null} />
            <FieldRow label="Reimbursed" value={claim.total_amount_reimbursed ? fmtMoney(claim.total_amount_reimbursed, currency) : null} />
            <FieldRow label="Approval" value={claim.approval_status} />
            <FieldRow label="Status" value={claim.status} />
            <FieldRow label="Paid" value={claim.is_paid ? 'Yes' : null} />
            <FieldRow label="Remark" value={claim.remark} />
          </div>
        </Card>

        <Card title="Lines" flush>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Date</th><th>Type</th><th>Description</th><th className="num">Claimed</th><th className="num">Sanctioned</th></tr>
              </thead>
              <tbody>
                {lines.map((line, index) => (
                  <tr key={index}>
                    <td>{fmtDate(line.expense_date)}</td>
                    <td>{line.expense_type}</td>
                    <td className="subtle">{line.description || '—'}</td>
                    <td className="num">{fmtMoney(line.amount, currency)}</td>
                    <td className="num">{line.sanctioned_amount ? fmtMoney(line.sanctioned_amount, currency) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </Drawer>
  );
}

export default function Claims() {
  const { currency: siteCurrency } = useWorkspace();
  const state = useAsync(({ signal }) => hr.expenseClaims({ signal }), []);
  const [newOpen, setNewOpen] = useState(false);
  const [detail, setDetail] = useState(null);

  const data = state.data;
  const claims = useMemo(() => data?.claims || [], [data]);
  const currency = data?.currency || siteCurrency;

  const columns = useMemo(
    () => [
      { key: 'posting_date', header: 'Date', render: (row) => <span className="cell-strong">{fmtDate(row.posting_date)}</span>, sortValue: (row) => row.posting_date },
      { key: 'name', header: 'Claim', render: (row) => <span className="subtle tabular">{row.name}</span> },
      {
        key: 'expenses',
        header: 'Lines',
        align: 'right',
        render: (row) => (row.expenses || []).length,
        sortValue: (row) => (row.expenses || []).length,
      },
      { key: 'total_claimed_amount', header: 'Claimed', align: 'right', render: (row) => fmtMoney(row.total_claimed_amount, currency), sortValue: (row) => Number(row.total_claimed_amount) },
      {
        key: 'total_sanctioned_amount',
        header: 'Sanctioned',
        align: 'right',
        render: (row) => (row.total_sanctioned_amount ? fmtMoney(row.total_sanctioned_amount, currency) : '—'),
        sortValue: (row) => Number(row.total_sanctioned_amount) || 0,
      },
      { key: 'approval_status', header: 'Approval', render: (row) => <Pill tone={statusTone(row.approval_status)}>{row.approval_status}</Pill> },
      { key: 'status', header: 'Status', render: (row) => <Pill tone={statusTone(row.status)}>{row.status}</Pill> },
    ],
    [currency],
  );

  const totals = useMemo(() => {
    const claimed = claims.reduce((sum, c) => sum + (Number(c.total_claimed_amount) || 0), 0);
    const sanctioned = claims.reduce((sum, c) => sum + (Number(c.total_sanctioned_amount) || 0), 0);
    const reimbursed = claims.reduce((sum, c) => sum + (Number(c.total_amount_reimbursed) || 0), 0);
    return { claimed, sanctioned, reimbursed };
  }, [claims]);

  return (
    <div className="stack">
      <div className="row row--between page-head">
        <div>
          <h1 className="page-head__title">Expense claims</h1>
          <p className="page-head__sub">What you've claimed, what's been sanctioned, and what's been paid back</p>
        </div>
        <Button variant="primary" onClick={() => setNewOpen(true)}>
          <Icon name="plus" size={15} /> New claim
        </Button>
      </div>

      <Async state={state} rows={5}>
        {() => (
          <>
            <div className="grid grid--3">
              <div className="card"><Stat label="Claimed" value={fmtMoney(totals.claimed, currency)} meta={`${claims.length} claim${claims.length === 1 ? '' : 's'}`} /></div>
              <div className="card"><Stat label="Sanctioned" value={fmtMoney(totals.sanctioned, currency)} /></div>
              <div className="card"><Stat label="Reimbursed" value={fmtMoney(totals.reimbursed, currency)} tone="success" /></div>
            </div>

            <Card
              flush
              title="Claims"
              action={
                claims.length > 0 && (
                  <Button size="sm" onClick={() => exportCsv('expense-claims', columns, claims)}>
                    <Icon name="download" size={14} /> CSV
                  </Button>
                )
              }
            >
              <DataTable
                columns={columns}
                rows={claims}
                onRowClick={setDetail}
                initialSort={{ key: 'posting_date', dir: 'desc' }}
                emptyTitle="No claims yet"
                emptyBody="Submit a claim and it will show here with its approval trail."
              />
            </Card>
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
      <ClaimDetail claim={detail} currency={currency} onClose={() => setDetail(null)} />
    </div>
  );
}
