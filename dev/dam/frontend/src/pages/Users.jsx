import { useState } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/KpiCard';
import TabNav from '../components/shared/TabNav';
import DataTable from '../components/shared/DataTable';
import Modal from '../components/shared/Modal';
import { StatusBadge } from '../components/shared/Badge';
import useApiData from '../hooks/useApiData';
import { apiPost } from '../api/client';
import { toast } from '../components/shared/Toast';

function formatDate(ts) {
  if (!ts) return 'Never';
  return new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// SSO account types (auth_provider → display label). Local is not listed here.
const SSO_LABELS = { azure_ad: 'Azure AD', okta: 'Okta', google: 'Google' };

// `role` is the CANONICAL value stored on the user (matches the RBAC map); `name` is
// the friendly label shown in the UI.
const DEMO_ROLES = [
  { id: 1, role: 'tenant_admin', name: 'Tenant Admin', description: 'Full system access', permissions: 'All permissions' },
  { id: 2, role: 'soc_analyst', name: 'SOC Analyst', description: 'Monitoring, alerts, policies, quarantine', permissions: 'Read/act on alerts, policies, quarantine' },
  { id: 3, role: 'db_owner', name: 'DB Owner', description: 'Owned databases, agents, access approvals', permissions: 'Read/Write databases, agents; approve JIT' },
  { id: 4, role: 'compliance', name: 'Compliance', description: 'Compliance, DSAR, masking, audit', permissions: 'Read/Write compliance, DSAR; Read audit' },
  { id: 5, role: 'auditor', name: 'Auditor', description: 'Read-only compliance, audit, reports', permissions: 'Read compliance, audit, reports' },
  { id: 6, role: 'viewer', name: 'Viewer', description: 'Read-only dashboard access', permissions: 'Read dashboard, reports' },
];

const DEMO_APIKEYS = [
  { id: 1, name: 'CI/CD Pipeline', key_prefix: 'dam_sk_ci_...3f8a', created_by: 'admin@meridian.com', created_at: '2025-05-10T09:00:00Z', last_used: '2025-06-27T08:14:00Z', status: 'active' },
  { id: 2, name: 'SIEM Integration', key_prefix: 'dam_sk_siem_...b2c4', created_by: 'admin@meridian.com', created_at: '2025-04-22T14:30:00Z', last_used: '2025-06-27T08:10:00Z', status: 'active' },
  { id: 3, name: 'Backup Service', key_prefix: 'dam_sk_bak_...9e1d', created_by: 'ops@meridian.com', created_at: '2025-03-15T11:00:00Z', last_used: '2025-06-26T23:00:00Z', status: 'active' },
  { id: 4, name: 'Legacy Reporter', key_prefix: 'dam_sk_rep_...4a7b', created_by: 'admin@meridian.com', created_at: '2024-12-01T08:00:00Z', last_used: '2025-01-15T10:00:00Z', status: 'disabled' },
];

export default function Users() {
  const { data, loading, error, refetch } = useApiData('/users');
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [activeTab, setActiveTab] = useState('users');
  const [showModal, setShowModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ full_name: '', email: '', role: 'viewer', auth_provider: 'local' });

  const handleRefresh = () => {
    refetch();
    setLastRefresh(new Date());
  };

  const rows = Array.isArray(data) ? data : [];
  const total = rows.length;
  const active = rows.filter(u => u.status === 'active').length;
  const mfaEnabled = rows.filter(u => u.mfa_enabled).length;
  const mfaPct = total > 0 ? Math.round((mfaEnabled / total) * 100) : 0;
  const apiKeyCount = DEMO_APIKEYS.filter(k => k.status === 'active').length;

  const tabs = [
    { id: 'users', label: 'Users', count: total },
    { id: 'roles', label: 'Roles', count: DEMO_ROLES.length },
    { id: 'apikeys', label: 'API Keys', count: DEMO_APIKEYS.length },
  ];

  const userColumns = [
    { key: 'full_name', label: 'Name' },
    { key: 'email', label: 'Email' },
    { key: 'role', label: 'Role', render: (v) => <span style={{ fontWeight: 600 }}>{v || '-'}</span> },
    { key: 'auth_provider', label: 'Auth Provider', render: (v) => <span style={{ textTransform: 'capitalize' }}>{v || 'local'}</span> },
    { key: 'mfa_enabled', label: 'MFA', render: (v) => (
      <span style={{ color: v ? 'var(--green)' : 'var(--danger)', fontWeight: 600 }}>{v ? 'Enabled' : 'Disabled'}</span>
    )},
    { key: 'status', label: 'Status', render: (v) => <StatusBadge status={v || 'active'} /> },
    { key: 'last_login_at', label: 'Last Login', render: (v) => formatDate(v) },
    { key: 'id', label: '', sortable: false, render: (v, row) => (
      row.status === 'invited'
        ? <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => handleResend(v, row.email)}>Resend invite</button>
        : null
    )},
  ];

  const roleColumns = [
    { key: 'name', label: 'Role Name', render: (v) => <span style={{ fontWeight: 600 }}>{v}</span> },
    { key: 'description', label: 'Description' },
    { key: 'users', label: 'Users', align: 'right' },
    { key: 'permissions', label: 'Permissions', render: (v) => <span style={{ color: 'var(--muted)', fontSize: 13 }}>{v}</span> },
  ];

  const apiKeyColumns = [
    { key: 'name', label: 'Key Name' },
    { key: 'key_prefix', label: 'Key', render: (v) => <code style={{ fontSize: 12 }}>{v}</code> },
    { key: 'created_by', label: 'Created By' },
    { key: 'created_at', label: 'Created', render: (v) => formatDate(v) },
    { key: 'last_used', label: 'Last Used', render: (v) => formatDate(v) },
    { key: 'status', label: 'Status', render: (v) => <StatusBadge status={v} /> },
  ];

  const handleInvite = async () => {
    setSubmitting(true);
    try {
      const result = await apiPost('/users', form);
      if (result && result.ok) {
        const { emailSent, inviteLink } = result.data || {};
        const ssoLabel = SSO_LABELS[form.auth_provider];
        setShowModal(false);
        setForm({ full_name: '', email: '', role: 'viewer', auth_provider: 'local' });
        refetch();
        if (ssoLabel) {
          toast(emailSent
            ? `${ssoLabel} access granted — sign-in email sent to ${result.data.email}`
            : `${ssoLabel} user added — they sign in with ${ssoLabel} SSO`, 'ok');
        } else if (emailSent) {
          toast(`Invitation email sent to ${result.data.email}`, 'ok');
        } else if (inviteLink) {
          // Dev (no SMTP configured): copy the link so it's testable.
          if (navigator.clipboard) navigator.clipboard.writeText(inviteLink).catch(() => {});
          toast('Invite created — email not configured, link copied to clipboard', 'info');
        } else {
          toast('User invited', 'ok');
        }
      } else {
        toast((result && result.data && result.data.error) || 'Failed to invite user', 'err');
      }
    } catch (err) {
      toast('Error: ' + err.message, 'err');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResend = async (userId, email) => {
    const result = await apiPost(`/users/${userId}/resend-invite`, {});
    if (result && result.ok) {
      const { emailSent, inviteLink } = result.data || {};
      if (emailSent) {
        toast(`Invitation resent to ${email}`, 'ok');
      } else if (inviteLink) {
        if (navigator.clipboard) navigator.clipboard.writeText(inviteLink).catch(() => {});
        toast('Invite link regenerated and copied to clipboard', 'info');
      } else {
        toast('Invitation resent', 'ok');
      }
    } else {
      toast((result && result.data && result.data.error) || 'Could not resend invitation', 'err');
    }
  };

  if (loading) {
    return (
      <Layout activePage="users">
        <div className="loading-screen"><div className="loading-spinner" /><p>Loading users...</p></div>
      </Layout>
    );
  }

  return (
    <Layout activePage="users" lastRefresh={lastRefresh} onRefresh={handleRefresh}>
      <PageHeader
        title="Users & Access"
        meta={[`${total} users`, `${active} active`, `${mfaPct}% MFA`]}
      >
        <button className="btn-secondary" onClick={handleRefresh}>Refresh</button>
        <button className="btn-primary" onClick={() => setShowModal(true)}>+ Invite User</button>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="◧" label="Total Users" value={total} detail="registered accounts" />
        <KpiCard icon="◉" iconBg="var(--green-soft)" iconColor="var(--green)" label="Active" value={active} detail="currently active users" detailType="up" />
        <KpiCard icon="◎" iconBg={mfaPct >= 90 ? 'var(--green-soft)' : 'var(--amber-soft)'} iconColor={mfaPct >= 90 ? 'var(--green)' : 'var(--amber)'} label="MFA Enabled" value={`${mfaPct}%`} detail={`${mfaEnabled} of ${total} users`} detailType={mfaPct >= 90 ? 'up' : 'down'} />
        <KpiCard icon="⊡" iconBg="var(--info-soft)" iconColor="var(--info)" label="API Keys" value={apiKeyCount} detail="active service keys" />
      </section>

      <TabNav tabs={tabs} active={activeTab} onChange={setActiveTab} />

      {error && <div className="card" style={{ padding: 16, color: 'var(--danger)' }}>Error: {error}</div>}

      {activeTab === 'users' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">All Users</span>
            <span className="card-sub">{total} users</span>
          </div>
          <div className="card-body no-pad">
            <DataTable columns={userColumns} data={rows} emptyMessage="No users found" />
          </div>
        </div>
      )}

      {activeTab === 'roles' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Roles</span>
            <span className="card-sub">{DEMO_ROLES.length} defined</span>
          </div>
          <div className="card-body no-pad">
            <DataTable columns={roleColumns} data={DEMO_ROLES} emptyMessage="No roles defined" />
          </div>
        </div>
      )}

      {activeTab === 'apikeys' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">API Keys</span>
            <span className="card-sub">{DEMO_APIKEYS.length} keys</span>
          </div>
          <div className="card-body no-pad">
            <DataTable columns={apiKeyColumns} data={DEMO_APIKEYS} emptyMessage="No API keys created" />
          </div>
        </div>
      )}

      <Modal open={showModal} onClose={() => setShowModal(false)} title="Invite User">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Account type</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {[
                { id: 'local', title: 'Local account', desc: 'Email invite to set a password' },
                { id: 'azure_ad', title: 'Azure AD (SSO)', desc: 'Signs in with Microsoft — no password' },
                { id: 'okta', title: 'Okta (SSO)', desc: 'Signs in with Okta — no password' },
                { id: 'google', title: 'Google (SSO)', desc: 'Signs in with Google — no password' },
              ].map(opt => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setForm({ ...form, auth_provider: opt.id })}
                  style={{
                    textAlign: 'left', padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                    border: `1.5px solid ${form.auth_provider === opt.id ? 'var(--primary)' : 'var(--line)'}`,
                    background: form.auth_provider === opt.id ? 'var(--primary-soft)' : 'var(--surface)',
                    fontFamily: 'var(--font)', color: 'var(--ink)',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{opt.title}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Full Name</span>
            <input type="text" value={form.full_name} onChange={e => setForm({ ...form, full_name: e.target.value })} placeholder="Jane Doe" style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--line)', fontSize: 14 }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{SSO_LABELS[form.auth_provider] ? `Email (must match ${SSO_LABELS[form.auth_provider]})` : 'Email'}</span>
            <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="jane@company.com" style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--line)', fontSize: 14 }} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Role</span>
            <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--line)', fontSize: 14 }}>
              {DEMO_ROLES.map(r => <option key={r.role} value={r.role}>{r.name}</option>)}
            </select>
          </label>
          {SSO_LABELS[form.auth_provider] && (
            <div style={{ fontSize: 12, color: 'var(--muted)', background: 'var(--info-soft)', borderRadius: 8, padding: '10px 12px', lineHeight: 1.5 }}>
              The user will sign in with <b>Continue with {SSO_LABELS[form.auth_provider]}</b> on the login page — no password or invite token. The email here must match their {SSO_LABELS[form.auth_provider]} identity, and {SSO_LABELS[form.auth_provider]} SSO must be enabled for this workspace. They're activated on first SSO sign-in.
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
            <button className="btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
            <button className="btn-primary" onClick={handleInvite} disabled={submitting || !form.full_name || !form.email}>
              {submitting ? 'Sending...' : SSO_LABELS[form.auth_provider] ? `Add ${SSO_LABELS[form.auth_provider]} user` : 'Send Invite'}
            </button>
          </div>
        </div>
      </Modal>
    </Layout>
  );
}
