import Layout from '../components/Layout';
import KpiCard from '../components/KpiCard';
import PageHeader from '../components/shared/PageHeader';
import useApiData from '../hooks/useApiData';

const STATUS_BADGE = { healthy: 'status-green', degraded: 'sev-high', down: 'sev-critical' };
const STATUS_LABEL = { healthy: 'Healthy', degraded: 'Degraded', down: 'Down' };

function diskColor(p) { return p > 80 ? 'var(--danger)' : p > 60 ? 'var(--amber)' : 'var(--green)'; }
function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export default function InfraHealth() {
  const { data, loading, lastRefresh, refetch } = useApiData('/admin/infra/health', { poll: 15000 });
  if (loading && !data) return <div className="loading-screen"><div className="loading-spinner" /><p>Probing infrastructure…</p></div>;

  const k = data?.kpis || {};
  const r = data?.region || {};
  const services = data?.services || [];
  const ch = data?.clickhouse || {};
  const pg = data?.postgres || {};
  const nats = data?.nats;

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refetch}>
      <PageHeader title="Infrastructure Health" meta={['TooVix DAM · Super Admin', 'live service probes']}>
        <span className="badge status-green">● live</span>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="●" iconBg="var(--green-soft)" iconColor="var(--green)"
          label="Services healthy" value={<span style={{ color: k.degraded ? 'var(--amber)' : 'var(--green)' }}>{k.servicesHealthy}/{k.servicesTotal}</span>}
          detail={k.degraded ? `${k.degraded} degraded` : 'all systems go'} detailType={k.degraded ? 'down' : 'up'} />
        <KpiCard icon="≈" iconBg="var(--info-soft)" iconColor="var(--info)"
          label="Ingest lag" value={k.avgLatency} detail="time since last event" />
        <KpiCard icon="▤" iconBg="var(--amber-soft)" iconColor="var(--amber)"
          label="ClickHouse disk" value={<span style={{ color: diskColor(k.clickhouseDiskPct) }}>{k.clickhouseDiskPct}%</span>}
          detail={`${k.clickhouseNodes} node · ${ch.dataRows?.toLocaleString() || 0} rows`} detailType={k.clickhouseDiskPct > 80 ? 'down' : 'up'} />
        <KpiCard icon="▷" iconBg="var(--green-soft)" iconColor="var(--green)"
          label="Event Bus" value={<span style={{ color: nats ? 'var(--green)' : 'var(--danger)' }}>{nats ? 'Healthy' : 'Down'}</span>}
          detail={nats ? `${nats.connections} conns · ${nats.slowConsumers || 0} slow` : 'NATS unreachable'} detailType={nats ? 'up' : 'down'} />
      </section>

      <h2 style={{ fontSize: 14, fontWeight: 700, margin: '4px 0 10px' }}>Region Health</h2>
      <section className="charts-row" style={{ marginBottom: 14 }}>
        <div className="card" style={{ maxWidth: 340 }}>
          <div className="card-header"><span className="card-title">{r.name}</span></div>
          <div className="card-body">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
              <div><small className="muted">Control Plane</small><br /><span className={`badge ${r.controlPlane === 'Healthy' ? 'status-green' : 'sev-high'}`}>{r.controlPlane}</span></div>
              <div><small className="muted">Data Plane</small><br /><span className={`badge ${r.dataPlane === 'Healthy' ? 'status-green' : 'sev-high'}`}>{r.dataPlane}</span></div>
            </div>
            {[['Ingest lag', r.ingestLag], ['Events/s', r.eps], ['Disk usage', `${r.diskPct}%`, diskColor(r.diskPct)]].map(([kk, vv, c]) => (
              <div key={kk} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 6 }}>
                <span className="muted">{kk}</span><b style={c ? { color: c } : {}}>{vv}</b>
              </div>
            ))}
            <div style={{ height: 8, borderRadius: 6, background: 'var(--surface-2)', overflow: 'hidden', marginTop: 4 }}>
              <div style={{ height: '100%', width: `${r.diskPct}%`, background: diskColor(r.diskPct) }} />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">Live Metrics</span><span className="card-sub">real · this stack</span></div>
          <div className="card-body">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px' }}>
              {[
                ['ClickHouse rows', ch.dataRows?.toLocaleString() ?? '—'],
                ['ClickHouse data size', fmtBytes(ch.dataBytes)],
                ['CH queries / hr', ch.queriesHr?.toLocaleString() ?? '—'],
                ['CH disk free', fmtBytes(ch.diskTotalBytes - ch.diskUsedBytes)],
                ['Postgres size', fmtBytes(pg.sizeBytes)],
                ['Postgres connections', pg.connections],
                ['NATS msgs in', nats ? nats.inMsgs?.toLocaleString() : '—'],
                ['NATS memory', nats ? `${nats.memMb} MB` : '—'],
              ].map(([kk, vv]) => (
                <div key={kk} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '5px 0', borderBottom: '1px solid var(--line-2)' }}>
                  <span className="muted">{kk}</span><b>{vv}</b>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Component Status</span><span className="card-sub">{services.length} platform services · live probe</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Component</th><th>Kind</th><th>Detail</th><th>Status</th></tr></thead>
            <tbody>
              {services.map(s => (
                <tr key={s.name}>
                  <td><b>{s.name}</b></td>
                  <td className="muted" style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>{s.kind}</td>
                  <td className="muted">{s.detail}</td>
                  <td><span className={`badge ${STATUS_BADGE[s.status]}`}>{STATUS_LABEL[s.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}
