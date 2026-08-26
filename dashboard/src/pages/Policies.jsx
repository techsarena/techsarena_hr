/**
 * Company policies — read them, and record that you have.
 *
 * The acknowledgement is evidence, so the flow is built around making it
 * truthful rather than quick: the confirm control only arms once the policy has
 * actually been opened, and it names the version being confirmed. A tick-box
 * next to an unopened document is worth nothing to an auditor.
 *
 * HR gets a second tab showing who has confirmed and who has not.
 */
import { useMemo, useState } from 'react';
import hr from '../api/hr';
import { t } from '../api/i18n';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { useAsync, useMutation } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { Async, Button, Card, Drawer, EmptyState, Meter, Pill, Tabs } from '../components/ui';
import { Icon } from '../components/Icon';
import { fmtDate } from '../api/format';

export default function Policies() {
  const { capabilities } = useWorkspace();
  const isHr = Boolean(capabilities.can_manage_hr);
  const [tab, setTab] = useState('mine');

  const mine = useAsync(({ signal }) => hr.myPolicies({ signal }), []);
  const outstanding = mine.data?.outstanding || 0;

  const tabs = useMemo(() => {
    const base = [{ id: 'mine', label: t('My policies'), count: outstanding || undefined }];
    if (isHr) base.push({ id: 'compliance', label: t('Compliance') });
    return base;
  }, [outstanding, isHr]);

  return (
    <div className="stack">
      <div className="page-head">
        <h1 className="page-head__title">{t('Policies')}</h1>
        <p className="page-head__sub">{t('Company policies and what you have confirmed reading')}</p>
      </div>

      {isHr && <Tabs items={tabs} value={tab} onChange={setTab} />}

      {tab === 'mine' || !isHr ? <MyPolicies state={mine} /> : <Compliance />}
    </div>
  );
}

/* ------------------------------------------------------------ Employee */

