import { NavLink } from 'react-router-dom';

// Super-Admin navigation, mirroring admin-mockups NAV_SUPER. Only routes with a
// real page are wired today; the rest resolve to a "coming soon" placeholder so
// the shell stays navigable as screens get built out.
const NAV = [
  { sec: 'Platform' },
  { id: 'dashboard',      ic: '▤', label: 'Platform Dashboard', to: '/' },
  { id: 'tenants',        ic: '⊞', label: 'Tenants',            to: '/tenants' },
  { id: 'feature-flags',  ic: '⚑', label: 'Feature Flags',      to: '/feature-flags' },
  { id: 'tenant-quotas',  ic: '◫', label: 'Resource Quotas',    to: '/quotas' },
  { id: 'tenant-health',  ic: '◉', label: 'Tenant Health',      to: '/tenant-health' },

  { sec: 'Infrastructure' },
  { id: 'infra-health',   ic: '⊡', label: 'Infrastructure Health', to: '/infra-health' },
  { id: 'noisy-neighbor', ic: '⚡', label: 'Noisy Neighbor',     to: '/noisy-neighbor' },
  { id: 'canary-deploy',  ic: '⊹', label: 'Canary Deployments',  to: '/canary' },
  { id: 'capacity',       ic: '◎', label: 'Capacity Planning',   to: '/capacity' },
  { id: 'runbooks',       ic: '▷', label: 'Runbooks',            to: '/runbooks' },

  { sec: 'Billing & Success' },
  { id: 'billing',        ic: '◈', label: 'Billing & Plans',     to: '/billing' },
  { id: 'trial-conv',     ic: '⊳', label: 'Trial Conversion',    to: '/trials' },
  { id: 'cust-success',   ic: '♥', label: 'Customer Success',    to: '/success' },

  { sec: 'Security & Ops' },
  { id: 'platform-audit', ic: '⛓', label: 'Platform Audit Log',  to: '/audit' },
  { id: 'impersonation',  ic: '◑', label: 'Impersonation',       to: '/impersonation' },
  { id: 'break-glass',    ic: '⚠', label: 'Break-Glass Access',  to: '/break-glass' },
  { id: 'roles',          ic: '⊕', label: 'Roles & Permissions', to: '/roles' },
  { id: 'platform-email', ic: '@', label: 'Platform Settings',    to: '/platform-email' },
  { id: 'approvals',      ic: '✓', label: 'Approval Requests',   to: '/approvals' },

  { sec: 'Product Config' },
  { id: 'content-packs',  ic: '⭳', label: 'Content Packs',       to: '/content-packs' },
  { id: 'agent-versions', ic: '⊡', label: 'Agent Versions',      to: '/agent-versions' },
];

export default function Sidebar({ collapsed, onToggle }) {
  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-brand">
        <span className="brand-dot" style={{ background: 'var(--danger)' }}>A</span>
        {!collapsed && <span className="brand-label">TooVix <span className="brand-sub">ADMIN</span></span>}
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
          return (
            <NavLink
              key={item.id}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
              title={item.label}
            >
              <span className="nav-icon">{item.ic}</span>
              {!collapsed && <span className="nav-label">{item.label}</span>}
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}
