import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/KpiCard';
import Modal from '../components/shared/Modal';
import TabNav from '../components/shared/TabNav';
import useApiData from '../hooks/useApiData';
import { apiPost, apiDelete } from '../api/client';
import { toast } from '../components/shared/Toast';

const ENGINE_TABS = [
  { id: 'all', label: 'All' }, { id: 'oracle', label: 'Oracle' }, { id: 'mssql', label: 'SQL Server' },
  { id: 'db2', label: 'Db2' }, { id: 'postgres', label: 'PostgreSQL' }, { id: 'mysql', label: 'MySQL' }, { id: 'mongodb', label: 'MongoDB' },
];
const ENGINE_LABEL = { oracle: 'Oracle', mssql: 'SQL Server', db2: 'Db2', postgresql: 'PostgreSQL', mysql: 'MySQL', mongodb: 'MongoDB' };
const SENS_CLS = { SSN: 'red', PHI: 'red', GDPR: 'red', Aadhaar: 'red', PCI: 'amber', PII: 'badge-ind', SIN: 'badge-ind' };
const COV_KEYS = [['net', 'N'], ['host', 'H'], ['pull', 'P'], ['push', 'C']];
const AGENT_MODES = ['Host (eBPF)', 'Network', 'Inline Proxy'];

function engineMatchesTab(engine, tab) {
  if (tab === 'all') return true;
  if (tab === 'postgres') return (engine || '').startsWith('postgres');
  return engine === tab;
}
const engineDisplay = (engine, version) => `${ENGINE_LABEL[engine] || engine}${version ? ' ' + version : ''}`;
const riskColor = (r) => (r >= 70 ? 'var(--danger)' : r >= 45 ? 'var(--amber)' : 'var(--green)');

function StatusBadge({ status }) {
  const map = { active: 'green', degraded: 'amber', unmonitored: 'red', paused: '' };
  return <span className={`badge ${map[status] || ''} dot`}>{status}</span>;
}
function SensCells({ tags }) {
  if (!tags || !tags.length) return <span className="muted">—</span>;
  return <>{tags.map((t) => <span key={t} className={`badge ${SENS_CLS[t] || ''}`} style={{ marginRight: 4 }}>{t}</span>)}</>;
}
function MonitoringCell({ monitoring }) {
  if (!monitoring || !monitoring.length) return <span className="mon-status"><span className="mon-pill none">Not monitored</span></span>;
  return <span className="mon-status">{monitoring.map((m) => <span key={m} className={`mon-pill ${AGENT_MODES.includes(m) ? 'agent' : 'agentless'}`}>{m}</span>)}</span>;
}
function CoverageCell({ coverage }) {
  return <span className="cov">{COV_KEYS.map(([k, ch]) => <span key={k} className={coverage[k] ? 'on' : ''} title={k}>{ch}</span>)}</span>;
}

