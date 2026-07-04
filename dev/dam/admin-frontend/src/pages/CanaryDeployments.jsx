import { useState } from 'react';
import Layout from '../components/Layout';
import KpiCard from '../components/KpiCard';
import PageHeader from '../components/shared/PageHeader';
import Modal from '../components/shared/Modal';
import { toast } from '../components/shared/Toast';
import useApiData from '../hooks/useApiData';
import { apiPost } from '../api/client';

const PHASES = [5, 25, 50, 100];
const OUTCOME = {
  active: { cls: 'sev-medium', label: 'Active' },
  paused: { cls: 'status-gray', label: 'Paused' },
  success: { cls: 'status-green', label: 'Success' },
  rolled_back: { cls: 'sev-high', label: 'Rolled back' },
};
const TYPE_CLS = { platform: 'status-gray', agent: 'sev-medium', content: 'engine' };

function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'; }
function ago(iso) {
  if (!iso) return '';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / 1440)}d ago`;
}

export default function CanaryDeployments() {
  const { data, loading, lastRefresh, refetch } = useApiData('/admin/canary', { poll: 20000 });
  const { data: tenants } = useApiData('/admin/tenants', { poll: 0 });
  const [startOpen, setStartOpen] = useState(false);

  if (loading && !data) return <div className="loading-screen"><div className="loading-spinner" /><p>Loading rollouts…</p></div>;
  const a = data?.active;
  const history = data?.history || [];

  async function act(action) {
    const res = await apiPost(`/admin/canary/${a.id}/action`, { action });
    if (res.ok) { toast(`${a.version}: ${action}${action === 'promote' ? 'd to next phase' : action === 'rollback' ? ' initiated' : 'd'}`, action === 'rollback' ? 'err' : 'ok'); refetch(); }
    else toast(res.data?.error || 'Action failed', 'err');
  }

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refetch}>
      <PageHeader title="Canary Deployments" meta={['progressive rollout', 'automated rollback']}>
        <button className="btn-primary" onClick={() => setStartOpen(true)}>＋ Start new rollout</button>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="▷" iconBg="var(--primary-soft)" iconColor="var(--primary)" label="Active rollout"
          value={a ? a.version : '—'} detail={a ? a.type : 'none in progress'} />
        <KpiCard icon="⏱" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Phase"
          value={a ? `${a.status === 'active' ? 'Canary' : a.status} — ${a.phasePct}%` : '—'} detail={a ? `started ${ago(a.startedAt)}` : ''} />
        <KpiCard icon="●" iconBg="var(--green-soft)" iconColor="var(--green)" label="Error rate"
          value={<span style={{ color: a && a.errorRate > 0.1 ? 'var(--danger)' : 'var(--green)' }}>{a ? `${a.errorRate}%` : '—'}</span>}
          detail="threshold 0.1%" detailType={a && a.errorRate <= 0.1 ? 'up' : 'down'} />
        <KpiCard icon="↻" iconBg="var(--info-soft)" iconColor="var(--info)" label="Rollback ready"
          value={<span style={{ color: 'var(--green)' }}>Yes</span>} detail="auto-rollback enabled" />
      </section>

      {a && (
        <section className="charts-row" style={{ marginBottom: 14 }}>
          <div className="card">
            <div className="card-header"><span className="card-title">Current Rollout — {a.fromVersion} → {a.version}</span></div>
            <div className="card-body">
              {[['Deploying version', `${a.version} (${a.type})`], ['Current version', a.fromVersion || '—'], ['Started', `${fmtDate(a.startedAt)} · ${ago(a.startedAt)}`]].map(([kk, vv]) => (
                <div key={kk} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 10 }}><span className="muted">{kk}</span><b>{vv}</b></div>
              ))}
              <div style={{ fontSize: 12, fontWeight: 600, margin: '4px 0 8px', color: 'var(--muted)' }}>Rollout phases</div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 16 }}>
                {PHASES.map((p, i) => (
                  <div key={p} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{
                      flex: 1, padding: '8px 6px', borderRadius: 6, textAlign: 'center', fontSize: 12, fontWeight: 600,
                      background: i < a.phase ? 'var(--green)' : i === a.phase ? 'var(--primary)' : 'var(--surface-2)',
                      color: i <= a.phase ? '#fff' : 'var(--muted)', border: i > a.phase ? '1px solid var(--line)' : 'none',
                    }}>{i === 0 ? `Canary ${p}%` : `${p}%`}</div>
                    {i < PHASES.length - 1 && <span style={{ color: 'var(--muted)' }}>→</span>}
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {a.status === 'paused'
                  ? <button className="btn-primary" onClick={() => act('resume')}>Resume</button>
                  : <button className="btn-primary" onClick={() => act('promote')} disabled={a.phasePct >= 100}>Promote to {PHASES[Math.min(a.phase + 1, 3)]}%</button>}
                {a.status !== 'paused' && <button className="btn-secondary" onClick={() => act('pause')}>Pause</button>}
                <button className="btn-secondary" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => act('rollback')}>Rollback</button>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header"><span className="card-title">Canary Metrics</span></div>
            <div className="card-body">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
                <Metric label="Error rate (canary)" value={`${a.errorRate}%`} color={a.errorRate > 0.1 ? 'var(--danger)' : 'var(--green)'} />
                <Metric label="Error rate (baseline)" value="0.01%" color="var(--green)" />
                <Metric label="p99 latency (canary)" value="45 ms" color="var(--amber)" />
                <Metric label="p99 latency (baseline)" value="41 ms" color="var(--green)" />
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Affected tenants (canary pool)</div>
              {(tenants || []).slice(0, 4).map(t => (
                <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
                  <span>{t.name}</span><span className="badge status-green">healthy</span>
                </div>
              ))}
              {(!tenants || tenants.length === 0) && <span className="muted" style={{ fontSize: 12 }}>No tenants in canary pool</span>}
            </div>
          </div>
        </section>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Rollout History</span><span className="card-sub">last {history.length} rollouts</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Version</th><th>Type</th><th>Phases</th><th>Duration</th><th>Date</th><th>Outcome</th></tr></thead>
            <tbody>
              {history.map(r => {
                const o = OUTCOME[r.status] || { cls: 'status-gray', label: r.status };
                return (
                  <tr key={r.id}>
                    <td><b>{r.version}</b></td>
                    <td><span className={`badge ${TYPE_CLS[r.type] || 'status-gray'}`}>{r.type}</span></td>
                    <td>{r.phasesLabel}</td>
                    <td className="muted">{r.status === 'active' ? 'In progress' : r.duration || '—'}</td>
                    <td className="muted">{fmtDate(r.startedAt)}</td>
                    <td><span className={`badge ${o.cls}`}>{o.label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <StartRollout open={startOpen} onClose={() => setStartOpen(false)} onStarted={refetch} />
    </Layout>
  );
}

function Metric({ label, value, color }) {
  return <div><div style={{ fontSize: 11, color: 'var(--muted)' }}>{label}</div><div style={{ fontSize: 18, fontWeight: 700, color }}>{value}</div></div>;
}

function StartRollout({ open, onClose, onStarted }) {
  const [version, setVersion] = useState('');
  const [type, setType] = useState('platform');
  const [saving, setSaving] = useState(false);
  async function start() {
    if (!version.trim()) { toast('Version is required', 'err'); return; }
    setSaving(true);
    const res = await apiPost('/admin/canary', { version: version.trim(), type });
    setSaving(false);
    if (res.ok) { toast(`Rollout ${version} started at Canary 5%`, 'ok'); setVersion(''); onStarted(); onClose(); }
    else toast(res.data?.error || 'Failed to start rollout', 'err');
  }
  return (
    <Modal open={open} onClose={onClose} title="Start new rollout" width={480}>
      <div className="form-field"><label>Version *</label><input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="e.g. v2.4.3" autoFocus /></div>
      <div className="form-field"><label>Type</label>
        <select value={type} onChange={(e) => setType(e.target.value)}><option value="platform">Platform</option><option value="agent">Agent</option><option value="content">Content pack</option></select></div>
      <p className="muted" style={{ fontSize: 12 }}>Starts at the Canary 5% phase with auto-rollback enabled. Promote through 25 → 50 → 100%.</p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 12, borderTop: '1px solid var(--line)' }}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={start} disabled={saving}>{saving ? 'Starting…' : 'Start rollout'}</button>
      </div>
    </Modal>
  );
}
