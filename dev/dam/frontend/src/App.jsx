import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { canSee } from './roles';
import Home from './pages/Home';
import Login from './pages/Login';
import Signup from './pages/Signup';
import VerifyEmail from './pages/VerifyEmail';
import AcceptInvite from './pages/AcceptInvite';
import Dashboard from './pages/Dashboard';
import Databases from './pages/Databases';
import Agents from './pages/Agents';
import CaptureModes from './pages/CaptureModes';
import Alerts from './pages/Alerts';
import AlertDetail from './pages/AlertDetail';
import Policies from './pages/Policies';
import Quarantine from './pages/Quarantine';
import Classification from './pages/Classification';
import Compliance from './pages/Compliance';
import FeatureGate from './components/shared/FeatureGate';
import Dsar from './pages/Dsar';
import AuditTrail from './pages/AuditTrail';
import ChangeLog from './pages/ChangeLog';
import Users from './pages/Users';
import Integrations from './pages/Integrations';
import Billing from './pages/Billing';
import Support from './pages/Support';
import Profile from './pages/Profile';
import Reports from './pages/Reports';
import Attestations from './pages/Attestations';
import Settings from './pages/Settings';
import Masking from './pages/Masking';
import Discovery from './pages/Discovery';
import LlmMonitoring from './pages/LlmMonitoring';
import Copilot from './pages/Copilot';
import ActiveDefense from './pages/ActiveDefense';
import AccessGovernance from './pages/AccessGovernance';
import Behavior from './pages/Behavior';
import Vulnerability from './pages/Vulnerability';
import './App.css';

function ProtectedRoute({ children, screen }) {
  const { authenticated, loading, user } = useAuth();
  if (loading) return <div className="loading-screen"><div className="loading-spinner" /><p>Loading...</p></div>;
  if (!authenticated) return <Navigate to="/login" replace />;
  // Role gate: a screen the user's role can't see is not reachable even by direct URL.
  if (screen && !canSee(user?.role, screen)) return <Navigate to="/dashboard" replace />;
  return children;
}

function NavigateExporter() {
  const navigate = useNavigate();
  useEffect(() => { window.__damNavigate = navigate; }, [navigate]);
  return null;
}

