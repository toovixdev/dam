import { useState, useEffect, useRef } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/KpiCard';
import Modal from '../components/shared/Modal';
import useApiData from '../hooks/useApiData';
import useLiveEvents from '../hooks/useLiveEvents';
import { apiPost, apiDelete } from '../api/client';
import { toast } from '../components/shared/Toast';

const THREAT_COLOR = { Critical: 'var(--danger)', Elevated: 'var(--amber)', Guarded: 'var(--green)' };

// Icon + colour for a real stream event, from its kind + severity.
function streamStyle(ev) {
  if (ev.kind === 'quarantine') return { ic: '⛔', color: 'var(--danger)' };
  if (/blocked by policy/i.test(ev.title || '')) return { ic: '⚷', color: 'var(--amber)' };
  const c = { critical: 'var(--danger)', high: 'var(--amber)', medium: 'var(--info)', low: 'var(--green)' }[ev.severity] || 'var(--info)';
  return { ic: ev.severity === 'critical' ? '⚠' : ev.severity === 'high' ? '▲' : '◷', color: c };
}
const fmtTime = (ts) => ts ? new Date(ts).toLocaleTimeString('en-GB', { hour12: false }) : '';
const riskColor = (r) => r >= 80 ? 'var(--danger)' : r >= 50 ? 'var(--amber)' : 'var(--green)';
const levelColor = (l) => l === 'High' ? 'var(--danger)' : l === 'Med' ? 'var(--amber)' : 'var(--green)';

function DeployDecoyModal({ open, onClose, onDeployed }) {
  const [schema, setSchema] = useState('payments');
  const [table, setTable] = useState('card_vault_bak');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setSchema('payments'); setTable('card_vault_bak'); setNote(''); } }, [open]);
  const deploy = async () => {
    if (!table.trim()) return toast('Table name required', 'err');
    setBusy(true);
    const res = await apiPost('/deception', { schema: schema.trim(), table: table.trim(), note: note.trim() || undefined });
    setBusy(false);
    if (res?.ok) { toast(res.data?.table_created ? 'Decoy deployed — honeypot table live' : 'Decoy armed (name-only) — probes still detected', 'ok'); onDeployed(); }
    else toast(res?.data?.error || 'Failed', 'err');
  };
  return (
    <Modal open={open} onClose={onClose} title="Deploy a decoy (honeypot)" width={460}>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 14px' }}>
        A decoy is a table no legitimate app should ever touch. TooVix arms it and raises a <b>critical alert</b> the
        moment any principal queries it — the query is caught inline even if the table doesn’t exist.
      </p>
      <div className="form-row">
        <div className="form-field"><label>Schema</label><input value={schema} onChange={(e) => setSchema(e.target.value)} /></div>
        <div className="form-field"><label>Decoy table name</label><input value={table} onChange={(e) => setTable(e.target.value)} placeholder="e.g. card_vault_bak" /></div>
      </div>
      <div className="form-field"><label>Note (optional)</label><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="why / where" /></div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 12, borderTop: '1px solid var(--line)' }}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy} onClick={deploy}>{busy ? 'Deploying…' : 'Deploy decoy'}</button>
      </div>
    </Modal>
  );
}

