import { useMemo, useState } from 'react';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { useToast } from '../hooks/useToast';
import { Async, Button, Card, Drawer, EmptyState, Field, FieldRow, Meter, Modal, Pill, Stat } from '../components/ui';
import { DataTable, exportCsv } from '../components/DataTable';
import { Icon } from '../components/Icon';
import { fmtDate, fmtMoney, fmtNumber, statusTone } from '../api/format';
import { t } from '../api/i18n';

/* Reschedule and skip run lending's formal Loan Restructure flow server-side —
   a real restructure that regenerates the schedule and posts the GL
   adjustments, not a schedule-only edit. The copy says so. */
function RescheduleModal({ loan, onClose, onDone }) {
  const toast = useToast();
  const [periods, setPeriods] = useState(loan ? String(loan.repayment_periods + 3) : '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!loan) return null;

  const submit = async () => {
    setBusy(true);
    try {
      await hr.rescheduleLoan(loan.name, Number(periods), reason || undefined);
      toast.success('Loan restructured with the new tenure.');
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
      title={t("Reschedule this loan")}
      subtitle={loan.name}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="indigo" onClick={submit} disabled={busy || !Number(periods)}>
            {busy ? 'Restructuring…' : 'Apply restructure'}
          </Button>
        </>
      }
    >
      <div className="fields">
        <p className="muted small">
          This submits a formal Loan Restructure: the repayment schedule is regenerated and the accounting
          adjustments are posted. Current tenure is {loan.repayment_periods} months.
        </p>
        <Field label={t("New tenure (months)")}>
          <input type="number" min="1" value={periods} onChange={(e) => setPeriods(e.target.value)} />
        </Field>
        <Field label={t("Reason")} hint="Recorded on the loan as an audit comment.">
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function SkipModal({ loan, onClose, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!loan) return null;

  const submit = async () => {
    setBusy(true);
    try {
      await hr.skipInstallment(loan.name, reason || undefined);
      toast.success('Instalment deferred; tenure extended by one month.');
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
      title={t("Skip one instalment")}
      subtitle={loan.name}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="indigo" onClick={submit} disabled={busy}>
            {busy ? 'Working…' : 'Defer instalment'}
          </Button>
        </>
      }
    >
      <div className="fields">
        <p className="muted small">
          Defers one instalment and extends the tenure to {loan.repayment_periods + 1} months, through the same
          formal restructure flow.
        </p>
        <Field label={t("Reason")}>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function LoanDetail({ loan, currency, canAdminister, onClose, onChanged }) {
  const state = useAsync(
    ({ signal }) => (loan ? hr.loanDetail(loan.name, { signal }) : Promise.resolve(null)),
    [loan?.name],
    { immediate: Boolean(loan) },
  );
  const [reschedule, setReschedule] = useState(null);
  const [skip, setSkip] = useState(null);

  const columns = useMemo(
    () => [
      { key: 'idx', header: '#', align: 'right', width: 50, sortValue: (row) => Number(row.idx) },
      { key: 'payment_date', header: t("Due"), render: (row) => <span className="cell-strong">{fmtDate(row.payment_date)}</span>, sortValue: (row) => row.payment_date },
      { key: 'principal_amount', header: t("Principal"), align: 'right', render: (row) => fmtMoney(row.principal_amount, currency), sortValue: (row) => Number(row.principal_amount) },
      { key: 'interest_amount', header: t("Interest"), align: 'right', render: (row) => fmtMoney(row.interest_amount, currency), sortValue: (row) => Number(row.interest_amount) },
      { key: 'total_payment', header: t("Instalment"), align: 'right', render: (row) => <span className="cell-strong">{fmtMoney(row.total_payment, currency)}</span>, sortValue: (row) => Number(row.total_payment) },
      { key: 'balance_loan_amount', header: t("Balance"), align: 'right', render: (row) => fmtMoney(row.balance_loan_amount, currency), sortValue: (row) => Number(row.balance_loan_amount) },
    ],
    [currency],
  );

  if (!loan) return null;

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        title={loan.loan_product || 'Loan'}
        subtitle={loan.name}
        /* Reschedule and skip drive lending's Loan Restructure, which posts GL
           and is an approval — HR only, server-side. Hiding them from the
           borrower keeps the UI honest rather than offering an action that can
           only come back as "not permitted". */
        footer={
          canAdminister ? (
            <>
              <Button onClick={() => setSkip(loan)}>{t("Skip an instalment")}</Button>
              <Button variant="indigo" onClick={() => setReschedule(loan)}>{t("Reschedule")}</Button>
            </>
          ) : null
        }
      >
        <Async state={state} rows={6}>
          {(data) => {
            const summary = data.loan || loan;
            const schedule = data.schedule || [];
            return (
              <div className="stack">
                <Card className="card--muted">
                  <Stat label={t("Outstanding")} value={fmtMoney(summary.outstanding, currency)} meta={`of ${fmtMoney(summary.total_payable, currency)} payable`} />
                  <div style={{ margin: 'var(--space-4) 0' }}>
                    <Meter value={summary.total_paid} total={summary.total_payable} tone="success" />
                  </div>
                  <FieldRow label={t("Status")} value={<Pill tone={statusTone(summary.status)}>{summary.status}</Pill>} />
                  <FieldRow label={t("Principal")} value={fmtMoney(summary.loan_amount, currency)} />
                  <FieldRow label={t("Interest rate")} value={summary.rate_of_interest ? `${fmtNumber(summary.rate_of_interest, 2)}%` : null} />
                  <FieldRow label={t("Tenure")} value={summary.repayment_periods ? `${summary.repayment_periods} months` : null} />
                  <FieldRow label={t("Monthly instalment")} value={summary.monthly_repayment_amount ? fmtMoney(summary.monthly_repayment_amount, currency) : null} />
                  <FieldRow label={t("Paid to date")} value={fmtMoney(summary.total_paid, currency)} />
                </Card>

                <Card
                  title={t("Repayment schedule")}
                  subtitle={`${schedule.length} instalments`}
                  flush
                  action={
                    schedule.length > 0 && (
                      <Button size="sm" onClick={() => exportCsv(`loan-${summary.name}-schedule`, columns, schedule)}>
                        <Icon name="download" size={14} /> CSV
                      </Button>
                    )
                  }
                >
                  <DataTable
                    columns={columns}
                    rows={schedule}
                    initialSort={{ key: 'idx', dir: 'asc' }}
                    emptyTitle="No active schedule"
                    emptyBody="A schedule appears once the loan is disbursed."
                    maxHeight="46vh"
                  />
                </Card>
              </div>
            );
          }}
        </Async>
      </Drawer>

      <RescheduleModal
        loan={reschedule}
        onClose={() => setReschedule(null)}
        onDone={() => { state.reload(); onChanged(); }}
      />
      <SkipModal
        loan={skip}
        onClose={() => setSkip(null)}
        onDone={() => { state.reload(); onChanged(); }}
      />
    </>
  );
}

export default function Loans() {
  const { currency, capabilities } = useWorkspace();
  const state = useAsync(({ signal }) => hr.myLoans({ signal }), []);
  const [open, setOpen] = useState(null);

  const loans = useMemo(() => state.data?.loans || [], [state.data]);
  const totals = useMemo(
    () => ({
      outstanding: loans.reduce((sum, l) => sum + (Number(l.outstanding) || 0), 0),
      monthly: loans.reduce((sum, l) => sum + (Number(l.monthly_repayment_amount) || 0), 0),
    }),
    [loans],
  );

  return (
    <div className="stack">
      <div className="page-head">
        <h1 className="page-head__title">{t("My loans")}</h1>
        <p className="page-head__sub">{t("Staff loans, their schedules, and restructure options")}</p>
      </div>

      <Async state={state} rows={4}>
        {(payload) => {
          if (!loans.length) {
            return (
              <Card>
                <EmptyState
                  title={payload.unavailable ? 'Loans are not enabled' : 'No loans'}
                  body={
                    payload.unavailable
                      ? 'Staff loans need the lending app installed on this site. Once it is, your loans and their repayment schedules appear here.'
                      : 'Staff loans issued to you will appear here with their full repayment schedule.'
                  }
                  icon={<Icon name="bank" size={22} />}
                />
              </Card>
            );
          }
          return (
            <>
              <div className="grid grid--3">
                <div className="card"><Stat label={t("Total outstanding")} value={fmtMoney(totals.outstanding, currency)} /></div>
                <div className="card"><Stat label={t("Monthly repayment")} value={fmtMoney(totals.monthly, currency)} /></div>
                <div className="card"><Stat label={t("Active loans")} value={loans.length} /></div>
              </div>

              <div className="grid grid--2">
                {loans.map((loan) => (
                  <Card
                    key={loan.name}
                    title={loan.loan_product || 'Loan'}
                    subtitle={loan.name}
                    action={<Pill tone={statusTone(loan.status)}>{loan.status}</Pill>}
                  >
                    <Stat label={t("Outstanding")} value={fmtMoney(loan.outstanding, currency)} meta={`of ${fmtMoney(loan.total_payable, currency)} payable`} />
                    <div style={{ margin: 'var(--space-4) 0' }}>
                      <Meter value={loan.total_paid} total={loan.total_payable} tone="success" />
                    </div>
                    <div className="row row--between small subtle">
                      <span>{fmtMoney(loan.monthly_repayment_amount, currency)}/month</span>
                      <span>{loan.repayment_periods} months</span>
                    </div>
                    <div style={{ marginTop: 'var(--space-4)' }}>
                      <Button variant="primary" size="sm" onClick={() => setOpen(loan)}>{t("View schedule")}</Button>
                    </div>
                  </Card>
                ))}
              </div>
            </>
          );
        }}
      </Async>

      <LoanDetail
        loan={open}
        currency={currency}
        canAdminister={Boolean(capabilities.can_manage_hr)}
        onClose={() => setOpen(null)}
        onChanged={state.reload}
      />
    </div>
  );
}
