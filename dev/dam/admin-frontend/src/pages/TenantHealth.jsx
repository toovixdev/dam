import { useState, useEffect } from 'react';
import Layout from '../components/Layout';
import KpiCard from '../components/KpiCard';
import PageHeader from '../components/shared/PageHeader';
import useApiData from '../hooks/useApiData';

const LEVEL = {
  healthy:  { color: 'var(--green)',  label: 'Healthy' },
  warning:  { color: 'var(--amber)',  label: 'Warning' },
  degraded: { color: 'var(--amber)',  label: 'Degraded' },
  critical: { color: 'var(--danger)', label: 'Critical' },
  none:     { color: 'var(--subtle)', label: 'No data' },
};
const SEV_BADGE = { high: 'sev-high', medium: 'sev-medium', low: 'status-gray', critical: 'sev-critical' };

function fmtNumber(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n ?? 0);
}
function healthColor(h) { return h >= 80 ? 'var(--green)' : h >= 60 ? 'var(--amber)' : 'var(--danger)'; }
function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(',', '');
}

function HealthCard({ title, level, rows }) {
  const m = LEVEL[level] || LEVEL.none;
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">{title}</span>
        <span className="card-sub" style={{ color: m.color }}>● {m.label}</span>
      </div>
      <div className="card-body">
        {rows.map(([k, v, color]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 6 }}>
            <span className="muted">{k}</span>
            <b style={color ? { color } : {}}>{v}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function TenantHealth() {
  const { data: tenants } = useApiData('/admin/tenants', { poll: 0 });
  const [selected, setSelected] = useState('');

  // Default to the first tenant once the list loads.
  useEffect(() => {
    if (!selected && tenants && tenants.length) setSelected(tenants[0].id);
  }, [tenants, selected]);

  const { data, loading, lastRefresh, refetch } = useApiData(
    selected ? `/admin/tenants/${selected}/health` : '/admin/tenants',
    { poll: 30000, skip: !selected }
  );

  const k = data?.kpis;
  const c = data?.cards;

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refetch}>
      <PageHeader title="Tenant Health" meta={['single-pane support view', 'per-tenant diagnostics']} />

      <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
        <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)' }}>Select tenant</label>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink)', fontSize: 13, minWidth: 260, fontFamily: 'var(--font)' }}
        >
          {(tenants || []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>

      {(!data || (loading && k == null)) ? (
        <div className="loading-screen"><div className="loading-spinner" /><p>Loading diagnostics...</p></div>
      ) : (
        <>
          <section className="kpi-grid">
            <KpiCard icon="●" iconBg="var(--green-soft)" iconColor="var(--green)"
              label="Overall health" value={<span style={{ color: healthColor(k.health) }}>{k.health}</span>} detail="composite score 0–100" detailType={k.health >= 80 ? 'up' : 'down'} />
            <KpiCard icon="▥" iconBg="var(--primary-soft)" iconColor="var(--primary)"
              label="Databases" value={k.databases} detail="registered" />
            <KpiCard icon="≈" iconBg="var(--info-soft)" iconColor="var(--info)"
              label="Events today" value={fmtNumber(k.eventsToday)} detail="this tenant" />
            <KpiCard icon="⚠" iconBg="var(--amber-soft)" iconColor="var(--amber)"
              label="Open issues" value={k.openIssues} detail={k.issueBreakdown} detailType={k.openIssues ? 'down' : 'up'} />
          </section>

          <h2 style={{ fontSize: 14, fontWeight: 700, margin: '4px 0 10px' }}>Health Cards — {data.tenant.name}</h2>

          <section className="charts-row three" style={{ marginBottom: 14 }}>
            <HealthCard title="Ingest Health" level={c.ingest.level} rows={[
              ['Events/s', c.ingest.eps],
              ['Ingest lag', c.ingest.lag],
              ['Last event', c.ingest.lastEvent],
              ['Pipeline status', c.ingest.status, LEVEL[c.ingest.level]?.color],
            ]} />
            <HealthCard title="Agent Health" level={c.agent.level} rows={[
              ['Online / Total', `${c.agent.online} / ${c.agent.total}`],
              ['Offline agents', c.agent.offline.length ? c.agent.offline.join(', ') : 'none', c.agent.offline.length ? 'var(--amber)' : undefined],
              ['Coverage', c.agent.coverage],
              ['Coverage gaps', c.agent.gaps, c.agent.gaps !== 'none' ? 'var(--amber)' : undefined],
            ]} />
            <HealthCard title="Alert Health" level={c.alert.level} rows={[
              ['Alerts (24h)', c.alert.count24h],
              ['Acknowledged rate', c.alert.ackRate],
              ['Avg response time', c.alert.avgResp],
              ['Unacknowledged', c.alert.unack, c.alert.unack ? 'var(--amber)' : undefined],
            ]} />
          </section>

          <section className="charts-row three" style={{ marginBottom: 14 }}>
            <HealthCard title="Classification Health" level={c.classification.level} rows={[
              ['Columns classified', fmtNumber(c.classification.columns)],
              ['Last scan', c.classification.lastScan],
              ['Coverage', c.classification.coverage],
              ['Pending review', c.classification.pending],
            ]} />
            <HealthCard title="Compliance Health" level={c.compliance.level} rows={[
              ['Frameworks active', c.compliance.frameworks],
              ['Control pass rate', c.compliance.passRate, LEVEL[c.compliance.level]?.color],
              ['Gaps identified', c.compliance.gaps, c.compliance.gaps ? 'var(--amber)' : undefined],
              ['Next audit due', c.compliance.nextAudit],
            ]} />
            <HealthCard title="Integration Health" level={c.integration.level} rows={[
              ['SIEM delivery', c.integration.siem],
              ['ITSM sync', c.integration.itsm],
              ['Notification', c.integration.notif],
              ['Last sync failure', c.integration.lastFail],
            ]} />
          </section>

          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-header"><span className="card-title">Recent Issues</span><span className="card-sub">{data.tenant.name}</span></div>
            <div className="card-body no-pad">
              <table className="data-table">
                <thead><tr><th>Time</th><th>Issue</th><th>Subsystem</th><th>Severity</th><th>Status</th></tr></thead>
                <tbody>
                  {data.issues.length === 0 && (
                    <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>No open issues — this tenant is healthy 🎉</td></tr>
                  )}
                  {data.issues.map((r, i) => (
                    <tr key={i}>
                      <td className="muted">{fmtTime(r.time)}</td>
                      <td><b>{r.issue}</b><br /><small className="muted">{r.detail}</small></td>
                      <td>{r.subsystem}</td>
                      <td><span className={`badge ${SEV_BADGE[r.severity] || 'status-gray'}`}>{r.severity}</span></td>
                      <td><span className="badge sev-high">{r.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </Layout>
  );
}
