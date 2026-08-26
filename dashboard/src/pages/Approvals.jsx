import { useMemo, useState } from 'react';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { useToast } from '../hooks/useToast';
import { Async, Avatar, Button, Card, Drawer, EmptyState, Field, FieldRow, Pill, Tabs } from '../components/ui';
import { DataTable, exportCsv } from '../components/DataTable';
import { Icon } from '../components/Icon';
import { fmtDays, fmtMoney, fmtRange, fmtRelative, statusTone } from '../api/format';

const KIND_LABEL = {
  leave: 'Leave',
  expense: 'Expense',
  attendance: 'Attendance',
  'comp-off': 'Comp-off',
  profile: 'Profile change',
};

/* ---------- Detail drawer ---------- */
function DetailDrawer({ request, currency, onClose, onDecided }) {
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const state = useAsync(
    ({ signal }) => (request ? hr.approvalDetail(request.doctype, request.id, { signal }) : Promise.resolve(null)),
    [request?.doctype, request?.id],
    { immediate: Boolean(request) },
  );

  const decide = async (decision) => {
    setBusy(true);
    try {
      await hr.decideRequest(request.doctype, request.id, decision, comment || undefined);
      toast.success(decision === 'approve' ? 'Request approved.' : 'Request rejected.');
      setComment('');
      onClose();
      onDecided?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={Boolean(request)}
      onClose={onClose}
      title={request?.employee_name || 'Request'}
      subtitle={request ? [KIND_LABEL[request.kind] || request.kind, request.department].filter(Boolean).join(' · ') : undefined}
      footer={
        <>
          <Button variant="danger" onClick={() => decide('reject')} disabled={busy}>Reject</Button>
          <Button variant="primary" onClick={() => decide('approve')} disabled={busy}>
            {busy ? 'Working…' : 'Approve'}
          </Button>
        </>
      }
    >
      {!request ? null : (
        <Async state={state} rows={5}>
          {(detail) => {
            // approval_detail returns the request's own fields flat, alongside
            // coverage[], history{} and attachments[].
            const row = detail || request;
            const checks = detail?.coverage || [];
            const history = detail?.history;
            const attachments = detail?.attachments || [];

            return (
              <div className="stack">
                <Card className="card--muted">
                  <FieldRow label="Request" value={row.title} />
                  <FieldRow label="Dates" value={row.from_date ? fmtRange(row.from_date, row.to_date) : null} />
                  <FieldRow label="Days" value={row.days ? fmtDays(row.days) : null} />
                  <FieldRow label="Amount" value={row.amount ? fmtMoney(row.amount, currency) : null} />
                  <FieldRow label="Half day" value={row.half_day ? 'Yes' : null} />
                  <FieldRow label="Leave balance" value={row.leave_balance !== null && row.leave_balance !== undefined ? fmtDays(row.leave_balance) : null} />
                  <FieldRow label="Submitted" value={row.created_at ? fmtRelative(row.created_at) : null} />
                  <FieldRow label="Designation" value={row.designation} />
                  <FieldRow label="Reason" value={row.reason} />
                </Card>

                {/* A profile change is decided on the difference, so the
                    current value sits beside the proposed one rather than the
                    approver having to open the employee record to compare. */}
                {(row.changes || []).length > 0 && (
                  <Card title="Requested changes">
                    <ul className="diff-list">
                      {row.changes.map((change) => (
                        <li className="diff-row" key={change.fieldname}>
                          <span className="diff-row__label">{change.label}</span>
                          <span className="diff-row__values">
                            <span className="diff-row__from">{change.current || '—'}</span>
                            <span className="diff-row__arrow" aria-label="changes to">→</span>
                            <span className="diff-row__to">{String(change.value)}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}

                {checks.length > 0 && (
                  <Card title="Team cover">
                    <div className="stack">
                      {checks.map((check, index) => (
                        <div className="row" key={index} style={{ gap: 8, alignItems: 'flex-start' }}>
                          <span
                            className={`pill pill--${check.ok ? 'success' : 'warning'}`}
                            style={{ marginTop: 1 }}
                          >
                            {check.ok ? '✓' : '!'}
                          </span>
                          <span className="small">{check.message}</span>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}

                {history && (
                  <Card title="Requester history">
                    <FieldRow label="Days taken" value={history.days_taken !== undefined ? fmtDays(history.days_taken) : null} />
                    <FieldRow label="Requests" value={history.requests ?? null} />
                    <FieldRow label="Previously rejected" value={history.rejected ?? null} />
                  </Card>
                )}

                {attachments.length > 0 && (
                  <Card title="Attachments">
                    <div className="stack">
                      {attachments.map((file) => (
                        <a key={file.file_url || file.name} href={file.file_url} target="_blank" rel="noreferrer" className="row" style={{ gap: 8 }}>
                          <Icon name="external" size={15} />
                          <span className="truncate">{file.file_name || file.name}</span>
                        </a>
                      ))}
                    </div>
                  </Card>
                )}

                <Field label="Comment" hint="Sent with your decision.">
                  <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
                </Field>
              </div>
            );
          }}
        </Async>
      )}
    </Drawer>
  );
}

/* ---------- Bulk decision ---------- */
function BulkBar({ selected, rows, onDone, onClear }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const decide = async (decision) => {
    setBusy(true);
    try {
      const payload = rows
        .filter((row) => selected.has(`${row.doctype}:${row.id}`))
        .map((row) => ({ doctype: row.doctype, name: row.id }));
      const result = await hr.decideRequests(payload, decision);
      // decide_requests returns failed[] so the UI can name what didn't go through.
      const failed = result?.failed || [];
      const done = payload.length - failed.length;
      if (done > 0) toast.success(`${done} request${done === 1 ? '' : 's'} ${decision === 'approve' ? 'approved' : 'rejected'}.`);
      if (failed.length) {
        toast.error(
          `${failed.length} could not be processed: ${failed
            .map((f) => f.name || f.error || 'unknown')
            .slice(0, 3)
            .join(', ')}`,
        );
      }
      onClear();
      onDone();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  if (!selected.size) return null;

  return (
    <div
      className="row card no-print"
      style={{ position: 'sticky', top: 0, zIndex: 10, marginBottom: 'var(--space-4)', padding: 'var(--space-3) var(--space-4)' }}
    >
      <strong>{selected.size} selected</strong>
      <div className="toolbar__spacer" />
      <Button size="sm" onClick={onClear}>Clear</Button>
      <Button size="sm" variant="danger" onClick={() => decide('reject')} disabled={busy}>Reject all</Button>
      <Button size="sm" variant="primary" onClick={() => decide('approve')} disabled={busy}>
        {busy ? 'Working…' : 'Approve all'}
      </Button>
    </div>
  );
}

export default function Approvals() {
  const { currency } = useWorkspace();
  const state = useAsync(({ signal }) => hr.approvalQueue({ signal }), []);
  const [kind, setKind] = useState('all');
  const [selected, setSelected] = useState(new Set());
  const [open, setOpen] = useState(null);

  const data = state.data;
  const allRows = useMemo(() => data?.requests || [], [data]);
  const rows = useMemo(() => (kind === 'all' ? allRows : allRows.filter((row) => row.kind === kind)), [allRows, kind]);

  const columns = useMemo(
    () => [
      {
        key: 'employee_name',
        header: 'Employee',
        render: (row) => (
          <div className="row" style={{ gap: 8 }}>
            <Avatar name={row.employee_name} size="sm" />
            <div className="truncate">
              <div className="cell-strong truncate">{row.employee_name}</div>
              {row.department && <div className="small subtle truncate">{row.department}</div>}
            </div>
          </div>
        ),
        exportValue: (row) => row.employee_name,
      },
      { key: 'kind', header: 'Type', render: (row) => <Pill tone={statusTone(row.kind)}>{KIND_LABEL[row.kind] || row.kind}</Pill>, exportValue: (row) => KIND_LABEL[row.kind] || row.kind },
      {
        key: 'title',
        header: 'Request',
        render: (row) => (
          <div className="truncate" style={{ maxWidth: 260 }}>
            <div className="truncate">{row.title}</div>
            {(row.days ? fmtDays(row.days) : row.subtitle) && (
              <div className="small subtle truncate">{row.days ? fmtDays(row.days) : row.subtitle}</div>
            )}
          </div>
        ),
        exportValue: (row) => [row.title, row.days ? fmtDays(row.days) : row.subtitle].filter(Boolean).join(' — '),
      },
      { key: 'from_date', header: 'Dates', render: (row) => (row.from_date ? fmtRange(row.from_date, row.to_date) : '—'), sortValue: (row) => row.from_date },
      {
        key: 'value',
        header: 'Value',
        align: 'right',
        render: (row) =>
          row.amount ? fmtMoney(row.amount, currency) : row.days ? fmtDays(row.days) : '—',
        sortValue: (row) => Number(row.amount || row.days || 0),
        exportValue: (row) => row.amount ?? row.days ?? '',
      },
      { key: 'created_at', header: 'Waiting', render: (row) => <span className="subtle">{fmtRelative(row.created_at)}</span>, sortValue: (row) => row.created_at },
      {
        key: 'actions',
        header: '',
        sortable: false,
        width: 90,
        render: (row) => (
          <Button size="sm" onClick={(e) => { e.stopPropagation(); setOpen(row); }}>Review</Button>
        ),
        exportValue: () => '',
      },
    ],
    [currency],
  );

  const counts = data?.counts || {};
  const tabs = [
    { id: 'all', label: 'All', count: counts.all ?? allRows.length },
    ...Object.keys(KIND_LABEL)
      .filter((k) => counts[k])
      .map((k) => ({ id: k, label: KIND_LABEL[k], count: counts[k] })),
  ];

  const toggleRow = (key) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  return (
    <div className="stack">
      <div className="row row--between page-head">
        <div>
          <h1 className="page-head__title">Approval inbox</h1>
          <p className="page-head__sub">Everything waiting on your decision, across every request type</p>
        </div>
        {rows.length > 0 && (
          <Button onClick={() => exportCsv('approvals', columns, rows)}>
            <Icon name="download" size={15} /> Export
          </Button>
        )}
      </div>

      <Async state={state} rows={6}>
        {() => (
          <>
            {allRows.length === 0 ? (
              <Card>
                <EmptyState
                  title="Inbox zero"
                  body="Nothing is waiting on your decision right now."
                  icon={<Icon name="check" size={22} />}
                />
              </Card>
            ) : (
              <>
                <Tabs value={kind} onChange={(next) => { setKind(next); setSelected(new Set()); }} items={tabs} />
                <BulkBar
                  selected={selected}
                  rows={rows}
                  onDone={state.reload}
                  onClear={() => setSelected(new Set())}
                />
                <Card flush>
                  <DataTable
                    columns={columns}
                    rows={rows}
                    rowKey={(row) => `${row.doctype}:${row.id}`}
                    selectedKeys={selected}
                    onToggleRow={toggleRow}
                    onToggleAll={(shouldSelect, visible) =>
                      setSelected(shouldSelect ? new Set(visible.map((row) => `${row.doctype}:${row.id}`)) : new Set())
                    }
                    onRowClick={setOpen}
                    initialSort={{ key: 'created_at', dir: 'desc' }}
                    emptyTitle="Nothing in this queue"
                  />
                </Card>
              </>
            )}
          </>
        )}
      </Async>

      <DetailDrawer request={open} currency={currency} onClose={() => setOpen(null)} onDecided={state.reload} />
    </div>
  );
}
