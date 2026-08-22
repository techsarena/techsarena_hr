import { useMemo, useState } from 'react';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { Button, Card, Meter, Pill } from '../components/ui';
import { DataTable, exportCsv } from '../components/DataTable';
import { ApplyDrawer } from '../components/ApplyLeaveDrawer';
import { Icon } from '../components/Icon';
import { fmtRange, statusTone } from '../api/format';

export default function Leave() {
  const { leaveBalances, leaveRequests } = useWorkspace();
  const [applyOpen, setApplyOpen] = useState(false);

  const columns = useMemo(
    () => [
      { key: 'leave_type', header: 'Type', render: (row) => <span className="cell-strong">{row.leave_type}</span> },
      { key: 'from_date', header: 'Dates', render: (row) => fmtRange(row.from_date, row.to_date), sortValue: (row) => row.from_date },
      { key: 'total_leave_days', header: 'Days', align: 'right', render: (row) => Number(row.total_leave_days).toFixed(1), sortValue: (row) => Number(row.total_leave_days) },
      { key: 'status', header: 'Status', render: (row) => <Pill tone={statusTone(row.status)}>{row.status}</Pill> },
      { key: 'leave_approver_name', header: 'Approver', render: (row) => row.leave_approver_name || '—' },
      { key: 'description', header: 'Reason', render: (row) => <span className="truncate subtle" style={{ maxWidth: 260, display: 'inline-block' }}>{row.description || '—'}</span> },
    ],
    [],
  );

  return (
    <div className="stack">
      <div className="row row--between page-head">
        <div>
          <h1 className="page-head__title">My leave</h1>
          <p className="page-head__sub">Your balance and every request you have made</p>
        </div>
        <Button variant="primary" onClick={() => setApplyOpen(true)}>
          <Icon name="plus" size={15} /> Apply for leave
        </Button>
      </div>

      <div className="grid grid--auto">
        {leaveBalances.map((row) => (
          <div className="card" key={row.leave_type}>
            <div className="stat__label">{row.leave_type}</div>
            <div className="row" style={{ alignItems: 'baseline', gap: 6, margin: '4px 0 8px' }}>
              <span className="stat__value" style={{ fontSize: 22 }}>{Number(row.remaining).toFixed(1)}</span>
              <span className="small subtle">of {Number(row.allocated).toFixed(1)} days</span>
            </div>
            <Meter
              value={row.remaining}
              total={row.allocated}
              tone={row.allocated > 0 && row.remaining / row.allocated < 0.25 ? 'warning' : undefined}
            />
            <div className="row row--between small subtle" style={{ marginTop: 6 }}>
              <span>Taken {Number(row.taken).toFixed(1)}</span>
              {Number(row.pending) > 0 && <span>Pending {Number(row.pending).toFixed(1)}</span>}
            </div>
          </div>
        ))}
      </div>

      <Card
        flush
        title="My requests"
        subtitle={`${leaveRequests.length} record${leaveRequests.length === 1 ? '' : 's'}`}
        action={
          <div className="row">
            <Button size="sm" onClick={() => exportCsv('my-leave', columns, leaveRequests)}>
              <Icon name="download" size={14} /> CSV
            </Button>
            <Button size="sm" variant="primary" onClick={() => setApplyOpen(true)}>
              <Icon name="plus" size={14} /> Apply
            </Button>
          </div>
        }
      >
        <DataTable
          columns={columns}
          rows={leaveRequests}
          initialSort={{ key: 'from_date', dir: 'desc' }}
          emptyTitle="No leave requests"
          emptyBody="Requests you submit will be listed here."
        />
      </Card>

      <ApplyDrawer open={applyOpen} onClose={() => setApplyOpen(false)} />
    </div>
  );
}
