import { useState } from 'react';
import Layout from '../components/Layout';
import KpiCard from '../components/KpiCard';
import PageHeader from '../components/shared/PageHeader';
import { toast } from '../components/shared/Toast';
import useApiData from '../hooks/useApiData';
import { apiPost } from '../api/client';

const SIGLABEL = { disk_pct: 'ClickHouse disk', agents_online_pct: 'Agents online', ingest_lag_s: 'Ingest lag', open_critical_24h: 'Open criticals (24h)', noisy_share: 'Top tenant share', canary_failed: 'Canary failed', breakglass_open: 'Break-glass active' };
const OPLABEL = { gte: '≥', gt: '>', lte: '≤', lt: '<', eq: '=' };
const SEV_COLOR = { critical: 'var(--danger)', high: 'var(--amber)', medium: 'var(--info)', info: 'var(--muted)' };
const STATUS_BADGE = { triggered: 'sev-critical', armed: 'status-gray', manual: 'status-gray', scheduled: 'status-blue' };
const STATUS_LABEL = { triggered: 'Triggered', armed: 'Armed', manual: 'Manual', scheduled: 'Scheduled' };
const RUN_BADGE = { success: 'status-green', aborted: 'sev-high', open: 'status-blue' };

function trigLabel(rb) {
  if (rb.triggerType === 'manual') return 'manual';
  if (rb.triggerType === 'scheduled') return `every ${rb.triggerConfig?.value || 90}d`;
  const c = rb.triggerConfig || {};
  const unit = c.signal === 'ingest_lag_s' ? 's' : (String(c.signal).endsWith('_pct') || c.signal === 'disk_pct' || c.signal === 'noisy_share') ? '%' : '';
  return `${SIGLABEL[c.signal] || c.signal} ${OPLABEL[c.op] || c.op} ${c.value}${unit}`;
}
function fmtDur(s) { if (s == null) return '—'; if (s < 60) return `${s}s`; if (s < 3600) return `${Math.round(s / 60)}m`; return `${(s / 3600).toFixed(1)}h`; }
function ago(iso) { if (!iso) return '—'; const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000); if (m < 1) return 'just now'; if (m < 60) return `${m}m ago`; if (m < 1440) return `${Math.floor(m / 60)}h ago`; return `${Math.floor(m / 1440)}d ago`; }
function Stripe({ sev }) { return <span style={{ display: 'inline-block', width: 3, height: 15, borderRadius: 2, verticalAlign: -3, marginRight: 8, background: SEV_COLOR[sev] || 'var(--muted)' }} />; }