export default function Databases() {
  const navigate = useNavigate();
  const inst = useApiData('/instances');
  const dbs = useApiData('/databases');
  const [tab, setTab] = useState('instances');
  const [engTab, setEngTab] = useState('all');
  const [query, setQuery] = useState('');
  const [detail, setDetail] = useState(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [addDbTo, setAddDbTo] = useState(null); // instance to add a database to
  const [confirm, setConfirm] = useState(null); // { kind, id, name, extra }

  const refreshAll = () => { inst.refetch(); dbs.refetch(); };

  const instances = Array.isArray(inst.data) ? inst.data : [];
  const databases = Array.isArray(dbs.data) ? dbs.data : [];

  const monitoredInst = instances.filter((i) => i.agents.total > 0).length;
  const degradedInst = instances.filter((i) => i.status === 'degraded').length;
  const highRisk = databases.filter((d) => (d.risk_score || 0) >= 70).length;
  const sensitive = databases.filter((d) => d.sensitivity.length > 0).length;

  const fInstances = instances.filter((i) => engineMatchesTab(i.engine, engTab) && (!query || (i.instance || '').toLowerCase().includes(query.toLowerCase())));
  const fDatabases = databases.filter((d) => engineMatchesTab(d.engine, engTab) && (!query || d.name.toLowerCase().includes(query.toLowerCase())));

  const doDelete = async () => {
    const c = confirm;
    setConfirm(null);
    const res = c.kind === 'instance' ? await apiDelete(`/instances/${c.id}`) : await apiDelete(`/databases/${c.id}`);
    if (res && res.ok) { toast(c.kind === 'instance' ? `Instance ${c.name} decommissioned` : `Database ${c.name} removed`, 'ok'); refreshAll(); }
    else toast((res && res.data && res.data.error) || 'Delete failed', 'err');
  };

  const exportCsv = () => {
    const header = ['Instance', 'Engine', 'Deployment', 'Env', 'Monitoring', 'Databases', 'Risk', 'Status'];
    const lines = instances.map((i) => [i.instance, engineDisplay(i.engine, i.version), i.deployment, i.environment, i.monitoring.join(' + ') || 'Not monitored', i.database_count, i.risk_score, i.status]);
    const csv = [header, ...lines].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'toovix-instances.csv'; a.click(); URL.revokeObjectURL(url);
    toast('Exported to CSV', 'ok');
  };

  if (inst.loading || dbs.loading) {
    return <Layout><div className="loading-screen"><div className="loading-spinner" /><p>Loading…</p></div></Layout>;
  }

  return (
    <Layout lastRefresh={new Date()} onRefresh={refreshAll}>
      <PageHeader title="Databases" meta={[`${instances.length} instances`, `${databases.length} databases`, `${new Set(instances.map((i) => i.engine)).size} engines`]}>
        <button className="btn-secondary" onClick={exportCsv}>⤓ Export</button>
        <button className="btn-primary" onClick={() => setRegisterOpen(true)}>＋ Register instance</button>
      </PageHeader>

      <section className="kpi-grid c5">
        <KpiCard icon="▤" label="Instances" value={instances.length} detail="database servers" />
        <KpiCard icon="◧" iconBg="var(--info-soft)" iconColor="var(--info)" label="Databases" value={databases.length} detail="schemas across instances" />
        <KpiCard icon="●" iconBg="var(--green-soft)" iconColor="var(--green)" label="Monitored" value={monitoredInst} detail="instances with agents" />
        <KpiCard icon="●" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Degraded" value={degradedInst} detail="coverage gap" detailType={degradedInst > 0 ? 'down' : 'up'} />
        <KpiCard icon="◈" iconBg="var(--danger-soft)" iconColor="var(--danger)" label="Sensitive" value={sensitive} detail="hold PII / PCI / PHI" />
      </section>

      <TabNav tabs={[{ id: 'instances', label: 'Instances', count: instances.length }, { id: 'databases', label: 'Databases', count: databases.length }]} active={tab} onChange={setTab} />

      <div className="card">
        <div className="card-header" style={{ gap: 14 }}>
          <div className="eng-tabs">
            {ENGINE_TABS.map((t) => <button key={t.id} className={`eng-tab ${engTab === t.id ? 'active' : ''}`} onClick={() => setEngTab(t.id)}>{t.label}</button>)}
          </div>
          <input className="db-filter" placeholder="Filter…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="card-body no-pad" style={{ overflowX: 'auto' }}>
          {tab === 'instances' ? (
            <table className="data-table">
              <thead><tr><th>Instance</th><th>Engine</th><th>Deployment</th><th>Env</th><th>Monitoring</th><th>Coverage</th><th className="num">DBs</th><th className="num">Risk</th><th>Status</th><th /></tr></thead>
              <tbody>
                {fInstances.map((i) => (
                  <tr key={i.id}>
                    <td><b>{i.name}</b>{i.name !== i.instance && <div className="mono muted" style={{ fontSize: 11 }}>{i.instance}</div>}</td>
                    <td><span className="badge">{engineDisplay(i.engine, i.version)}</span>{i.is_paas && <span style={{ fontSize: 9, color: 'var(--info)', fontWeight: 700, marginLeft: 4 }}>PaaS</span>}</td>
                    <td>{i.deployment}</td>
                    <td><span className={`badge ${i.environment === 'prod' ? 'badge-ind' : ''}`}>{i.environment}</span></td>
                    <td><MonitoringCell monitoring={i.monitoring} /></td>
                    <td><CoverageCell coverage={i.coverage} /></td>
                    <td className="num">{i.database_count}</td>
                    <td className="num"><b style={{ color: riskColor(i.risk_score) }}>{i.risk_score}</b></td>
                    <td><StatusBadge status={i.status} /></td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn-secondary" style={{ padding: '4px 9px', fontSize: 12 }} onClick={() => setAddDbTo(i)}>＋ DB</button>{' '}
                      <button className="btn-secondary" style={{ padding: '4px 9px', fontSize: 12 }} onClick={() => navigate(`/agents?deploy=1&instance=${i.id}`)} disabled={i.is_paas}>Deploy</button>{' '}
                      <button className="btn-secondary" style={{ padding: '4px 9px', fontSize: 12, borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => setConfirm({ kind: 'instance', id: i.id, name: i.instance, extra: i.database_count })}>Delete</button>
                    </td>
                  </tr>
                ))}
                {fInstances.length === 0 && <tr><td colSpan={10} className="chart-empty">No instances match this filter</td></tr>}
              </tbody>
            </table>
          ) : (
            <table className="data-table">
              <thead><tr><th>Database</th><th>Instance</th><th>Engine</th><th>Sensitivity</th><th className="num">Risk</th><th>Status</th><th /></tr></thead>
              <tbody>
                {fDatabases.map((d) => (
                  <tr key={d.id}>
                    <td style={{ cursor: 'pointer' }} onClick={() => setDetail(d)}><b>{d.name}</b></td>
                    <td>{d.instance_name}{d.instance_name !== d.instance && <div className="mono muted" style={{ fontSize: 11 }}>{d.instance}</div>}</td>
                    <td><span className="badge">{engineDisplay(d.engine, d.version)}</span></td>
                    <td><SensCells tags={d.sensitivity} /></td>
                    <td className="num"><b style={{ color: riskColor(d.risk_score) }}>{d.risk_score}</b></td>
                    <td><StatusBadge status={d.status} /></td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn-secondary" style={{ padding: '4px 9px', fontSize: 12, borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => setConfirm({ kind: 'database', id: d.id, name: d.name })}>Delete</button>
                    </td>
                  </tr>
                ))}
                {fDatabases.length === 0 && <tr><td colSpan={7} className="chart-empty">No databases match this filter</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Database detail */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.name || 'Database'} width={680}>
        {detail && (
          <>
            <div className="rmmeta">
              <span>Engine <b>{engineDisplay(detail.engine, detail.version)}</b></span>
              <span>Instance <b>{detail.instance_name}</b></span>
              <span>Endpoint <b className="mono">{detail.instance}</b></span>
              <span>Environment <b>{detail.environment}</b></span>
              <span>Risk <b style={{ color: riskColor(detail.risk_score) }}>{detail.risk_score}/100</b></span>
            </div>
            {detail.instance_databases > 1 && (
              <div className="muted" style={{ fontSize: 12, margin: '-4px 0 12px' }}>This instance hosts <b style={{ color: 'var(--ink)' }}>{detail.instance_databases}</b> databases — they share the agents deployed on the instance.</div>
            )}
            <div className="grid2" style={{ marginBottom: 12 }}>
              <div className="card"><div className="card-body"><div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>CAPTURE (from instance)</div><CoverageCell coverage={detail.coverage} /><div style={{ fontSize: 12, marginTop: 8, color: 'var(--muted)' }}>{detail.monitoring.length ? detail.monitoring.join(' · ') : 'Not monitored'}</div></div></div>
              <div className="card"><div className="card-body"><div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>SENSITIVITY</div><SensCells tags={detail.sensitivity} /></div></div>
            </div>
            <div className="modal-footer" style={{ padding: '4px 0 0', justifyContent: 'flex-end' }}>
              <button className="btn-secondary" onClick={() => { setDetail(null); navigate('/alerts'); }}>View alerts</button>
              <button className="btn-primary" onClick={() => { const id = detail.instance_id; setDetail(null); navigate(`/agents?deploy=1&instance=${id}`); }}>Deploy monitoring</button>
            </div>
          </>
        )}
      </Modal>

      {/* Register instance */}
      <Modal open={registerOpen} onClose={() => setRegisterOpen(false)} title="＋ Register database instance" width={760}>
        <RegisterInstanceForm onClose={() => setRegisterOpen(false)} onDone={refreshAll} />
      </Modal>

      {/* Add database to instance */}
      <Modal open={!!addDbTo} onClose={() => setAddDbTo(null)} title={`Add database to ${addDbTo?.instance || ''}`} width={480}>
        {addDbTo && <AddDatabaseForm instance={addDbTo} onClose={() => setAddDbTo(null)} onDone={refreshAll} />}
      </Modal>

      {/* Confirm delete */}
      <Modal open={!!confirm} onClose={() => setConfirm(null)} title={confirm?.kind === 'instance' ? 'Decommission instance' : 'Remove database'} width={460}>
        {confirm && (
          <>
            <p style={{ fontSize: 13.5, lineHeight: 1.55 }}>
              {confirm.kind === 'instance'
                ? <>Decommission <b className="mono">{confirm.name}</b>? This permanently removes the instance, its <b>{confirm.extra}</b> database{confirm.extra === 1 ? '' : 's'}, and all agents deployed on it.</>
                : <>Remove database <b>{confirm.name}</b>? This deletes the schema record and its alerts. The instance and its agents are unaffected.</>}
            </p>
            <div className="modal-footer" style={{ padding: '8px 0 0', justifyContent: 'flex-end' }}>
              <button className="btn-secondary" onClick={() => setConfirm(null)}>Cancel</button>
              <button className="btn-primary" style={{ background: 'var(--danger)' }} onClick={doDelete}>{confirm.kind === 'instance' ? 'Decommission' : 'Remove'}</button>
            </div>
          </>
        )}
      </Modal>
    </Layout>
  );
}

const DISCOVERY = [
  { name: 'aurora-mysql-billing-2', meta: 'AWS RDS · us-east-1 · MySQL 8.0', engine: 'mysql', version: '8.0', deployment_type: 'rds', cloud_provider: 'aws', region: 'us-east-1' },
  { name: 'azuresql-analytics', meta: 'Azure SQL · westeurope · SQL Server', engine: 'mssql', version: 'Azure SQL', deployment_type: 'azuresql', cloud_provider: 'azure', region: 'westeurope' },
  { name: 'ocidb-hr-prod', meta: 'OCI · us-ashburn-1 · Oracle Autonomous', engine: 'oracle', version: 'Autonomous', deployment_type: 'oci', cloud_provider: 'oci', region: 'us-ashburn-1' },
];

function RegisterInstanceForm({ onClose, onDone }) {
  const [mode, setMode] = useState('manual');
  const [done, setDone] = useState([]);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', engine: 'oracle', host: '', deployment_type: 'onprem', environment: 'prod', initial_database: '' });

  const register = async (payload, label) => {
    const res = await apiPost('/instances', payload);
    if (res && res.ok) { toast(`Instance ${label} registered`, 'ok'); onDone(); return true; }
    toast((res && res.data && res.data.error) || 'Registration failed', 'err'); return false;
  };

  const registerDiscovery = async (d) => {
    const ok = await register({ name: d.name, engine: d.engine, version: d.version, host: d.name, deployment_type: d.deployment_type, cloud_provider: d.cloud_provider, region: d.region }, d.name);
    if (ok) setDone((x) => [...x, d.name]);
  };

  const saveManual = async () => {
    if (!form.host) { toast('Host : port is required', 'err'); return; }
    setSaving(true);
    const [host, port] = form.host.split(':');
    const ok = await register({ name: form.name || undefined, engine: form.engine, host, port: port ? parseInt(port) : null, deployment_type: form.deployment_type, environment: form.environment, initial_database: form.initial_database || undefined }, form.name || host);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <>
      <div className="modetab">
        <button className={mode === 'manual' ? 'on' : ''} onClick={() => setMode('manual')}>✎ Manual</button>
        <button className={mode === 'auto' ? 'on' : ''} onClick={() => setMode('auto')}>☁ Cloud Discovery</button>
      </div>

      {mode === 'manual' && (
        <div>
          <p className="muted" style={{ fontSize: 13, margin: '0 0 12px' }}>Register a database server (instance). You can add its databases/schemas after — they’ll share the instance’s agents.</p>
          <div className="row2">
            <div className="form-field"><label>Display name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="optional — defaults to host:port" /></div>
            <div className="form-field"><label>Engine *</label>
              <select value={form.engine} onChange={(e) => setForm({ ...form, engine: e.target.value })}>
                <option value="oracle">Oracle</option><option value="mssql">SQL Server</option><option value="db2">IBM Db2</option><option value="postgresql">PostgreSQL</option><option value="mysql">MySQL / MariaDB</option><option value="mongodb">MongoDB</option>
              </select>
            </div>
          </div>
          <div className="row2">
            <div className="form-field"><label>Host : port *</label><input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="10.20.14.8:1521" /></div>
            <div className="form-field"><label>Deployment</label>
              <select value={form.deployment_type} onChange={(e) => setForm({ ...form, deployment_type: e.target.value })}>
                <option value="onprem">On-premises</option><option value="iaas">IaaS (VM)</option><option value="rds">AWS RDS / Aurora</option><option value="azuresql">Azure SQL</option><option value="cloudsql">Google Cloud SQL</option><option value="atlas">MongoDB Atlas</option><option value="oci">OCI Autonomous</option>
              </select>
            </div>
          </div>
          <div className="row2">
            <div className="form-field"><label>Environment</label>
              <select value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })}><option value="prod">prod</option><option value="staging">staging</option><option value="dev">dev</option><option value="dr">dr</option></select>
            </div>
            <div className="form-field"><label>First database (optional)</label><input value={form.initial_database} onChange={(e) => setForm({ ...form, initial_database: e.target.value })} placeholder="e.g. payments" /></div>
          </div>
          <div className="modal-footer" style={{ padding: '14px 0 0', justifyContent: 'flex-end' }}>
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" onClick={saveManual} disabled={saving}>{saving ? 'Registering…' : 'Register instance'}</button>
          </div>
        </div>
      )}

      {mode === 'auto' && (
        <div>
          <p className="muted" style={{ fontSize: 13, margin: '0 0 12px' }}>Managed instances discovered from your cloud accounts.</p>
          {DISCOVERY.map((d) => (
            <div className="scanrow" key={d.name}>
              <span className="badge green">found</span> <b>{d.name}</b> <span className="muted">{d.meta}</span>
              {done.includes(d.name) ? <span className="badge green" style={{ marginLeft: 'auto' }}>registered</span> : <button className="btn-secondary" style={{ marginLeft: 'auto', padding: '6px 14px' }} onClick={() => registerDiscovery(d)}>Register</button>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function AddDatabaseForm({ instance, onClose, onDone }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!name) { toast('Database name is required', 'err'); return; }
    setSaving(true);
    const res = await apiPost('/databases', { name, instance_id: instance.id });
    setSaving(false);
    if (res && res.ok) { toast(`Added ${name} to ${instance.instance}`, 'ok'); onDone(); onClose(); }
    else toast((res && res.data && res.data.error) || 'Failed to add database', 'err');
  };
  return (
    <>
      <p className="muted" style={{ fontSize: 13, margin: '0 0 12px' }}>Adding a database to <b className="mono" style={{ color: 'var(--ink)' }}>{instance.instance}</b>. It inherits the instance’s agents{instance.monitoring.length ? ` (${instance.monitoring.join(' + ')})` : ' once any are deployed'} — auto-covered, no redeploy.</p>
      <div className="form-field"><label>Database / schema name *</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. inventory" autoFocus /></div>
      <div className="modal-footer" style={{ padding: '8px 0 0', justifyContent: 'flex-end' }}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Adding…' : 'Add database'}</button>
      </div>
    </>
  );
}
