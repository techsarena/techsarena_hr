import { useMemo, useState } from 'react';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { Async, Card, EmptyState, Stat } from '../components/ui';
import { Icon } from '../components/Icon';
import { fmtDate, fmtDays, truthy } from '../api/format';
import { t } from '../api/i18n';

/** A leave type's headline numbers. Only tiles the record actually carries
 *  are rendered — an unset allocation is omitted, never shown as 0. */
function policyStats(type) {
  const tiles = [];
  if (type.max_leaves_allowed) {
    tiles.push({ label: t("Annual allocation"), value: type.max_leaves_allowed, meta: 'days' });
  }
  if (truthy(type.is_earned_leave) && type.earned_leave_frequency) {
    const ACCRUAL = {
      Monthly: { periods: 12, unit: 'per month' },
      Quarterly: { periods: 4, unit: 'per quarter' },
      'Half-Yearly': { periods: 2, unit: 'per half-year' },
      Yearly: { periods: 1, unit: 'per year' },
    }[type.earned_leave_frequency];
    const rate = ACCRUAL && type.max_leaves_allowed
      ? (Number(type.max_leaves_allowed) / ACCRUAL.periods).toFixed(1)
      : null;
    tiles.push(
      rate
        ? { label: t("Accrual"), value: rate, meta: ACCRUAL.unit }
        : { label: t("Accrual"), value: type.earned_leave_frequency, meta: 'earned' },
    );
  }
  if (truthy(type.is_carry_forward)) {
    tiles.push({
      label: t("Carry forward"),
      value: type.maximum_carry_forwarded_leaves || 'Yes',
      meta: type.maximum_carry_forwarded_leaves ? 'days max' : undefined,
    });
  }
  if (type.techsarena_notice_days) {
    tiles.push({ label: t("Notice required"), value: type.techsarena_notice_days, meta: 'days' });
  }
  return tiles;
}

/** Rules are derived from the record's own flags, so the screen never states
 *  a rule the backing Leave Type does not actually encode. */
function policyRules(type) {
  const rules = [];
  if (type.max_continuous_days_allowed) {
    rules.push({
      tone: 'allow',
      text: `Maximum ${type.max_continuous_days_allowed} consecutive days in one application.`,
    });
  }
  if ('allow_half_day' in type) {
    rules.push(
      truthy(type.allow_half_day)
        ? { tone: 'allow', text: 'Half-days are permitted on this leave type.' }
        : { tone: 'deny', text: 'Half-days are not permitted on this leave type.' },
    );
  }
  if (truthy(type.include_holiday)) {
    rules.push({ tone: 'deny', text: 'Holidays and weekends inside a leave block are counted against balance.' });
  } else {
    rules.push({ tone: 'allow', text: 'Holidays and weekends inside a leave block are not counted against balance.' });
  }
  if (truthy(type.is_earned_leave)) {
    rules.push({ tone: 'allow', text: 'Earned monthly rather than allocated up front.' });
  }
  if (truthy(type.is_lwp)) {
    rules.push({ tone: 'deny', text: 'Unpaid — days taken are deducted from pay.' });
  }
  if (truthy(type.is_optional_leave)) {
    rules.push({ tone: 'allow', text: 'Optional holiday — choose from the optional holiday list.' });
  }
  if (type.applicable_after) {
    rules.push({ tone: 'deny', text: `Cannot be applied for in the first ${type.applicable_after} days of service.` });
  }
  if (truthy(type.allow_encashment)) {
    rules.push({
      tone: 'allow',
      text: type.encashment_threshold_days
        ? `Unused balance above ${type.encashment_threshold_days} days is encashable.`
        : 'Unused balance is encashable.',
    });
  }
  if (truthy(type.is_compensatory)) {
    rules.push({ tone: 'allow', text: 'Earned from approved work on a holiday or weekly off.' });
  }
  return rules;
}

