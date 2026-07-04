import { useState } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/KpiCard';
import TabNav from '../components/shared/TabNav';
import { toast } from '../components/shared/Toast';
import useApiData from '../hooks/useApiData';
import { apiPost, apiDelete } from '../api/client';

// The masking method that policy applies for a given data class (display hint —
// enforcement is the per-column masked flag the backend actually stores).
const METHOD = { pci: 'last-4 (FPE)', ssn: 'redact', aadhaar: 'redact', email: 'domain-only', financial: 'last-4', phone: 'last-4' };
const methodFor = (tag) => METHOD[tag] || 'last-4';

// Illustrative only — static (non-prod refresh) masking jobs aren't backed yet.
const STATIC_JOBS = [
  { job: 'mask-cbs-uat', flow: 'ORCL-CBS-PROD → UAT', cols: '18 PII', fk: '✓', status: 'done · 2h', cls: 'green' },
  { job: 'mask-crm-dev', flow: 'PG-CRM-PROD → DEV', cols: '9 PII', fk: '✓', status: 'running', cls: 'amber' },
  { job: 'mask-cards-uat', flow: 'DB2-CARDS-PROD → UAT', cols: '4 PCI', fk: '✓', status: 'scheduled', cls: '' },
];

export default function Masking() {
  const [tab, setTab] = useState('dyn');
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [busyId, setBusyId] = useState(null);
  const { data, loading, error, refetch } = useApiData('/compliance/masking');
  const { data: features } = useApiData('/features', { poll: 30000 });
  // Default true until loaded so we don't flash the disabled state.
  const maskingEnabled = features ? features['dynamic-masking'] !== false : true;

  const handleRefresh = () => { refetch(); setLastRefresh(new Date()); };

  if (loading) return <Layout><div className="loading-screen"><div className="loading-spinner" /><p>Loading masking…</p></div></Layout>;
  if (error || !data) return <Layout><div className="card" style={{ padding: 16, color: 'var(--danger)' }}>Error loading masking: {error || 'no data'}</div></Layout>;

  const columns = data.columns || [];
  const gaps = columns.filter((c) => !c.masked);

  const toggle = async (c) => {
    setBusyId(c.id);
    const res = await apiPost(`/classification/columns/${c.id}/mask`, { masked: !c.masked });
    setBusyId(null);
    if (res?.ok) { toast(`Masking ${c.masked ? 'disabled' : 'enabled'} on ${c.col}`, 'ok'); refetch(); }
    else toast(res?.data?.error || 'Could not update masking', 'err');
  };

  const maskAllGaps = async () => {
    if (!gaps.length) return toast('No unmasked sensitive columns', 'ok');
    if (!window.confirm(`Enable masking on ${gaps.length} unmasked sensitive column(s)?`)) return;
    setBusyId('all');
    for (const c of gaps) await apiPost(`/classification/columns/${c.id}/mask`, { masked: true });
    setBusyId(null);
    toast(`Masking enabled on ${gaps.length} column(s)`, 'ok');
    refetch();
  };

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={handleRefresh}>
      <PageHeader title="Masking" meta={['dynamic data masking', `${data.pct}% of sensitive columns masked`]}>
        <button className="btn-primary" disabled={!maskingEnabled || busyId === 'all' || !gaps.length} onClick={maskAllGaps}>
          {busyId === 'all' ? 'Masking…' : `Mask all gaps (${gaps.length})`}
        </button>
      </PageHeader>

      {!maskingEnabled && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, background: 'var(--amber-soft)', border: '1px solid var(--line)', borderRadius: 10, padding: '12px 16px', marginBottom: 16, fontSize: 13, lineHeight: 1.5 }}>
          <span style={{ fontSize: 16 }}>⚠</span>
          <div>
            <b style={{ color: 'var(--amber)' }}>Dynamic Masking is disabled for your organization.</b> Masking policies below can be
            reviewed but are <b>not enforced</b> — queries return unmasked data. Contact your administrator to enable the feature.
          </div>
        </div>
      )}

      <section className="kpi-grid">
        <KpiCard icon="▦" iconBg="var(--info-soft)" iconColor="var(--info)" label="Sensitive columns" value={data.sensitive} detail="high / critical" />
        <KpiCard icon="◎" iconBg="var(--green-soft)" iconColor="var(--green)" label="Masked" value={data.masked} detail="query-time masking" />
        <KpiCard icon="◐" iconBg={data.pct >= 80 ? 'var(--green-soft)' : 'var(--amber-soft)'} iconColor={data.pct >= 80 ? 'var(--green)' : 'var(--amber)'} label="Coverage" value={`${data.pct}%`} detail="of sensitive columns" />
        <KpiCard icon="⚠" iconBg="var(--danger-soft)" iconColor="var(--danger)" label="Unmasked" value={gaps.length} detail="gaps open" detailType={gaps.length > 0 ? 'down' : 'up'} />
      </section>

      <TabNav
        tabs={[{ id: 'dyn', label: 'Dynamic rules' }, { id: 'bypass', label: 'Bypass' }, { id: 'static', label: 'Static jobs' }, { id: 'preview', label: 'Preview' }]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'bypass' && <BypassTab />}

      {tab === 'dyn' && (
        <div className="card">
          <div className="card-body no-pad">
            <table className="data-table">
              <thead>
                <tr><th>Column</th><th>Class</th><th>Sensitivity</th><th>Mask method</th><th>Status</th><th>On</th></tr>
              </thead>
              <tbody>
                {columns.length === 0 && (
                  <tr><td colSpan={6} className="muted" style={{ padding: 18, textAlign: 'center' }}>No sensitive columns classified yet — run Discovery / Classification first.</td></tr>
                )}
                {columns.map((c) => (
                  <tr key={c.id} style={{ opacity: busyId === c.id ? 0.5 : 1 }}>
                    <td className="mono" style={{ fontSize: 12 }}>{c.db}.{c.obj}.{c.col}</td>
                    <td><span className={`badge ${c.tag === 'pci' ? 'amber' : 'red'}`}>{c.tag}</span></td>
                    <td><span className={`badge ${c.sensitivity === 'critical' ? 'sev-critical' : 'sev-high'}`}>{c.sensitivity}</span></td>
                    <td className="muted">{c.masked ? methodFor(c.tag) : '—'}</td>
                    <td>{c.masked ? <span className="badge green">masked</span> : <span className="badge red">unmasked</span>}</td>
                    <td><button className={`switch ${c.masked ? 'on' : ''}`} aria-label="toggle masking" disabled={!maskingEnabled || busyId === c.id} onClick={() => toggle(c)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'static' && (
        <div className="card">
          <div style={{ background: 'var(--amber-soft)', color: 'var(--amber)', fontSize: 12, padding: '8px 16px', borderBottom: '1px solid var(--line)' }}>
            Illustrative — static (non-prod refresh) masking jobs are a roadmap feature and not yet wired to a backend.
          </div>
          <div className="card-body no-pad">
            <table className="data-table">
              <thead><tr><th>Job</th><th>Source → Target</th><th>Columns</th><th>FK preserved</th><th>Status</th></tr></thead>
              <tbody>
                {STATIC_JOBS.map((j) => (
                  <tr key={j.job}>
                    <td className="mono">{j.job}</td>
                    <td>{j.flow}</td>
                    <td>{j.cols}</td>
                    <td>{j.fk}</td>
                    <td><span className={`badge ${j.cls}`}>{j.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'preview' && (
        <>
          <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 14px', lineHeight: 1.5 }}>
            Illustration of how the same row renders for a privileged vs a non-privileged role under the masking policies above.
          </p>
          <div className="grid2">
            <div className="card">
              <div className="card-header"><span className="card-title">Privileged role (settlement)</span></div>
              <div className="card-body mono" style={{ fontSize: 13, lineHeight: 1.9 }}>
                <div>card_number&nbsp; <b>4539 1488 0343 6467</b></div>
                <div>sin&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; <b>412-88-9011</b></div>
                <div>email&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; <b>asha.k@meridian.example</b></div>
              </div>
            </div>
            <div className="card">
              <div className="card-header"><span className="card-title">Non-privileged role (support)</span></div>
              <div className="card-body mono" style={{ fontSize: 13, lineHeight: 1.9 }}>
                <div>card_number&nbsp; <b>XXXX XXXX XXXX 6467</b></div>
                <div>sin&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; <b>XXX-XX-9011</b></div>
                <div>email&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; <b>a****@meridian.example</b></div>
              </div>
            </div>
          </div>
        </>
      )}
    </Layout>
  );
}

// Per-database bypass principals — the (least-privilege) DB accounts that see UNMASKED
// data for a given database. No default bypass; the app/service account is masked unless
// added here. Never add root/DBA accounts — the app tier should not connect as those.
function BypassTab() {
  const { data, loading, refetch } = useApiData('/compliance/masking/bypass', { poll: 0 });
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);

  const add = async (databaseId) => {
    const principal = (draft[databaseId] || '').trim();
    if (!principal) return toast('Enter a DB username', 'err');
    setBusy(true);
    const res = await apiPost('/compliance/masking/bypass', { databaseId, principal });
    setBusy(false);
    if (res?.ok) { toast(`${principal} will see unmasked data`, 'ok'); setDraft((d) => ({ ...d, [databaseId]: '' })); refetch(); }
    else toast(res?.data?.error || 'Could not add', 'err');
  };
  const remove = async (id) => {
    setBusy(true);
    const res = await apiDelete(`/compliance/masking/bypass/${id}`);
    setBusy(false);
    if (res?.ok) { toast('Bypass removed', 'ok'); refetch(); }
    else toast(res?.data?.error || 'Could not remove', 'err');
  };

  if (loading) return <div className="card" style={{ padding: 16 }} ><span className="muted">Loading…</span></div>;
  const dbs = data || [];

  return (
    <>
      <div style={{ background: 'var(--info-soft)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 14px', marginBottom: 14, fontSize: 12.5, lineHeight: 1.5 }}>
        Bypass principals are the DB usernames that see <b>unmasked</b> data for that database. Configured per database —
        each has its own list, and <b>nothing bypasses by default</b>. Add only specific least-privilege accounts that
        genuinely need raw values (e.g. a settlement/reconciliation service or an audited break-glass identity).
        Never add root / admin / DBA accounts — the app tier must not connect as those.
      </div>
      {dbs.length === 0 && <div className="card" style={{ padding: 16, color: 'var(--muted)' }}>No databases found.</div>}
      <div className="grid2">
        {dbs.map((d) => (
          <div className="card" key={d.databaseId}>
            <div className="card-header">
              <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>▦ {d.db}</span>
              <span className="card-sub">{d.maskedCols} masked col{d.maskedCols === 1 ? '' : 's'} · {d.principals.length} bypass</span>
            </div>
            <div className="card-body">
              {d.maskedCols === 0 && <p className="muted" style={{ fontSize: 11.5, margin: '0 0 10px', lineHeight: 1.4 }}>No columns are masked on this database yet, so bypass has no effect here until you mask some (Dynamic rules tab). You can still pre-configure principals.</p>}
              {d.principals.length === 0 && d.maskedCols > 0 && <p className="muted" style={{ fontSize: 12.5, margin: '0 0 12px' }}>No bypass — every principal sees masked data for this database.</p>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                {d.principals.map((p) => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8, background: 'var(--surface-2)', border: '1px solid var(--line)', fontSize: 13 }}>
                    <span className="mono" style={{ flex: 1 }}>{p.principal}</span>
                    <span className="badge green">unmasked</span>
                    <button className="btn-secondary" style={{ padding: '3px 9px', fontSize: 11, color: 'var(--danger)', borderColor: 'var(--danger)' }} disabled={busy} onClick={() => remove(p.id)}>Remove</button>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input style={{ flex: 1 }} placeholder="DB username (e.g. settlement_svc)" value={draft[d.databaseId] || ''} onChange={(e) => setDraft((s) => ({ ...s, [d.databaseId]: e.target.value }))} onKeyDown={(e) => e.key === 'Enter' && add(d.databaseId)} />
                <button className="btn-primary" disabled={busy} onClick={() => add(d.databaseId)}>＋ Add</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
