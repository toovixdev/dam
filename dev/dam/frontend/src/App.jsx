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
import Dsar from './pages/Dsar';
import AuditTrail from './pages/AuditTrail';
import ChangeLog from './pages/ChangeLog';
import Users from './pages/Users';
import Integrations from './pages/Integrations';
import Billing from './pages/Billing';
import Support from './pages/Support';
import Profile from './pages/Profile';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
import Masking from './pages/Masking';
import Discovery from './pages/Discovery';
import LlmMonitoring from './pages/LlmMonitoring';
import Copilot from './pages/Copilot';
import ActiveDefense from './pages/ActiveDefense';
import AccessGovernance from './pages/AccessGovernance';
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

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <NavigateExporter />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route path="/accept-invite" element={<AcceptInvite />} />
          <Route path="/" element={<Home />} />
          <Route path="/dashboard" element={<ProtectedRoute screen="dashboard"><Dashboard /></ProtectedRoute>} />
          <Route path="/databases" element={<ProtectedRoute screen="databases"><Databases /></ProtectedRoute>} />
          <Route path="/discovery" element={<ProtectedRoute screen="discovery"><Discovery /></ProtectedRoute>} />
          <Route path="/agents" element={<ProtectedRoute screen="agents"><Agents /></ProtectedRoute>} />
          <Route path="/capture-modes" element={<ProtectedRoute screen="capture-modes"><CaptureModes /></ProtectedRoute>} />
          <Route path="/alerts" element={<ProtectedRoute screen="alerts"><Alerts /></ProtectedRoute>} />
          <Route path="/alerts/:id" element={<ProtectedRoute screen="alerts"><AlertDetail /></ProtectedRoute>} />
          <Route path="/policies" element={<ProtectedRoute screen="policies"><Policies /></ProtectedRoute>} />
          <Route path="/quarantine" element={<ProtectedRoute screen="quarantine"><Quarantine /></ProtectedRoute>} />
          <Route path="/classification" element={<ProtectedRoute screen="classification"><Classification /></ProtectedRoute>} />
          <Route path="/masking" element={<ProtectedRoute screen="masking"><Masking /></ProtectedRoute>} />
          <Route path="/access" element={<ProtectedRoute screen="access"><AccessGovernance /></ProtectedRoute>} />
          <Route path="/compliance" element={<ProtectedRoute screen="compliance"><Compliance /></ProtectedRoute>} />
          <Route path="/dsar" element={<ProtectedRoute screen="dsar"><Dsar /></ProtectedRoute>} />
          <Route path="/audit" element={<ProtectedRoute screen="audit"><AuditTrail /></ProtectedRoute>} />
          <Route path="/change-log" element={<ProtectedRoute screen="change-log"><ChangeLog /></ProtectedRoute>} />
          <Route path="/reports" element={<ProtectedRoute screen="reports"><Reports /></ProtectedRoute>} />
          <Route path="/llm" element={<ProtectedRoute screen="llm"><LlmMonitoring /></ProtectedRoute>} />
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
