import { Drawer, Pill } from './ui';
import { fmtDateTime, fmtRange, fmtDate, statusTone } from '../api/format';

/* The approval trail HRMS actually records: a Leave Application carries its
   submission (creation), one approver, and the balance deduction that happens
   on approval. Nothing here is inferred — a step whose timestamp the document
   does not hold renders as upcoming rather than as a guessed date. */
function steps(row) {
  const status = row._status;
  const decided = ['Approved', 'Rejected'].includes(status);
  return [
    {
      key: 'submitted',
      title: status === 'Draft' ? 'Not submitted' : 'Submitted',
      meta: status === 'Draft' ? 'Saved as a draft' : fmtDateTime(row.creation),
      state: status === 'Draft' ? 'todo' : 'done',
    },
    {
      key: 'approver',
      title: row.leave_approver_name || 'Approver',
      meta: decided
        ? `${status} · ${fmtDate(row.modified || row.creation)}`
        : status === 'Cancelled'
          ? 'Cancelled before a decision'
          : 'Awaiting a decision',
      state: status === 'Approved' ? 'done' : status === 'Rejected' || status === 'Cancelled' ? 'stop' : 'active',
    },
    {
      key: 'balance',
      title: 'Balance deducted',
      meta: status === 'Approved' ? 'Applied to your balance' : 'On approval',
      state: status === 'Approved' ? 'done' : 'todo',
    },
  ];
}

export function LeaveDetailDrawer({ row, onClose }) {
  if (!row) return null;
  const days = Number(row.total_leave_days);

  return (
    <Drawer
      open={Boolean(row)}
      onClose={onClose}
      title={row.leave_type}
      subtitle={`${row.name} · applied ${fmtDate(row.creation)}`}
    >
      <div className="stack">
        <div className="card card--muted leave-detail__range">
          <div>
            <div className="stat__label">From</div>
            <div className="leave-detail__date">{fmtDate(row.from_date)}</div>
          </div>
          <div className="leave-detail__arrow" aria-hidden>→</div>
          <div>
            <div className="stat__label">To</div>
            <div className="leave-detail__date">{fmtDate(row.to_date || row.from_date)}</div>
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div className="stat__label">Days</div>
            <div className="leave-detail__date tabular">{days.toFixed(1)}</div>
          </div>
        </div>

        <div className="row row--between">
          <span className="small subtle">{fmtRange(row.from_date, row.to_date)}</span>
          <Pill tone={statusTone(row._status === 'Pending' ? 'open' : row._status)}>{row._status}</Pill>
        </div>

        {row.description && <p className="muted">{row.description}</p>}

        <div className="card">
          <div className="section-heading__label" style={{ marginBottom: 'var(--space-3)' }}>Approval</div>
          <ol className="steps">
            {steps(row).map((step, i) => (
              <li key={step.key} className={`steps__item steps__item--${step.state}`}>
                <span className="steps__marker">{step.state === 'done' ? '✓' : i + 1}</span>
                <div>
                  <div className="steps__title">{step.title}</div>
                  <div className="small subtle">{step.meta}</div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </Drawer>
  );
}

export default LeaveDetailDrawer;
