import { useMemo, useState } from 'react';
import hr from '../api/hr';
import { useAsync } from '../hooks/useAsync';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { Async, Avatar, Button, Card, Drawer, EmptyState, FieldRow, Pill, SearchInput, Tabs } from '../components/ui';
import { DataTable, exportCsv } from '../components/DataTable';
import { Icon } from '../components/Icon';
import { fmtDate, fmtMoney, fmtRange } from '../api/format';

/** Turns a snake_case Employee fieldname into a readable label. */
const label = (key) => key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Renders whatever the server returned for a profile section — nothing is
 *  invented, and unset fields are omitted by FieldRow rather than defaulted. */
function Section({ title, values }) {
  const entries = Object.entries(values || {}).filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (!entries.length) return null;
  return (
    <Card title={title}>
      {entries.map(([key, value]) => (
        <FieldRow
          key={key}
          label={label(key)}
          value={/date|joining|birth/.test(key) ? fmtDate(value) : String(value)}
        />
      ))}
    </Card>
  );
}

function ProfileDrawer({ employee, onClose }) {
  const [tab, setTab] = useState('profile');
  const state = useAsync(
    ({ signal }) => (employee ? hr.employeeProfile(employee, { signal }) : Promise.resolve(null)),
    [employee],
    { immediate: Boolean(employee) },
  );

  if (!employee) return null;

  return (
    <Drawer open onClose={onClose} title="Employee profile" subtitle={employee}>
      <Async state={state} rows={6}>
        {(data) => {
          const identity = data.identity || {};
          const tabs = [
            { id: 'profile', label: 'Profile' },
            { id: 'team', label: 'Team', count: (data.reports || []).length },
            ...(data.can_view_statutory ? [{ id: 'pay', label: 'Pay & leave' }] : []),
            { id: 'records', label: 'Records', count: (data.documents || []).length + (data.assets || []).length },
          ];

          return (
            <div className="stack">
              <div className="row" style={{ gap: 'var(--space-4)' }}>
                <Avatar name={identity.employee_name} src={identity.image || undefined} size="lg" />
                <div className="truncate">
                  <h2 style={{ fontSize: 17 }} className="truncate">{identity.employee_name || employee}</h2>
                  <p className="small subtle truncate">
                    {[identity.designation, identity.department].filter(Boolean).join(' · ') || '—'}
                  </p>
                  {data.is_self && <Pill tone="primary">You</Pill>}
                </div>
              </div>

              <Tabs value={tab} onChange={setTab} items={tabs} />

              {tab === 'profile' && (
                <>
                  <Section title="Identity" values={data.identity} />
                  <Section title="Job" values={data.job} />
                  <Section title="Personal" values={data.personal} />
                  {data.can_view_statutory && <Section title="Statutory" values={data.statutory} />}
                  {!data.can_view_statutory && (
                    <p className="small subtle">
                      Bank and statutory details stay with the employee and HR.
                    </p>
                  )}
                </>
              )}

              {tab === 'team' && (
                <>
                  {data.manager && (
                    <Card title="Reports to">
                      <div className="row">
                        <Avatar name={data.manager.employee_name} src={data.manager.image || undefined} size="sm" />
                        <div>
                          <div style={{ fontWeight: 500 }}>{data.manager.employee_name}</div>
                          <div className="small subtle">{data.manager.designation || '—'}</div>
                        </div>
                      </div>
                    </Card>
                  )}
                  <Card title={`Direct reports (${(data.reports || []).length})`}>
                    {(data.reports || []).length === 0 ? (
                      <EmptyState title="No direct reports" icon="◷" />
                    ) : (
                      <div className="stack">
                        {data.reports.map((row) => (
                          <div className="row" key={row.name}>
                            <Avatar name={row.employee_name} src={row.image || undefined} size="sm" />
                            <div className="truncate">
                              <div className="truncate" style={{ fontWeight: 500 }}>{row.employee_name}</div>
                              <div className="small subtle truncate">{row.designation || '—'}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                </>
              )}

              {tab === 'pay' && (
                <>
                  <Card title="Leave balances" flush>
                    {(data.leave_balances || []).length === 0 ? (
                      <EmptyState title="No allocations" icon="◷" />
                    ) : (
                      <div className="table-wrap">
                        <table className="table">
                          <thead><tr><th>Type</th><th className="num">Allocated</th><th className="num">Taken</th><th className="num">Left</th></tr></thead>
                          <tbody>
                            {data.leave_balances.map((row) => (
                              <tr key={row.leave_type}>
                                <td>{row.leave_type}</td>
                                <td className="num">{Number(row.allocated).toFixed(1)}</td>
                                <td className="num">{Number(row.taken).toFixed(1)}</td>
                                <td className="num cell-strong">{Number(row.remaining).toFixed(1)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Card>

                  <Card title="Recent payslips" flush>
                    {(data.salary_slips || []).length === 0 ? (
                      <EmptyState title="No payslips" icon="◷" />
                    ) : (
                      <div className="table-wrap">
                        <table className="table">
                          <thead><tr><th>Period</th><th className="num">Gross</th><th className="num">Net</th></tr></thead>
                          <tbody>
                            {data.salary_slips.map((slip) => (
                              <tr key={slip.name}>
                                <td>{fmtRange(slip.start_date, slip.end_date)}</td>
                                <td className="num">{fmtMoney(slip.gross_pay, slip.currency)}</td>
                                <td className="num cell-strong">{fmtMoney(slip.net_pay, slip.currency)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Card>
                </>
              )}

              {tab === 'records' && (
                <>
                  <Card title="Documents">
                    {(data.documents || []).length === 0 ? (
                      <EmptyState title="No documents" icon="◷" />
                    ) : (
                      <div className="stack">
                        {data.documents.map((doc) => (
                          <a key={doc.file_url || doc.name} href={doc.file_url} target="_blank" rel="noreferrer" className="row" style={{ gap: 8 }}>
                            <Icon name="external" size={15} />
                            <span className="truncate">{doc.file_name || doc.name}</span>
                          </a>
                        ))}
                      </div>
                    )}
                  </Card>
                  <Card title="Assets">
                    {(data.assets || []).length === 0 ? (
                      <EmptyState title="No assets assigned" icon="◷" />
                    ) : (
                      <div className="stack">
                        {data.assets.map((asset, index) => (
                          <div className="row row--between" key={asset.name || index}>
                            <span className="truncate">{asset.asset_name || asset.item_name || asset.name}</span>
                            {asset.status && <Pill>{asset.status}</Pill>}
                          </div>
                        ))}
                      </div>
                    )}
                  </Card>
                </>
              )}
            </div>
          );
        }}
      </Async>
    </Drawer>
  );
}

export default function People() {
  const { directory, capabilities } = useWorkspace();
  const [query, setQuery] = useState('');
  const [department, setDepartment] = useState('');
  const [view, setView] = useState('table');
  const [open, setOpen] = useState(null);

  const departments = useMemo(
    () => [...new Set(directory.map((row) => row.department).filter(Boolean))].sort(),
    [directory],
  );

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return directory.filter((row) => {
      if (department && row.department !== department) return false;
      if (!needle) return true;
      return [row.employee_name, row.name, row.designation, row.department, row.branch, row.company_email]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [directory, query, department]);

  const columns = useMemo(
    () => [
      {
        key: 'employee_name',
        header: 'Name',
        render: (row) => (
          <div className="row" style={{ gap: 8 }}>
            <Avatar name={row.employee_name} src={row.image || undefined} size="sm" />
            <div className="truncate">
              <div className="cell-strong truncate">{row.employee_name}</div>
              <div className="small subtle truncate">{row.name}</div>
            </div>
          </div>
        ),
        exportValue: (row) => row.employee_name,
      },
      { key: 'designation', header: 'Designation', render: (row) => row.designation || '—' },
      { key: 'department', header: 'Department', render: (row) => row.department || '—' },
      { key: 'branch', header: 'Branch', render: (row) => row.branch || '—' },
      {
        key: 'company_email',
        header: 'Email',
        // A real <a> — the browser's own "open in new tab" and copy-address work.
        render: (row) => (row.company_email ? <a href={`mailto:${row.company_email}`}>{row.company_email}</a> : '—'),
        exportValue: (row) => row.company_email || '',
      },
      { key: 'cell_number', header: 'Phone', render: (row) => row.cell_number || '—' },
      {
        key: 'roles',
        header: 'Roles',
        sortable: false,
        render: (row) => {
          const roles = (row.roles || []).filter((r) => r !== 'All' && r !== 'Guest');
          if (!roles.length) return '—';
          return (
            <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
              {roles.slice(0, 2).map((role) => <Pill key={role}>{role}</Pill>)}
              {roles.length > 2 && <span className="small subtle">+{roles.length - 2}</span>}
            </div>
          );
        },
        exportValue: (row) => (row.roles || []).join(' / '),
      },
    ],
    [],
  );

  return (
    <div className="stack">
      <div className="row row--between page-head">
        <div>
          <h1 className="page-head__title">People</h1>
          <p className="page-head__sub">
            {capabilities.can_manage_hr
              ? `${directory.length} active employees`
              : 'You and your reporting line'}
          </p>
        </div>
        <Button onClick={() => exportCsv('directory', columns, rows)} disabled={!rows.length}>
          <Icon name="download" size={15} /> Export
        </Button>
      </div>

      <Card flush>
        <div className="toolbar" style={{ padding: 'var(--space-4) var(--space-5)', margin: 0 }}>
          <SearchInput value={query} onChange={setQuery} placeholder="Search name, ID, email…" />
          <select value={department} onChange={(e) => setDepartment(e.target.value)} style={{ width: 'auto', minWidth: 170 }}>
            <option value="">All departments</option>
            {departments.map((dept) => <option key={dept} value={dept}>{dept}</option>)}
          </select>
          <div className="toolbar__spacer" />
          <span className="small subtle">{rows.length} of {directory.length}</span>
          <Tabs
            value={view}
            onChange={setView}
            items={[{ id: 'table', label: 'Table' }, { id: 'cards', label: 'Cards' }]}
          />
        </div>

        {view === 'table' ? (
          <DataTable
            columns={columns}
            rows={rows}
            onRowClick={(row) => setOpen(row.name)}
            initialSort={{ key: 'employee_name', dir: 'asc' }}
            emptyTitle="No employees match"
            emptyBody="Try a different search or department."
            maxHeight="64vh"
          />
        ) : (
          <div className="grid grid--auto" style={{ padding: 'var(--space-5)' }}>
            {rows.map((row) => (
              <button
                key={row.name}
                type="button"
                className="card"
                style={{ textAlign: 'left', cursor: 'pointer' }}
                onClick={() => setOpen(row.name)}
              >
                <div className="row">
                  <Avatar name={row.employee_name} src={row.image || undefined} />
                  <div className="truncate">
                    <div className="truncate" style={{ fontWeight: 600 }}>{row.employee_name}</div>
                    <div className="small subtle truncate">{row.designation || '—'}</div>
                  </div>
                </div>
                <div className="small subtle" style={{ marginTop: 'var(--space-3)' }}>
                  {[row.department, row.branch].filter(Boolean).join(' · ') || '—'}
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      <ProfileDrawer employee={open} onClose={() => setOpen(null)} />
    </div>
  );
}
