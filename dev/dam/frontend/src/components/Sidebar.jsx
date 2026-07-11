import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import useApiData from '../hooks/useApiData';
import { getBranding, onBrandingChange } from '../branding';
import { canSee as roleCanSee } from '../roles';

const NAV = [
  { sec: 'Monitor' },
  { id: 'dashboard',      ic: '▤', label: 'Dashboard',         to: '/dashboard' },
  { id: 'active-defense', ic: '◎', label: 'Active Defense',    to: '/active-defense' },
  { sec: 'Data Sources' },
  { id: 'databases',      ic: '▥', label: 'Databases',         to: '/databases' },
  { id: 'discovery',      ic: '⊹', label: 'Discovery',         to: '/discovery' },
  { id: 'agents',         ic: '⊡', label: 'Agents & Coverage', to: '/agents' },
  { id: 'capture-modes',  ic: '◫', label: 'Capture Modes',     to: '/capture-modes' },
  { sec: 'Threats' },
  { id: 'alerts',         ic: '⚠', label: 'Alerts',            to: '/alerts' },
  { id: 'policies',       ic: '⚑', label: 'Policies & Rules',  to: '/policies' },
  { id: 'quarantine',     ic: '⛔', label: 'Quarantine',        to: '/quarantine' },
  { sec: 'Data Security' },
  { id: 'classification', ic: '◧', label: 'Classification',    to: '/classification' },
  { id: 'masking',        ic: '▦', label: 'Masking',           to: '/masking' },
  { id: 'access',         ic: '⊠', label: 'Access Governance', to: '/access' },
  { sec: 'Compliance' },
  { id: 'compliance',     ic: '⚖', label: 'Compliance Center', to: '/compliance', ct: '2' },
  { id: 'dsar',           ic: '◔', label: 'DSAR Manager',      to: '/dsar', ct: '1' },
  { id: 'audit',          ic: '⛓', label: 'Audit Trail',       to: '/audit' },
  { id: 'change-log',     ic: '⛭', label: 'Change Log',        to: '/change-log' },
  { id: 'reports',        ic: '◫', label: 'Reports',           to: '/reports' },
  { sec: 'AI & Analytics' },
  { id: 'copilot',        ic: '✦', label: 'Copilot',           to: '/copilot' },
  { id: 'llm',            ic: '✦', label: 'LLM Monitoring',    to: '/llm' },
  { sec: 'Administration' },
  { id: 'users',          ic: '☰', label: 'Users & Roles',     to: '/users' },
  { id: 'integrations',   ic: '⇄', label: 'Integrations',      to: '/integrations' },
  { id: 'billing',        ic: '◈', label: 'Billing & Usage',   to: '/billing' },
  { id: 'support',        ic: '♥', label: 'Support Center',    to: '/support' },
  { id: 'settings',       ic: '⚙', label: 'Settings',          to: '/settings' },
];

export default function Sidebar({ collapsed, onToggle }) {
  const { user } = useAuth();
  const canSee = (id) => roleCanSee(user?.role, id);

  // White-label branding (custom logo + name), reactive to Settings changes.
  const [brand, setBrand] = useState(getBranding());
  useEffect(() => onBrandingChange(() => setBrand(getBranding())), []);

  // Live nav-badge counts (authoritative summaries, not capped lists).
  const { data: alertsSummary } = useApiData('/alerts/summary', { poll: 30000 });
  const { data: quarantineSummary } = useApiData('/quarantine/summary', { poll: 30000 });
  const { data: agentsSummary } = useApiData('/agents/summary', { poll: 30000 });
  const openAlerts = alertsSummary?.open?.total ?? null;
  const heldSessions = quarantineSummary?.held ?? null;
  const offlineAgents = agentsSummary?.offline ?? null;
  const badgeFor = (item) => {
    if (item.id === 'alerts') return openAlerts > 0 ? String(openAlerts) : null;
    if (item.id === 'quarantine') return heldSessions > 0 ? String(heldSessions) : null;
    if (item.id === 'agents') return offlineAgents > 0 ? String(offlineAgents) : null;
    return item.ct;
  };

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-brand">
        {brand.logo && brand.placement !== 'header'
          ? <img src={brand.logo} alt="logo" className="brand-logo" />
          : <span className="brand-dot">{(brand.name[0] || 'T').toUpperCase()}</span>}
        {!collapsed && (brand.custom
          ? <span className="brand-label">{brand.name}</span>
          : <span className="brand-label">TooVix <span className="brand-sub">DAM</span></span>)}
        <button className="sidebar-toggle" onClick={onToggle} title="Toggle sidebar">
          {collapsed ? '☰' : '⇤'}
        </button>
      </div>

      <nav className="sidebar-nav">
        {NAV.map((item, i) => {
          if (item.sec) {
            if (collapsed) return null;
            return <div key={i} className="nav-section">{item.sec}</div>;
          }
          if (!canSee(item.id)) return null;

          const badge = badgeFor(item);
          return (
            <NavLink
              key={item.id}
              to={item.to}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
              title={item.label}
            >
              <span className="nav-icon">{item.ic}</span>
              {!collapsed && <span className="nav-label">{item.label}</span>}
              {!collapsed && badge && <span className={`nav-badge ${item.id === 'agents' ? 'warn' : ''}`} title={item.id === 'agents' ? `${badge} agent(s) offline` : undefined}>{badge}</span>}
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}
