import { useState, useEffect } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/KpiCard';
import useApiData from '../hooks/useApiData';
import { apiFetch } from '../api/client';
import { fmtTs } from '../hooks/useTimezone';

// Risk band → colour. Semantic (not the app accent): green safe, amber elevated, red high.
function riskColor(score) {
  if (score >= 70) return 'var(--danger, #c0392b)';
  if (score >= 40) return 'var(--amber, #d98a00)';
  return 'var(--green, #1f9d55)';
}
function RiskScore({ score }) {
  const c = riskColor(score);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 120 }}>
      <div style={{ flex: 1, height: 6, borderRadius: 4, background: 'var(--surface-2, #eee)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.max(3, score)}%`, background: c }} />
      </div>
      <b style={{ color: c, fontVariantNumeric: 'tabular-nums', width: 26, textAlign: 'right' }}>{score}</b>
    </div>
  );
}

// A behavioural signal chip. Only rendered when the count is non-zero, so a clean
// entity shows no chips and an anomalous one reads at a glance.
function Factor({ n, label, tone }) {
  if (!n) return null;
  const bg = { warn: 'rgba(217,138,0,.14)', bad: 'rgba(192,57,43,.14)', info: 'rgba(99,102,241,.14)' }[tone] || 'var(--surface-2)';
  const fg = { warn: 'var(--amber, #d98a00)', bad: 'var(--danger, #c0392b)', info: 'var(--primary, #6366f1)' }[tone] || 'var(--ink)';
  return <span style={{ background: bg, color: fg, borderRadius: 6, padding: '2px 7px', fontSize: 11.5, fontWeight: 600, whiteSpace: 'nowrap' }}>{n} {label}</span>;
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // ClickHouse toDayOfWeek: 1=Mon … 7=Sun

// Learned-activity heatmap: 7 days × 24 hours, cell intensity = typical query volume.
// This is the baseline an entity is scored against — off-cell activity is "unusual hours".
function Heatmap({ cells }) {
  const map = {}; let max = 0;
  (cells || []).forEach((c) => { const k = `${c.day_of_week}-${c.hour_of_day}`; map[k] = +c.q || 0; if (map[k] > max) max = map[k]; });
  if (!max) return <div className="muted" style={{ fontSize: 12.5, padding: '10px 0' }}>No learned baseline yet for this entity — it needs a few days of activity.</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'separate', borderSpacing: 2 }}>
        <thead>
          <tr><th></th>{Array.from({ length: 24 }, (_, h) => <th key={h} style={{ fontSize: 9, color: 'var(--muted)', fontWeight: 500, width: 14 }}>{h % 6 === 0 ? h : ''}</th>)}</tr>
        </thead>
        <tbody>
          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
            <tr key={d}>
              <td style={{ fontSize: 10.5, color: 'var(--muted)', paddingRight: 6, textAlign: 'right' }}>{DAYS[d - 1]}</td>
              {Array.from({ length: 24 }, (_, h) => {
                const v = map[`${d}-${h}`] || 0; const a = v ? 0.18 + 0.82 * (v / max) : 0;
                return <td key={h} title={v ? `${DAYS[d - 1]} ${h}:00 — ~${v} queries` : `${DAYS[d - 1]} ${h}:00 — no learned activity`}
                  style={{ width: 14, height: 14, borderRadius: 3, background: v ? `rgba(99,102,241,${a})` : 'var(--surface-2, #f0f0f4)' }} />;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EntityDetail({ principal, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    setD(null); setErr(null);
    apiFetch(`/behavior/entities/${encodeURIComponent(principal)}`).then((r) => { if (live) setD(r); }).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [principal]);

  const f = d?.factors || {};
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-header">
        <span className="card-title">Entity — <span className="mono">{principal}</span></span>
        {d && <span className="card-sub">risk {d.risk_score} · {Number(d.events_24h).toLocaleString()} events / 24h · last seen {d.last_activity ? fmtTs(d.last_activity) : '—'}</span>}
        <button className="btn-secondary" style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: 12 }} onClick={onClose}>Close</button>
      </div>
      <div className="card-body">
        {err && <div className="muted">Could not load entity: {err}</div>}
        {!d && !err && <div className="muted">Loading…</div>}
        {d && (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.1fr) minmax(0,1fr)', gap: 22 }}>
            <div>
              <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>What drives the score</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
                <Factor n={f.off_hours} label="off-normal-hours" tone="warn" />
                <Factor n={f.volume_spikes} label="volume spikes" tone="bad" />
                <Factor n={f.new_tables} label="first-time tables" tone="info" />
                <Factor n={f.sensitive_hits} label="sensitive reads" tone="warn" />
                <Factor n={f.alert_pressure} label="alert pressure" tone="bad" />
                {!f.off_hours && !f.volume_spikes && !f.new_tables && !f.sensitive_hits && !f.alert_pressure && <span className="muted" style={{ fontSize: 12.5 }}>No behavioural deviation — activity matches this entity's baseline.</span>}
              </div>
              <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>Learned activity baseline</div>
              <Heatmap cells={d.heatmap} />
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>Recent alerts</div>
              {(d.alerts || []).length === 0 ? <div className="muted" style={{ fontSize: 12.5, marginBottom: 14 }}>None in the recent window.</div> : (
                <table className="data-table" style={{ marginBottom: 16 }}>
                  <tbody>
                    {d.alerts.map((a) => (
                      <tr key={a.id}>
                        <td><span className={`badge sev-${a.severity}`}>{a.severity}</span></td>
                        <td>{a.summary}<br /><small className="muted">{a.object_name || ''}</small></td>
                        <td className="num">{fmtTs(a.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }}>Recent activity (24h)</div>
              {(d.recent || []).length === 0 ? <div className="muted" style={{ fontSize: 12.5 }}>No captured activity in the last 24h.</div> : (
                <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                  <table className="data-table">
                    <tbody>
                      {d.recent.map((e, i) => (
                        <tr key={i}>
                          <td className="mono" style={{ fontSize: 11.5 }}>{e.operation}</td>
                          <td>{e.schema_name ? `${e.schema_name}.${e.table_name}` : (e.table_name || e.database_name)}{e.tags ? <span className="muted"> · {e.tags}</span> : null}</td>
                          <td className="num">{Number(e.row_count || 0).toLocaleString()}</td>
                          <td className="num"><small className="muted">{fmtTs(e.ts)}</small></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Behavior() {
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [selected, setSelected] = useState(null);
  const { data: summary, refetch: rs } = useApiData('/behavior/summary', { poll: 60000 });
  const { data: entitiesData, refetch: re } = useApiData('/behavior/entities', { poll: 60000 });
  const entities = Array.isArray(entitiesData) ? entitiesData : [];
  const s = summary || {};

  const refresh = () => { rs(); re(); setLastRefresh(new Date()); };

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refresh}>
      <PageHeader title="Behavioral Analytics" meta={['UEBA', 'entity risk', `${entities.length} entities`]} />

      <section className="kpi-grid">
        <KpiCard icon="◉" iconBg="var(--primary-soft, #eef)" iconColor="var(--primary, #6366f1)" label="Entities tracked" value={s.entities ?? 0} detail="users & service accounts" />
        <KpiCard icon="▲" iconBg="rgba(192,57,43,.12)" iconColor="var(--danger, #c0392b)" label="High risk" value={s.high ?? 0} detail="score ≥ 70" detailType={s.high ? 'down' : ''} />
        <KpiCard icon="◔" iconBg="rgba(217,138,0,.14)" iconColor="var(--amber, #d98a00)" label="Elevated" value={s.elevated ?? 0} detail="score 40–69" />
        <KpiCard icon="≈" iconBg="var(--info-soft, #eef)" iconColor="var(--info, #3b82f6)" label="Anomalies (24h)" value={s.anomalies ?? 0} detail="off-hours · volume · first-access" />
        <KpiCard icon="◧" iconBg="var(--green-soft, #effaf1)" iconColor="var(--green, #1f9d55)" label="Baselines learned" value={s.baselines ?? 0} detail="hour × day activity slots" />
      </section>

      {selected && <EntityDetail principal={selected} onClose={() => setSelected(null)} />}

      <div className="card">
        <div className="card-header">
          <span className="card-title">Entity Risk Ranking</span>
          <span className="card-sub">each principal scored against its own learned baseline — click a row to drill in</span>
        </div>
        <div className="card-body no-pad">
          {entities.length === 0 ? (
            <div className="chart-empty" style={{ padding: 28 }}>No entity activity scored yet. Once agents capture a day or two of traffic, learned baselines drive the risk here.</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Entity</th>
                  <th style={{ width: 150 }}>Risk</th>
                  <th>Behavioral signals</th>
                  <th className="num">Events (24h)</th>
                  <th className="num">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {entities.map((e) => (
                  <tr key={e.principal} className={selected === e.principal ? 'row-selected' : ''} style={{ cursor: 'pointer' }} onClick={() => setSelected(e.principal === selected ? null : e.principal)}>
                    <td><b className="mono">{e.principal}</b></td>
                    <td><RiskScore score={e.risk_score} /></td>
                    <td>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        <Factor n={e.off_hours} label="off-hours" tone="warn" />
                        <Factor n={e.volume_spikes} label="volume" tone="bad" />
                        <Factor n={e.new_tables} label="new tables" tone="info" />
                        <Factor n={e.sensitive_hits} label="sensitive" tone="warn" />
                        {!e.off_hours && !e.volume_spikes && !e.new_tables && !e.sensitive_hits && <span className="muted" style={{ fontSize: 12 }}>within baseline</span>}
                      </div>
                    </td>
                    <td className="num">{Number(e.events_24h).toLocaleString()}</td>
                    <td className="num"><small className="muted">{e.last_activity ? fmtTs(e.last_activity) : '—'}</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>
  );
}
