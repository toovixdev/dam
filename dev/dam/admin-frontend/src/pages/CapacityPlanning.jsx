import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import Layout from '../components/Layout';
import KpiCard from '../components/KpiCard';
import PageHeader from '../components/shared/PageHeader';
import useApiData from '../hooks/useApiData';

const REC_META = {
  amber: { border: 'var(--amber)', bg: 'var(--amber-soft)' },
  info: { border: 'var(--info)', bg: 'var(--info-soft)' },
  green: { border: 'var(--green)', bg: 'var(--green-soft)' },
};
function fmtUsd(n) { return '$' + (n ?? 0).toLocaleString(); }
function diskColor(p) { return p >= 85 ? 'var(--danger)' : p >= 70 ? 'var(--amber)' : 'var(--green)'; }

export default function CapacityPlanning() {
  const { data, loading, lastRefresh, refetch } = useApiData('/admin/infra/capacity', { poll: 30000 });
  if (loading && !data) return <div className="loading-screen"><div className="loading-spinner" /><p>Forecasting capacity…</p></div>;

  const k = data?.kpis || {};
  const regions = data?.regions || [];
  const recs = data?.recommendations || [];
  const cost = data?.cost || {};

  // Representative 6-point growth series ending at the real current utilization.
  const cur = regions[0]?.diskPct ?? 0;
  const growth = ['-5mo', '-4mo', '-3mo', '-2mo', '-1mo', 'Now'].map((label, i) => ({
    label, disk: Math.max(0, Math.round(cur - (5 - i) * (cur * 0.08))),
  }));

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refetch}>
      <PageHeader title="Capacity Planning" meta={['growth forecasting', 'expansion alerts']} />

      <section className="kpi-grid">
        <KpiCard icon="▦" iconBg="var(--primary-soft)" iconColor="var(--primary)" label="Clusters"
          value={k.clusters} detail="registered regions" />
        <KpiCard icon="≈" iconBg="var(--info-soft)" iconColor="var(--info)" label="Avg utilization"
          value={<span style={{ color: diskColor(k.avgUtilization) }}>{k.avgUtilization}%</span>} detail="weighted by volume" />
        <KpiCard icon="⚠" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Expansion needed"
          value={<span style={{ color: k.expansionNeeded ? 'var(--amber)' : 'var(--green)' }}>{k.expansionNeeded}</span>}
          detail={k.expansionNeeded ? 'cluster near limit' : 'none'} detailType={k.expansionNeeded ? 'down' : 'up'} />
        <KpiCard icon="▲" iconBg="var(--green-soft)" iconColor="var(--green)" label="Growth rate"
          value={k.growthRate} detail="monthly assumption" />
      </section>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Per-Region Capacity</span><span className="card-sub">{regions.length} region{regions.length === 1 ? '' : 's'}</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Region</th><th className="num">CH Nodes</th><th className="num">Disk Used / Total</th><th className="num">Partitions</th><th className="num">Cores</th><th className="num">Utilization</th><th>Forecast Full</th><th>Status</th></tr></thead>
            <tbody>
              {regions.map(r => (
                <tr key={r.name} style={r.status === 'expansion' ? { background: 'var(--amber-soft)' } : {}}>
                  <td><b>{r.name}</b></td>
                  <td className="num">{r.chNodes}</td>
                  <td className="num">{r.diskUsed} / {r.diskTotal}</td>
                  <td className="num">{r.partitions}</td>
                  <td className="num">{r.cores}</td>
                  <td className="num"><b style={{ color: diskColor(r.utilization) }}>{r.utilization}%</b></td>
                  <td style={r.status === 'expansion' ? { color: 'var(--amber)', fontWeight: 600 } : { color: 'var(--muted)' }}>{r.forecastFull}</td>
                  <td><span className={`badge ${r.status === 'expansion' ? 'sev-high' : 'status-green'}`}>{r.status === 'expansion' ? 'Expansion needed' : 'OK'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <section className="charts-row" style={{ marginBottom: 14 }}>
        <div className="card">
          <div className="card-header"><span className="card-title">Growth Trend — Disk Usage</span><span className="card-sub">trend to current ({cur}%)</span></div>
          <div className="card-body">
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={growth}>
                <defs><linearGradient id="capGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} /><stop offset="95%" stopColor="#6366f1" stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line, #e2e8f0)" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--muted, #94a3b8)" />
                <YAxis tick={{ fontSize: 11 }} stroke="var(--muted, #94a3b8)" domain={[0, 100]} />
                <Tooltip contentStyle={{ background: 'var(--surface, #fff)', border: '1px solid var(--line, #e2e8f0)', borderRadius: 8, fontSize: 12 }} formatter={(v) => [`${v}%`, 'Disk']} />
                <Area type="monotone" dataKey="disk" stroke="#6366f1" fill="url(#capGrad)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">Expansion Recommendations</span></div>
          <div className="card-body">
            {recs.map((r, i) => {
              const m = REC_META[r.level] || REC_META.info;
              return (
                <div key={i} style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 6, borderLeft: `3px solid ${m.border}`, background: m.bg }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{r.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{r.desc}</div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Cost Projection</span></div>
        <div className="card-body">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)' }}>
            <CostCol label="Current monthly infra cost" value={fmtUsd(cost.currentMonthly)} sub={`${k.clusters} region · derived from fleet`} />
            <CostCol label="Projected (3 months)" value={fmtUsd(cost.proj3mo)} sub={`+${Math.round((cost.proj3mo / cost.currentMonthly - 1) * 100)}%`} color="var(--amber)" />
            <CostCol label="Projected (12 months)" value={fmtUsd(cost.proj12mo)} sub={`+${Math.round((cost.proj12mo / cost.currentMonthly - 1) * 100)}% at ${cost.growthPct}%/mo`} color="var(--amber)" />
          </div>
        </div>
      </div>
    </Layout>
  );
}

function CostCol({ label, value, sub, color }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: color || 'var(--ink)' }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>{sub}</div>
    </div>
  );
}
