import { useState } from 'react';
import Layout from '../components/Layout';
import KpiCard from '../components/KpiCard';
import PageHeader from '../components/shared/PageHeader';
import { toast } from '../components/shared/Toast';
import useApiData from '../hooks/useApiData';
import { apiPost } from '../api/client';

const ENGINE_LABEL = { mysql: 'MySQL / MariaDB', postgresql: 'PostgreSQL', mssql: 'SQL Server', oracle: 'Oracle' };
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
function sevBadge(sev) {
  const c = { critical: '#c0392b', high: '#d98a00', medium: '#3b82f6', low: '#6b7280', info: '#6b7280' }[sev] || '#6b7280';
  return <span className="badge" style={{ background: `${c}22`, color: c, fontWeight: 700 }}>{sev}</span>;
}

export default function ContentPacks() {
  const { data, loading, lastRefresh, refetch } = useApiData('/admin/va/checks', { poll: 0 });
  const [filter, setFilter] = useState('all');   // all | <engine>
  const [busy, setBusy] = useState('');

  const engines = data?.engines || [];
  const checks = data?.checks || [];
  const totals = {
    total: checks.length,
    enabled: checks.filter((c) => c.enabled).length,
    critical: checks.filter((c) => c.severity === 'critical' && c.enabled).length,
    high: checks.filter((c) => c.severity === 'high' && c.enabled).length,
  };

  async function toggle(c) {
    setBusy(c.id);
    const res = await apiPost(`/admin/va/checks/${c.id}/toggle`, { enabled: !c.enabled });
    setBusy('');
    if (res.ok) { toast(`${c.check_id} ${!c.enabled ? 'enabled' : 'disabled'}`, 'ok'); refetch(); }
    else toast(res.data?.error || 'Failed to update check', 'err');
  }

  if (loading && !data) {
    return <div className="loading-screen"><div className="loading-spinner" /><p>Loading benchmark library…</p></div>;
  }

  const shown = (filter === 'all' ? checks : checks.filter((c) => c.engine === filter))
    .slice().sort((a, b) => a.engine.localeCompare(b.engine) || (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]) || a.check_id.localeCompare(b.check_id));

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refetch}>
      <PageHeader title="Content Packs — VA Benchmarks" meta={['CIS database checks', 'centrally managed · agents pull the curated pack']} />

      <section className="kpi-grid">
        <KpiCard icon="▤" iconBg="var(--primary-soft)" iconColor="var(--primary)" label="Checks" value={totals.total} detail={`${engines.length} engines`} />
        <KpiCard icon="▮" iconBg="var(--green-soft)" iconColor="var(--green)" label="Enabled" value={totals.enabled} detail="pushed to agents" detailType="up" />
        <KpiCard icon="▲" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Critical" value={totals.critical} detail="enabled critical checks" />
        <KpiCard icon="△" iconBg="var(--info-soft)" iconColor="var(--info)" label="High" value={totals.high} detail="enabled high checks" />
      </section>

      {/* Per-engine pack summary — this is exactly what an agent pulls for that engine */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Benchmark packs</span><span className="card-sub">one signed pack per engine · version changes when you enable/disable a check</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Engine</th><th className="num">Enabled / Total</th><th>Pack version</th><th></th></tr></thead>
            <tbody>
              {engines.map((e) => (
                <tr key={e.engine}>
                  <td><b>{ENGINE_LABEL[e.engine] || e.engine}</b></td>
                  <td className="num">{e.enabled} / {e.total}</td>
                  <td><span className="mono" style={{ fontSize: 12 }}>{e.version}</span></td>
                  <td><button className="btn-secondary" style={{ padding: '4px 12px' }} onClick={() => setFilter(filter === e.engine ? 'all' : e.engine)}>{filter === e.engine ? 'Show all' : 'View checks'}</button></td>
                </tr>
              ))}
              {engines.length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 18, textAlign: 'center' }}>No checks registered yet — an agent populates the library the first time it runs a VA scan.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Check library{filter !== 'all' ? ` — ${ENGINE_LABEL[filter] || filter}` : ''}</span>
          <span className="card-sub">{shown.length} checks · toggle to curate what agents run</span>
          {filter !== 'all' && <button className="btn-secondary" style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: 12 }} onClick={() => setFilter('all')}>All engines</button>}
        </div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead>
              <tr><th>Engine</th><th>Check</th><th>Section</th><th style={{ width: 90 }}>Severity</th><th>Source</th><th style={{ width: 110 }}>Enabled</th></tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id} style={{ opacity: c.enabled ? 1 : 0.5 }}>
                  <td><small className="muted">{c.engine}</small></td>
                  <td><b>{c.title}</b><br /><small className="muted mono">{c.check_id}{c.benchmark ? ` · ${c.benchmark}` : ''}</small></td>
                  <td>{c.section || '—'}</td>
                  <td>{sevBadge(c.severity)}</td>
                  <td>{c.source === 'custom' ? <span className="badge sev-medium">custom</span> : <span className="badge status-gray">agent</span>}</td>
                  <td>
                    <button className={c.enabled ? 'btn-secondary' : 'btn-primary'} style={{ padding: '4px 12px', fontSize: 12 }} disabled={busy === c.id} onClick={() => toggle(c)}>
                      {busy === c.id ? '…' : c.enabled ? 'On' : 'Off'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}
