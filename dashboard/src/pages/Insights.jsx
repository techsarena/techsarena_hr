import { useMemo } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { Card, EmptyState, Stat } from '../components/ui';
import { Icon } from '../components/Icon';

/* Categorical ramp drawn from the indigo/cyan system so charts read as part of
   the same product rather than a library default. */
const SERIES = ['#4F46E5', '#0E7490', '#7771FA', '#22C4D8', '#3730A3', '#06A8C2', '#A9A7FF', '#67DCEB'];

const AXIS = { stroke: '#64748B', fontSize: 11 };

function ChartCard({ title, subtitle, children, empty }) {
  return (
    <Card title={title} subtitle={subtitle}>
      {empty ? <EmptyState title="Nothing to chart" body={empty} icon="▤" /> : (
        <div style={{ height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

const tooltipStyle = {
  contentStyle: {
    borderRadius: 10,
    border: '1px solid rgba(15,23,42,.12)',
    boxShadow: '0 4px 16px rgba(15,23,42,.08)',
    fontSize: 12,
  },
};

export default function Insights() {
  const { directory, hrSummary, approvals } = useWorkspace();

  const byDepartment = useMemo(() => {
    const counts = new Map();
    for (const row of directory) {
      const key = row.department || 'Unassigned';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }, [directory]);

  const byBranch = useMemo(() => {
    const counts = new Map();
    for (const row of directory) {
      const key = row.branch || 'Unassigned';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [directory]);

  const byDesignation = useMemo(() => {
    const counts = new Map();
    for (const row of directory) {
      const key = row.designation || 'Unassigned';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
  }, [directory]);

  const approvalMix = useMemo(() => {
    const counts = new Map();
    for (const row of approvals) {
      const key = row.kind || 'other';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].map(([name, value]) => ({ name, value }));
  }, [approvals]);

  return (
    <div className="stack">
      <div className="page-head">
        <h1 className="page-head__title">Insights</h1>
        <p className="page-head__sub">Workforce shape, drawn from the directory and HR summary this site returns</p>
      </div>

      {hrSummary && (
        <div className="grid grid--4">
          <div className="card"><Stat label="Headcount" value={hrSummary.headcount ?? '—'} /></div>
          <div className="card"><Stat label="Joined this month" value={hrSummary.new_this_month ?? '—'} tone="success" /></div>
          <div className="card"><Stat label="Open leave requests" value={hrSummary.open_leave_requests ?? '—'} tone={hrSummary.open_leave_requests ? 'warning' : undefined} /></div>
          <div className="card"><Stat label="Payslips this month" value={hrSummary.salary_slips_this_month ?? '—'} /></div>
        </div>
      )}

      {directory.length === 0 ? (
        <Card>
          <EmptyState
            title="No directory data"
            body="Insights are built from the employee directory this account can see."
            icon={<Icon name="chart" size={22} />}
          />
        </Card>
      ) : (
        <>
          <div className="grid grid--2">
            <ChartCard title="Headcount by department" subtitle={`${byDepartment.length} departments`}>
              <BarChart data={byDepartment} margin={{ top: 4, right: 8, bottom: 4, left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,.07)" vertical={false} />
                <XAxis dataKey="name" tick={AXIS} interval={0} angle={-25} textAnchor="end" height={64} />
                <YAxis tick={AXIS} allowDecimals={false} />
                <Tooltip {...tooltipStyle} />
                <Bar dataKey="value" name="Employees" fill={SERIES[0]} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartCard>

            <ChartCard title="Distribution by branch" subtitle={`${byBranch.length} locations`}>
              <PieChart>
                <Pie data={byBranch} dataKey="value" nameKey="name" innerRadius={54} outerRadius={90} paddingAngle={2}>
                  {byBranch.map((entry, index) => (
                    <Cell key={entry.name} fill={SERIES[index % SERIES.length]} />
                  ))}
                </Pie>
                <Tooltip {...tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ChartCard>
          </div>

          <div className="grid grid--2">
            <ChartCard title="Top designations" subtitle="Most common roles on the payroll">
              <BarChart data={byDesignation} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(15,23,42,.07)" horizontal={false} />
                <XAxis type="number" tick={AXIS} allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={AXIS} width={130} />
                <Tooltip {...tooltipStyle} />
                <Bar dataKey="value" name="Employees" fill={SERIES[1]} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ChartCard>

            <ChartCard
              title="Pending approvals by type"
              subtitle={`${approvals.length} waiting`}
              empty={approvals.length === 0 ? 'Nothing is currently waiting on an approver.' : null}
            >
              <PieChart>
                <Pie data={approvalMix} dataKey="value" nameKey="name" outerRadius={92}>
                  {approvalMix.map((entry, index) => (
                    <Cell key={entry.name} fill={SERIES[index % SERIES.length]} />
                  ))}
                </Pie>
                <Tooltip {...tooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ChartCard>
          </div>
        </>
      )}
    </div>
  );
}
