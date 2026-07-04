import { useState } from 'react';
import Layout from '../components/Layout';
import KpiCard from '../components/KpiCard';
import PageHeader from '../components/shared/PageHeader';
import { toast } from '../components/shared/Toast';
import useApiData from '../hooks/useApiData';

function actionBadge(a) {
  if (/impersonation\.start|break-glass\.activate/.test(a)) return 'sev-critical';
  if (/^tenant\.|approval\.approve/.test(a)) return 'engine';
  if (/^billing\.|approval\.reject/.test(a)) return 'sev-high';
  if (/content-pack|platform\.deploy|canary/.test(a)) return 'sev-medium';
  return 'status-gray';
}
function fmtTs(ts) { return new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(',', ''); }

function exportCsv(events) {
  const head = ['Timestamp', 'Actor', 'Action', 'Tenant', 'Resource', 'IP', 'Details'];
  const rows = events.map(e => [fmtTs(e.ts), e.actor, e.action, e.tenant_name || '', e.resource || '', e.ip || '', e.details || '']);
  const csv = [head, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a'); a.href = url; a.download = 'platform-audit-log.csv'; a.click(); URL.revokeObjectURL(url);
}

export default function PlatformAudit() {
  const [path, setPath] = useState('/admin/audit');
  const [f, setF] = useState({ actor: '', action: '', tenant: '', q: '', from: '', to: '' });
  const { data, loading, lastRefresh, refetch } = useApiData(path, { poll: 20000 });

  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  function applyFilters() {
    const qs = Object.entries(f).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    setPath('/admin/audit' + (qs ? `?${qs}` : ''));
  }

  if (loading && !data) return <div className="loading-screen"><div className="loading-spinner" /><p>Loading audit log…</p></div>;
  const k = data?.kpis || {};
  const events = data?.events || [];
  const filters = data?.filters || { actors: [], actions: [] };

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refetch}>
      <PageHeader title="Platform Audit Log" meta={['operator actions', 'all vendor activity']}>
        <button className="btn-secondary" onClick={() => events.length ? exportCsv(events) : toast('Nothing to export', 'err')}>⭳ Export evidence</button>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="▮" iconBg="var(--primary-soft)" iconColor="var(--primary)" label="Events today" value={k.eventsToday} detail="operator actions" />
        <KpiCard icon="◴" iconBg="var(--info-soft)" iconColor="var(--info)" label="Actors active" value={k.actorsActive} detail="today" />
        <KpiCard icon="≈" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Tenants accessed" value={k.tenantsAccessed} detail="today" />
        <KpiCard icon="⚠" iconBg="var(--danger-soft)" iconColor="var(--danger)" label="Impersonation" value={k.impersonationSessions} detail="active sessions" detailType={k.impersonationSessions ? 'down' : 'up'} />
      </section>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-body" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field" style={{ marginBottom: 0 }}><label>From</label><input type="date" value={f.from} onChange={e => set('from', e.target.value)} /></div>
          <div className="form-field" style={{ marginBottom: 0 }}><label>To</label><input type="date" value={f.to} onChange={e => set('to', e.target.value)} /></div>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 150 }}><label>Actor</label>
            <select value={f.actor} onChange={e => set('actor', e.target.value)}><option value="">All actors</option>{filters.actors.map(a => <option key={a}>{a}</option>)}</select></div>
          <div className="form-field" style={{ marginBottom: 0, minWidth: 160 }}><label>Action</label>
            <select value={f.action} onChange={e => set('action', e.target.value)}><option value="">All actions</option>{filters.actions.map(a => <option key={a}>{a}</option>)}</select></div>
          <div className="form-field" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}><label>Search</label><input type="text" placeholder="events, resources, IPs…" value={f.q} onChange={e => set('q', e.target.value)} onKeyDown={e => e.key === 'Enter' && applyFilters()} /></div>
          <button className="btn-primary" onClick={applyFilters}>Filter</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Audit Events</span><span className="card-sub">{events.length} events · latest 200</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Timestamp</th><th>Actor</th><th>Action</th><th>Tenant</th><th>Resource</th><th>IP</th><th>Details</th></tr></thead>
            <tbody>
              {events.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>No matching events</td></tr>}
              {events.map(e => (
                <tr key={e.id}>
                  <td><small className="muted" style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{fmtTs(e.ts)}</small></td>
                  <td><b>{e.actor}</b></td>
                  <td><span className={`badge ${actionBadge(e.action)}`}>{e.action}</span></td>
                  <td>{e.tenant_name || <span className="muted">—</span>}</td>
                  <td><small className="muted" style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{e.resource || '—'}</small></td>
                  <td><small className="muted" style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{e.ip || '—'}</small></td>
                  <td><small className="muted">{e.details || '—'}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}