export default function Runbooks() {
  const { data, loading, lastRefresh, refetch } = useApiData('/admin/runbooks', { poll: 20000 });
  const [cat, setCat] = useState('all');
  const [sel, setSel] = useState(null);      // selected runbook id
  const [activeRun, setActiveRun] = useState(null);
  const [busy, setBusy] = useState(false);

  if (loading && !data) return <div className="loading-screen"><div className="loading-spinner" /><p>Loading runbooks…</p></div>;
  const k = data?.kpis || {};
  const runbooks = data?.runbooks || [];
  const runs = data?.runs || [];
  const cats = data?.categories || [];
  const triggered = runbooks.filter(r => r.triggered);
  const selected = runbooks.find(r => r.id === sel) || null;
  const shown = cat === 'all' ? runbooks : runbooks.filter(r => r.category === cat);

  async function startRun(rb) {
    setBusy(true);
    const res = await apiPost(`/admin/runbooks/${rb.id}/run`, {});
    setBusy(false);
    if (res.ok) { setSel(rb.id); setActiveRun(res.data.run); toast(`Started “${rb.title}”`, 'ok'); refetch(); }
    else toast(res.data?.error || 'Failed to start', 'err');
  }
  async function toggleStep(i) {
    if (!activeRun) return;
    const checklist = activeRun.checklist.map(c => c.i === i ? { ...c, done: !c.done } : c);
    setActiveRun({ ...activeRun, checklist });
    const res = await apiPost(`/admin/runbooks/runs/${activeRun.id}`, { checklist });
    if (res.ok) setActiveRun(res.data.run.checklist ? { ...res.data.run, checklist } : { ...activeRun, checklist });
  }
  async function finish(status) {
    if (!activeRun) return;
    setBusy(true);
    const res = await apiPost(`/admin/runbooks/runs/${activeRun.id}`, { status, checklist: activeRun.checklist });
    setBusy(false);
    if (res.ok) { toast(`Run ${status}`, status === 'aborted' ? 'err' : 'ok'); setActiveRun(null); refetch(); }
    else toast(res.data?.error || 'Failed', 'err');
  }

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refetch}>
      <PageHeader title="Runbooks" meta={['operational playbooks', 'incident & maintenance', 'every run audited']}>
        <span className="badge status-green">● live</span>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="▷" iconBg="var(--primary-soft)" iconColor="var(--primary)" label="Runbooks" value={k.total ?? 0} detail={`${k.categories ?? 0} categories`} />
        <KpiCard icon="⚠" iconBg={k.triggered ? 'var(--amber-soft)' : 'var(--green-soft)'} iconColor={k.triggered ? 'var(--amber)' : 'var(--green)'} label="Triggered now"
          value={<span style={{ color: k.triggered ? 'var(--amber)' : 'var(--green)' }}>{k.triggered ?? 0}</span>} detail="matching live signals" detailType={k.triggered ? 'down' : 'up'} />
        <KpiCard icon="↻" iconBg="var(--info-soft)" iconColor="var(--info)" label="Runs · 30 days" value={k.runs30d ?? 0} detail={`${k.runsOk ?? 0} ok · ${k.runsAborted ?? 0} aborted · ${k.runsOpen ?? 0} open`} />
        <KpiCard icon="◉" iconBg="var(--green-soft)" iconColor="var(--green)" label="Auto-armed" value={k.armed ?? 0} detail="threshold / event triggers" />
      </section>

      {triggered.length > 0 && (
        <div className="card" style={{ marginBottom: 14, borderLeft: '3px solid var(--amber)' }}>
          <div className="card-header"><span className="card-title" style={{ color: 'var(--amber)' }}>⚠ Triggered by live conditions</span><span className="card-sub">evaluated against Infrastructure Health · Noisy Neighbor · Canary · Agent fleet</span></div>
          <div className="card-body no-pad">
            {triggered.map(rb => (
              <div key={rb.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderBottom: '1px solid var(--line-2)', fontSize: 13 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: rb.severity === 'critical' ? 'var(--danger)' : 'var(--amber)', flex: 'none' }} />
                <b>{rb.title}</b>
                <span className="badge" style={{ color: SEV_COLOR[rb.severity], borderColor: SEV_COLOR[rb.severity] }}>{trigLabel(rb)}</span>
                <button className="btn-primary" style={{ marginLeft: 'auto', padding: '4px 12px', fontSize: 12 }} onClick={() => { setSel(rb.id); startRun(rb); }} disabled={busy}>Start run</button>
                <button className="btn-secondary" style={{ padding: '4px 12px', fontSize: 12 }} onClick={() => setSel(rb.id)}>View</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        <button className={cat === 'all' ? 'btn-primary' : 'btn-secondary'} style={{ padding: '5px 12px', fontSize: 12 }} onClick={() => setCat('all')}>All · {runbooks.length}</button>
        {cats.map(c => <button key={c} className={cat === c ? 'btn-primary' : 'btn-secondary'} style={{ padding: '5px 12px', fontSize: 12 }} onClick={() => setCat(c)}>{c} · {runbooks.filter(r => r.category === c).length}</button>)}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 400px' : '1fr', gap: 16, alignItems: 'start' }}>
        <div className="card" style={{ margin: 0 }}>
          <div className="card-header"><span className="card-title">Runbook Library</span><span className="card-sub">{shown.length} shown · click to open</span></div>
          <div className="card-body no-pad">
            <table className="data-table">
              <thead><tr><th>Runbook</th><th>Category</th><th>Trigger</th><th className="num">Steps</th><th>Status</th></tr></thead>
              <tbody>
                {shown.map(rb => (
                  <tr key={rb.id} style={{ cursor: 'pointer', background: sel === rb.id ? 'var(--surface-2)' : undefined }} onClick={() => setSel(rb.id)}>
                    <td><Stripe sev={rb.severity} /><b>{rb.title}</b><br /><small className="muted mono" style={{ marginLeft: 11 }}>{rb.key}</small></td>
                    <td><span className="badge engine">{rb.category}</span></td>
                    <td className="muted" style={{ fontSize: 12 }}>{trigLabel(rb)}</td>
                    <td className="num">{rb.stepCount}</td>
                    <td><span className={`badge ${STATUS_BADGE[rb.status] || 'status-gray'}`}>{STATUS_LABEL[rb.status] || rb.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {selected && (
          <div className="card" style={{ margin: 0, position: 'sticky', top: 16 }}>
            <div className="card-header" style={{ display: 'block' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Stripe sev={selected.severity} /><span className="card-title">{selected.title}</span>
                <button className="btn-secondary" style={{ marginLeft: 'auto', padding: '2px 8px', fontSize: 12 }} onClick={() => { setSel(null); }}>✕</button>
              </div>
            </div>
            <div className="card-body" style={{ fontSize: 12.5 }}>
              {[['Category', selected.category], ['Severity', selected.severity], ['Trigger', trigLabel(selected)], ['Owner', selected.owner], ['Status', STATUS_LABEL[selected.status]]].map(([kk, vv]) => (
                <div key={kk} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}><span className="muted">{kk}</span><b>{vv}</b></div>
              ))}
              <p className="muted" style={{ margin: '10px 0 0', lineHeight: 1.5 }}>{selected.description}</p>
            </div>

            <div style={{ borderTop: '1px solid var(--line-2)' }}>
              {(activeRun && activeRun.runbook_id === selected.id ? activeRun.checklist.map(c => ({ text: c.text, done: c.done, i: c.i })) : selected.steps.map((s, i) => ({ text: s.text, link: s.link, tag: s.tag, done: false, i }))).map((st, idx) => {
                const step = selected.steps[st.i] || {};
                const running = activeRun && activeRun.runbook_id === selected.id;
                return (
                  <div key={idx} style={{ display: 'flex', gap: 11, padding: '10px 16px', borderBottom: '1px solid var(--line-2)', fontSize: 12.5, alignItems: 'flex-start' }}>
                    <span onClick={() => running && toggleStep(st.i)} style={{ width: 19, height: 19, borderRadius: 6, border: '1.5px solid var(--line)', flex: 'none', marginTop: 1, display: 'grid', placeItems: 'center', fontSize: 12, cursor: running ? 'pointer' : 'default', background: st.done ? 'var(--green)' : 'transparent', borderColor: st.done ? 'var(--green)' : 'var(--line)', color: st.done ? '#07130c' : 'transparent' }}>✓</span>
                    <span style={{ flex: 1, color: st.done ? 'var(--muted)' : 'var(--text)', textDecoration: st.done ? 'line-through' : 'none' }}>
                      {st.text}{step.tag && <small className="mono muted" style={{ marginLeft: 6 }}>{step.tag}</small>}
                      {step.link && <a href={step.link} style={{ display: 'block', marginTop: 3, fontSize: 11, color: 'var(--info)', fontWeight: 600 }}>Open →</a>}
                    </span>
                  </div>
                );
              })}
            </div>

            {selected.related?.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '12px 16px', borderBottom: '1px solid var(--line-2)' }}>
                {selected.related.map(r => <span key={r} className="badge status-blue">{r}</span>)}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, padding: '13px 16px', background: 'var(--surface-2)' }}>
              {activeRun && activeRun.runbook_id === selected.id ? (
                <>
                  <button className="btn-primary" style={{ flex: 1 }} disabled={busy} onClick={() => finish('success')}>✓ Complete run</button>
                  <button className="btn-secondary" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} disabled={busy} onClick={() => finish('aborted')}>Abort</button>
                </>
              ) : (
                <button className="btn-primary" style={{ flex: 1 }} disabled={busy} onClick={() => startRun(selected)}>▶ Start run</button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header"><span className="card-title">Execution History</span><span className="card-sub">every run is written to the platform audit trail</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Runbook</th><th>Operator</th><th>Started</th><th className="num">Duration</th><th className="num">Steps</th><th>Outcome</th></tr></thead>
            <tbody>
              {runs.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 18 }}>No runs yet.</td></tr>}
              {runs.map(r => (
                <tr key={r.id}>
                  <td><b>{r.runbook_title}</b></td>
                  <td className="muted">{r.operator}</td>
                  <td className="muted">{ago(r.started_at)}</td>
                  <td className="num">{fmtDur(r.duration_s)}</td>
                  <td className="num">{r.steps_done}/{r.steps_total}</td>
                  <td><span className={`badge ${RUN_BADGE[r.status] || 'status-gray'}`}>{r.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}
