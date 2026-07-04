import Layout from '../components/Layout';
import KpiCard from '../components/KpiCard';
import PageHeader from '../components/shared/PageHeader';
import useApiData from '../hooks/useApiData';

// Badges + capability matrix for the REAL product RBAC roles (from the users table).
const ROLE_BADGE = {
  tenant_admin: 'sev-critical', Admin: 'sev-critical', compliance: 'sev-medium',
  'Security Analyst': 'sev-high', soc_analyst: 'sev-high', auditor: 'engine',
  db_owner: 'status-gray', viewer: 'status-gray',
};
const CAPS = ['Dashboard', 'Threats', 'Policies', 'Data Security', 'Compliance', 'Audit', 'Admin'];
const ROLE_CAPS = {
  tenant_admin: { label: 'Tenant Admin', desc: 'Full tenant access — config, users, all modules', caps: [1, 1, 1, 1, 1, 1, 1] },
  Admin: { label: 'Admin', desc: 'Administrative access across the tenant', caps: [1, 1, 1, 1, 1, 1, 1] },
  soc_analyst: { label: 'SOC Analyst', desc: 'Threat monitoring, alerts, policies, classification', caps: [1, 1, 1, 1, 0, 0, 0] },
  'Security Analyst': { label: 'Security Analyst', desc: 'Threat monitoring + investigation', caps: [1, 1, 1, 1, 0, 0, 0] },
  db_owner: { label: 'DB Owner', desc: 'Owns databases — monitoring, classification, reports', caps: [1, 1, 0, 1, 0, 0, 0] },
  compliance: { label: 'Compliance', desc: 'Classification, masking, compliance, DSAR, audit', caps: [1, 0, 0, 1, 1, 1, 0] },
  auditor: { label: 'Auditor', desc: 'Read-only — compliance, audit trail, reports', caps: [1, 0, 0, 0, 1, 1, 0] },
  viewer: { label: 'Viewer', desc: 'Dashboard + reports only', caps: [1, 0, 0, 0, 0, 0, 0] },
};
const PRINCIPLES = [
  ['Least privilege', 'Each role grants only the modules needed for its job; viewers and auditors are read-only.'],
  ['Separation of duties', 'Compliance/audit roles are distinct from operational (SOC/DB) roles — investigators don\'t own policy.'],
  ['MFA enforced', 'All active accounts require multi-factor authentication; SSO/SCIM provisions via the identity provider.'],
  ['Immutable audit', 'Every privileged action is recorded in the hash-chained audit trail (see Platform Audit Log).'],
];

function Cell({ on }) {
  return <td style={{ textAlign: 'center' }}>{on ? <span style={{ color: 'var(--green)', fontWeight: 700 }}>✓</span> : <span style={{ color: 'var(--subtle)' }}>✗</span>}</td>;
}
function ago(d) { if (!d) return '—'; const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000); if (m < 60) return `${m}m ago`; if (m < 1440) return `${Math.floor(m / 60)}h ago`; return `${Math.floor(m / 1440)}d ago`; }

export default function Roles() {
  const { data, loading, lastRefresh, refetch } = useApiData('/admin/operators', { poll: 30000 });
  if (loading && !data) return <div className="loading-screen"><div className="loading-spinner" /><p>Loading roles…</p></div>;
  const k = data?.kpis || {};
  const operators = data?.operators || [];
  const counts = data?.roleCounts || {};
  // Show matrix rows only for roles that actually exist in the data.
  const presentRoles = Object.keys(counts).filter(r => ROLE_CAPS[r]);

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refetch}>
      <PageHeader title="Roles & Permissions" meta={['product RBAC', 'real user assignments', 'least privilege']} />

      <section className="kpi-grid">
        <KpiCard icon="●" iconBg="var(--primary-soft)" iconColor="var(--primary)" label="Roles" value={k.roles} detail="in use" />
        <KpiCard icon="●" iconBg="var(--green-soft)" iconColor="var(--green)" label="Users" value={k.users} detail="real accounts" />
        <KpiCard icon="▲" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Pending approvals" value={k.pendingApprovals} detail="awaiting sign-off" detailType={k.pendingApprovals ? 'down' : 'up'} />
        <KpiCard icon="◉" iconBg="var(--info-soft)" iconColor="var(--info)" label="MFA / SoD" value="Enforced" detail="least privilege" detailType="up" />
      </section>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Role Capabilities</span><span className="card-sub">product RBAC · roles in use</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Role</th><th>Description</th><th className="num">Users</th>{CAPS.map(c => <th key={c} style={{ textAlign: 'center' }}>{c}</th>)}</tr></thead>
            <tbody>
              {presentRoles.map(r => (
                <tr key={r}>
                  <td><span className={`badge ${ROLE_BADGE[r] || 'status-gray'}`}>{ROLE_CAPS[r].label}</span></td>
                  <td className="muted" style={{ fontSize: 12 }}>{ROLE_CAPS[r].desc}</td>
                  <td className="num">{counts[r] || 0}</td>
                  {ROLE_CAPS[r].caps.map((v, i) => <Cell key={i} on={v} />)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Role Assignments</span><span className="card-sub">{operators.length} real users</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Tenant</th><th>Status</th><th>Last login</th><th>MFA</th></tr></thead>
            <tbody>
              {operators.map(o => (
                <tr key={o.id}>
                  <td><b>{o.name}</b></td>
                  <td className="muted">{o.email}</td>
                  <td><span className={`badge ${ROLE_BADGE[o.role] || 'status-gray'}`}>{o.roleLabel}</span></td>
                  <td className="muted">{o.tenant || '—'}</td>
                  <td><span className={`badge ${o.status === 'active' ? 'status-green' : 'status-gray'}`} style={{ fontSize: 10 }}>{o.status}</span></td>
                  <td className="muted">{ago(o.lastActive)}</td>
                  <td><span className={`badge ${o.mfa ? 'status-green' : 'sev-critical'}`} style={{ fontSize: 10 }}>{o.mfa ? 'Enabled' : 'Off'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Access Principles</span></div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {PRINCIPLES.map(([title, desc]) => (
            <div key={title} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 9 }}>
              <span className="badge status-green" style={{ flex: 'none', marginTop: 2 }}>Enforced</span>
              <div style={{ fontSize: 12.5, lineHeight: 1.5 }}><b>{title}</b> — {desc}</div>
            </div>
          ))}
        </div>
      </div>
    </Layout>
  );
}
