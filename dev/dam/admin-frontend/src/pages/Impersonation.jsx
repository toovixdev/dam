import { useState } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import { toast } from '../components/shared/Toast';
import useApiData from '../hooks/useApiData';
import { apiPost } from '../api/client';

const ST = { active: 'status-green', completed: 'status-gray', auto_revoked: 'sev-high', revoked: 'sev-high', pending_review: 'sev-high' };
const STL = { active: 'Active', completed: 'Completed', auto_revoked: 'Auto-revoked', revoked: 'Revoked', pending_review: 'Pending review' };
function fmtDt(d) { return d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(',', '') : '—'; }
function dur(s) {
  if (!s.endedAt) return `${s.durationMin} min cap`;
  const m = Math.round((new Date(s.endedAt) - new Date(s.startedAt)) / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}min` : `${m} min`;
}

export default function Impersonation() {
  const { data: tenants } = useApiData('/admin/tenants', { poll: 0 });
  const { data, loading, lastRefresh, refetch } = useApiData('/admin/sessions?type=impersonation', { poll: 15000 });
  const [form, setForm] = useState({ tenantId: '', justification: '', durationMin: '60', ticketRef: '' });
  const [busy, setBusy] = useState(false);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  async function request() {
    if (!form.tenantId) return toast('Please select a tenant', 'err');
    if (!form.justification.trim()) return toast('Justification is required', 'err');
    setBusy(true);
    const res = await apiPost('/admin/sessions', { type: 'impersonation', ...form });
    setBusy(false);
    if (res.ok) { toast('Impersonation session started — recorded in audit', 'ok'); setForm({ tenantId: '', justification: '', durationMin: '60', ticketRef: '' }); refetch(); }
    else toast(res.data?.error || 'Failed to start session', 'err');
  }
  async function end(id) {
    const res = await apiPost(`/admin/sessions/${id}/end`, {});
    if (res.ok) { toast('Session ended', 'ok'); refetch(); } else toast('Failed to end session', 'err');
  }

  if (loading && !data) return <div className="loading-screen"><div className="loading-spinner" /><p>Loading sessions…</p></div>;
  const active = data?.active || [];
  const history = data?.history || [];

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refetch}>
      <PageHeader title="Tenant Impersonation" meta={['restricted access', 'full session recording', 'auto-revoke']} />

      <div style={{ background: 'var(--danger-soft)', border: '1.5px solid var(--danger)', borderRadius: 14, padding: '14px 18px', marginBottom: 14, display: 'flex', gap: 12 }}>
        <span style={{ fontSize: 18 }}>⚠</span>
        <div><div style={{ fontWeight: 700, fontSize: 14, color: 'var(--danger)', marginBottom: 4 }}>Restricted Action — Impersonation Session</div>
          <div style={{ fontSize: 12.5, color: 'var(--danger)', opacity: 0.85, lineHeight: 1.55 }}>Impersonation grants full access to a tenant environment under your identity. All actions are recorded and hash-chained in the audit log. Sessions are time-limited and auto-revoke at expiry.</div></div>
      </div>

      <section className="charts-row" style={{ marginBottom: 14 }}>
        <div className="card">
          <div className="card-header"><span className="card-title">Request Impersonation Session</span></div>
          <div className="card-body">
            <div className="form-field"><label>Tenant *</label>
              <select value={form.tenantId} onChange={e => set('tenantId', e.target.value)}>
                <option value="">— Select tenant —</option>{(tenants || []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
            <div className="form-field"><label>Justification *</label>
              <textarea rows={3} value={form.justification} onChange={e => set('justification', e.target.value)} placeholder="Reason for impersonation (logged permanently)…" style={{ resize: 'vertical' }} /></div>
            <div className="form-row">
              <div className="form-field"><label>Duration</label>
                <select value={form.durationMin} onChange={e => set('durationMin', e.target.value)}><option value="30">30 minutes</option><option value="60">1 hour</option><option value="120">2 hours (max)</option></select></div>
              <div className="form-field"><label>Support ticket</label><input value={form.ticketRef} onChange={e => set('ticketRef', e.target.value)} placeholder="e.g. SUP-2026-4821" /></div>
            </div>
            <button className="btn-primary" onClick={request} disabled={busy}>{busy ? 'Starting…' : '▷ Request impersonation'}</button>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">Active Sessions</span><span className="card-sub">{active.length} active</span></div>
          <div className="card-body no-pad">
            <table className="data-table">
              <thead><tr><th>Operator</th><th>Tenant</th><th>Expires</th><th className="num">Actions</th><th></th></tr></thead>
              <tbody>
                {active.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No active sessions</td></tr>}
                {active.map(s => (
                  <tr key={s.id}>
                    <td><b>{s.operator}</b><br /><small className="muted">{s.operatorEmail}</small></td>
                    <td>{s.tenantName}</td><td><small className="muted">{fmtDt(s.expiresAt)}</small></td><td className="num">{s.actions}</td>
                    <td><button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => end(s.id)}>End</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Recent Impersonation Log</span><span className="card-sub">{history.length} sessions</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Operator</th><th>Tenant</th><th>Started</th><th>Duration</th><th className="num">Actions</th><th>Justification</th><th>Status</th></tr></thead>
            <tbody>
              {history.map(s => (
                <tr key={s.id}>
                  <td><b>{s.operator}</b></td><td>{s.tenantName}</td><td className="muted">{fmtDt(s.startedAt)}</td><td>{dur(s)}</td><td className="num">{s.actions}</td>
                  <td><small className="muted">{s.ticketRef ? `${s.ticketRef} · ` : ''}{s.justification}</small></td>
                  <td><span className={`badge ${ST[s.status] || 'status-gray'}`}>{STL[s.status] || s.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}
