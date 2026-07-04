import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
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
import Policies from './pages/Policies';
import Quarantine from './pages/Quarantine';
import Classification from './pages/Classification';
import Compliance from './pages/Compliance';
import Dsar from './pages/Dsar';
import AuditTrail from './pages/AuditTrail';
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
import ActiveDefense from './pages/ActiveDefense';
import AccessGovernance from './pages/AccessGovernance';
import './App.css';

function ProtectedRoute({ children }) {
  const { authenticated, loading } = useAuth();
  if (loading) return <div className="loading-screen"><div className="loading-spinner" /><p>Loading...</p></div>;
  if (!authenticated) return <Navigate to="/login" replace />;
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
          <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
          <Route path="/databases" element={<ProtectedRoute><Databases /></ProtectedRoute>} />
          <Route path="/discovery" element={<ProtectedRoute><Discovery /></ProtectedRoute>} />
          <Route path="/agents" element={<ProtectedRoute><Agents /></ProtectedRoute>} />
          <Route path="/capture-modes" element={<ProtectedRoute><CaptureModes /></ProtectedRoute>} />
          <Route path="/alerts" element={<ProtectedRoute><Alerts /></ProtectedRoute>} />
          <Route path="/policies" element={<ProtectedRoute><Policies /></ProtectedRoute>} />
          <Route path="/quarantine" element={<ProtectedRoute><Quarantine /></ProtectedRoute>} />
          <Route path="/classification" element={<ProtectedRoute><Classification /></ProtectedRoute>} />
          <Route path="/masking" element={<ProtectedRoute><Masking /></ProtectedRoute>} />
          <Route path="/access" element={<ProtectedRoute><AccessGovernance /></ProtectedRoute>} />
          <Route path="/compliance" element={<ProtectedRoute><Compliance /></ProtectedRoute>} />
          <Route path="/dsar" element={<ProtectedRoute><Dsar /></ProtectedRoute>} />
          <Route path="/audit" element={<ProtectedRoute><AuditTrail /></ProtectedRoute>} />
          <Route path="/reports" element={<ProtectedRoute><Reports /></ProtectedRoute>} />
          <Route path="/llm" element={<ProtectedRoute><LlmMonitoring /></ProtectedRoute>} />
          <Route path="/active-defense" element={<ProtectedRoute><ActiveDefense /></ProtectedRoute>} />
          <Route path="/users" element={<ProtectedRoute><Users /></ProtectedRoute>} />
          <Route path="/integrations" element={<ProtectedRoute><Integrations /></ProtectedRoute>} />
          <Route path="/billing" element={<ProtectedRoute><Billing /></ProtectedRoute>} />
          <Route path="/support" element={<ProtectedRoute><Support /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
          <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
