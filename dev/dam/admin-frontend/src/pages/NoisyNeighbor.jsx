import { useState, useRef, useEffect } from 'react';
import Layout from '../components/Layout';
import KpiCard from '../components/KpiCard';
import PageHeader from '../components/shared/PageHeader';
import { toast } from '../components/shared/Toast';
import useApiData from '../hooks/useApiData';

const LAYERS = [['all', 'All Layers'], ['clickhouse', 'ClickHouse'], ['eventhub', 'Event Hub'], ['k8s', 'Kubernetes']];

function clr(v, warn, danger) { return v >= danger ? { color: 'var(--danger)' } : v >= warn ? { color: 'var(--amber)' } : {}; }
function StatusBadge({ status }) {
  return <span className={`badge ${status === 'warning' ? 'sev-high' : status === 'danger' ? 'sev-critical' : 'status-green'}`}>{status === 'warning' ? 'Warning' : status === 'danger' ? 'Critical' : 'Normal'}</span>;
}

export default function NoisyNeighbor() {
  const { data, loading, lastRefresh, refetch } = useApiData('/admin/infra/noisy', { poll: 20000 });
  const [layer, setLayer] = useState('all');
  const [detail, setDetail] = useState(null);
  const detailRef = useRef(null);
  const [autoThrottle, setAutoThrottle] = useState(false);

  useEffect(() => { if (detail && detailRef.current) detailRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [detail]);

  if (loading && !data) return <div className="loading-screen"><div className="loading-spinner" /><p>Loading resource consumption…</p></div>;
  const k = data?.kpis || {};
  const tenants = data?.tenants || [];
  const warn = tenants.find(t => t.status === 'warning');

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refetch}>
      <PageHeader title="Noisy Neighbor Detection" meta={['SaaS shared infrastructure', `${tenants.length} tenants on shared clusters`]}>
        <span className="badge status-green">● live</span>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="▲" iconBg="var(--danger-soft)" iconColor="var(--danger)" label="Top consumer"
          value={<span style={{ fontSize: 15 }}>{k.topConsumer}</span>} detail={k.topRegion} detailType="down" />
        <KpiCard icon="▤" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="ClickHouse"
          value={<span style={{ color: k.clickhouseDiskPct > 80 ? 'var(--danger)' : 'var(--amber)' }}>{k.clickhouseDiskPct}%</span>} detail="shared cluster disk" />
        <KpiCard icon="▷" iconBg="var(--green-soft)" iconColor="var(--green)" label="Event Bus"
          value={<span style={{ color: 'var(--green)' }}>{k.eventBusPct}%</span>} detail="0 partitions saturated" detailType="up" />
        <KpiCard icon="●" iconBg="var(--green-soft)" iconColor="var(--green)" label="Throttled"
          value={<span style={{ color: 'var(--green)' }}>{k.throttled}</span>} detail="no active throttles" detailType="up" />
      </section>

      <div className="card" style={{ marginBottom: 14, borderLeft: '3px solid var(--info)' }}>
        <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 18, color: 'var(--info)' }}>ⓘ</span>
          <div><b style={{ color: 'var(--info)' }}>Shared infrastructure view</b><br />
            <span>Per-tenant ClickHouse usage is derived from real event share on the shared dev cluster. Event-Hub and Kubernetes figures are estimates scaled from that share.</span></div>
        </div>
      </div>

      {warn && (
        <div className="card" style={{ marginBottom: 14, borderLeft: '3px solid var(--amber)' }}>
          <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 18, color: 'var(--amber)' }}>⚠</span>
            <div><b style={{ color: 'var(--amber)' }}>Capacity Warning</b><br />
              <span>{warn.name} is consuming {warn.clickhouse.cpu}% CPU and {warn.clickhouse.disk}% disk on the shared ClickHouse cluster — consider a dedicated cluster.</span></div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button className="btn-secondary" onClick={() => toast('Opening migration planner', 'ok')}>Plan migration</button>
              <button className="btn-secondary" onClick={() => toast('Alert acknowledged', 'ok')}>Acknowledge</button>
            </div>
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header" style={{ gap: 14 }}>
          <span className="card-title">Resource Consumption by Tenant</span>
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            {LAYERS.map(([id, label]) => (
              <button key={id} className={layer === id ? 'btn-primary' : 'btn-secondary'} style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setLayer(id)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><LayerHead layer={layer} /></thead>
            <tbody>
              {tenants.map(t => <LayerRow key={t.tenantId} t={t} layer={layer} onDetail={() => setDetail(t)} />)}
            </tbody>
          </table>
        </div>
      </div>

      {detail && (
        <div className="card" style={{ marginBottom: 14 }} ref={detailRef}>
          <div className="card-header">
            <span className="card-title">Tenant Detail — {detail.name}</span>
            <span className="card-sub">{detail.region} · {detail.dbs} databases</span>
            <button className="btn-secondary" style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: 12 }} onClick={() => setDetail(null)}>Close</button>
          </div>
          <div className="card-body">
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
        <div className="card-header"><span className="card-title">Throttle Controls</span><span className="card-sub">per-tenant rate limiting · prototype</span></div>
        <div className="card-body">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>Auto-throttle when a tenant exceeds 30% of shared capacity</span>
            <button className={autoThrottle ? 'btn-primary' : 'btn-secondary'} style={{ minWidth: 80 }}
              onClick={() => { setAutoThrottle(!autoThrottle); toast(autoThrottle ? 'Auto-throttle disabled' : 'Auto-throttle enabled at 30% threshold', 'ok'); }}>
              {autoThrottle ? 'Disable' : 'Enable'}</button>
          </div>
          {tenants.map(t => <ThrottleRow key={t.tenantId} t={t} />)}
        </div>
      </div>
    </Layout>
  );
}

function LayerHead({ layer }) {
  if (layer === 'clickhouse') return <tr><th>Tenant</th><th>Region</th><th className="num">CPU %</th><th className="num">Mem %</th><th className="num">Disk I/O %</th><th className="num">Disk %</th><th className="num">Queries/h</th><th className="num">Slow Q</th><th>Status</th><th></th></tr>;
  if (layer === 'eventhub') return <tr><th>Tenant</th><th>Region</th><th className="num">Throughput %</th><th className="num">Partitions</th><th className="num">Lag</th><th className="num">Backlog</th><th>Status</th><th></th></tr>;
  if (layer === 'k8s') return <tr><th>Tenant</th><th>Region</th><th className="num">CPU %</th><th className="num">Mem %</th><th className="num">Pods</th><th className="num">Restarts</th><th className="num">Evictions</th><th>Status</th><th></th></tr>;
  return <tr><th>Tenant</th><th className="num">CH CPU</th><th className="num">CH I/O</th><th className="num">CH Disk</th><th className="num">EH TPU</th><th className="num">EH Lag</th><th className="num">K8s CPU</th><th>Status</th><th></th></tr>;
}

function LayerRow({ t, layer, onDetail }) {
  const bg = t.status === 'warning' ? { background: 'var(--danger-soft)' } : {};
  const name = <td><b>{t.name}</b><br /><small className="muted">{t.slug} · {t.region}</small></td>;
  const detailBtn = <td><button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={onDetail}>Detail</button></td>;
  const c = t.clickhouse, e = t.eventhub, kk = t.k8s;
  if (layer === 'clickhouse') return <tr style={bg}>{name}<td className="muted">{t.region}</td><td className="num"><b style={clr(c.cpu, 25, 30)}>{c.cpu}%</b></td><td className="num"><b style={clr(c.mem, 25, 30)}>{c.mem}%</b></td><td className="num"><b style={clr(c.diskIO, 25, 30)}>{c.diskIO}%</b></td><td className="num"><b style={clr(c.disk, 70, 85)}>{c.disk}%</b></td><td className="num">{c.queriesHr}</td><td className="num">{c.slowQ || 0}</td><td><StatusBadge status={t.status} /></td>{detailBtn}</tr>;
  if (layer === 'eventhub') return <tr style={bg}>{name}<td className="muted">{t.region}</td><td className="num"><b style={clr(e.tpu, 60, 80)}>{e.tpu}%</b></td><td className="num">{e.partitions}</td><td className="num">{e.lag}</td><td className="num">{e.backlog}</td><td><StatusBadge status={t.status} /></td>{detailBtn}</tr>;
  if (layer === 'k8s') return <tr style={bg}>{name}<td className="muted">{t.region}</td><td className="num"><b style={clr(kk.cpu, 20, 30)}>{kk.cpu}%</b></td><td className="num"><b style={clr(kk.mem, 20, 30)}>{kk.mem}%</b></td><td className="num">{kk.pods}</td><td className="num">{kk.restarts}</td><td className="num">{kk.evictions}</td><td><StatusBadge status={t.status} /></td>{detailBtn}</tr>;
  return <tr style={bg}>{name}<td className="num"><b style={clr(c.cpu, 25, 30)}>{c.cpu}%</b></td><td className="num"><b style={clr(c.diskIO, 25, 30)}>{c.diskIO}%</b></td><td className="num"><b style={clr(c.disk, 70, 85)}>{c.disk}%</b></td><td className="num"><b style={clr(e.tpu, 60, 80)}>{e.tpu}%</b></td><td className="num">{e.lag}</td><td className="num"><b style={clr(kk.cpu, 20, 30)}>{kk.cpu}%</b></td><td><StatusBadge status={t.status} /></td>{detailBtn}</tr>;
}

function recsFor(t) {
  const a = [];
  if (t.clickhouse.cpu >= 30 || t.clickhouse.disk >= 85) a.push({ color: 'var(--danger)', bg: 'var(--danger-soft)', title: 'Migrate ClickHouse to dedicated cluster', desc: `Consuming ${t.clickhouse.cpu}% CPU and ${t.clickhouse.disk}% disk on the shared cluster.` });
  if (t.clickhouse.slowQ > 5) a.push({ color: 'var(--info)', bg: 'var(--info-soft)', title: 'Optimize slow queries', desc: `${t.clickhouse.slowQ} slow queries in the last hour.` });
  if (!a.length) a.push({ color: 'var(--green)', bg: 'var(--green-soft)', title: 'No action required', desc: 'Resource consumption is within normal bounds across all layers.' });
  return a;
}

function ThrottleRow({ t }) {
  const [v, setV] = useState(Math.max(500, Math.round(t.eps * 3600 / 60) * 60 || 2500));
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
