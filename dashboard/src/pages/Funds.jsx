import { useMemo, useState } from 'react';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { Async, Card, EmptyState, Pill, Stat, Tabs } from '../components/ui';
import { DataTable, exportCsv } from '../components/DataTable';
import { Button } from '../components/ui';
import { Icon } from '../components/Icon';
import { fmtDate, fmtMoney } from '../api/format';

const CREDIT_ENTRIES = new Set(['Employee Contribution', 'Employer Contribution', 'Profit']);

export default function Funds() {
  const { currency } = useWorkspace();
  const state = useAsync(({ signal }) => hr.myFunds({ signal }), []);
  const [fundType, setFundType] = useState('all');

  const data = state.data;
  const balances = data?.balances || {};
  const allTransactions = useMemo(() => data?.transactions || [], [data]);

  const transactions = useMemo(
    () => (fundType === 'all' ? allTransactions : allTransactions.filter((row) => row.fund_type === fundType)),
    [allTransactions, fundType],
  );

  const columns = useMemo(
    () => [
      { key: 'posting_date', header: 'Date', render: (row) => <span className="cell-strong">{fmtDate(row.posting_date)}</span>, sortValue: (row) => row.posting_date },
      { key: 'fund_type', header: 'Fund', render: (row) => <Pill>{row.fund_type}</Pill> },
      {
        key: 'entry_type',
        header: 'Entry',
        render: (row) => (
          <Pill tone={CREDIT_ENTRIES.has(row.entry_type) ? 'success' : 'warning'}>{row.entry_type}</Pill>
        ),
      },
      { key: 'period', header: 'Period', render: (row) => row.period || '—' },
      {
        key: 'amount',
        header: 'Amount',
        align: 'right',
        render: (row) => {
          const credit = CREDIT_ENTRIES.has(row.entry_type);
          return (
            <span className="cell-strong" style={{ color: credit ? 'var(--success)' : 'var(--danger)' }}>
              {credit ? '+' : '−'}{fmtMoney(Math.abs(Number(row.amount)), currency)}
            </span>
          );
        },
        sortValue: (row) => Number(row.amount) || 0,
      },
      { key: 'remarks', header: 'Remarks', render: (row) => <span className="subtle truncate" style={{ maxWidth: 240, display: 'inline-block' }}>{row.remarks || '—'}</span> },
    ],
    [currency],
  );

  const fundTypes = Object.keys(balances);

  return (
    <div className="stack">
      <div className="page-head">
        <h1 className="page-head__title">My funds</h1>
        <p className="page-head__sub">Your EOBI and provident fund ledger</p>
      </div>

      <Async state={state} rows={5}>
        {() => (
          <>
            {fundTypes.length > 0 ? (
              <div className="grid grid--auto">
                {fundTypes.map((type) => (
                  <div className="card" key={type}>
                    <Stat
                      label={type}
                      value={fmtMoney(balances[type], currency)}
                      meta={`${allTransactions.filter((t) => t.fund_type === type).length} transactions`}
                    />
                  </div>
                ))}
              </div>
            ) : null}

            {allTransactions.length === 0 ? (
              <Card>
                <EmptyState
                  title="No fund transactions"
                  body="Contributions, withdrawals and profit allocations posted against your funds will show here."
                  icon={<Icon name="vault" size={22} />}
                />
              </Card>
            ) : (
              <Card flush>
                <div className="row row--between" style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
                  <Tabs
                    value={fundType}
                    onChange={setFundType}
                    items={[
                      { id: 'all', label: 'All', count: allTransactions.length },
                      ...fundTypes.map((type) => ({
                        id: type,
                        label: type,
                        count: allTransactions.filter((t) => t.fund_type === type).length,
                      })),
                    ]}
                  />
                  <Button size="sm" onClick={() => exportCsv('fund-statement', columns, transactions)}>
                    <Icon name="download" size={14} /> CSV
                  </Button>
                </div>
                <DataTable
                  columns={columns}
                  rows={transactions}
                  initialSort={{ key: 'posting_date', dir: 'desc' }}
                  emptyTitle="No transactions in this fund"
                  maxHeight="60vh"
                />
              </Card>
            )}

            <p className="small subtle" style={{ textAlign: 'center' }}>
              Contribution rates are configured on the server. Confirm them against current regulation.
            </p>
          </>
        )}
      </Async>
    </div>
  );
}
