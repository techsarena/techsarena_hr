import { useMemo, useState } from 'react';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { Button, Card, EmptyState } from '../components/ui';
import { exportCsv } from '../components/DataTable';
import { Icon } from '../components/Icon';
import { fmtDate, fmtDateShort, fmtMoney, toDate } from '../api/format';
import { t } from '../api/i18n';

/** April-start financial year, matching the HRMS default. */
function fyOf(value) {
  const d = toDate(value);
  if (!d) return null;
  const start = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return { key: String(start), label: `FY ${start}–${String(start + 1).slice(2)}` };
}

const MONTH_FMT = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const monthLabelOf = (slip) => {
  const d = toDate(slip.end_date) || toDate(slip.start_date);
  return d ? MONTH_FMT.format(d) : slip.name;
};

/* Frappe renders the payslip itself — asking it for the PDF keeps the
   downloaded document identical to what the print view shows, rather than a
   second rendering of the same numbers that could drift from it. */
function payslipPdfUrl(slip) {
  const params = new URLSearchParams({
    doctype: 'Salary Slip',
    name: slip.name,
    format: 'Salary Slip',
    no_letterhead: '0',
  });
  return `/api/method/frappe.utils.print_format.download_pdf?${params}`;
}

/** A component row's share of its side, for the proportion bar. */
function shares(rows, total) {
  const sum = Number(total) || rows.reduce((n, r) => n + Number(r.amount || 0), 0);
  if (!sum) return [];
  return rows.map((r) => ({ ...r, pct: (Number(r.amount || 0) / sum) * 100 }));
}

