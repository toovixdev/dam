import Layout from '../components/Layout';
import KpiCard from '../components/KpiCard';
import PageHeader from '../components/shared/PageHeader';
import useApiData from '../hooks/useApiData';

const RISK_COLOR = { green: 'var(--green)', amber: 'var(--amber)', red: 'var(--danger)' };
const TIER_BADGE = { enterprise: 'engine', business: 'sev-medium', starter: 'sev-high', professional: 'status-gray' };
const TIER_LABEL = { enterprise: 'Enterprise', business: 'Business', starter: 'Starter', professional: 'Professional' };
const REC = { red: { b: 'var(--danger)', bg: 'var(--danger-soft)' }, amber: { b: 'var(--amber)', bg: 'var(--amber-soft)' }, info: { b: 'var(--info)', bg: 'var(--info-soft)' } };

function usdK(n) { return n >= 1000 ? '$' + (n / 1000).toFixed(0) + 'K' : '$' + (n ?? 0); }
function Trend({ t }) { return t === 'up' ? <span style={{ color: 'var(--green)' }}>▲</span> : t === 'down' ? <span style={{ color: 'var(--danger)' }}>▼</span> : <span className="muted">▶</span>; }

export default function CustomerSuccess() {
  const { data, loading, lastRefresh, refetch } = useApiData('/admin/success', { poll: 30000 });
  if (loading && !data) return <div className="loading-screen"><div className="loading-spinner" /><p>Scoring accounts…</p></div>;

  const k = data?.kpis || {};
  const accounts = data?.accounts || [];
  const adoption = data?.adoption || [];
  const expansion = data?.expansion || [];
  const ttv = data?.ttv || [];

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refetch}>
      <PageHeader title="Customer Success" meta={['account health', 'renewal pipeline', 'feature adoption', 'expansion signals']} />

      <section className="kpi-grid">
        <KpiCard icon="●" iconBg="var(--green-soft)" iconColor="var(--green)" label="Healthy"
          value={k.healthy} detail={`${k.total ? Math.round((k.healthy / k.total) * 100) : 0}% of tenants`} detailType="up" />
        <KpiCard icon="●" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="At risk"
          value={k.atRisk} detail="declining usage" detailType={k.atRisk ? 'down' : ''} />
        <KpiCard icon="●" iconBg="var(--danger-soft)" iconColor="var(--danger)" label="Churn risk"
          value={k.churnRisk} detail={k.churnRisk ? 'action needed' : 'none'} detailType={k.churnRisk ? 'down' : 'up'} />
        <KpiCard icon="↻" iconBg="var(--info-soft)" iconColor="var(--info)" label="Renewals (90d)"
          value={k.renewals90d} detail={`${usdK(k.arrAtStake)} ARR at stake`} />
      </section>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Account Health</span><span className="card-sub">composite of usage · alert response · coverage</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Tenant</th><th>Plan</th><th className="num">Health</th><th>Trend</th><th className="num">Usage</th><th className="num">Alert ack</th><th className="num">Features</th><th>Signal</th><th>Renewal</th></tr></thead>
            <tbody>
              {accounts.map(a => (
                <tr key={a.id}>
                  <td><b>{a.name}</b></td>
                  <td><span className={`badge ${TIER_BADGE[a.plan] || 'status-gray'}`}>{TIER_LABEL[a.plan] || a.plan}</span></td>
                  <td className="num"><b style={{ color: RISK_COLOR[a.risk] }}>{a.health}</b></td>
                  <td><Trend t={a.trend} /></td>
                  <td className="num">{a.usage}%</td>
                  <td className="num">{a.ackPct}%</td>
                  <td className="num">{a.features}</td>
                  <td>{a.signal ? <span style={{ fontSize: 12, color: a.risk === 'red' ? 'var(--danger)' : 'var(--amber)' }}>{a.signal}</span> : <span className="muted">—</span>}</td>
                  <td>{a.renewal}{a.renewalEstimated ? <small className="muted" title="No contract on file — estimated as signup + 1 year"> ·est</small> : ''}<br /><small className="muted">{usdK(a.arr)} ARR</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <section className="charts-row" style={{ marginBottom: 14 }}>
        <div className="card">
          <div className="card-header"><span className="card-title">Feature Adoption</span><span className="card-sub">across all tenants</span></div>
          <div className="card-body no-pad">
            <table className="data-table">
              <thead><tr><th>Feature</th><th className="num">Adoption</th><th>Bar</th></tr></thead>
              <tbody>
                {adoption.map(f => {
                  const c = f.pct >= 70 ? 'var(--green)' : f.pct >= 40 ? 'var(--amber)' : 'var(--info)';
                  return <tr key={f.feature}><td>{f.feature}</td><td className="num">{f.pct}%</td>
                    <td><div style={{ background: 'var(--line)', height: 8, borderRadius: 4, width: 120 }}><div style={{ width: `${f.pct}%`, height: 8, borderRadius: 4, background: c }} /></div></td></tr>;
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">Expansion Signals</span><span className="card-sub">upsell & cross-sell</span></div>
          <div className="card-body">
            {expansion.length === 0 && <div className="muted">No expansion or risk signals — all accounts steady.</div>}
            {expansion.map((e, i) => {
              const m = REC[e.level] || REC.info;
              return <div key={i} style={{ background: m.bg, border: `1px solid ${m.b}33`, borderRadius: 10, padding: '12px 14px', marginBottom: 10 }}>
                <b style={{ fontSize: 13 }}>{e.title}</b><br /><span style={{ fontSize: 12, color: 'var(--muted)' }}>{e.desc}</span></div>;
            })}
          </div>
        </div>
      </section>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Time-to-Value Benchmarks</span><span className="card-sub">median days from signup to milestone</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Milestone</th><th className="num">Median (days)</th><th className="num">Best</th><th className="num">Worst</th><th>Benchmark</th></tr></thead>
            <tbody>
              {ttv.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 16 }}>Not enough activity yet to measure time-to-value.</td></tr>}
              {ttv.map(r => <tr key={r.label}><td><b>{r.label}</b><br /><small className="muted">n={r.n}</small></td><td className="num">{r.median}</td><td className="num">{r.best}</td><td className="num">{r.worst}</td><td><span className={`badge ${r.status === 'good' ? 'status-green' : 'sev-high'}`}>{r.status}</span></td></tr>)}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}
