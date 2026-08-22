import { useMemo, useState } from 'react';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { Button, Card, Drawer, EmptyState, FieldRow, Stat } from '../components/ui';
import { DataTable, exportCsv } from '../components/DataTable';
import { Icon } from '../components/Icon';
import { fmtDate, fmtMoney, fmtRange } from '../api/format';

/* Component rows are hydrated into every slip by the bootstrap payload, so
   opening an older month shows its real breakdown rather than an empty list. */
function SlipDrawer({ slip, onClose }) {
  if (!slip) return null;
  const earnings = slip.earnings || [];
  const deductions = slip.deductions || [];

  return (
    <Drawer
      open
      onClose={onClose}
      title={fmtRange(slip.start_date, slip.end_date)}
      subtitle={`Payslip ${slip.name}`}
      footer={<Button onClick={() => window.print()}><Icon name="download" size={15} /> Print</Button>}
    >
      <div className="stack">
        <Card className="card--muted">
          <Stat label="Net pay" value={fmtMoney(slip.net_pay, slip.currency)} meta={`Posted ${fmtDate(slip.posting_date)}`} />
        </Card>

        <Card title="Earnings" flush>
          {earnings.length === 0 ? (
            <EmptyState title="No earning lines" icon="◷" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {earnings.map((row, i) => (
                    <tr key={`${row.salary_component}-${i}`}>
                      <td>{row.salary_component}</td>
                      <td className="num">{fmtMoney(row.amount, slip.currency)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="cell-strong">Gross</td>
                    <td className="num cell-strong">{fmtMoney(slip.gross_pay, slip.currency)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Deductions" flush>
          {deductions.length === 0 ? (
            <EmptyState title="No deductions" icon="◷" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {deductions.map((row, i) => (
                    <tr key={`${row.salary_component}-${i}`}>
                      <td>{row.salary_component}</td>
                      <td className="num">{fmtMoney(row.amount, slip.currency)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="cell-strong">Total</td>
                    <td className="num cell-strong">{fmtMoney(slip.total_deduction, slip.currency)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Details">
          <FieldRow label="Period" value={fmtRange(slip.start_date, slip.end_date)} />
          <FieldRow label="Posting date" value={slip.posting_date ? fmtDate(slip.posting_date) : null} />
          <FieldRow label="Bank" value={slip.bank_name} />
          <FieldRow label="Currency" value={slip.currency} />
        </Card>
      </div>
    </Drawer>
  );
}

export default function Salary() {
  const { salarySlips } = useWorkspace();
  const [open, setOpen] = useState(null);

  const latest = salarySlips[0];
  const currency = latest?.currency;

  const trend = useMemo(() => {
    if (salarySlips.length < 2) return null;
    const [current, previous] = salarySlips;
    const delta = Number(current.net_pay) - Number(previous.net_pay);
    if (!delta) return 'Unchanged from last period';
    return `${delta > 0 ? '+' : ''}${fmtMoney(delta, currency)} vs previous period`;
  }, [salarySlips, currency]);

  const columns = useMemo(
    () => [
      {
        key: 'start_date',
        header: 'Period',
        render: (row) => <span className="cell-strong">{fmtRange(row.start_date, row.end_date)}</span>,
        sortValue: (row) => row.start_date,
      },
      { key: 'posting_date', header: 'Posted', render: (row) => fmtDate(row.posting_date), sortValue: (row) => row.posting_date },
      { key: 'gross_pay', header: 'Gross', align: 'right', render: (row) => fmtMoney(row.gross_pay, row.currency), sortValue: (row) => Number(row.gross_pay) },
      { key: 'total_deduction', header: 'Deductions', align: 'right', render: (row) => fmtMoney(row.total_deduction, row.currency), sortValue: (row) => Number(row.total_deduction) },
      {
        key: 'net_pay',
        header: 'Net pay',
        align: 'right',
        render: (row) => <span className="cell-strong">{fmtMoney(row.net_pay, row.currency)}</span>,
        sortValue: (row) => Number(row.net_pay),
      },
      { key: 'bank_name', header: 'Bank', render: (row) => row.bank_name || '—' },
    ],
    [],
  );

  return (
    <div className="stack">
      <div className="page-head">
        <h1 className="page-head__title">Salary</h1>
        <p className="page-head__sub">Your submitted payslips and their component breakdown</p>
      </div>

      {salarySlips.length === 0 ? (
        <Card>
          <EmptyState
            title="No payslips yet"
            body="Submitted salary slips will appear here once payroll has run for you."
            icon={<Icon name="wallet" size={22} />}
          />
        </Card>
      ) : (
        <>
          <div className="grid grid--3">
            <div className="card">
              <Stat label="Latest net pay" value={fmtMoney(latest.net_pay, currency)} meta={trend || fmtRange(latest.start_date, latest.end_date)} />
            </div>
            <div className="card">
              <Stat label="Latest gross" value={fmtMoney(latest.gross_pay, currency)} meta={`Deductions ${fmtMoney(latest.total_deduction, currency)}`} />
            </div>
            <div className="card">
              <Stat label="Payslips on record" value={salarySlips.length} meta="Most recent 12 periods" />
            </div>
          </div>

          <Card
            flush
            title="Payslip history"
            action={
              <Button size="sm" onClick={() => exportCsv('payslips', columns, salarySlips)}>
                <Icon name="download" size={14} /> CSV
              </Button>
            }
          >
            <DataTable
              columns={columns}
              rows={salarySlips}
              onRowClick={setOpen}
              initialSort={{ key: 'start_date', dir: 'desc' }}
              emptyTitle="No payslips"
            />
          </Card>
        </>
      )}

      <SlipDrawer slip={open} onClose={() => setOpen(null)} />
    </div>
  );
}