export default function Salary() {
  const { salarySlips } = useWorkspace();
  const [selected, setSelected] = useState(null);
  const [fy, setFy] = useState('all');

  const years = useMemo(() => {
    const seen = new Map();
    for (const slip of salarySlips) {
      const f = fyOf(slip.end_date || slip.start_date);
      if (f) seen.set(f.key, f.label);
    }
    return [...seen].sort((a, b) => b[0].localeCompare(a[0]));
  }, [salarySlips]);

  const slips = useMemo(
    () => (fy === 'all'
      ? salarySlips
      : salarySlips.filter((s) => fyOf(s.end_date || s.start_date)?.key === fy)),
    [salarySlips, fy],
  );

  // Derived, not stored: a slip the year filter has just hidden falls back to
  // the newest visible one without an effect round-trip.
  const active = useMemo(
    () => slips.find((s) => s.name === selected) || slips[0] || null,
    [slips, selected],
  );

  const csvColumns = [
    { key: 'start_date', header: t("From") },
    { key: 'end_date', header: 'To' },
    { key: 'posting_date', header: t("Posted") },
    { key: 'gross_pay', header: t("Gross") },
    { key: 'total_deduction', header: t("Deductions") },
    { key: 'net_pay', header: t("Net pay") },
  ];

  if (salarySlips.length === 0) {
    return (
      <div className="stack">
        <div className="page-head">
          <h1 className="page-head__title">{t("Salary")}</h1>
          <p className="page-head__sub">{t("Your payslips and their component breakdown")}</p>
        </div>
        <Card>
          <EmptyState
            title={t("No payslips yet")}
            body={t("Submitted salary slips will appear here once payroll has run for you.")}
            icon={<Icon name="wallet" size={22} />}
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row row--between page-head" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <div>
          <h1 className="page-head__title">{t("Salary")}</h1>
          <p className="page-head__sub">{t("Your payslips and their component breakdown")}</p>
        </div>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          {years.length > 1 && (
            <select value={fy} onChange={(e) => setFy(e.target.value)} style={{ width: 'auto' }} aria-label={t("Financial year")}>
              <option value="all">{t("All years")}</option>
              {years.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          )}
          <Button size="sm" onClick={() => exportCsv('payslips', csvColumns, slips)}>
            <Icon name="download" size={14} /> Export CSV
          </Button>
        </div>
      </div>

      <div className="pay-layout">
        {/* ---- Payslip rail ---- */}
        <aside className="pay-rail">
          <div className="pay-rail__label">{t("Payslips")}</div>
          <div className="pay-rail__list">
            {slips.map((slip) => (
              <button
                type="button"
                key={slip.name}
                className={`pay-rail__item${slip.name === active?.name ? ' is-active' : ''}`}
                aria-current={slip.name === active?.name}
                onClick={() => setSelected(slip.name)}
              >
                <span className="pay-rail__month">
                  {monthLabelOf(slip)}
                  {slip.posting_date && (
                    <span className="pay-rail__paid">Paid {fmtDateShort(slip.posting_date)}</span>
                  )}
                </span>
                <span className="pay-rail__amount">{fmtMoney(slip.net_pay, slip.currency)}</span>
              </button>
            ))}
          </div>
        </aside>

        {/* ---- Selected payslip ---- */}
        {active && <PayslipDetail slip={active} />}
      </div>
    </div>
  );
}

function PayslipDetail({ slip }) {
  const currency = slip.currency;
  const earnings = shares(slip.earnings || [], slip.gross_pay);
  const deductions = slip.deductions || [];

  return (
    <div className="stack" style={{ minWidth: 0 }}>
      {/* ---- Net pay hero ---- */}
      <div className="pay-hero">
        <div className="pay-hero__main">
          <div className="pay-hero__label">Net pay · {monthLabelOf(slip)}</div>
          <div className="pay-hero__value">{fmtMoney(slip.net_pay, currency)}</div>
          {/* Only stated when the document actually records it — a payslip with
              no posting date or bank must not imply it was credited. */}
          {(slip.posting_date || slip.bank_name) && (
            <div className="pay-hero__meta">
              {slip.posting_date ? `Credited ${fmtDate(slip.posting_date)}` : 'Not yet credited'}
              {slip.bank_name ? ` to ${slip.bank_name}` : ''}
            </div>
          )}
        </div>

        <div className="pay-hero__figures">
          <div className="pay-hero__figure">
            <span className="pay-hero__figure-label">{t("Gross")}</span>
            <span className="pay-hero__figure-value">{fmtMoney(slip.gross_pay, currency)}</span>
          </div>
          <div className="pay-hero__figure">
            <span className="pay-hero__figure-label">{t("Deductions")}</span>
            <span className="pay-hero__figure-value">{fmtMoney(slip.total_deduction, currency)}</span>
          </div>
        </div>

        <a className="btn btn--indigo pay-hero__action" href={payslipPdfUrl(slip)} target="_blank" rel="noreferrer">
          <Icon name="download" size={15} /> Download PDF
        </a>
      </div>

      {/* ---- Component breakdown ---- */}
      <div className="grid grid--2 pay-breakdown">
        <Card className="pay-panel">
          <header className="pay-panel__head">
            <h3 className="card__title">{t("Earnings")}</h3>
            <span className="pay-panel__total">{fmtMoney(slip.gross_pay, currency)}</span>
          </header>
          {earnings.length === 0 ? (
            <EmptyState title={t("No earning lines")} body={t("This payslip records no component rows.")} icon="◷" />
          ) : (
            <>
              <ul className="pay-lines">
                {earnings.map((row, i) => (
                  <li className="pay-line" key={`${row.salary_component}-${i}`}>
                    <span className="pay-line__name">{row.salary_component}</span>
                    <span className="pay-line__amount">{fmtMoney(row.amount, currency)}</span>
                  </li>
                ))}
              </ul>
              {/* Composition of gross at a glance — which components the pay
                  actually consists of, without a second set of numbers. */}
              <div className="pay-bar" role="img" aria-label={t("Share of gross by component")}>
                {earnings.map((row, i) => (
                  <span
                    key={`${row.salary_component}-${i}`}
                    className={`pay-bar__seg pay-bar__seg--${i % 4}`}
                    style={{ width: `${row.pct}%` }}
                    title={`${row.salary_component} · ${fmtMoney(row.amount, currency)}`}
                  />
                ))}
              </div>
            </>
          )}
        </Card>

        <Card className="pay-panel">
          <header className="pay-panel__head">
            <h3 className="card__title">{t("Deductions")}</h3>
            <span className="pay-panel__total pay-panel__total--minus">
              − {fmtMoney(slip.total_deduction, currency)}
            </span>
          </header>
          {deductions.length === 0 ? (
            <EmptyState title={t("No deductions")} body={t("Nothing was withheld from this payslip.")} icon="◷" />
          ) : (
            <ul className="pay-lines">
              {deductions.map((row, i) => (
                <li className="pay-line" key={`${row.salary_component}-${i}`}>
                  <span className="pay-line__name">{row.salary_component}</span>
                  <span className="pay-line__amount">{fmtMoney(row.amount, currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
