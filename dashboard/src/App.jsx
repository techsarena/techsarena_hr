import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { WorkspaceProvider, useWorkspace } from './hooks/WorkspaceContext';
import { ToastProvider } from './hooks/useToast';
import Shell from './layout/Shell';
import Login from './pages/Login';
import { ErrorState, Skeleton } from './components/ui';

import Home from './pages/Home';
import Attendance from './pages/Attendance';
import Leave from './pages/Leave';
import LeaveTeamCalendar from './pages/LeaveTeamCalendar';
import LeavePolicies from './pages/LeavePolicies';
import Salary from './pages/Salary';
import Claims from './pages/Claims';
import Goals from './pages/Goals';
import Funds from './pages/Funds';
import Loans from './pages/Loans';
import Approvals from './pages/Approvals';
import People from './pages/People';
import OrgChart from './pages/OrgChart';
import Profile from './pages/Profile';
import Payroll from './pages/Payroll';
const Insights = lazy(() => import('./pages/Insights'));
import LeaveAdmin from './pages/LeaveAdmin';
import Announcements from './pages/Announcements';
import Hiring from './pages/Hiring';
import Onboarding from './pages/Onboarding';
import Offboarding from './pages/Offboarding';
import Lifecycle from './pages/Lifecycle';
import Settings from './pages/Settings';
import Users from './pages/Users';

/** Routes the app can only mount once bootstrap has answered. */
function Gate() {
  const { status, error, reload, capabilities } = useWorkspace();

  if (status === 'checking') {
    return (
      <div className="login">
        <div className="col" style={{ alignItems: 'center', gap: 12 }}>
          <div className="skeleton" style={{ width: 120, height: 8, borderRadius: 99 }} />
          <p className="small subtle">Loading your workspace…</p>
        </div>
      </div>
    );
  }

  if (status === 'anonymous') return <Login />;

  if (status === 'error') {
    return (
      <div className="login">
        <div className="login__card">
          <ErrorState error={error} onRetry={reload} title="Could not start the workspace" />
        </div>
      </div>
    );
  }

  // A route the user's capabilities don't cover redirects Home rather than
  // rendering an empty screen — the same rule the nav model applies.
  const guard = (capability, element) => (capability && !capabilities[capability] ? <Navigate to="/" replace /> : element);

  return (
    <Suspense fallback={<div style={{ padding: 'var(--space-6)' }}><Skeleton rows={6} /></div>}>
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Home />} />
        <Route path="/profile" element={guard('employee_self_service', <Profile />)} />
        <Route path="/attendance" element={guard('employee_self_service', <Attendance />)} />
        <Route path="/leave" element={guard('employee_self_service', <Leave />)} />
        <Route path="/leave/team" element={guard('employee_self_service', <LeaveTeamCalendar />)} />
        <Route path="/leave/policies" element={guard('employee_self_service', <LeavePolicies />)} />
        <Route path="/salary" element={guard('employee_self_service', <Salary />)} />
        <Route path="/claims" element={guard('employee_self_service', <Claims />)} />
        <Route path="/goals" element={guard('employee_self_service', <Goals />)} />
        <Route path="/funds" element={guard('employee_self_service', <Funds />)} />
        <Route path="/loans" element={guard('employee_self_service', <Loans />)} />
        <Route path="/approvals" element={guard('can_approve_leave', <Approvals />)} />
        <Route path="/people" element={guard('can_view_directory', <People />)} />
        <Route path="/people/:employee" element={guard('can_view_directory', <People />)} />
        <Route path="/org" element={guard('can_view_directory', <OrgChart />)} />
        <Route path="/payroll" element={guard('can_run_payroll', <Payroll />)} />
        <Route path="/insights" element={guard('can_manage_hr', <Insights />)} />
        <Route path="/leave-admin" element={guard('can_manage_hr', <LeaveAdmin />)} />
        <Route path="/announcements" element={<Announcements />} />
        <Route path="/hiring" element={guard('can_manage_hr', <Hiring />)} />
        <Route path="/onboarding" element={guard('can_manage_hr', <Onboarding />)} />
        <Route path="/offboarding" element={guard('can_manage_hr', <Offboarding />)} />
        <Route path="/lifecycle" element={guard('can_manage_hr', <Lifecycle />)} />
        <Route path="/settings" element={guard('can_manage_hr', <Settings />)} />
        <Route path="/users" element={guard('can_manage_users', <Users />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    // Served at /dashboard in production; vite dev serves it at the root.
    <BrowserRouter basename={import.meta.env.DEV ? '/' : '/dashboard'}>
      <ToastProvider>
        <WorkspaceProvider>
          <Gate />
        </WorkspaceProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