// "View as tenant" entry: a platform operator's break-glass token arrives in the URL hash (never
// sent to the server). We store it, resolve the synthetic identity via /api/auth/me, flag the
// session, and drop into the tenant's dashboard — with the banner below shown app-wide.
function BreakGlassEntry() {
  const navigate = useNavigate();
  const { login } = useAuth();
  useEffect(() => {
    const h = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
    const t = h.get('t');
    if (!t) { navigate('/login', { replace: true }); return; }
    localStorage.setItem('dam_token', t);
    localStorage.setItem('dam_breakglass', JSON.stringify({ tenant: h.get('tenant') || '', scope: h.get('scope') || 'ro', op: h.get('op') || '', kind: h.get('kind') || 'break_glass' }));
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${t}` } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('invalid'))))
      .then((u) => {
        login(t, { id: u.id, email: u.email, fullName: u.full_name, role: u.role, tenantId: u.tenant_id, tenantName: u.tenant_name, breakGlass: true });
        window.history.replaceState(null, '', '/dashboard');
        navigate('/dashboard', { replace: true });
      })
      .catch(() => {
        ['dam_token', 'dam_user', 'dam_breakglass', 'nx-role'].forEach((k) => localStorage.removeItem(k));
        navigate('/login?error=' + encodeURIComponent('Break-glass session invalid or expired'), { replace: true });
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="loading-screen"><div className="loading-spinner" /><p>Entering break-glass session…</p></div>;
}

// App-wide red banner while a break-glass session is active. Read-only is enforced server-side
// (writes 403); this makes the operator unmistakably aware they are impersonating a tenant.
function BreakGlassBanner() {
  useAuth(); // subscribe to auth-context changes so the banner appears the instant a session starts
  let bg = null;
  try { bg = JSON.parse(localStorage.getItem('dam_breakglass') || 'null'); } catch { bg = null; }
  useEffect(() => {
    if (bg) { document.body.style.paddingTop = '36px'; return () => { document.body.style.paddingTop = ''; }; }
  }, [!!bg]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!bg) return null;
  const isImp = bg.kind === 'impersonation';
  const bar = isImp ? '#b45309' : '#b91c1c'; // impersonation amber vs break-glass red
  const label = isImp ? 'IMPERSONATION SESSION' : 'BREAK-GLASS SESSION';
  const exit = () => {
    ['dam_token', 'dam_user', 'dam_breakglass', 'nx-role'].forEach((k) => localStorage.removeItem(k));
    document.body.style.paddingTop = '';
    try { window.close(); } catch { /* not a popup */ }
    window.location.href = '/login';
  };
  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100000, background: bar, color: '#fff', display: 'flex', alignItems: 'center', gap: 12, padding: '7px 16px', fontSize: 13, fontWeight: 600, boxShadow: '0 2px 10px rgba(0,0,0,.35)' }}>
      <span>⚠ {label}</span>
      <span style={{ fontWeight: 500, opacity: 0.95 }}>Viewing <b>{bg.tenant}</b>{bg.op ? ` as ${bg.op}` : ''} · {bg.scope === 'rw' ? 'READ-WRITE' : 'READ-ONLY'} · every action is audited</span>
      <button onClick={exit} style={{ marginLeft: 'auto', background: '#fff', color: bar, border: 'none', borderRadius: 6, padding: '3px 12px', fontWeight: 700, cursor: 'pointer', fontSize: 12 }}>Exit ✕</button>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <NavigateExporter />
        <BreakGlassBanner />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route path="/accept-invite" element={<AcceptInvite />} />
          <Route path="/break-glass" element={<BreakGlassEntry />} />
          <Route path="/" element={<Home />} />
          <Route path="/dashboard" element={<ProtectedRoute screen="dashboard"><Dashboard /></ProtectedRoute>} />
          <Route path="/databases" element={<ProtectedRoute screen="databases"><Databases /></ProtectedRoute>} />
          <Route path="/discovery" element={<ProtectedRoute screen="discovery"><Discovery /></ProtectedRoute>} />
          <Route path="/agents" element={<ProtectedRoute screen="agents"><Agents /></ProtectedRoute>} />
          <Route path="/capture-modes" element={<ProtectedRoute screen="capture-modes"><CaptureModes /></ProtectedRoute>} />
          <Route path="/alerts" element={<ProtectedRoute screen="alerts"><Alerts /></ProtectedRoute>} />
          <Route path="/behavior" element={<ProtectedRoute screen="behavior"><FeatureGate feature="ueba" name="Behavioral Analytics (UEBA)"><Behavior /></FeatureGate></ProtectedRoute>} />
          <Route path="/alerts/:id" element={<ProtectedRoute screen="alerts"><AlertDetail /></ProtectedRoute>} />
          <Route path="/policies" element={<ProtectedRoute screen="policies"><Policies /></ProtectedRoute>} />
          <Route path="/quarantine" element={<ProtectedRoute screen="quarantine"><Quarantine /></ProtectedRoute>} />
          <Route path="/classification" element={<ProtectedRoute screen="classification"><Classification /></ProtectedRoute>} />
          <Route path="/vulnerability" element={<ProtectedRoute screen="vulnerability"><FeatureGate feature="va-scanner" name="Vulnerability Assessment"><Vulnerability /></FeatureGate></ProtectedRoute>} />
          <Route path="/masking" element={<ProtectedRoute screen="masking"><Masking /></ProtectedRoute>} />
          <Route path="/access" element={<ProtectedRoute screen="access"><FeatureGate feature="jit-access" name="Access Governance (JIT)"><AccessGovernance /></FeatureGate></ProtectedRoute>} />
          <Route path="/compliance" element={<ProtectedRoute screen="compliance"><Compliance /></ProtectedRoute>} />
          <Route path="/dsar" element={<ProtectedRoute screen="dsar"><FeatureGate feature="dsar" name="DSAR Manager"><Dsar /></FeatureGate></ProtectedRoute>} />
          <Route path="/audit" element={<ProtectedRoute screen="audit"><AuditTrail /></ProtectedRoute>} />
          <Route path="/change-log" element={<ProtectedRoute screen="change-log"><ChangeLog /></ProtectedRoute>} />
          <Route path="/attestations" element={<ProtectedRoute screen="attestations"><Attestations /></ProtectedRoute>} />
          <Route path="/reports" element={<ProtectedRoute screen="reports"><Reports /></ProtectedRoute>} />
          <Route path="/llm" element={<ProtectedRoute screen="llm"><FeatureGate feature="llm-monitoring" name="LLM Monitoring"><LlmMonitoring /></FeatureGate></ProtectedRoute>} />
          <Route path="/copilot" element={<ProtectedRoute screen="copilot"><Copilot /></ProtectedRoute>} />
          <Route path="/active-defense" element={<ProtectedRoute screen="active-defense"><ActiveDefense /></ProtectedRoute>} />
          <Route path="/users" element={<ProtectedRoute screen="users"><Users /></ProtectedRoute>} />
          <Route path="/integrations" element={<ProtectedRoute screen="integrations"><Integrations /></ProtectedRoute>} />
          <Route path="/billing" element={<ProtectedRoute screen="billing"><Billing /></ProtectedRoute>} />
          <Route path="/support" element={<ProtectedRoute screen="support"><Support /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute screen="settings"><Settings /></ProtectedRoute>} />
          <Route path="/profile" element={<ProtectedRoute screen="profile"><Profile /></ProtectedRoute>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
