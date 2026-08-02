import { useState, useRef, useEffect } from 'react';
import Layout from '../components/Layout';
import KpiCard from '../components/KpiCard';
import PageHeader from '../components/shared/PageHeader';
import { toast } from '../components/shared/Toast';
import useApiData from '../hooks/useApiData';

function fmtBytes(b) {
  if (b == null) return '—';
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtNum(n) { return (n ?? 0).toLocaleString(); }
function StatusBadge({ status }) {
  return <span className={`badge ${status === 'warning' ? 'sev-high' : status === 'danger' ? 'sev-critical' : 'status-green'}`}>{status === 'warning' ? 'Warning' : status === 'danger' ? 'Critical' : 'Normal'}</span>;
}
function ShareBar({ pct }) {
  const c = pct >= 40 ? 'var(--danger)' : pct >= 25 ? 'var(--amber)' : 'var(--green)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
      <div style={{ width: 60, height: 6, borderRadius: 4, background: 'var(--surface-2)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: c }} />
      </div>
      <b style={{ minWidth: 34, textAlign: 'right', color: c }}>{pct}%</b>
    </div>
  );
}

export default function NoisyNeighbor() {
  const { data, loading, lastRefresh, refetch } = useApiData('/admin/infra/noisy', { poll: 20000 });
  const [detail, setDetail] = useState(null);
  const detailRef = useRef(null);
  const [autoThrottle, setAutoThrottle] = useState(false);

  useEffect(() => { if (detail && detailRef.current) detailRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [detail]);

  if (loading && !data) return <div className="loading-screen"><div className="loading-spinner" /><p>Measuring resource consumption…</p></div>;
  const k = data?.kpis || {};
  const node = data?.node || {};
  const tenants = data?.tenants || [];
  const warn = tenants.find(t => t.status !== 'normal'); // shared-plane over-consumer

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refetch}>
      <PageHeader title="Noisy Neighbor Detection" meta={['SaaS shared infrastructure', `${node.sharedTenants ?? 0} of ${tenants.length} tenants on the shared plane`]}>
        <span className="badge status-green">● live</span>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="▲" iconBg="var(--danger-soft)" iconColor="var(--danger)" label="Top consumer"
          value={<span style={{ fontSize: 15 }}>{k.topConsumer}</span>} detail={`${k.topShare ?? 0}% of fleet events · ${k.topRegion}`} detailType="down" />
        <KpiCard icon="▤" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="ClickHouse disk"
          value={<span style={{ color: k.clickhouseDiskPct > 80 ? 'var(--danger)' : 'var(--amber)' }}>{k.clickhouseDiskPct}%</span>} detail={`${node.dataPlanes ?? 0} data planes on node`} />
        <KpiCard icon="▦" iconBg="var(--info-soft)" iconColor="var(--info)" label="ClickHouse memory"
          value={<span>{fmtBytes((node.memMb ?? 0) * 1e6)}</span>} detail="MemoryTracking (node)" />
        <KpiCard icon="▷" iconBg={k.warnings ? 'var(--amber-soft)' : 'var(--green-soft)'} iconColor={k.warnings ? 'var(--amber)' : 'var(--green)'} label="Queries / hr"
          value={<span>{fmtNum(k.queriesHr)}</span>} detail={k.warnings ? `${k.warnings} tenant(s) flagged` : 'no noisy tenants'} detailType={k.warnings ? 'down' : 'up'} />
      </section>

      <div className="card" style={{ marginBottom: 14, borderLeft: '3px solid var(--info)' }}>
        <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 18, color: 'var(--info)' }}>ⓘ</span>
          <div><b style={{ color: 'var(--info)' }}>What's measured</b><br />
            <span>Every figure is real — event share, events/hr, all-time rows, dedicated-plane storage and ClickHouse query-log load, read live from each tenant's data plane.
              <b> Dedicated</b>-plane tenants are isolated in their own database; only <b>shared</b>-plane tenants contend for the same ClickHouse DB, so only they can be flagged noisy.</span></div>
        </div>
      </div>

      {warn && (
        <div className="card" style={{ marginBottom: 14, borderLeft: '3px solid var(--amber)' }}>
          <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 18, color: 'var(--amber)' }}>⚠</span>
            <div><b style={{ color: 'var(--amber)' }}>Capacity Warning</b><br />
              <span>{warn.name} is driving {warn.share}% of fleet events on the <b>shared</b> ClickHouse plane — consider migrating it to a dedicated data plane.</span></div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button className="btn-secondary" onClick={() => toast('Opening migration planner', 'ok')}>Plan migration</button>
              <button className="btn-secondary" onClick={() => toast('Alert acknowledged', 'ok')}>Acknowledge</button>
            </div>
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Resource Consumption by Tenant</span><span className="card-sub">sorted by fleet event share · live</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr>
              <th>Tenant</th><th>Plane</th><th>Region</th>
              <th className="num">Event share</th><th className="num">Events/hr</th><th className="num">EPS</th>
              <th className="num">Rows</th><th className="num">Storage</th><th className="num">Queries/hr</th>
              <th>Status</th><th></th>
            </tr></thead>
            <tbody>
              {tenants.length === 0 && <tr><td colSpan={11} className="muted" style={{ textAlign: 'center', padding: 18 }}>No tenants.</td></tr>}
              {tenants.map(t => (
                <tr key={t.tenantId} style={t.status !== 'normal' ? { background: 'var(--danger-soft)' } : {}}>
                  <td><b>{t.name}</b><br /><small className="muted">{t.slug}</small></td>
                  <td><span className={`badge ${t.plane === 'dedicated' ? 'status-green' : ''}`}>{t.plane}</span></td>
                  <td className="muted">{t.region}</td>
                  <td className="num"><ShareBar pct={t.share} /></td>
                  <td className="num">{fmtNum(t.eventsHr)}</td>
                  <td className="num">{t.eps}</td>
                  <td className="num">{fmtNum(t.totalRows)}</td>
                  <td className="num">{t.plane === 'dedicated' ? fmtBytes(t.storageBytes) : <span className="muted" title="Shared plane — bytes not split per tenant">shared</span>}</td>
                  <td className="num">{fmtNum(t.queriesHr)}{t.queriesShared ? <small className="muted" title="Plane-wide — the shared plane's queries can't be attributed per tenant"> ·shared</small> : ''}</td>
                  <td><StatusBadge status={t.status} /></td>
                  <td><button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setDetail(t)}>Detail</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {detail && (
        <div className="card" style={{ marginBottom: 14 }} ref={detailRef}>
          <div className="card-header">
            <span className="card-title">Tenant Detail — {detail.name}</span>
            <span className="card-sub">{detail.plane} plane · {detail.region} · {detail.dbs} databases</span>
            <button className="btn-secondary" style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: 12 }} onClick={() => setDetail(null)}>Close</button>
          </div>
          <div className="card-body">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px 24px', marginBottom: 14 }}>
              {[
                ['Event share', `${detail.share}%`], ['Events / hr', fmtNum(detail.eventsHr)], ['EPS (last min)', detail.eps],
                ['All-time rows', fmtNum(detail.totalRows)], ['Storage', detail.plane === 'dedicated' ? fmtBytes(detail.storageBytes) : 'shared plane'], ['Queries / hr', fmtNum(detail.queriesHr)],
              ].map(([kk, vv]) => (
                <div key={kk} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '5px 0', borderBottom: '1px solid var(--line-2)' }}>
                  <span className="muted">{kk}</span><b>{vv}</b>
                </div>
              ))}
            </div>
            <h3 style={{ fontSize: 13, fontWeight: 700, margin: '0 0 8px' }}>Recommended Actions</h3>
            {recsFor(detail).map((a, i) => (
              <div key={i} style={{ padding: '8px 12px', borderRadius: 8, background: a.bg, fontSize: 13, marginBottom: 6 }}>
                <b style={{ color: a.color }}>{a.title}</b><br /><small className="muted">{a.desc}</small>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Throttle Controls</span><span className="card-sub">per-tenant rate limiting · prototype (not yet enforced)</span></div>
        <div className="card-body">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>Auto-throttle when a shared-plane tenant exceeds 30% of fleet events</span>
            <button className={autoThrottle ? 'btn-primary' : 'btn-secondary'} style={{ minWidth: 80 }}
              onClick={() => { setAutoThrottle(!autoThrottle); toast(autoThrottle ? 'Auto-throttle disabled' : 'Auto-throttle enabled at 30% threshold', 'ok'); }}>
              {autoThrottle ? 'Disable' : 'Enable'}</button>
          </div>
          {tenants.filter(t => t.plane === 'shared').map(t => <ThrottleRow key={t.tenantId} t={t} />)}
          {tenants.filter(t => t.plane === 'shared').length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>No tenants on the shared plane — nothing to throttle.</span>}
        </div>
      </div>
    </Layout>
  );
}

function recsFor(t) {
  const a = [];
  if (t.plane === 'shared' && t.share >= 25) a.push({ color: 'var(--danger)', bg: 'var(--danger-soft)', title: 'Migrate to a dedicated data plane', desc: `Driving ${t.share}% of fleet events on the shared ClickHouse DB — a dedicated plane isolates its load.` });
  if (t.plane === 'dedicated' && t.storageBytes != null && t.storageBytes > 5e9) a.push({ color: 'var(--info)', bg: 'var(--info-soft)', title: 'Review retention / storage', desc: `Dedicated plane is using ${fmtBytes(t.storageBytes)} — check the 90-day TTL and partitioning.` });
  if (!a.length) a.push({ color: 'var(--green)', bg: 'var(--green-soft)', title: 'No action required', desc: t.plane === 'dedicated' ? 'Isolated on its own data plane — no shared contention.' : 'Consumption is within normal bounds on the shared plane.' });
  return a;
}

function ThrottleRow({ t }) {
  const [v, setV] = useState(Math.max(500, Math.round(t.eps * 60) * 60 || 2500));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}>
      <b style={{ minWidth: 180, fontSize: 13 }}>{t.name}</b>
      <span className="muted" style={{ fontSize: 12, minWidth: 110 }}>Current: {t.eps}/s</span>
      <input type="range" min={500} max={5000} step={100} value={v} onChange={(e) => setV(+e.target.value)} style={{ flex: 1 }} />
      <span style={{ fontSize: 12, fontWeight: 600, minWidth: 60 }}>{v}/s</span>
      <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => toast(`Rate limit ${v}/s applied to ${t.name}`, 'ok')}>Apply</button>
    </div>
  );
}
