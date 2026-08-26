import { useMemo, useState } from 'react';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { Async, Avatar, Button, Card, Drawer, EmptyState, FieldRow, Pill, SearchInput, Stat } from '../components/ui';
import { DataTable, exportCsv } from '../components/DataTable';
import { Icon } from '../components/Icon';
import { fmtDate, fmtMoney, statusTone } from '../api/format';
import { t } from '../api/i18n';

function salaryBand(opening, fallbackCurrency) {
  const currency = opening.currency || fallbackCurrency;
  if (!opening.salary_from && !opening.salary_to) return null;
  if (opening.salary_from && opening.salary_to) {
    return `${fmtMoney(opening.salary_from, currency)} – ${fmtMoney(opening.salary_to, currency)}`;
  }
  return fmtMoney(opening.salary_from || opening.salary_to, currency);
}

function OpeningDrawer({ opening, currency, onClose }) {
  const state = useAsync(
    ({ signal }) => (opening ? hr.jobOpeningDetail(opening.name, { signal }) : Promise.resolve(null)),
    [opening?.name],
    { immediate: Boolean(opening) },
  );
  if (!opening) return null;

  return (
    <Drawer open onClose={onClose} title={opening.title} subtitle={opening.name}>
      <Async state={state} rows={5}>
        {(data) => {
          const detail = data.opening || opening;
          const applicants = data.applicants || [];
          const stages = Object.entries(detail.stages || {});

          return (
            <div className="stack">
              <div className="grid grid--3">
                <div className="card"><Stat label={t("Applicants")} value={detail.applicants ?? 0} /></div>
                <div className="card"><Stat label={t("In process")} value={detail.in_process ?? 0} /></div>
                <div className="card"><Stat label={t("Offers")} value={detail.offers ?? 0} tone="success" /></div>
              </div>

              <Card title={t("Requisition")}>
                <FieldRow label={t("Status")} value={<Pill tone={statusTone(detail.status)}>{detail.status}</Pill>} />
                <FieldRow label={t("Designation")} value={detail.designation} />
                <FieldRow label={t("Department")} value={detail.department} />
                <FieldRow label={t("Location")} value={detail.location} />
                <FieldRow label={t("Company")} value={detail.company} />
                <FieldRow label={t("Posts")} value={detail.posts} />
                <FieldRow label={t("Posted on")} value={detail.posted_on ? fmtDate(detail.posted_on) : null} />
                <FieldRow label={t("Closes on")} value={detail.closes_on ? fmtDate(detail.closes_on) : null} />
                <FieldRow label={t("Open for")} value={detail.age_days !== null && detail.age_days !== undefined ? `${detail.age_days} days` : null} />
                <FieldRow label={t("Salary band")} value={salaryBand(detail, currency)} />
              </Card>

              {stages.length > 0 && (
                <Card title={t("Pipeline")}>
                  <div className="stack">
                    {stages.map(([stage, count]) => (
                      <div className="row row--between" key={stage}>
                        <span>{stage}</span>
                        <span className="cell-strong tabular">{count}</span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              <Card title={`Candidates in flight (${applicants.length})`}>
                {applicants.length === 0 ? (
                  <EmptyState title={t("No candidates")} body={t("Applicants in this pipeline will be listed here.")} icon="◷" />
                ) : (
                  <div className="stack">
                    {applicants.map((row) => (
                      <div className="row" key={row.name}>
                        <Avatar name={row.applicant_name} size="sm" />
                        <div className="truncate" style={{ flex: 1 }}>
                          <div className="truncate" style={{ fontWeight: 500 }}>{row.applicant_name}</div>
                          <div className="small subtle truncate">{row.email_id || row.name}</div>
                        </div>
                        {row.status && <Pill tone={statusTone(row.status)}>{row.status}</Pill>}
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              {detail.description && (
                <Card title={t("Description")}>
                  <div
                    className="muted"
                    style={{ fontSize: 13.5, lineHeight: 1.6 }}
                    dangerouslySetInnerHTML={{ __html: detail.description }}
                  />
                </Card>
              )}
            </div>
          );
        }}
      </Async>
    </Drawer>
  );
}

export default function Hiring() {
  const state = useAsync(({ signal }) => hr.jobOpenings({ signal }), []);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(null);

  const data = state.data;
  const currency = data?.currency;
  const openings = useMemo(() => {
    const rows = data?.openings || [];
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      [row.title, row.designation, row.department, row.location].filter(Boolean).some((v) => String(v).toLowerCase().includes(needle)),
    );
  }, [data, query]);

  const columns = useMemo(
    () => [
      {
        key: 'title',
        header: t("Opening"),
        render: (row) => (
          <div className="truncate">
            <div className="cell-strong truncate">{row.title}</div>
            <div className="small subtle truncate">{[row.department, row.location].filter(Boolean).join(' · ') || row.name}</div>
          </div>
        ),
        exportValue: (row) => row.title,
      },
      { key: 'status', header: t("Status"), render: (row) => <Pill tone={statusTone(row.status)}>{row.status}</Pill> },
      { key: 'posts', header: t("Posts"), align: 'right', sortValue: (row) => Number(row.posts) || 0 },
      { key: 'applicants', header: t("Applicants"), align: 'right', sortValue: (row) => Number(row.applicants) || 0 },
      { key: 'in_process', header: t("In process"), align: 'right', sortValue: (row) => Number(row.in_process) || 0 },
      {
        key: 'offers',
        header: t("Offers"),
        align: 'right',
        render: (row) => (row.offers ? <span style={{ color: 'var(--success)', fontWeight: 600 }}>{row.offers}</span> : '—'),
        sortValue: (row) => Number(row.offers) || 0,
      },
      {
        key: 'age_days',
        header: t("Open for"),
        align: 'right',
        // The API reports a raw day count and leaves the phrasing here, so no
        // ageing threshold is baked into the backend.
        render: (row) =>
          row.age_days === null || row.age_days === undefined ? '—' : (
            <span style={{ color: row.age_days > 60 ? 'var(--warning)' : undefined, fontWeight: row.age_days > 60 ? 600 : undefined }}>
              {row.age_days}d
            </span>
          ),
        sortValue: (row) => Number(row.age_days) || 0,
      },
      { key: 'hiring_manager', header: t("Hiring manager"), render: (row) => row.hiring_manager || '—' },
      { key: 'salary', header: t("Band"), render: (row) => salaryBand(row, currency) || '—', sortable: false, exportValue: (row) => salaryBand(row, currency) || '' },
    ],
    [currency],
  );

  const totals = useMemo(() => {
    const rows = data?.openings || [];
    return {
      open: rows.filter((r) => String(r.status).toLowerCase() === 'open').length,
      applicants: rows.reduce((s, r) => s + (Number(r.applicants) || 0), 0),
      offers: rows.reduce((s, r) => s + (Number(r.offers) || 0), 0),
      stale: rows.filter((r) => Number(r.age_days) > 60).length,
    };
  }, [data]);

  return (
    <div className="stack">
      <div className="row row--between page-head">
        <div>
          <h1 className="page-head__title">{t("Job openings")}</h1>
          <p className="page-head__sub">{t("Requisitions you're hiring against, with their live pipelines")}</p>
        </div>
        {openings.length > 0 && (
          <Button onClick={() => exportCsv('job-openings', columns, openings)}>
            <Icon name="download" size={15} /> Export
          </Button>
        )}
      </div>

      <Async state={state} rows={5}>
        {(payload) => {
          if (!(payload.openings || []).length) {
            return (
              <Card>
                <EmptyState
                  title={t("No job openings")}
                  body="Recruitment is optional in HRMS. Job Opening records created on this site will appear here with their pipelines."
                  icon={<Icon name="briefcase" size={22} />}
                />
              </Card>
            );
          }

          return (
            <>
              <div className="grid grid--4">
                <div className="card"><Stat label={t("Open requisitions")} value={totals.open} meta={`${payload.openings.length} total`} /></div>
                <div className="card"><Stat label={t("Applicants")} value={totals.applicants} /></div>
                <div className="card"><Stat label={t("Offers out")} value={totals.offers} tone="success" /></div>
                <div className="card"><Stat label={t("Open over 60 days")} value={totals.stale} tone={totals.stale ? 'warning' : undefined} /></div>
              </div>

              <Card flush>
                <div className="toolbar" style={{ padding: 'var(--space-4) var(--space-5)', margin: 0 }}>
                  <SearchInput value={query} onChange={setQuery} placeholder={t("Search openings…")} />
                  <div className="toolbar__spacer" />
                  <span className="small subtle">{openings.length} of {payload.openings.length}</span>
                </div>
                <DataTable
                  columns={columns}
                  rows={openings}
                  onRowClick={setOpen}
                  initialSort={{ key: 'age_days', dir: 'desc' }}
                  emptyTitle="No openings match"
                  maxHeight="60vh"
                />
              </Card>
            </>
          );
        }}
      </Async>

      <OpeningDrawer opening={open} currency={currency} onClose={() => setOpen(null)} />
    </div>
  );
}
