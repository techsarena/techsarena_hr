import { useState } from 'react';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import {
  Async, Button, Card, Drawer, EmptyState, Field, FieldRow, Meter, Pill, Stat,
} from '../components/ui';
import { Icon } from '../components/Icon';
import { fmtDate, fmtNumber, fmtRange, statusTone } from '../api/format';
import { t } from '../api/i18n';

/**
 * Goals and appraisal, now writable.
 *
 * Scores are still never computed here: rate_goal saves progress and
 * submit_self_assessment saves ratings, then HRMS's Appraisal recalculates
 * self/final score on save. An unrated goal renders as unrated, never as zero.
 */

/* ---------- Progress editor ---------- */
function GoalRow({ goal, onSaved }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(Number(goal.progress) || 0);
  const [busy, setBusy] = useState(false);

  // A parent goal rolls its progress up from its children, so it is not
  // directly editable — matching the server-side guard.
  const locked = Boolean(goal.is_group) || ['Archived', 'Closed'].includes(goal.status);

  const save = async () => {
    setBusy(true);
    try {
      await hr.rateGoal(goal.name, value);
      toast.success('Progress updated.');
      setEditing(false);
      onSaved?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card--muted">
      <div className="row row--between" style={{ alignItems: 'flex-start', gap: 'var(--space-4)' }}>
        <div className="truncate">
          <div style={{ fontWeight: 600 }} className="truncate">{goal.goal_name}</div>
          <div className="small subtle">
            {[goal.kra, goal.appraisal_cycle, fmtRange(goal.start_date, goal.end_date)]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          {goal.status && <Pill tone={statusTone(goal.status)}>{goal.status}</Pill>}
          {!locked && !editing && (
            <Button size="sm" onClick={() => { setValue(Number(goal.progress) || 0); setEditing(true); }}>
              Update
            </Button>
          )}
        </div>
      </div>

      {goal.progress !== null && goal.progress !== undefined && !editing && (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <div className="row row--between small" style={{ marginBottom: 4 }}>
            <span className="subtle">{t("Progress")}</span>
            <span className="tabular">{fmtNumber(goal.progress)}%</span>
          </div>
          <Meter
            value={Number(goal.progress)}
            total={100}
            tone={Number(goal.progress) >= 100 ? 'success' : undefined}
          />
        </div>
      )}

      {editing && (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <div className="row row--between small" style={{ marginBottom: 4 }}>
            <span className="subtle">{t("Progress")}</span>
            <span className="tabular">{value}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={value}
            onChange={(e) => setValue(Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <div className="row" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
            <Button variant="primary" size="sm" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" onClick={() => setEditing(false)} disabled={busy}>{t("Cancel")}</Button>
            {value >= 100 && <span className="small subtle">{t("Marks the goal complete.")}</span>}
          </div>
        </div>
      )}

      {goal.is_group && (
        <div className="small subtle" style={{ marginTop: 8 }}>
          Rolled up from child goals.
        </div>
      )}
      {goal.end_date && !goal.is_group && (
        <div className="small subtle" style={{ marginTop: 8 }}>Due {fmtDate(goal.end_date)}</div>
      )}
    </div>
  );
}

/* ---------- Self-assessment ---------- */
function SelfAssessmentDrawer({ appraisal, onClose, onSaved }) {
  const toast = useToast();
  const state = useAsync(
    ({ signal }) => (appraisal ? hr.appraisalDetail(appraisal.name, { signal }) : Promise.resolve(null)),
    [appraisal?.name],
    { immediate: Boolean(appraisal) },
  );
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);

  if (!appraisal) return null;

  const save = async (detail) => {
    setBusy(true);
    try {
      const ratings = (draft?.ratings ?? detail.self_ratings).map((row) => ({
        criteria: row.criteria,
        rating: row.rating,
      }));
      const result = await hr.submitSelfAssessment(
        appraisal.name,
        draft?.reflections ?? detail.reflections ?? '',
        ratings,
      );
      toast.success(`Self-assessment saved. Score ${fmtNumber(result.self_score, 2)}.`);
      onClose();
      onSaved?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title={t("Self-assessment")}
      subtitle={appraisal.appraisal_cycle || appraisal.name}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button
            variant="primary"
            onClick={() => save(state.data)}
            disabled={busy || !state.data || state.data.docstatus !== 0}
          >
            {busy ? 'Saving…' : 'Save assessment'}
          </Button>
        </>
      }
    >
      <Async state={state} rows={5}>
        {(detail) => {
          const ratings = draft?.ratings ?? detail.self_ratings ?? [];
          const reflections = draft?.reflections ?? detail.reflections ?? '';
          const stars = detail.star_count || 5;

          const setRating = (criteria, rating) =>
            setDraft({
              reflections,
              ratings: ratings.map((row) => (row.criteria === criteria ? { ...row, rating } : row)),
            });

          if (detail.docstatus !== 0) {
            return (
              <EmptyState
                title={t("Appraisal submitted")}
                body={t("This appraisal has been submitted and can no longer be edited.")}
                icon="◷"
              />
            );
          }

          return (
            <div className="stack">
              <Card className="card--muted">
                <Stat
                  label={t("Self score")}
                  value={fmtNumber(detail.scores.self_score, 2)}
                  meta="Recalculated by HRMS when you save"
                />
              </Card>

              {ratings.length > 0 ? (
                <Card title={t("Rate yourself")}>
                  {ratings.map((row) => (
                    <div key={row.criteria} style={{ marginBottom: 'var(--space-4)' }}>
                      <div className="row row--between small" style={{ marginBottom: 4 }}>
                        <span style={{ fontWeight: 500 }}>{row.criteria}</span>
                        <span className="subtle tabular">
                          {fmtNumber(row.rating, 1)} / {stars}
                          {row.per_weightage ? ` · ${fmtNumber(row.per_weightage)}%` : ''}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={stars}
                        step={0.5}
                        value={Number(row.rating) || 0}
                        onChange={(e) => setRating(row.criteria, Number(e.target.value))}
                        style={{ width: '100%' }}
                      />
                    </div>
                  ))}
                </Card>
              ) : (
                <EmptyState
                  title={t("No rating criteria")}
                  body={t("This appraisal cycle defines no self-rating criteria. You can still write reflections.")}
                  icon="◎"
                />
              )}

              <Field label={t("Reflections")} hint="What went well, and what you would change">
                <textarea
                  rows={6}
                  value={reflections}
                  onChange={(e) => setDraft({ ratings, reflections: e.target.value })}
                />
              </Field>

              {(detail.feedback || []).length > 0 && (
                <Card title={`Reviewer feedback (${detail.feedback.length})`}>
                  {detail.feedback.map((row) => (
                    <div key={row.name} style={{ marginBottom: 'var(--space-3)' }}>
                      <div className="row row--between small">
                        <span style={{ fontWeight: 500 }}>{row.reviewer_name || row.reviewer}</span>
                        <span className="subtle tabular">{fmtNumber(row.total_score, 2)}</span>
                      </div>
                      <div
                        className="small subtle"
                        dangerouslySetInnerHTML={{ __html: row.feedback || '' }}
                      />
                    </div>
                  ))}
                </Card>
              )}
            </div>
          );
        }}
      </Async>
    </Drawer>
  );
}

export default function Goals() {
  const state = useAsync(({ signal }) => hr.goalsAndAppraisal({ signal }), []);
  const [assessing, setAssessing] = useState(null);

  return (
    <div className="stack">
      <div className="page-head">
        <h1 className="page-head__title">{t("Goals & appraisal")}</h1>
        <p className="page-head__sub">{t("Track your goals and complete your self-assessment")}</p>
      </div>

      <Async state={state} rows={5}>
        {(data) => {
          const goals = data.goals || [];
          const appraisals = data.appraisals || [];

          if (!goals.length && !appraisals.length) {
            return (
              <Card>
                <EmptyState
                  title={t("No goals or appraisals")}
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
                    <Card
                      key={appraisal.name}
                      title={appraisal.appraisal_cycle || 'Appraisal'}
                      subtitle={fmtRange(appraisal.start_date, appraisal.end_date)}
                      action={
                        appraisal.docstatus === 0 ? (
                          <Button size="sm" onClick={() => setAssessing(appraisal)}>
                            Self-assess
                          </Button>
                        ) : null
                      }
                    >
                      <Stat
                        label={t("Final score")}
                        // Null means not scored — never rendered as 0.
                        value={appraisal.final_score !== null && appraisal.final_score !== undefined ? fmtNumber(appraisal.final_score, 2) : 'Not scored'}
                      />
                      <div style={{ marginTop: 'var(--space-4)' }}>
                        <FieldRow label={t("Total score")} value={appraisal.total_score !== null && appraisal.total_score !== undefined ? fmtNumber(appraisal.total_score, 2) : null} />
                        <FieldRow label={t("Self score")} value={appraisal.self_score !== null && appraisal.self_score !== undefined ? fmtNumber(appraisal.self_score, 2) : null} />
                        <FieldRow label={t("Feedback average")} value={appraisal.avg_feedback_score !== null && appraisal.avg_feedback_score !== undefined ? fmtNumber(appraisal.avg_feedback_score, 2) : null} />
                        <FieldRow label={t("Goal score")} value={appraisal.goal_score_percentage !== null && appraisal.goal_score_percentage !== undefined ? `${fmtNumber(appraisal.goal_score_percentage)}%` : null} />
                        <FieldRow label={t("State")} value={appraisal.docstatus === 1 ? 'Submitted' : 'Draft'} />
                      </div>
                    </Card>
                  ))}
                </div>
              )}

              <Card title={t("Goals")} subtitle={`${goals.length} recorded`}>
                {goals.length === 0 ? (
                  <EmptyState title={t("No goals set")} body={t("Goals assigned to you will appear here.")} icon="◎" />
                ) : (
                  <div className="stack">
                    {goals.map((goal) => (
                      <GoalRow key={goal.name} goal={goal} onSaved={state.reload} />
                    ))}
                  </div>
                )}
              </Card>
            </>
          );
        }}
      </Async>

      <SelfAssessmentDrawer
        appraisal={assessing}
        onClose={() => setAssessing(null)}
        onSaved={state.reload}
      />
    </div>
  );
}
