import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { Async, Card, EmptyState, FieldRow, Meter, Pill, Stat } from '../components/ui';
import { Icon } from '../components/Icon';
import { fmtDate, fmtNumber, fmtRange, statusTone } from '../api/format';

/**
 * Read-only by design.
 *
 * goals_and_appraisal returns ONLY {goals, appraisals}. Per-goal self-rating
 * (rate_goal / submit_self_assessment) is not implemented server-side, so this
 * screen shows no rating control and no self-assessment banner. Nothing here
 * fabricates a score — an unrated goal renders as unrated, never as zero.
 */
export default function Goals() {
  const state = useAsync(({ signal }) => hr.goalsAndAppraisal({ signal }), []);

  return (
    <div className="stack">
      <div className="page-head">
        <h1 className="page-head__title">Goals &amp; appraisal</h1>
        <p className="page-head__sub">Your goals and appraisal scores as recorded in HRMS</p>
      </div>

      <Async state={state} rows={5}>
        {(data) => {
          const goals = data.goals || [];
          const appraisals = data.appraisals || [];

          if (!goals.length && !appraisals.length) {
            return (
              <Card>
                <EmptyState
                  title="No goals or appraisals"
                  body="Goal and Appraisal records are optional in a stock install. Once your organisation runs an appraisal cycle, it will show here."
                  icon={<Icon name="target" size={22} />}
                />
              </Card>
            );
          }

          return (
            <>
              {appraisals.length > 0 && (
                <div className="grid grid--auto">
                  {appraisals.map((appraisal) => (
                    <Card key={appraisal.name} title={appraisal.appraisal_cycle || 'Appraisal'} subtitle={fmtRange(appraisal.start_date, appraisal.end_date)}>
                      <Stat
                        label="Final score"
                        // Null means not scored — never rendered as 0.
                        value={appraisal.final_score !== null && appraisal.final_score !== undefined ? fmtNumber(appraisal.final_score, 2) : 'Not scored'}
                      />
                      <div style={{ marginTop: 'var(--space-4)' }}>
                        <FieldRow label="Total score" value={appraisal.total_score !== null && appraisal.total_score !== undefined ? fmtNumber(appraisal.total_score, 2) : null} />
                        <FieldRow label="Self score" value={appraisal.self_score !== null && appraisal.self_score !== undefined ? fmtNumber(appraisal.self_score, 2) : null} />
                        <FieldRow label="Feedback average" value={appraisal.avg_feedback_score !== null && appraisal.avg_feedback_score !== undefined ? fmtNumber(appraisal.avg_feedback_score, 2) : null} />
                        <FieldRow label="Goal score" value={appraisal.goal_score_percentage !== null && appraisal.goal_score_percentage !== undefined ? `${fmtNumber(appraisal.goal_score_percentage)}%` : null} />
                        <FieldRow label="State" value={appraisal.docstatus === 1 ? 'Submitted' : 'Draft'} />
                      </div>
                    </Card>
                  ))}
                </div>
              )}

              <Card title="Goals" subtitle={`${goals.length} recorded`}>
                {goals.length === 0 ? (
                  <EmptyState title="No goals set" body="Goals assigned to you will appear here." icon="◎" />
                ) : (
                  <div className="stack">
                    {goals.map((goal) => (
                      <div key={goal.name} className="card card--muted">
                        <div className="row row--between" style={{ alignItems: 'flex-start', gap: 'var(--space-4)' }}>
                          <div className="truncate">
                            <div style={{ fontWeight: 600 }} className="truncate">{goal.goal_name}</div>
                            <div className="small subtle">
                              {[goal.kra, goal.appraisal_cycle, fmtRange(goal.start_date, goal.end_date)]
                                .filter(Boolean)
                                .join(' · ')}
                            </div>
                          </div>
                          {goal.status && <Pill tone={statusTone(goal.status)}>{goal.status}</Pill>}
                        </div>
                        {goal.progress !== null && goal.progress !== undefined && (
                          <div style={{ marginTop: 'var(--space-3)' }}>
                            <div className="row row--between small" style={{ marginBottom: 4 }}>
                              <span className="subtle">Progress</span>
                              <span className="tabular">{fmtNumber(goal.progress)}%</span>
                            </div>
                            <Meter value={Number(goal.progress)} total={100} tone={Number(goal.progress) >= 100 ? 'success' : undefined} />
                          </div>
                        )}
                        {goal.end_date && (
                          <div className="small subtle" style={{ marginTop: 8 }}>Due {fmtDate(goal.end_date)}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <p className="small subtle" style={{ textAlign: 'center' }}>
                Goals are read-only here — this site's backend does not expose per-goal self-rating.
              </p>
            </>
          );
        }}
      </Async>
    </div>
  );
}
