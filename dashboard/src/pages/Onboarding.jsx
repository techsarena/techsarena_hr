import { useMemo, useState } from 'react';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { Async, Avatar, Card, Drawer, EmptyState, FieldRow, Meter, Pill, Stat } from '../components/ui';
import { Icon } from '../components/Icon';
import { fmtDate, statusTone } from '../api/format';
import { t } from '../api/i18n';

/**
 * Read-only, by design: progress, blocked and at-risk state are all derived
 * from the real HRMS Task rows the endpoint hydrates. Nothing here fabricates
 * a checklist action the backend cannot honour.
 */
function derive(onboarding) {
  const activities = onboarding.activities || [];
  const done = activities.filter((a) => a.completed).length;
  const overdue = activities.filter((a) => a.overdue).length;
  const blocked = activities.filter((a) => a.required && !a.completed).length;
  return {
    activities,
    done,
    total: activities.length,
    overdue,
    blocked,
    percent: activities.length ? Math.round((done / activities.length) * 100) : 0,
  };
}

function OnboardingDrawer({ record, onClose }) {
  if (!record) return null;
  const stats = derive(record);

  return (
    <Drawer open onClose={onClose} title={record.employee_name || record.job_applicant || record.name} subtitle={record.name}>
      <div className="stack">
        <Card className="card--muted">
          <Stat label={t("Progress")} value={`${stats.percent}%`} meta={`${stats.done} of ${stats.total} activities complete`} />
          <div style={{ marginTop: 'var(--space-4)' }}>
            <Meter
              value={stats.done}
              total={stats.total}
              tone={stats.overdue ? 'warning' : stats.percent === 100 ? 'success' : undefined}
            />
          </div>
        </Card>

        <Card title={t("Details")}>
          <FieldRow label={t("Status")} value={record.status ? <Pill tone={statusTone(record.status)}>{record.status}</Pill> : null} />
          <FieldRow label={t("Employee")} value={record.employee} />
          <FieldRow label={t("Designation")} value={record.designation} />
          <FieldRow label={t("Department")} value={record.department} />
          <FieldRow label={t("Company")} value={record.company} />
          <FieldRow label={t("Joining date")} value={record.date_of_joining ? fmtDate(record.date_of_joining) : null} />
          <FieldRow label={t("Boarding begins")} value={record.boarding_begins_on ? fmtDate(record.boarding_begins_on) : null} />
          <FieldRow label={t("Template")} value={record.template} />
          <FieldRow label={t("Job applicant")} value={record.job_applicant} />
          <FieldRow label={t("Job offer")} value={record.job_offer} />
        </Card>

        <Card title={`Activities (${stats.total})`} flush>
          {stats.total === 0 ? (
            <EmptyState title={t("No activities")} body={t("This onboarding has no linked tasks.")} icon="◷" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>{t("Activity")}</th><th>{t("Owner")}</th><th>{t("Due")}</th><th>{t("Status")}</th></tr>
                </thead>
                <tbody>
                  {stats.activities.map((activity) => (
                    <tr key={activity.name}>
                      <td>
                        <div className="cell-strong">{activity.activity_name}</div>
                        {activity.required && <span className="small subtle">{t("Required for employee creation")}</span>}
                      </td>
                      <td className="subtle">{activity.owner_name || activity.user || activity.role || '—'}</td>
                      <td className={activity.overdue ? '' : 'subtle'} style={activity.overdue ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>
                        {activity.due_on ? fmtDate(activity.due_on) : '—'}
                      </td>
                      <td>
                        <Pill tone={activity.overdue ? 'danger' : statusTone(activity.task_status)}>
                          {activity.overdue ? 'Overdue' : activity.task_status}
                        </Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </Drawer>
  );
}

export default function Onboarding() {
  const state = useAsync(({ signal }) => hr.employeeOnboarding({ signal }), []);
  const [open, setOpen] = useState(null);

  const records = useMemo(() => state.data?.onboardings || [], [state.data]);
  const totals = useMemo(() => {
    let overdue = 0;
    let complete = 0;
    for (const record of records) {
      const stats = derive(record);
      if (stats.overdue) overdue += 1;
      if (stats.percent === 100) complete += 1;
    }
    return { overdue, complete };
  }, [records]);

  return (
    <div className="stack">
      <div className="page-head">
        <h1 className="page-head__title">{t("Onboarding")}</h1>
        <p className="page-head__sub">{t("Active joiners and the real tasks attached to their onboarding")}</p>
      </div>

      <Async state={state} rows={4}>
        {() => {
          if (!records.length) {
            return (
              <Card>
                <EmptyState
                  title={t("No active onboardings")}
                  body={t("Employee Onboarding records created in HRMS will appear here with their task progress.")}
                  icon={<Icon name="checklist" size={22} />}
                />
              </Card>
            );
          }

          return (
            <>
              <div className="grid grid--3">
                <div className="card"><Stat label={t("Active onboardings")} value={records.length} /></div>
                <div className="card"><Stat label={t("With overdue tasks")} value={totals.overdue} tone={totals.overdue ? 'danger' : undefined} /></div>
                <div className="card"><Stat label={t("Fully complete")} value={totals.complete} tone="success" /></div>
              </div>

              <div className="grid grid--2">
                {records.map((record) => {
                  const stats = derive(record);
                  return (
                    <button
                      key={record.name}
                      type="button"
                      className="card"
                      style={{ textAlign: 'left', cursor: 'pointer' }}
                      onClick={() => setOpen(record)}
                    >
                      <div className="row row--between" style={{ alignItems: 'flex-start', gap: 'var(--space-4)' }}>
                        <div className="row" style={{ minWidth: 0 }}>
                          <Avatar name={record.employee_name || record.job_applicant} />
                          <div className="truncate">
                            <div className="truncate" style={{ fontWeight: 600 }}>
                              {record.employee_name || record.job_applicant || record.name}
                            </div>
                            <div className="small subtle truncate">
                              {[record.designation, record.department].filter(Boolean).join(' · ') || record.name}
                            </div>
                          </div>
                        </div>
                        {record.status && <Pill tone={statusTone(record.status)}>{record.status}</Pill>}
                      </div>

                      <div style={{ marginTop: 'var(--space-4)' }}>
                        <div className="row row--between small" style={{ marginBottom: 5 }}>
                          <span className="subtle">{stats.done} of {stats.total} activities</span>
                          <span className="tabular">{stats.percent}%</span>
                        </div>
                        <Meter
                          value={stats.done}
                          total={stats.total}
                          tone={stats.overdue ? 'warning' : stats.percent === 100 ? 'success' : undefined}
                        />
                      </div>

                      <div className="row" style={{ marginTop: 'var(--space-3)', gap: 6, flexWrap: 'wrap' }}>
                        {record.date_of_joining && <Pill>Joins {fmtDate(record.date_of_joining)}</Pill>}
                        {stats.overdue > 0 && <Pill tone="danger">{stats.overdue} overdue</Pill>}
                        {stats.blocked > 0 && <Pill tone="warning">{stats.blocked} required open</Pill>}
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          );
        }}
      </Async>

      <OnboardingDrawer record={open} onClose={() => setOpen(null)} />
    </div>
  );
}
