import { useState } from 'react';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { useToast } from '../hooks/useToast';
import { Async, Button, Card, Drawer, EmptyState, Field, FieldRow, Meter, Modal, Pill, Stat } from '../components/ui';
import { Icon } from '../components/Icon';
import { fmtDate, fmtRelative } from '../api/format';
import { t } from '../api/i18n';

/* ---------- Assign a leave policy to an unassigned employee ---------- */
function AssignModal({ open, onClose, alert, onDone }) {
  const toast = useToast();
  const [employee, setEmployee] = useState('');
  const [policy, setPolicy] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) return null;

  const submit = async () => {
    setBusy(true);
    try {
      await hr.assignLeavePolicy(employee, policy);
      toast.success('Leave policy assigned.');
      setEmployee('');
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
      title={t("Assign a leave policy")}
      subtitle={t("Submits a standard HRMS Leave Policy Assignment")}
      footer={
        <>
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="indigo" onClick={submit} disabled={busy || !employee || !policy}>
            {busy ? 'Assigning…' : 'Assign policy'}
          </Button>
        </>
      }
    >
      <div className="fields">
        <p className="muted small">
          HRMS creates and pro-rates the corresponding Leave Allocation records, so its own overlap validation applies.
        </p>
        <Field label={t("Employee")}>
          <select value={employee} onChange={(e) => setEmployee(e.target.value)}>
            <option value="">{t("Select an employee…")}</option>
            {(alert.employees || []).map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}{row.joined_on ? ` — joined ${fmtDate(row.joined_on)}` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("Leave policy")}>
          <select value={policy} onChange={(e) => setPolicy(e.target.value)}>
            <option value="">{t("Select a policy…")}</option>
            {(alert.leave_policies || []).map((row) => (
              <option key={row.id} value={row.id}>{row.name}</option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

/* ---------- Demo seeding ---------- */
function DemoCard({ onDone }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const seed = async () => {
    setBusy(true);
    try {
      const result = await hr.seedDemoData();
      toast.success(result?.message || 'Demo data seeded.');
      setConfirm(false);
      onDone();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card title={t("Demo & testing")} subtitle={t("Provisions a demo workforce for evaluating the app")}>
        <p className="muted small">
          Seeds around 24 demo employees, each with a login, plus their leave, attendance and payroll records and
          populated approver queues. The operation is idempotent. It only runs on a site that has opted in via
          developer mode or the demo-seed config flag.
        </p>
        <div style={{ marginTop: 'var(--space-4)' }}>
          <Button variant="ghost" onClick={() => setConfirm(true)}>{t("Seed demo data")}</Button>
        </div>
      </Card>

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t("Seed demo data?")}
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>{t("Cancel")}</Button>
            <Button variant="indigo" onClick={seed} disabled={busy}>
              {busy ? 'Seeding…' : 'Seed data'}
            </Button>
          </>
        }
      >
        <p className="muted">
          This writes real records into this site: employees, users, leave allocations, attendance and salary slips.
          Run it on a demo or development site only.
        </p>
      </Modal>
    </>
  );
}

/* ---------- Section item detail ---------- */
function ItemDrawer({ item, onClose }) {
  if (!item) return null;
  return (
    <Drawer open onClose={onClose} title={item.title} subtitle={item.description}>
      {(item.details || []).length === 0 ? (
        <EmptyState title={t("No detail returned")} body={t("This card has no further breakdown on this site.")} icon="◷" />
      ) : (
        <Card flush>
          {item.details.map((detail, index) => (
            <FieldRow key={`${detail.label}-${index}`} label={detail.label} value={detail.value ?? '—'} />
          ))}
        </Card>
      )}
    </Drawer>
  );
}

export default function Settings() {
  const state = useAsync(({ signal }) => hr.settingsHub({ signal }), []);
  const [assignOpen, setAssignOpen] = useState(false);
  const [item, setItem] = useState(null);

  return (
    <div className="stack">
      <div className="page-head">
        <h1 className="page-head__title">{t("Settings")}</h1>
        <p className="page-head__sub">{t("The HRMS configuration behind this workspace")}</p>
      </div>

      <Async state={state} rows={6}>
        {(data) => {
          const alert = data.alert || {};
          const unassigned = alert.unassigned_leave_policy || 0;

          return (
            <>
              <div className="grid grid--3">
                <div className="card"><Stat label={t("Organisation")} value={data.organisation_name || '—'} /></div>
                <div className="card"><Stat label={t("Active staff")} value={data.staff_count ?? '—'} /></div>
                <div className="card">
                  <Stat
                    label={t("Your access")}
                    value={data.can_edit ? 'Can edit' : 'Read only'}
                    meta={data.can_edit ? 'HR Manager or System Manager' : 'Setup access without edit rights'}
                  />
                </div>
              </div>

              {unassigned > 0 && (
                <Card
                  title={t("Employees without a leave policy")}
                  subtitle={`${unassigned} employee${unassigned === 1 ? '' : 's'} have no active assignment`}
                  action={data.can_edit && <Button variant="indigo" size="sm" onClick={() => setAssignOpen(true)}>{t("Assign")}</Button>}
                >
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {(alert.employees || []).slice(0, 12).map((row) => (
                      <Pill key={row.id} tone="warning">{row.name}</Pill>
                    ))}
                    {(alert.employees || []).length > 12 && (
                      <span className="small subtle">+{alert.employees.length - 12} more</span>
                    )}
                  </div>
                </Card>
              )}

              {(data.health || []).length > 0 && (
                <Card title={t("Configuration coverage")} subtitle={t("How much of the workforce each setup step covers")}>
                  <div className="grid grid--2">
                    {data.health.map((row) => (
                      <div key={row.label}>
                        <div className="row row--between small" style={{ marginBottom: 5 }}>
                          <span style={{ fontWeight: 500 }}>{row.label}</span>
                          <span className="tabular subtle">{row.value} / {row.total}</span>
                        </div>
                        <Meter
                          value={row.value}
                          total={row.total}
                          tone={row.warning ? 'warning' : row.total && row.value === row.total ? 'success' : undefined}
                        />
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {(data.sections || []).map((section) => (
                <div key={section.id}>
                  <div className="section-heading__label" style={{ marginBottom: 'var(--space-3)' }}>{section.title}</div>
                  <div className="grid grid--3">
                    {(section.items || []).map((sectionItem) => (
                      <button
                        key={sectionItem.id}
                        type="button"
                        className="card"
                        style={{ textAlign: 'left', cursor: 'pointer' }}
                        onClick={() => setItem(sectionItem)}
                      >
                        <div className="row row--between" style={{ alignItems: 'flex-start', gap: 'var(--space-3)' }}>
                          <div className="truncate">
                            <div style={{ fontWeight: 600 }} className="truncate">{sectionItem.title}</div>
                            <p className="small subtle" style={{ marginTop: 3 }}>{sectionItem.description}</p>
                          </div>
                          {sectionItem.count !== undefined && sectionItem.count !== null && (
                            <span className="pill pill--primary">{sectionItem.count}</span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              <div className="grid grid--2">
                <Card title={t("Recent changes")}>
                  {(data.recent_changes || []).length === 0 ? (
                    <EmptyState title={t("No recent changes")} icon="◷" />
                  ) : (
                    <div className="stack">
                      {data.recent_changes.map((change, index) => (
                        <div className="row row--between" key={index}>
                          <div className="truncate">
                            <div className="truncate" style={{ fontWeight: 500 }}>{change.title}</div>
                            <div className="small subtle">by {change.changed_by}</div>
                          </div>
                          <span className="small subtle">{fmtRelative(change.modified)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>

                <Card title={t("Who can edit setup")}>
                  {(data.editors || []).length === 0 ? (
                    <EmptyState title={t("No editors listed")} icon="◷" />
                  ) : (
                    <div className="stack">
                      {data.editors.map((editor, index) => (
                        <div className="row row--between" key={editor.id || index}>
                          <span className="truncate">{editor.name}</span>
                          {editor.role && <Pill>{editor.role}</Pill>}
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>

              <Card title={t("Manage in the desk")} subtitle={t("Record-level editing keeps Frappe's own validation and audit trail")}>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {['Holiday List', 'Leave Type', 'Leave Policy', 'Shift Type', 'Salary Component', 'Salary Structure'].map((doctype) => (
                    <a
                      key={doctype}
                      className="btn btn--ghost btn--sm"
                      href={`/app/${doctype.toLowerCase().replace(/ /g, '-')}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Icon name="external" size={13} /> {doctype}
                    </a>
                  ))}
                </div>
              </Card>

              {data.can_edit && <DemoCard onDone={state.reload} />}

              <AssignModal open={assignOpen} onClose={() => setAssignOpen(false)} alert={alert} onDone={state.reload} />
            </>
          );
        }}
      </Async>

      <ItemDrawer item={item} onClose={() => setItem(null)} />
    </div>
  );
}
