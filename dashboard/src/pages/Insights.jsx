import { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { Async, Card, EmptyState, Pill } from '../components/ui';
import { exportCsv } from '../components/DataTable';
import { Icon } from '../components/Icon';
import { fmtMoney, toDate } from '../api/format';

const JOINERS = '#0E7490';
const EXITS = '#7771FA';
const AXIS = { stroke: '#64748B', fontSize: 11 };

const tooltipStyle = {
  contentStyle: {
    borderRadius: 10,
    border: '1px solid rgba(15,23,42,.12)',
    boxShadow: '0 4px 16px rgba(15,23,42,.08)',
    fontSize: 12,
  },
};

/** Applicant statuses in the order a candidate moves through them. Anything
 *  the site uses beyond these keeps its own name and sorts after. */
const FUNNEL_ORDER = ['Open', 'Replied', 'Screening', 'Shortlisted', 'Interview', 'Accepted', 'Rejected', 'Hold'];

const MONTH_INITIAL = new Intl.DateTimeFormat(undefined, { month: 'narrow' });
const MONTH_FULL = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

export default function Insights() {
  const { hrSummary, approvals, currency } = useWorkspace();
  const [months, setMonths] = useState(12);

  const state = useAsync(({ signal }) => hr.insights(months, { signal }), [months]);

  return (
    <div className="stack">
      <div className="row row--between page-head" style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <div>
          <h1 className="page-head__title">Insights</h1>
          <p className="page-head__sub">Workforce shape, drawn from the records this site keeps</p>
        </div>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <select
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
            style={{ width: 'auto' }}
            aria-label="Reporting window"
          >
            <option value={6}>Last 6 months</option>
            <option value={12}>Last 12 months</option>
            <option value={24}>Last 24 months</option>
          </select>
        </div>
      </div>

      <Async state={state} rows={8}>
        {(data) => (
          <InsightsBody
            data={data}
            hrSummary={hrSummary}
            approvals={approvals}
            currency={currency}
            months={months}
          />
        )}
      </Async>
    </div>
  );
}

function InsightsBody({ data, hrSummary, approvals, currency, months }) {
  const departments = data.departments || [];
  const summary = data.summary || hrSummary || {};

  const chartRows = useMemo(
    () => (data.movement || []).map((row) => {
      const d = toDate(row.month);
      return {
        month: row.month,
        label: d ? MONTH_INITIAL.format(d) : '',
        full: d ? MONTH_FULL.format(d) : row.month,
        Joiners: Number(row.joiners) || 0,
        Exits: Number(row.exits) || 0,
      };
    }),
    [data.movement],
  );

  const netChange = useMemo(
    () => chartRows.reduce((n, r) => n + r.Joiners - r.Exits, 0),
    [chartRows],
  );

  const funnel = useMemo(() => {
    const rows = (data.funnel || []).filter((r) => Number(r.count) > 0);
    return rows.sort((a, b) => {
      const ia = FUNNEL_ORDER.indexOf(a.stage);
      const ib = FUNNEL_ORDER.indexOf(b.stage);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }, [data.funnel]);

  const funnelMax = Math.max(1, ...funnel.map((r) => Number(r.count) || 0));
  const deptMax = Math.max(1, ...departments.map((r) => Number(r.count) || 0));

  const attritionRate = data.attrition?.rate;

  return (
    <>
      {/* ---- Headline figures ---- */}
      <div className="grid grid--4">
        <Metric label="Headcount" value={data.headcount ?? '—'}
          badge={netChange ? `${netChange > 0 ? '+' : ''}${netChange} net` : null}
          tone={netChange > 0 ? 'success' : netChange < 0 ? 'danger' : undefined} />

        {/* Omitted rather than shown as 0% when there is no denominator. */}
        <Metric
          label={`Attrition (${months}m)`}
          value={attritionRate === null || attritionRate === undefined ? '—' : `${attritionRate}%`}
          badge={data.attrition?.exits ? `${data.attrition.exits} exits` : null}
        />

        <Metric label="Joined this month" value={summary.new_this_month ?? '—'} />

        <Metric
          label="Open leave requests"
          value={summary.open_leave_requests ?? '—'}
          badge={approvals?.length ? `${approvals.length} to approve` : null}
          tone={summary.open_leave_requests ? 'warning' : undefined}
        />
      </div>

      {/* ---- Movement chart + payroll ---- */}
      <div className="insight-row">
        <Card
          title="Headcount & attrition"
          subtitle={`Joiners and exits over the last ${months} months`}
          action={<ChartLegend />}
        >
          {chartRows.length === 0 ? (
            <EmptyState title="No movement recorded" body="Joining and relieving dates drive this chart." icon="▤" />
          ) : (
            <div style={{ height: 300 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartRows} margin={{ top: 8, right: 8, bottom: 0, left: -22 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,.07)" vertical={false} />
                  <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} interval={0} />
                  <YAxis tick={AXIS} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip
                    {...tooltipStyle}
                    cursor={{ fill: 'rgba(15,23,42,.04)' }}
                    labelFormatter={(_label, payload) => payload?.[0]?.payload?.full || ''}
                  />
                  {/* Stacked, so each column reads as that month's total churn
                      with its split visible, rather than two bars to compare. */}
                  <Bar dataKey="Exits" stackId="m" fill={EXITS} maxBarSize={38} />
                  <Bar dataKey="Joiners" stackId="m" fill={JOINERS} radius={[4, 4, 0, 0]} maxBarSize={38} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <PayrollCard summary={summary} currency={currency} />
      </div>

      {/* ---- Departments, funnel, attention ---- */}
      <div className="insight-row insight-row--thirds">
        <Card
          title="Headcount by department"
          subtitle={`${departments.length} department${departments.length === 1 ? '' : 's'}`}
          action={
            departments.length > 0 && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => exportCsv('headcount-by-department',
                  [{ key: 'name', header: 'Department' }, { key: 'count', header: 'Employees' }],
                  departments)}
              >
                <Icon name="download" size={14} /> CSV
              </button>
            )
          }
        >
          {departments.length === 0 ? (
            <EmptyState title="No departments" body="Employees are not assigned to a department." icon="▤" />
          ) : (
            <ul className="bar-list">
              {departments.slice(0, 6).map((row) => (
                <li key={row.name}>
                  <div className="bar-list__head">
                    <span className="bar-list__name">{row.name}</span>
                    <span className="bar-list__value">{row.count}</span>
                  </div>
                  <div className="bar-list__track">
                    <span className="bar-list__fill" style={{ width: `${(row.count / deptMax) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Hiring pipeline" subtitle="Candidates by stage">
          {funnel.length === 0 ? (
            <EmptyState
              title="No candidates"
              body="This site has no applicant records to chart."
              icon="▤"
            />
          ) : (
            <ul className="funnel">
              {funnel.map((row) => (
                <li className="funnel__row" key={row.stage}>
                  <span className="funnel__stage">{row.stage}</span>
                  <span className="funnel__track">
                    <span className="funnel__fill" style={{ width: `${(row.count / funnelMax) * 100}%` }}>
                      <span className="funnel__count">{row.count}</span>
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <AttentionCard summary={summary} approvals={approvals} attrition={data.attrition} />
      </div>
    </>
  );
}

function ChartLegend() {
  return (
    <div className="chart-legend">
      <span className="chart-legend__item">
        <span className="chart-legend__dot" style={{ background: JOINERS }} /> Joiners
      </span>
      <span className="chart-legend__item">
        <span className="chart-legend__dot" style={{ background: EXITS }} /> Exits
      </span>
    </div>
  );
}

function Metric({ label, value, badge, tone }) {
  return (
    <div className="card metric">
      <div className="metric__label">{label}</div>
      <div className="metric__figure">
        <span className="metric__value">{value}</span>
        {badge && <Pill tone={tone}>{badge}</Pill>}
      </div>
    </div>
  );
}

/* Payroll progress is stated only from what the summary actually reports:
   how many slips exist against the active headcount. Nothing here claims a
   step is done that the site has not recorded. */
function PayrollCard({ summary, currency }) {
  const slips = Number(summary.salary_slips_this_month) || 0;
  const head = Number(summary.headcount) || 0;
  const pct = head > 0 ? Math.min(100, (slips / head) * 100) : 0;

  return (
    <Card title="Payroll this month" subtitle={slips ? `${slips} of ${head} slips submitted` : 'No slips submitted yet'}>
      <div className="payroll-progress">
        <div className="payroll-progress__ring" style={{ '--pct': `${pct}%` }}>
          <span>{Math.round(pct)}%</span>
        </div>
        <div className="payroll-progress__detail">
          <div className="field-row">
            <span className="field-row__label">Slips submitted</span>
            <span className="field-row__value">{slips}</span>
          </div>
          <div className="field-row">
            <span className="field-row__label">Active headcount</span>
            <span className="field-row__value">{head || '—'}</span>
          </div>
          {/* Only shown when the site reports a figure — never a computed guess. */}
          {summary.payroll_net_payable !== undefined && summary.payroll_net_payable !== null && (
            <div className="field-row">
              <span className="field-row__label">Net payable</span>
              <span className="field-row__value">{fmtMoney(summary.payroll_net_payable, currency)}</span>
            </div>
          )}
        </div>
      </div>
      <p className="small subtle" style={{ marginTop: 'var(--space-4)' }}>
        Counted from submitted salary slips dated this month.
      </p>
    </Card>
  );
}

/* Only conditions the payload actually evidences are listed. An empty list
   means nothing is outstanding, which is said plainly rather than left blank. */
function AttentionCard({ summary, approvals, attrition }) {
  const items = [];

  if (approvals?.length) {
    items.push({
      tone: 'warning',
      title: `${approvals.length} request${approvals.length === 1 ? '' : 's'} awaiting you`,
      body: 'Sitting in your approval inbox',
    });
  }
  if (Number(summary.open_leave_requests) > 0) {
    items.push({
      tone: 'info',
      title: `${summary.open_leave_requests} open leave request${Number(summary.open_leave_requests) === 1 ? '' : 's'}`,
      body: 'Across the whole site',
    });
  }
  if (Number(attrition?.exits) > 0) {
    items.push({
      tone: 'danger',
      title: `${attrition.exits} exit${Number(attrition.exits) === 1 ? '' : 's'} in this window`,
      body: attrition.rate !== null && attrition.rate !== undefined ? `${attrition.rate}% attrition` : 'Relieving dates recorded',
    });
  }
  const head = Number(summary.headcount) || 0;
  const slips = Number(summary.salary_slips_this_month) || 0;
  if (head > 0 && slips < head) {
    items.push({
      tone: 'warning',
      title: `${head - slips} employee${head - slips === 1 ? '' : 's'} without a slip this month`,
      body: 'Payroll may still be mid-run',
    });
  }

  return (
    <Card
      title="Needs attention"
      subtitle={items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : 'Everything is clear'}
    >
      {items.length === 0 ? (
        <EmptyState title="Nothing outstanding" body="No open approvals, exits or missing payslips." icon="✓" />
      ) : (
        <ul className="attention">
          {items.map((item) => (
            <li className="attention__item" key={item.title}>
              <span className={`attention__dot attention__dot--${item.tone}`} />
              <div>
                <div className="attention__title">{item.title}</div>
                <div className="small subtle">{item.body}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