export default function LeavePolicies() {
  const { leaveBalances } = useWorkspace();
  const state = useAsync(({ signal }) => hr.leavePolicies({ signal }), []);
  const [selected, setSelected] = useState(null);

  const types = useMemo(() => state.data?.leave_types || [], [state.data]);

  const balanceFor = (leaveType) => leaveBalances.find((b) => b.leave_type === leaveType) || null;

  return (
    <div className="stack">
      <div className="page-head">
        <h1 className="page-head__title">{t("Leave policies")}</h1>
        <p className="page-head__sub">{t("What each leave type allows, and who signs it off")}</p>
      </div>

      <Async state={state} rows={6}>
        {(data) => {
          if (!types.length) {
            return (
              <EmptyState
                title={t("No leave types configured")}
                body={t("Leave types set up in HRMS will appear here with their rules.")}
                icon="◷"
              />
            );
          }

          const type = types.find((t) => t.name === selected) || types[0];
          const stats = policyStats(type);
          const rules = policyRules(type);
          const chain = data.approval_chain || [];
          const holidays = data.holidays || [];
          const documents = data.documents || [];
          const balance = balanceFor(type.name);

          return (
            <div className="md">
              <div className="md__rail">
                <div className="section-heading__label" style={{ padding: '0 var(--space-4) var(--space-2)' }}>
                  Leave types
                </div>
                {types.map((row) => {
                  const rowBalance = balanceFor(row.name);
                  return (
                    <button
                      key={row.name}
                      type="button"
                      className={`md__item${row.name === type.name ? ' is-active' : ''}`}
                      onClick={() => setSelected(row.name)}
                    >
                      <div className="md__item-title truncate">{row.name}</div>
                      <div className="md__item-meta truncate">
                        {[
                          row.max_leaves_allowed ? `${row.max_leaves_allowed} days` : null,
                          truthy(row.is_carry_forward) ? 'carry forward' : null,
                          truthy(row.is_lwp) ? 'unpaid' : null,
                          rowBalance ? `${Number(rowBalance.remaining).toFixed(1)} left` : null,
                        ].filter(Boolean).join(' · ') || 'No allocation set'}
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="stack" style={{ marginTop: 0 }}>
                <Card>
                  <div className="row row--between" style={{ alignItems: 'flex-start' }}>
                    <div>
                      <h2 className="section-heading__title">{type.name}</h2>
                      <p className="small subtle" style={{ marginTop: 3 }}>
                        {[
                          type.techsarena_policy_version ? `Policy ${type.techsarena_policy_version}` : null,
                          type.techsarena_effective_from ? `effective ${fmtDate(type.techsarena_effective_from)}` : null,
                          type.techsarena_applies_to || null,
                        ].filter(Boolean).join(' · ') || (data.policy_set ? `Policy set · ${data.policy_set}` : null)}
                      </p>
                    </div>
                    {balance && (
                      <span className="pill pill--info">
                        {Number(balance.remaining).toFixed(1)} of {Number(balance.allocated).toFixed(1)} left
                      </span>
                    )}
                  </div>

                  {stats.length > 0 ? (
                    <div className="grid grid--4" style={{ marginTop: 'var(--space-5)' }}>
                      {stats.map((tile) => (
                        <div className="card card--muted" key={tile.label}>
                          <Stat label={tile.label} value={tile.value} meta={tile.meta} />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="callout callout--warning" style={{ marginTop: 'var(--space-5)' }}>
                      <span className="callout__icon"><Icon name="close" size={15} /></span>
                      <span>
                        No allocation is configured on this leave type yet — annual days, accrual,
                        carry forward and notice period are all unset in HRMS.
                        {' '}<a href={`/app/leave-type/${encodeURIComponent(type.name)}`} target="_blank" rel="noreferrer">
                          Configure it
                        </a>.
                      </span>
                    </div>
                  )}
                </Card>

                <div className="grid grid--2">
                  <Card title={t("Rules")}>
                    {rules.map((rule, i) => (
                      <div className="rule" key={i}>
                        <span className={`rule__icon rule__icon--${rule.tone}`}>
                          <Icon name={rule.tone === 'allow' ? 'check' : 'close'} size={15} />
                        </span>
                        <span className="rule__text">{rule.text}</span>
                      </div>
                    ))}
                  </Card>

                  <div className="stack" style={{ marginTop: 0 }}>
                    <Card title={t("Approval chain")}>
                      {chain.length === 0 ? (
                        <p className="small subtle">
                          Your employee record has no approval chain configured.
                        </p>
                      ) : (
                        <>
                          {chain.map((step, i) => (
                            <div className="step" key={`${step.name}-${i}`}>
                              <span className="step__num">{i + 1}</span>
                              <div className="truncate">
                                <div className="step__name truncate">{step.name}</div>
                                <div className="step__meta truncate">
                                  {[step.role, step.scope].filter(Boolean).join(' · ')}
                                </div>
                              </div>
                            </div>
                          ))}
                          {type.techsarena_escalation_days && (
                            <p className="small subtle" style={{ marginTop: 'var(--space-3)' }}>
                              Auto-escalates after {fmtDays(type.techsarena_escalation_days)}.
                            </p>
                          )}
                        </>
                      )}
                    </Card>

                    {holidays.length > 0 && (
                      <Card title={t("Holidays left")} subtitle={data.holiday_list || undefined}>
                        {holidays.map((h, i) => (
                          <div className="field-row" key={`${h.holiday_date}-${i}`}>
                            <span className="field-row__label truncate">{h.description}</span>
                            <span className="field-row__value">{fmtDate(h.holiday_date)}</span>
                          </div>
                        ))}
                      </Card>
                    )}

                    {documents.length > 0 && (
                      <Card title={t("Documents")}>
                        {documents.map((doc) => (
                          <a
                            key={doc.file_url || doc.name}
                            href={doc.file_url}
                            target="_blank"
                            rel="noreferrer"
                            className="row"
                            style={{ gap: 8, padding: '6px 0' }}
                          >
                            <Icon name="download" size={15} />
                            <span className="truncate">{doc.file_name || doc.name}</span>
                          </a>
                        ))}
                      </Card>
                    )}
                  </div>
                </div>

                {balance && (
                  <div className="callout callout--success">
                    <span className="callout__icon"><Icon name="check" size={15} /></span>
                    <span>
                      You have {Number(balance.remaining).toFixed(1)} days left
                      {Number(balance.pending) > 0 ? ` and ${Number(balance.pending).toFixed(1)} pending` : ''}
                      {' '}on {type.name}.
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        }}
      </Async>
    </div>
  );
}
