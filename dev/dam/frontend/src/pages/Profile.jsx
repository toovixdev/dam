import { useState } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import Modal from '../components/shared/Modal';
import { useAuth } from '../context/AuthContext';
import useApiData from '../hooks/useApiData';
import useTimezone, { TIMEZONES, tzShortName } from '../hooks/useTimezone';
import { apiPost } from '../api/client';
import { toast } from '../components/shared/Toast';

const ROLE_PERMS = {
  tenant_admin: ['*'],
  soc_analyst: ['alerts.*', 'audit.read', 'policy.read', 'databases.read', 'quarantine.*', 'classification.read'],
  compliance: ['compliance.*', 'classification.*', 'masking.*', 'reports.*', 'dsar.*', 'audit.read', 'databases.read'],
  auditor: ['audit.read', 'compliance.read', 'reports.read'],
  db_owner: ['databases.scoped', 'alerts.scoped', 'agents.scoped', 'classification.read'],
  viewer: ['dashboard.read'],
};
const ROLE_LABELS = {
  tenant_admin: 'Tenant Admin', soc_analyst: 'SOC Analyst', compliance: 'Compliance Officer',
  auditor: 'Auditor (Read-only)', db_owner: 'DB Owner', viewer: 'Viewer',
};

const SESSIONS = [
  { time: '21 Jun 14:42', ip: '10.20.4.2', loc: 'New York, US', dev: 'Chrome 126 / macOS', auth: 'Azure AD + MFA', status: 'current', cls: 'green' },
  { time: '21 Jun 08:15', ip: '10.20.4.2', loc: 'New York, US', dev: 'Chrome 126 / macOS', auth: 'Azure AD + MFA', status: 'ended', cls: '' },
  { time: '20 Jun 16:30', ip: '10.20.4.2', loc: 'New York, US', dev: 'Chrome 126 / macOS', auth: 'Azure AD + MFA', status: 'ended', cls: '' },
  { time: '19 Jun 09:05', ip: '172.16.0.44', loc: 'VPN - Corporate', dev: 'Firefox 128 / Windows', auth: 'Azure AD + MFA', status: 'ended', cls: '' },
  { time: '18 Jun 22:10', ip: '73.158.x.x', loc: 'Home - New York', dev: 'Safari / iPhone 16', auth: 'Azure AD + MFA', status: 'ended', cls: '' },
];

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function Profile() {
  const { user } = useAuth();
  const { data: me } = useApiData('/auth/me');
  const [tz, changeTz] = useTimezone();
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwErr, setPwErr] = useState('');
  const [saving, setSaving] = useState(false);

  const name = user?.fullName || 'User';
  const initials = name.split(' ').map((n) => n[0]).join('').substring(0, 2).toUpperCase();
  const roleKey = user?.role || 'viewer';
  const perms = ROLE_PERMS[roleKey] || ['dashboard.read'];

  const submitPw = async () => {
    setPwErr('');
    if (!pw.current || !pw.next) { setPwErr('All fields are required'); return; }
    if (pw.next.length < 8) { setPwErr('New password must be at least 8 characters'); return; }
    if (pw.next !== pw.confirm) { setPwErr('New passwords do not match'); return; }
    setSaving(true);
    const res = await apiPost('/auth/change-password', { currentPassword: pw.current, newPassword: pw.next });
    setSaving(false);
    if (res && res.ok) {
      toast('Password changed successfully', 'ok');
      setPwOpen(false);
      setPw({ current: '', next: '', confirm: '' });
    } else {
      setPwErr((res && res.data && res.data.error) || 'Could not change password');
    }
  };

  return (
    <Layout>
      <PageHeader title="My Profile" meta={['account settings · security · sessions']}>
        <button className="btn-secondary" onClick={() => setPwOpen(true)}>🔒 Change password</button>
        <button className="btn-primary" onClick={() => toast('Profile saved', 'ok')}>Save changes</button>
      </PageHeader>

      <div className="grid2" style={{ gridTemplateColumns: '1.2fr 1fr', marginBottom: 16 }}>
        <div className="card"><div className="card-body">
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 22 }}>
            <span className="topbar-avatar" style={{ width: 72, height: 72, fontSize: 24 }}>{initials}</span>
            <div>
              <h2 style={{ margin: '0 0 2px', fontSize: 20, fontWeight: 800 }}>{name}</h2>
              <div className="muted" style={{ fontSize: 13.5 }}>{ROLE_LABELS[roleKey] || roleKey} · <b style={{ color: 'var(--ink)' }}>{user?.tenantName || 'TooVix DAM'}</b></div>
            </div>
          </div>
          <div className="def-grid">
            <span className="k">Email</span><span className="v">{user?.email || '—'}</span>
            <span className="k">Authentication</span><span className="v">Local + MFA</span>
            <span className="k">MFA status</span><span className="v"><span className="badge green">✓ Enabled (Authenticator)</span></span>
            <span className="k">Timezone</span>
            <span className="v" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {tz} ({tzShortName(tz)})
              <select value={tz} onChange={(e) => { changeTz(e.target.value); toast('Timezone updated', 'ok'); }} style={{ padding: '4px 8px', border: '1px solid var(--line)', borderRadius: 8, fontFamily: 'var(--font)', fontSize: 12, background: 'var(--surface)', color: 'var(--ink)' }}>
                {TIMEZONES.map((t) => <option key={t.id} value={t.id}>{t.label} — {t.id}</option>)}
              </select>
            </span>
            <span className="k">Member since</span><span className="v">{fmtDate(me?.created_at)}</span>
            <span className="k">Last login</span><span className="v">{me?.last_login_at ? new Date(me.last_login_at).toLocaleString('en-GB') : 'Just now'}</span>
          </div>
        </div></div>

        <div className="card">
          <div className="card-header"><span className="card-title">Role &amp; Permissions</span></div>
          <div className="card-body">
            <div className="def-grid">
              <span className="k">Assigned role</span><span className="v"><span className="badge engine">{ROLE_LABELS[roleKey] || roleKey}</span></span>
              <span className="k">Scope</span><span className="v">All databases (global)</span>
              <span className="k">Granted by</span><span className="v">SCIM auto-provision</span>
              <span className="k">Expires</span><span className="v muted">Never (permanent)</span>
            </div>
            <div className="muted" style={{ fontSize: 12, fontWeight: 600, margin: '14px 0 6px' }}>PERMISSIONS</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {perms[0] === '*' ? <span className="badge engine">Full access (all permissions)</span> : perms.map((p) => <span className="badge" key={p}>{p}</span>)}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header"><span className="card-title">Recent sessions</span><span className="card-sub">last 10 sign-ins · logged to audit trail</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Time</th><th>IP address</th><th>Location</th><th>Device / Browser</th><th>Auth method</th><th>Status</th></tr></thead>
            <tbody>
              {SESSIONS.map((s, i) => (
                <tr key={i}>
                  <td className="muted">{s.time}</td><td className="mono">{s.ip}</td><td>{s.loc}</td><td>{s.dev}</td><td>{s.auth}</td>
                  <td><span className={`badge ${s.cls}`}>{s.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={pwOpen} onClose={() => setPwOpen(false)} title="Change password" width={460}>
        {pwErr && <div className="login-error" style={{ marginBottom: 12 }}>{pwErr}</div>}
        <div className="form-field"><label>Current password</label><input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></div>
        <div className="form-field"><label>New password</label><input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></div>
        <div className="form-field"><label>Confirm new password</label><input type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></div>
        <div className="modal-footer" style={{ padding: '14px 0 0', borderTop: 'none' }}>
          <button className="btn-secondary" onClick={() => setPwOpen(false)}>Cancel</button>
          <button className="btn-primary" onClick={submitPw} disabled={saving}>{saving ? 'Saving…' : 'Change password'}</button>
        </div>
      </Modal>
    </Layout>
  );
}
