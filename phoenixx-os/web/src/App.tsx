import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from './lib/auth';
import Layout from './components/Layout';
import Login from './pages/Login';
import Signup from './pages/Signup';
import AcceptInvite from './pages/AcceptInvite';
import Recover from './pages/Recover';
import PublicProposal from './pages/PublicProposal';
import Home from './pages/Home';

// Route-level code splitting keeps the first paint small on 4G (NFR performance).
const Dashboard = lazy(() => import('./pages/Dashboard'));
const ActionItems = lazy(() => import('./pages/ActionItems'));
const Meetings = lazy(() => import('./pages/Meetings'));
const Chat = lazy(() => import('./pages/Chat'));
const Deadlines = lazy(() => import('./pages/Deadlines'));
const CRM = lazy(() => import('./pages/CRM'));
const ClientDetail = lazy(() => import('./pages/ClientDetail'));
const Proposals = lazy(() => import('./pages/Proposals'));
const Projects = lazy(() => import('./pages/Projects'));
const Invoices = lazy(() => import('./pages/Invoices'));
const InvoiceDetail = lazy(() => import('./pages/InvoiceDetail'));
const Finance = lazy(() => import('./pages/Finance'));
const HR = lazy(() => import('./pages/HR'));
const Team = lazy(() => import('./pages/Team'));
const SOP = lazy(() => import('./pages/SOP'));
const SOPDetail = lazy(() => import('./pages/SOPDetail'));
const Reports = lazy(() => import('./pages/Reports'));
const ReportDetail = lazy(() => import('./pages/ReportDetail'));
const Settings = lazy(() => import('./pages/Settings'));
const Billing = lazy(() => import('./pages/Billing'));
const Admin = lazy(() => import('./pages/Admin'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Profile = lazy(() => import('./pages/Profile'));

function FullPageSpinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="grid min-h-[60vh] place-items-center" role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-3 text-subtle">
        <Loader2 size={26} className="animate-spin" />
        <p className="text-sm">{label}…</p>
      </div>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageSpinner label="Signing you in" />;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

export default function App() {
  const { user, loading } = useAuth();

  return (
    <Routes>
      {/* -------------------------------------------------------- public */}
      <Route path="/p/:token" element={<PublicProposal />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route path="/recover" element={<Recover />} />
      <Route path="/login" element={loading ? <FullPageSpinner /> : user ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/signup" element={loading ? <FullPageSpinner /> : user ? <Navigate to="/" replace /> : <Signup />} />

      {/* ----------------------------------------------------- protected */}
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<Home />} />
        <Route path="dashboard" element={<Suspense fallback={<FullPageSpinner />}><Dashboard /></Suspense>} />
        <Route path="action-items" element={<Suspense fallback={<FullPageSpinner />}><ActionItems /></Suspense>} />
        <Route path="action-items/:id" element={<Suspense fallback={<FullPageSpinner />}><ActionItems /></Suspense>} />
        <Route path="meetings" element={<Suspense fallback={<FullPageSpinner />}><Meetings /></Suspense>} />
        <Route path="meetings/:id" element={<Suspense fallback={<FullPageSpinner />}><Meetings /></Suspense>} />
        <Route path="deadlines" element={<Suspense fallback={<FullPageSpinner />}><Deadlines /></Suspense>} />
        <Route path="chat" element={<Suspense fallback={<FullPageSpinner />}><Chat /></Suspense>} />
        <Route path="crm" element={<Suspense fallback={<FullPageSpinner />}><CRM /></Suspense>} />
        <Route path="crm/:id" element={<Suspense fallback={<FullPageSpinner />}><ClientDetail /></Suspense>} />
        <Route path="proposals" element={<Suspense fallback={<FullPageSpinner />}><Proposals /></Suspense>} />
        <Route path="projects" element={<Suspense fallback={<FullPageSpinner />}><Projects /></Suspense>} />
        <Route path="projects/:id" element={<Suspense fallback={<FullPageSpinner />}><Projects /></Suspense>} />
        <Route path="proposals/:id" element={<Suspense fallback={<FullPageSpinner />}><Proposals /></Suspense>} />
        <Route path="invoices" element={<Suspense fallback={<FullPageSpinner />}><Invoices /></Suspense>} />
        <Route path="invoices/:id" element={<Suspense fallback={<FullPageSpinner />}><InvoiceDetail /></Suspense>} />
        <Route path="finance" element={<Suspense fallback={<FullPageSpinner />}><Finance /></Suspense>} />
        <Route path="hr" element={<Suspense fallback={<FullPageSpinner />}><HR /></Suspense>} />
        <Route path="team" element={<Suspense fallback={<FullPageSpinner />}><Team /></Suspense>} />
        <Route path="sop" element={<Suspense fallback={<FullPageSpinner />}><SOP /></Suspense>} />
        <Route path="sop/:id" element={<Suspense fallback={<FullPageSpinner />}><SOPDetail /></Suspense>} />
        <Route path="reports" element={<Suspense fallback={<FullPageSpinner />}><Reports /></Suspense>} />
        <Route path="reports/:id" element={<Suspense fallback={<FullPageSpinner />}><ReportDetail /></Suspense>} />
        <Route path="notifications" element={<Suspense fallback={<FullPageSpinner />}><Notifications /></Suspense>} />
        <Route path="settings" element={<Suspense fallback={<FullPageSpinner />}><Settings /></Suspense>} />
        <Route path="billing" element={<Suspense fallback={<FullPageSpinner />}><Billing /></Suspense>} />
        <Route path="profile" element={<Suspense fallback={<FullPageSpinner />}><Profile /></Suspense>} />
        <Route path="admin" element={<Suspense fallback={<FullPageSpinner />}><Admin /></Suspense>} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