export default function ActiveDefense() {
  const [paused, setPaused] = useState(false);
  // WebSocket drives the live feel; the slow poll is just a fallback + keeps KPIs/timeline fresh.
  const { data, refetch } = useApiData('/active-defense', { poll: 20000 });
  const { data: dec, refetch: refetchDec } = useApiData('/deception', { poll: 8000 });
  const [deployOpen, setDeployOpen] = useState(false);
  const [feed, setFeed] = useState([]);
  const refetchTimer = useRef(null);

  // Mirror the authoritative server stream whenever it (re)loads, unless paused.
  useEffect(() => { if (!paused && data?.stream) setFeed(data.stream); }, [data, paused]);

  // Live push: every new alert (agent block OR detection) and quarantine event arrives over the
  // WebSocket. Prepend alert events instantly, and debounce a refetch to refresh KPIs/timeline.
  useLiveEvents(['alert', 'quarantine'], (msg) => {
    if (paused) return;
    if (msg.type === 'alert' && msg.alert && msg.alert.summary) {
      setFeed((prev) => [{ kind: 'alert', severity: msg.alert.severity, principal: msg.alert.principal, title: msg.alert.summary, ts: new Date().toISOString() }, ...prev].slice(0, 14));
    }
    if (!refetchTimer.current) refetchTimer.current = setTimeout(() => { refetchTimer.current = null; refetch(); }, 4000);
  });
  useEffect(() => () => { if (refetchTimer.current) clearTimeout(refetchTimer.current); }, []);

  const threatLevel = data?.threatLevel ?? '—';
  const timeline = data?.timeline || [];
  const maxN = Math.max(1, ...timeline.map((t) => t.n));

  return (
    <Layout>
      <PageHeader title="Active Defense" meta={[<span key="l" className="live-dot"><span className="bl" /> LIVE</span>, 'real-time threat surface']}>
        <button className="btn-secondary" onClick={() => { setPaused((p) => !p); if (paused) refetch(); toast(paused ? 'Feed resumed' : 'Feed paused'); }}>{paused ? '▶ Resume feed' : '⏸ Pause feed'}</button>
        <a className="btn-primary" href="/alerts">⚠ Open alerts</a>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="◎" iconBg="var(--danger-soft)" iconColor={THREAT_COLOR[threatLevel] || 'var(--danger)'} label="Threat level" value={threatLevel} detail={data?.threatDetail || '—'} detailType={threatLevel === 'Guarded' ? 'up' : 'down'} />
        <KpiCard icon="⚷" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Blocked / hr" value={data?.blockedHr ?? 0} detail="inline proxy blocks" />
        <KpiCard icon="⛔" label="Accounts held" value={data?.held ?? 0} detail="quarantined now" />
        <KpiCard icon="⚠" iconBg="var(--info-soft)" iconColor="var(--info)" label="Critical (24h)" value={data?.crit24h ?? 0} detail="critical alerts" detailType={data?.crit24h ? 'down' : 'up'} />
      </section>

      <div className="charts-row" style={{ gridTemplateColumns: '1.3fr 1fr' }}>
        <div className="card">
          <div className="card-header"><span className="card-title">Live threat stream</span><span className="live-dot"><span className="bl" /> {paused ? 'paused' : 'streaming'}</span></div>
          <div className="card-body">
            <div className="feed">
              {feed.length === 0 && <div className="muted" style={{ fontSize: 12.5, padding: 10 }}>No recent threat activity.</div>}
              {feed.map((f, i) => {
                const st = streamStyle(f);
                return (
                  <div className="feed-evt" key={`${f.ts}-${i}`}>
                    <span style={{ color: st.color, fontSize: 15 }}>{st.ic}</span>
                    <div className="fe-body"><b>{f.title}</b><small>{f.principal || '—'}{f.kind === 'quarantine' ? ' · account held' : ''}</small></div>
                    <span className="fe-time">{fmtTime(f.ts)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">Threat volume · 24h</span><span className="card-sub">alerts per 3h</span></div>
          <div className="card-body">
            <div className="barchart">
              {timeline.map((t, i) => (
                <div className="barchart-row" key={i}>
                  <span className="barchart-label">{t.label}</span>
                  <span className="barchart-track"><span className="barchart-fill" style={{ width: `${Math.round((t.n / maxN) * 100)}%`, background: t.n >= maxN * 0.6 && maxN > 1 ? 'var(--danger)' : 'var(--primary)' }} /></span>
                  <span className="barchart-val">{t.n}</span>
                </div>
              ))}
              {timeline.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>No alerts in the last 24h.</div>}
            </div>
            <p className="muted" style={{ fontSize: 11.5, margin: '8px 0 0' }}>Real alert volume (inline blocks + detections) bucketed over the last 24 hours.</p>
          </div>
        </div>
      </div>

      <div className="charts-row three">
        <div className="card">
          <div className="card-header"><span className="card-title">Egress · rows read per DB</span><span className="card-sub">last 24h</span></div>
          <div className="card-body">
            {(data?.egress || []).map((e) => (
              <div key={e.db} style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0' }}>
                <span style={{ width: 120, fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.db}</span>
                <span className="prog-track"><span className="prog-fill" style={{ width: `${e.pct}%`, background: levelColor(e.level) }} /></span>
                <span style={{ width: 64, textAlign: 'right', fontSize: 11.5, fontWeight: 700, color: levelColor(e.level) }}>{Number(e.rows).toLocaleString()}</span>
              </div>
            ))}
            {(!data?.egress || data.egress.length === 0) && <div className="muted" style={{ fontSize: 12.5 }}>No read activity captured in the last 24h.</div>}
            <p className="muted" style={{ fontSize: 11.5, margin: '6px 0 0' }}>Actual rows read through the proxy per database — high relative volume can indicate exfiltration.</p>
          </div>
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">Deception console</span><span className="card-sub">{dec?.summary?.hit ? `${dec.summary.hit} hit · ` : ''}{dec?.summary?.armed ?? 0} armed</span></div>
          <div className="card-body">
            {(dec?.decoys || []).map((d) => (
              <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line-2)', fontSize: 12.5 }}>
                <span className={`badge ${d.state === 'hit' ? 'red' : ''}`}>{d.state}</span>
                <b className="mono">{d.schema_name}.{d.table_name}</b>
                <span className="muted" style={{ marginLeft: 'auto', textAlign: 'right' }}>
                  {d.state === 'hit'
                    ? <span style={{ color: 'var(--danger)' }}>probed by {d.hit_principal} · {d.hit_at ? new Date(d.hit_at).toLocaleTimeString('en-GB', { hour12: false }) : ''}</span>
                    : <>{d.table_created ? 'table live' : 'name-only'} · no hits</>}
                  <button className="btn-secondary" style={{ padding: '1px 7px', fontSize: 11, marginLeft: 8, borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={async () => { const r = await apiDelete(`/deception/${d.id}`); if (r?.ok) { toast('Decoy removed', 'ok'); refetchDec(); } }}>✕</button>
                </span>
              </div>
            ))}
            {(!dec?.decoys || dec.decoys.length === 0) && <div className="muted" style={{ fontSize: 12.5, padding: 6 }}>No decoys deployed. A decoy is a honeypot table no real app touches — any access is a probe.</div>}
            <button className="btn-secondary" style={{ width: '100%', justifyContent: 'center', marginTop: 10 }} onClick={() => setDeployOpen(true)}>＋ Deploy decoy</button>
          </div>
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">Behavioral topology</span><span className="card-sub">riskiest principal → DB edges · 24h</span></div>
          <div className="card-body">
            {(data?.topology || []).map((t, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--line-2)', fontSize: 12.5 }}>
                <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 }}>{t.principal}</span>
                <span style={{ color: 'var(--muted)' }}>─▶</span>
                <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 90 }}>{t.db}</span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="muted" style={{ fontSize: 11.5 }}>{Number(t.rows).toLocaleString()}</span>
                  <span style={{ background: riskColor(t.risk), color: '#fff', fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 10 }}>risk {t.risk}</span>
                </span>
              </div>
            ))}
            {(!data?.topology || data.topology.length === 0) && <div className="muted" style={{ fontSize: 12.5 }}>No principal activity captured in the last 24h.</div>}
            <p className="muted" style={{ fontSize: 12, margin: '10px 0 0' }}>Top principal→database access edges by anomaly risk, from captured events.</p>
          </div>
        </div>
      </div>
      <DeployDecoyModal open={deployOpen} onClose={() => setDeployOpen(false)} onDeployed={() => { setDeployOpen(false); refetchDec(); }} />
    </Layout>
  );
}
