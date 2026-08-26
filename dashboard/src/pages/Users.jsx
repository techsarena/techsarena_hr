import { useMemo, useState } from 'react';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { Avatar, Button, Card, Drawer, Pill, SearchInput, Stat } from '../components/ui';
import { DataTable, exportCsv } from '../components/DataTable';
import { Icon } from '../components/Icon';
import { fmtRelative } from '../api/format';
import { t } from '../api/i18n';

const NOISE_ROLES = new Set(['All', 'Guest', 'Desk User']);

export default function Users() {
  const { users } = useWorkspace();
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const [open, setOpen] = useState(null);

  const roles = useMemo(() => {
    const set = new Set();
    for (const user of users) for (const r of user.roles || []) if (!NOISE_ROLES.has(r)) set.add(r);
    return [...set].sort();
  }, [users]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return users.filter((user) => {
      if (role && !(user.roles || []).includes(role)) return false;
      if (!needle) return true;
      return [user.full_name, user.name].filter(Boolean).some((v) => String(v).toLowerCase().includes(needle));
    });
  }, [users, query, role]);

  const columns = useMemo(
    () => [
      {
        key: 'full_name',
        header: t("User"),
        render: (row) => (
          <div className="row" style={{ gap: 8 }}>
            <Avatar name={row.full_name} src={row.user_image || undefined} size="sm" />
            <div className="truncate">
              <div className="cell-strong truncate">{row.full_name || row.name}</div>
              <div className="small subtle truncate">{row.name}</div>
            </div>
          </div>
        ),
        exportValue: (row) => row.full_name,
      },
      { key: 'user_type', header: t("Type"), render: (row) => <Pill tone={row.user_type === 'System User' ? 'primary' : 'default'}>{row.user_type}</Pill> },
      {
        key: 'roles',
        header: t("Roles"),
        sortable: false,
        render: (row) => {
          const list = (row.roles || []).filter((r) => !NOISE_ROLES.has(r));
          if (!list.length) return <span className="subtle">{t("None")}</span>;
          return (
            <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
              {list.slice(0, 3).map((r) => <Pill key={r}>{r}</Pill>)}
              {list.length > 3 && <span className="small subtle">+{list.length - 3}</span>}
            </div>
          );
        },
        exportValue: (row) => (row.roles || []).join(' / '),
      },
      {
        key: 'last_active',
        header: t("Last active"),
        render: (row) => (row.last_active ? <span className="subtle">{fmtRelative(row.last_active)}</span> : <span className="subtle">{t("Never")}</span>),
        sortValue: (row) => row.last_active,
      },
    ],
    [],
  );

  const systemUsers = users.filter((u) => u.user_type === 'System User').length;

  return (
    <div className="stack">
      <div className="row row--between page-head">
        <div>
          <h1 className="page-head__title">{t("Users & roles")}</h1>
          <p className="page-head__sub">{t("Enabled accounts on this site and the roles they hold")}</p>
        </div>
        <Button onClick={() => exportCsv('users', columns, rows)} disabled={!rows.length}>
          <Icon name="download" size={15} /> Export
        </Button>
      </div>

      <div className="grid grid--3">
        <div className="card"><Stat label={t("Enabled users")} value={users.length} /></div>
        <div className="card"><Stat label={t("System users")} value={systemUsers} meta={`${users.length - systemUsers} website users`} /></div>
        <div className="card"><Stat label={t("Distinct roles")} value={roles.length} /></div>
      </div>

      <Card flush>
        <div className="toolbar" style={{ padding: 'var(--space-4) var(--space-5)', margin: 0 }}>
          <SearchInput value={query} onChange={setQuery} placeholder={t("Search users…")} />
          <select value={role} onChange={(e) => setRole(e.target.value)} style={{ width: 'auto', minWidth: 190 }}>
            <option value="">{t("All roles")}</option>
            {roles.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <div className="toolbar__spacer" />
          <span className="small subtle">{rows.length} of {users.length}</span>
        </div>

        <DataTable
          columns={columns}
          rows={rows}
          onRowClick={setOpen}
          initialSort={{ key: 'full_name', dir: 'asc' }}
          emptyTitle="No users match"
          maxHeight="64vh"
        />
      </Card>

      <Drawer
        open={Boolean(open)}
        onClose={() => setOpen(null)}
        title={open?.full_name || open?.name}
        subtitle={open?.name}
        footer={
          <a
            className="btn btn--ghost"
            href={open ? `/app/user/${encodeURIComponent(open.name)}` : '#'}
            target="_blank"
            rel="noreferrer"
          >
            <Icon name="external" size={15} /> Edit in desk
          </a>
        }
      >
        {open && (
          <div className="stack">
            <div className="row">
              <Avatar name={open.full_name} src={open.user_image || undefined} size="lg" />
              <div>
                <div style={{ fontWeight: 600 }}>{open.full_name || open.name}</div>
                <div className="small subtle">{open.user_type}</div>
              </div>
            </div>
            <Card title={t("Roles")}>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {(open.roles || []).filter((r) => !NOISE_ROLES.has(r)).map((r) => <Pill key={r}>{r}</Pill>)}
                {(open.roles || []).filter((r) => !NOISE_ROLES.has(r)).length === 0 && (
                  <span className="subtle small">{t("No roles beyond the defaults.")}</span>
                )}
              </div>
            </Card>
            <p className="small subtle">
              Role assignment stays in the Frappe desk, so its own permission rules and audit trail apply.
            </p>
          </div>
        )}
      </Drawer>
    </div>
  );
}
