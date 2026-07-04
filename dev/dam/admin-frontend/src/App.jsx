import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import PlatformDashboard from './pages/PlatformDashboard';
import Tenants from './pages/Tenants';
import FeatureFlags from './pages/FeatureFlags';
import Quotas from './pages/Quotas';
import TenantHealth from './pages/TenantHealth';
import InfraHealth from './pages/InfraHealth';
import NoisyNeighbor from './pages/NoisyNeighbor';
import CanaryDeployments from './pages/CanaryDeployments';
import CapacityPlanning from './pages/CapacityPlanning';
import Billing from './pages/Billing';
import TrialConversion from './pages/TrialConversion';
import CustomerSuccess from './pages/CustomerSuccess';
import PlatformAudit from './pages/PlatformAudit';
import Impersonation from './pages/Impersonation';
import BreakGlass from './pages/BreakGlass';
import Roles from './pages/Roles';
import PlatformEmail from './pages/PlatformEmail';
import Approvals from './pages/Approvals';
import Placeholder from './pages/Placeholder';
import Login from './pages/Login';
import { getToken } from './api/client';
import './App.css';

// Sidebar entries that don't have a real page yet resolve to a titled placeholder.
const STUBS = [
  ['/runbooks', 'Runbooks'],
  ['/content-packs', 'Content Packs'],
  ['/agent-versions', 'Agent Versions'],
];

// Gate the console behind a platform-admin token. Invalid/expired tokens are cleared
// by the API client on the first 401, which bounces back here to /login.
function RequireAuth({ children }) {
  return getToken() ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<RequireAuth><PlatformDashboard /></RequireAuth>} />
        <Route path="/tenants" element={<RequireAuth><Tenants /></RequireAuth>} />
        <Route path="/feature-flags" element={<RequireAuth><FeatureFlags /></RequireAuth>} />
        <Route path="/quotas" element={<RequireAuth><Quotas /></RequireAuth>} />
        <Route path="/tenant-health" element={<RequireAuth><TenantHealth /></RequireAuth>} />
        <Route path="/infra-health" element={<RequireAuth><InfraHealth /></RequireAuth>} />
        <Route path="/noisy-neighbor" element={<RequireAuth><NoisyNeighbor /></RequireAuth>} />
        <Route path="/canary" element={<RequireAuth><CanaryDeployments /></RequireAuth>} />
        <Route path="/capacity" element={<RequireAuth><CapacityPlanning /></RequireAuth>} />
        <Route path="/billing" element={<RequireAuth><Billing /></RequireAuth>} />
        <Route path="/trials" element={<RequireAuth><TrialConversion /></RequireAuth>} />
        <Route path="/success" element={<RequireAuth><CustomerSuccess /></RequireAuth>} />
        <Route path="/audit" element={<RequireAuth><PlatformAudit /></RequireAuth>} />
        <Route path="/impersonation" element={<RequireAuth><Impersonation /></RequireAuth>} />
        <Route path="/break-glass" element={<RequireAuth><BreakGlass /></RequireAuth>} />
        <Route path="/roles" element={<RequireAuth><Roles /></RequireAuth>} />
        <Route path="/platform-email" element={<RequireAuth><PlatformEmail /></RequireAuth>} />
        <Route path="/approvals" element={<RequireAuth><Approvals /></RequireAuth>} />
        {STUBS.map(([path, title]) => (
          <Route key={path} path={path} element={<RequireAuth><Placeholder title={title} /></RequireAuth>} />
        ))}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
