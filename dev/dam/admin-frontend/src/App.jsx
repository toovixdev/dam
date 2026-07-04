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
import './App.css';

// Sidebar entries that don't have a real page yet resolve to a titled placeholder.
const STUBS = [
  ['/runbooks', 'Runbooks'],
  ['/content-packs', 'Content Packs'],
  ['/agent-versions', 'Agent Versions'],
];

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<PlatformDashboard />} />
        <Route path="/tenants" element={<Tenants />} />
        <Route path="/feature-flags" element={<FeatureFlags />} />
        <Route path="/quotas" element={<Quotas />} />
        <Route path="/tenant-health" element={<TenantHealth />} />
        <Route path="/infra-health" element={<InfraHealth />} />
        <Route path="/noisy-neighbor" element={<NoisyNeighbor />} />
        <Route path="/canary" element={<CanaryDeployments />} />
        <Route path="/capacity" element={<CapacityPlanning />} />
        <Route path="/billing" element={<Billing />} />
        <Route path="/trials" element={<TrialConversion />} />
        <Route path="/success" element={<CustomerSuccess />} />
        <Route path="/audit" element={<PlatformAudit />} />
        <Route path="/impersonation" element={<Impersonation />} />
        <Route path="/break-glass" element={<BreakGlass />} />
        <Route path="/roles" element={<Roles />} />
        <Route path="/platform-email" element={<PlatformEmail />} />
        <Route path="/approvals" element={<Approvals />} />
        {STUBS.map(([path, title]) => (
          <Route key={path} path={path} element={<Placeholder title={title} />} />
        ))}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