function MyPolicies({ state }) {
  const [reading, setReading] = useState(null);

  return (
    <Async state={state} rows={4}>
      {(data) => (data.policies.length === 0 ? (
        <Card>
          <EmptyState
            title={t('No policies published')}
            body={t('Policies your company publishes will appear here.')}
            icon={<Icon name="checklist" size={22} />}
          />
        </Card>
      ) : (
        <div className="stack">
          {data.outstanding > 0 && (
            <Card className="card--muted">
              <div className="row" style={{ gap: 'var(--space-3)', alignItems: 'flex-start' }}>
                <Icon name="checklist" size={18} />
                <div>
                  <strong>
                    {data.outstanding === 1
                      ? t('1 policy needs your confirmation')
                      : t('{0} policies need your confirmation', [data.outstanding])}
                  </strong>
                  <p className="small subtle" style={{ margin: '2px 0 0' }}>
                    {t('Open each one to read it, then confirm.')}
                  </p>
                </div>
              </div>
            </Card>
          )}

          <Card flush>
            <ul className="policy-list">
              {data.policies.map((policy) => {
                const needs = policy.requires_acknowledgement && !policy.acknowledged;
                return (
                  <li key={policy.name}>
                    <button
                      type="button"
                      className={`policy-row${needs ? ' is-outstanding' : ''}`}
                      onClick={() => setReading(policy.name)}
                    >
                      <div className="col" style={{ gap: 3, minWidth: 0 }}>
                        <span className="row" style={{ gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                          <strong className="truncate">{policy.title}</strong>
                          {policy.acknowledged ? (
                            <Pill tone="success" dot>{t('Confirmed')}</Pill>
                          ) : policy.previously_acknowledged ? (
                            /* Distinguishing "changed since you read it" from
                               "new to you" tells the employee why it is back. */
                            <Pill tone="warning" dot>{t('Updated — read again')}</Pill>
                          ) : policy.requires_acknowledgement ? (
                            <Pill tone="warning" dot>{t('Not confirmed')}</Pill>
                          ) : null}
                        </span>
                        <span className="small subtle truncate">
                          {[
                            t(policy.policy_type),
                            t('v{0}', [policy.version]),
                            policy.effective_from ? t('from {0}', [fmtDate(policy.effective_from)]) : null,
                          ].filter(Boolean).join(' · ')}
                        </span>
                        {policy.summary && <span className="small truncate">{policy.summary}</span>}
                      </div>
                      <Icon name="external" size={15} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>

          <PolicyDrawer
            name={reading}
            onClose={() => setReading(null)}
            onAcknowledged={() => { setReading(null); state.reload(); }}
          />
        </div>
      ))}
    </Async>
  );
}

function PolicyDrawer({ name, onClose, onAcknowledged }) {
  const toast = useToast();
  const state = useAsync(
    ({ signal }) => (name ? hr.policyDetail(name, { signal }) : Promise.resolve(null)),
    [name],
  );
  // The confirm control arms only once the reader says they have read it —
  // an acknowledgement recorded without that is evidence of nothing.
  const [confirmed, setConfirmed] = useState(false);

  const policy = state.data;

  const acknowledge = useMutation(async () => {
    await hr.acknowledgePolicy(policy.name, policy.version);
    toast.success(t('Confirmed. Thank you.'));
    setConfirmed(false);
    onAcknowledged();
  });

  const close = () => { setConfirmed(false); onClose(); };

  return (
    <Drawer
      open={Boolean(name)}
      onClose={close}
      title={policy?.title || t('Policy')}
      subtitle={policy ? [t(policy.policy_type), t('v{0}', [policy.version])].join(' · ') : undefined}
      footer={policy && policy.requires_acknowledgement && !policy.acknowledged ? (
        <div className="col" style={{ width: '100%', gap: 'var(--space-3)' }}>
          <label className="row small" style={{ gap: 8, alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={confirmed}
              style={{ width: 'auto', margin: '2px 0 0' }}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>{t('I have read and understood this policy (version {0}).', [policy.version])}</span>
          </label>
          <div className="row row--end">
            <Button
              variant="indigo"
              onClick={acknowledge.mutate}
              disabled={!confirmed || acknowledge.pending}
            >
              {acknowledge.pending ? t('Recording…') : t('Confirm')}
            </Button>
          </div>
        </div>
      ) : undefined}
    >
      <Async state={state} rows={6}>
        {(data) => (
          <div className="stack">
            {data.acknowledged && (
              <Card className="card--muted">
                <span className="row small" style={{ gap: 8, alignItems: 'center' }}>
                  <Pill tone="success" dot>{t('Confirmed')}</Pill>
                  {data.acknowledged_on ? t('on {0}', [fmtDate(data.acknowledged_on)]) : ''}
                </span>
              </Card>
            )}

            {data.summary && <p className="muted" style={{ margin: 0 }}>{data.summary}</p>}

            {data.body && (
              /* Body is authored by HR in the desk's own rich-text editor, so
                 the markup is theirs, not user-supplied from the app. */
              <div className="policy-body" dangerouslySetInnerHTML={{ __html: data.body }} />
            )}

            {data.attachment && (
              <a className="btn btn--ghost" href={data.attachment} target="_blank" rel="noreferrer">
                <Icon name="download" size={15} /> {t('Open the document')}
              </a>
            )}

            <p className="small subtle" style={{ margin: 0 }}>
              {t('In force from {0}', [fmtDate(data.effective_from)])}
            </p>
          </div>
        )}
      </Async>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ HR */

function Compliance() {
  const state = useAsync(({ signal }) => hr.policyCompliance(undefined, { signal }), []);
  const [showing, setShowing] = useState(null);

  return (
    <Async state={state} rows={4}>
      {(data) => (data.policies.length === 0 ? (
        <Card>
          <EmptyState title={t('No policies in force')} body={t('Publish a policy to track confirmations.')} icon="◍" />
        </Card>
      ) : (
        <div className="stack">
          {data.policies.map((policy) => (
            <Card key={policy.name}>
              <div className="row row--between" style={{ gap: 'var(--space-4)', flexWrap: 'wrap' }}>
                <div className="col" style={{ gap: 2, minWidth: 0 }}>
                  <strong>{policy.title}</strong>
                  <span className="small subtle">
                    {[t(policy.policy_type), t('v{0}', [policy.version])].join(' · ')}
                  </span>
                </div>
                <div className="row" style={{ gap: 'var(--space-3)', alignItems: 'center' }}>
                  <span className="small">
                    {t('{0} of {1}', [policy.acknowledged, policy.audience])}
                  </span>
                  {policy.pending.length > 0 && (
                    <Button size="sm" onClick={() => setShowing(policy)}>
                      {t('Who has not')}
                    </Button>
                  )}
                </div>
              </div>
              {policy.percent !== null && (
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <Meter value={policy.acknowledged} total={policy.audience}
                         tone={policy.percent === 100 ? 'success' : undefined} />
                </div>
              )}
            </Card>
          ))}

          <Drawer
            open={Boolean(showing)}
            onClose={() => setShowing(null)}
            title={t('Not yet confirmed')}
            subtitle={showing?.title}
          >
            <ul className="policy-list">
              {(showing?.pending || []).map((person) => (
                <li className="policy-pending" key={person.employee}>
                  <span className="truncate">{person.employee_name}</span>
                  {person.department && <span className="small subtle">{person.department}</span>}
                </li>
              ))}
            </ul>
          </Drawer>
        </div>
      ))}
    </Async>
  );
}
