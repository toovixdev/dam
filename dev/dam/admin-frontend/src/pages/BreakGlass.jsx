import { useState } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import { toast } from '../components/shared/Toast';
import useApiData from '../hooks/useApiData';
import { apiPost } from '../api/client';

const ST = { active: 'status-green', completed: 'status-gray', auto_revoked: 'sev-high', revoked: 'sev-high', pending_review: 'sev-high' };
const STL = { active: 'Active', completed: 'Reviewed', auto_revoked: 'Auto-revoked', revoked: 'Revoked', pending_review: 'Pending review' };
const APPROVERS = ['Sanjay Kumar (VP Engineering)', 'Claire Dupont (Head of Security)', 'Mike Reynolds (Director SRE)'];
const WORKFLOW = [
  ['Requested', 'var(--green)', 'Operator submits with justification + incident ref'],
  ['Manager Approval', 'var(--amber)', 'Designated manager approves/rejects within 15 min SLA'],
  ['Security Review', 'var(--info)', 'Automated scope check + least-privilege grant'],
  ['Active Session', 'var(--primary)', 'Full session recording, hash-chained'],
  ['Auto-Expired', 'var(--muted)', 'Terminates at limit · post-incident review within 48h'],
];
function fmtDt(d) { return d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(',', '') : '—'; }
function dur(s) {
  if (!s.endedAt) return `${s.durationMin} min cap`;
  const m = Math.round((new Date(s.endedAt) - new Date(s.startedAt)) / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}min` : `${m} min`;
}

export default function BreakGlass() {
  const { data: tenants } = useApiData('/admin/tenants', { poll: 0 });
  const { data, loading, lastRefresh, refetch } = useApiData('/admin/sessions?type=break_glass', { poll: 15000 });
  const [form, setForm] = useState({ tenantId: '', justification: '', scope: 'ro', durationMin: '60', approver: '', incidentRef: '' });
  const [busy, setBusy] = useState(false);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  async function request() {
    if (!form.tenantId) return toast('Please select a tenant', 'err');
    if (!form.justification.trim()) return toast('Justification is required', 'err');
    if (!form.approver) return toast('Please select an approver', 'err');
    if (!form.incidentRef.trim()) return toast('Incident reference is required', 'err');
    setBusy(true);
    const res = await apiPost('/admin/sessions', { type: 'break_glass', ...form });
    setBusy(false);
    if (res.ok) { toast('Break-glass session activated — recorded + escalated', 'ok'); setForm({ tenantId: '', justification: '', scope: 'ro', durationMin: '60', approver: '', incidentRef: '' }); refetch(); }
    else toast(res.data?.error || 'Failed to start session', 'err');
  }
  async function revoke(id) {
    const res = await apiPost(`/admin/sessions/${id}/end`, {});
    if (res.ok) { toast('Break-glass session terminated', 'ok'); refetch(); } else toast('Failed to revoke', 'err');
  }

  if (loading && !data) return <div className="loading-screen"><div className="loading-spinner" /><p>Loading break-glass…</p></div>;
  const active = data?.active || [];
  const history = data?.history || [];

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refetch}>
      <PageHeader title="Break-Glass Access" meta={['emergency production access', 'manager approval required']} />

      <div style={{ background: 'var(--danger-soft)', border: '1.5px solid var(--danger)', borderRadius: 14, padding: '14px 18px', marginBottom: 14, display: 'flex', gap: 12 }}>
        <span style={{ fontSize: 18 }}>⚠</span>
        <div><div style={{ fontWeight: 700, fontSize: 14, color: 'var(--danger)', marginBottom: 4 }}>Emergency Access Only — Break-Glass Protocol</div>
          <div style={{ fontSize: 12.5, color: 'var(--danger)', opacity: 0.85, lineHeight: 1.55 }}>Break-glass bypasses normal RBAC and grants elevated production access. Strictly for emergencies (P1 incidents, data recovery, security response). All sessions require manager approval, are time-limited, fully recorded, and subject to mandatory post-incident review.</div></div>
      </div>

      <section className="charts-row" style={{ marginBottom: 14 }}>
        <div className="card">
          <div className="card-header"><span className="card-title">Request Break-Glass Access</span></div>
          <div className="card-body">
            <div className="form-field"><label>Tenant *</label>
              <select value={form.tenantId} onChange={e => set('tenantId', e.target.value)}><option value="">— Select tenant —</option>{(tenants || []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
            <div className="form-field"><label>Justification *</label>
              <textarea rows={2} value={form.justification} onChange={e => set('justification', e.target.value)} placeholder="Describe the emergency (reference an active P1/P2 incident)…" style={{ resize: 'vertical' }} /></div>
            <div className="form-row">
              <div className="form-field"><label>Access scope</label><select value={form.scope} onChange={e => set('scope', e.target.value)}><option value="ro">Read-only</option><option value="rw">Read-write</option></select></div>
              <div className="form-field"><label>Duration</label><select value={form.durationMin} onChange={e => set('durationMin', e.target.value)}><option value="30">30 minutes</option><option value="60">1 hour</option><option value="120">2 hours (max)</option></select></div>
            </div>
            <div className="form-row">
              <div className="form-field"><label>Approver *</label><select value={form.approver} onChange={e => set('approver', e.target.value)}><option value="">— Select manager —</option>{APPROVERS.map(a => <option key={a} value={a}>{a}</option>)}</select></div>
              <div className="form-field"><label>Incident ref *</label><input value={form.incidentRef} onChange={e => set('incidentRef', e.target.value)} placeholder="e.g. INC-2026-0315" /></div>
            </div>
            <button className="btn-primary" style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={request} disabled={busy}>{busy ? 'Activating…' : '⚠ Request break-glass access'}</button>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">Approval Workflow</span></div>
          <div className="card-body">
            {WORKFLOW.map(([label, color, desc], i) => (
              <div key={label}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
                  <span style={{ width: 30, height: 30, borderRadius: '50%', background: color, color: color === 'var(--muted)' ? 'var(--ink)' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flex: 'none' }}>{i + 1}</span>
                  <div><div style={{ fontWeight: 700, fontSize: 13 }}>{label}</div><div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{desc}</div></div>
                </div>
                {i < WORKFLOW.length - 1 && <div style={{ width: 2, height: 12, background: 'var(--line)', marginLeft: 14 }} />}
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Active Break-Glass Sessions</span><span className="card-sub">{active.length} active</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Requester</th><th>Tenant</th><th>Scope</th><th>Approver</th><th>Expires</th><th className="num">Actions</th><th>Incident</th><th></th></tr></thead>
            <tbody>
              {active.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 20 }}>No active break-glass sessions</td></tr>}
              {active.map(s => (
                <tr key={s.id}>
                  <td><b>{s.operator}</b><br /><small className="muted">{s.operatorEmail}</small></td>
                  <td>{s.tenantName}</td><td><span className={`badge ${s.scope === 'rw' ? 'sev-critical' : 'sev-medium'}`}>{s.scope === 'rw' ? 'Read-write' : 'Read-only'}</span></td>
                  <td><small className="muted">{s.approver}</small></td><td><small className="muted">{fmtDt(s.expiresAt)}</small></td><td className="num">{s.actions}</td>
                  <td><small className="muted" style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{s.incidentRef}</small></td>
                  <td><button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 12, color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => revoke(s.id)}>Revoke</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Break-Glass History</span><span className="card-sub">{history.length} sessions</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Requester</th><th>Tenant</th><th>Scope</th><th>Duration</th><th className="num">Actions</th><th>Incident</th><th>Justification</th><th>Post-review</th></tr></thead>
            <tbody>
              {history.map(s => (
                <tr key={s.id}>
                  <td><b>{s.operator}</b></td><td>{s.tenantName}</td>
                  <td><span className={`badge ${s.scope === 'rw' ? 'sev-critical' : 'sev-medium'}`}>{s.scope === 'rw' ? 'Read-write' : 'Read-only'}</span></td>
                  <td>{dur(s)}</td><td className="num">{s.actions}</td>
                  <td><small className="muted" style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{s.incidentRef}</small></td>
                  <td><small className="muted">{s.justification}</small></td>
                  <td><span className={`badge ${s.reviewed ? 'status-green' : 'sev-high'}`}>{s.reviewed ? 'Reviewed' : 'Pending review'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}
