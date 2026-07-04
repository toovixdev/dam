import Layout from '../components/Layout';
import KpiCard from '../components/KpiCard';
import PageHeader from '../components/shared/PageHeader';
import { toast } from '../components/shared/Toast';
import useApiData from '../hooks/useApiData';

const HEALTH_BADGE = { excellent: 'status-green', 'on-track': 'status-green', slow: 'sev-high', 'at-risk': 'sev-high' };
const HEALTH_LABEL = { excellent: 'Excellent', 'on-track': 'On track', slow: 'Slow', 'at-risk': 'At risk' };
const REC = { amber: { b: 'var(--amber)', bg: 'var(--amber-soft)' }, info: { b: 'var(--info)', bg: 'var(--info-soft)' }, green: { b: 'var(--green)', bg: 'var(--green-soft)' } };

export default function TrialConversion() {
  const { data, loading, lastRefresh, refetch } = useApiData('/admin/trials', { poll: 30000 });
  if (loading && !data) return <div className="loading-screen"><div className="loading-spinner" /><p>Loading trial pipeline…</p></div>;

  const k = data?.kpis || {};
  const funnel = data?.funnel || [];
  const trials = data?.trials || [];
  const signals = data?.signals || [];
  const maxF = Math.max(1, ...funnel.map(f => f.value));

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refetch}>
      <PageHeader title="Trial Conversion" meta={['pipeline', 'funnel', 'conversion signals']} />

      <section className="kpi-grid">
        <KpiCard icon="⏱" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Active trials" value={k.activeTrials} detail="in evaluation" />
        <KpiCard icon="▲" iconBg="var(--green-soft)" iconColor="var(--green)" label="Converted this month" value={k.convertedThisMonth} detail="trial → paid" detailType="up" />
        <KpiCard icon="▦" iconBg="var(--primary-soft)" iconColor="var(--primary)" label="Conversion rate" value={`${k.conversionRate}%`} detail="signup → active" detailType="up" />
        <KpiCard icon="≈" iconBg="var(--info-soft)" iconColor="var(--info)" label="Avg trial duration" value={k.avgDuration} detail="to conversion" />
      </section>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Conversion Funnel</span><span className="card-sub">derived from real tenant pipeline</span></div>
        <div className="card-body">
          <div style={{ display: 'flex', gap: 6, alignItems: 'stretch', minHeight: 150 }}>
            {funnel.map(f => (
              <div key={f.label} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end' }}>
                <div style={{ width: '100%', background: f.color, borderRadius: '6px 6px 0 0', minHeight: Math.max(28, (f.value / maxF) * 120), display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 18 }}>{f.value}</div>
                <div style={{ fontSize: 11, fontWeight: 600, marginTop: 6, textAlign: 'center' }}>{f.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Trial Tenants</span><span className="card-sub">{trials.length} active trial{trials.length === 1 ? '' : 's'}</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Tenant</th><th className="num">Day #</th><th className="num">DBs</th><th className="num">Alerts</th><th className="num">Reports</th><th>Next milestone</th><th>Health</th><th></th></tr></thead>
            <tbody>
              {trials.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>No active trials right now — all tenants are on paid plans.</td></tr>}
              {trials.map(t => (
                <tr key={t.id} style={t.health === 'at-risk' ? { background: 'var(--amber-soft)' } : {}}>
                  <td><b>{t.name}</b><br /><small className="muted">{t.slug} · {t.region}</small></td>
                  <td className="num">{t.day}</td><td className="num">{t.dbs}</td><td className="num">{t.alerts}</td><td className="num">{t.reports}</td>
                  <td><span className={`badge ${t.health === 'excellent' ? 'status-green' : 'sev-medium'}`}>{t.milestone}</span></td>
                  <td><span className={`badge ${HEALTH_BADGE[t.health]}`}>{HEALTH_LABEL[t.health]}</span></td>
                  <td>{t.health === 'excellent'
                    ? <button className="btn-primary" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => toast(`Conversion offer sent to ${t.name}`, 'ok')}>Convert</button>
                    : <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => toast(`Opening ${t.name}`, 'ok')}>View</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Auto-trigger Alerts</span><span className="card-sub">CSM notifications</span></div>
        <div className="card-body">
          {signals.length === 0 && <div className="muted">No trial signals — nothing needs CSM attention.</div>}
          {signals.map((s, i) => {
            const m = REC[s.level] || REC.info;
            return <div key={i} style={{ marginBottom: 10, padding: '10px 12px', borderRadius: 6, borderLeft: `3px solid ${m.b}`, background: m.bg }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{s.title}</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>{s.desc}</div></div>;
          })}
        </div>
      </div>
    </Layout>
  );
}
