import Layout from '../components/Layout';
import KpiCard from '../components/KpiCard';
import PageHeader from '../components/shared/PageHeader';
import PlatformEventsChart from '../components/PlatformEventsChart';
import RegionDonut from '../components/RegionDonut';
import useApiData from '../hooks/useApiData';

function formatNumber(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n ?? 0);
}

const SEV_BADGE = { critical: 'sev-critical', high: 'sev-high', medium: 'sev-medium', low: 'status-gray' };
const TIER_LABEL = { enterprise: 'Enterprise', business: 'Business', professional: 'Professional', starter: 'Starter' };

function timeAgo(iso) {
  if (!iso) return '—';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / 1440)}d`;
}

export default function PlatformDashboard() {
  const { data, loading, lastRefresh, refetch } = useApiData('/admin/platform/overview', { poll: 30000 });
  const { data: timeline } = useApiData('/admin/platform/events-timeline', { poll: 30000 });

  if (loading && !data) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner" />
        <p>Loading platform dashboard...</p>
      </div>
    );
  }

  const k = data?.kpis || {};
  const tenants = k.tenants || { active: 0, total: 0, newThisMonth: 0 };
  const agents = k.agents || { online: 0, total: 0 };
  const agentHealth = agents.total > 0 ? Math.round((agents.online / agents.total) * 100) : 100;
  const regions = k.regions || [];
  const topTenants = data?.topTenants || [];
  const alerts = data?.alerts || [];
  const byRegion = data?.tenantsByRegion || [];
  const deployed = k.versionDeployedAt
    ? new Date(k.versionDeployedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
    : '—';

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refetch}>
      <PageHeader
        title="Platform Dashboard"
        meta={['TooVix DAM · Super Admin', `${regions.length || 0} regions · ${tenants.total} tenants`]}
      />

      {/* KPI Row 1 */}
      <section className="kpi-grid">
        <KpiCard
          icon="▦" iconBg="var(--primary-soft)" iconColor="var(--primary)"
          label="Active tenants" value={tenants.active}
          detail={tenants.newThisMonth > 0 ? `▲ ${tenants.newThisMonth} this month` : `${tenants.total} total`}
          detailType={tenants.newThisMonth > 0 ? 'up' : ''}
        />
        <KpiCard
          icon="▥" iconBg="var(--info-soft)" iconColor="var(--info)"
          label="Total databases" value={formatNumber(k.databases)}
          detail="across all tenants"
        />
        <KpiCard
          icon="●" iconBg="var(--green-soft)" iconColor="var(--green)"
          label="Agents online" value={formatNumber(agents.online)}
          detail={`${agentHealth}% healthy · ${agents.total} total`}
          detailType={agentHealth >= 95 ? 'up' : 'down'}
        />
        <KpiCard
          icon="≋" iconBg="var(--amber-soft)" iconColor="var(--amber)"
          label="Events today" value={formatNumber(k.eventsToday)}
          detail="all tenants · live from ClickHouse"
          detailType="up"
        />
      </section>

      {/* KPI Row 2 */}
      <section className="kpi-grid">
        <KpiCard
          icon="⚠" iconBg="var(--danger-soft)" iconColor="var(--danger)"
          label="Platform alerts" value={k.platformAlerts ?? 0}
          detail={alerts.length ? alerts.slice(0, 2).map(a => a.category).join(' · ') : 'all clear'}
          detailType={k.platformAlerts > 0 ? 'down' : 'up'}
        />
        <KpiCard
          icon="◴" label="Regions" value={regions.length}
          detail={regions.join(' · ') || '—'}
        />
        <KpiCard
          icon="⛓" iconBg={k.dataIntegrity === 'Intact' ? 'var(--green-soft)' : 'var(--amber-soft)'}
          iconColor={k.dataIntegrity === 'Intact' ? 'var(--green)' : 'var(--amber)'}
          label="Data integrity"
          value={<span style={{ color: k.dataIntegrity === 'Intact' ? 'var(--green)' : 'var(--amber)' }}>{k.dataIntegrity || '—'}</span>}
          detail="audit hash-chain verified"
          detailType={k.dataIntegrity === 'Intact' ? 'up' : 'down'}
        />
        <KpiCard
          icon="▷" iconBg="var(--info-soft)" iconColor="var(--info)"
          label="Platform version" value={k.version || '—'}
          detail={`deployed ${deployed}`}
        />
      </section>

      {/* Charts */}
      <section className="charts-row">
        <div className="card">
          <div className="card-header">
            <span className="card-title">Events ingested · last 24h (all tenants)</span>
            <span className="card-sub">live from ClickHouse</span>
          </div>
          <div className="card-body">
            <PlatformEventsChart data={timeline} />
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            <span className="card-title">Tenants by region</span>
          </div>
          <div className="card-body">
            <RegionDonut data={byRegion} />
          </div>
        </div>
      </section>

      {/* Tables */}
      <section className="charts-row">
        <div className="card">
          <div className="card-header"><span className="card-title">Top tenants by volume</span></div>
          <div className="card-body no-pad">
            <table className="data-table">
              <thead>
                <tr><th>Tenant</th><th>Plan</th><th className="num">DBs</th><th className="num">Events/day</th><th>Region</th></tr>
              </thead>
              <tbody>
                {topTenants.length === 0 && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>No tenants registered</td></tr>
                )}
                {topTenants.map(t => (
                  <tr key={t.id}>
                    <td><b>{t.name}</b></td>
                    <td><span className="badge engine">{TIER_LABEL[t.tier] || t.tier}</span></td>
                    <td className="num">{t.databases}</td>
                    <td className="num">{formatNumber(t.eventsPerDay)}</td>
                    <td className="muted">{t.region}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">Platform alerts</span></div>
          <div className="card-body no-pad">
            <table className="data-table">
              <thead>
                <tr><th>Alert</th><th>Region</th><th>Severity</th><th className="num">Age</th></tr>
              </thead>
              <tbody>
                {alerts.length === 0 && (
                  <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 20 }}>No open platform alerts</td></tr>
                )}
                {alerts.map(a => (
                  <tr key={a.id}>
                    <td><b>{a.title}</b><br /><small className="muted">{a.detail}</small></td>
                    <td className="muted">{a.region}</td>
                    <td><span className={`badge ${SEV_BADGE[a.severity] || 'status-gray'}`}>{a.severity}</span></td>
                    <td className="num muted">{timeAgo(a.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </Layout>
  );
}
