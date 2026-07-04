import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/KpiCard';
import Modal from '../components/shared/Modal';
import { toast } from '../components/shared/Toast';
import useApiData from '../hooks/useApiData';
import { apiPost } from '../api/client';

// Port-set presets — mirrors dev/dam/discovery/portsets.js so the UI can preview
// how many ports/host a scan will probe. The scanner identifies engines by
// protocol handshake, so a wider set just widens *where* we look.
const PORT_PRESETS = {
  default: { label: 'Default ports only', count: 9, hint: 'textbook ports — fastest, misses relocated DBs' },
  common: { label: 'Default + common alternates', count: 27, hint: 'recommended — catches the usual non-default ports' },
  top: { label: 'Top relocated ports', count: 39, hint: 'broader curated set' },
  full: { label: 'Full range (1–65535)', count: 65535, hint: 'exhaustive — slow + noisy, use rate limiting' },
  custom: { label: 'Custom list / ranges', count: null, hint: 'e.g. 5432, 3300-3400, 27017-27019' },
};

function countCustomPorts(spec) {
  if (!spec) return 0;
  let n = 0;
  for (const tok of spec.split(',')) {
    const t = tok.trim();
    if (!t) continue;
    if (t.includes('-')) { const [a, b] = t.split('-').map((x) => parseInt(x, 10)); if (a <= b) n += b - a + 1; }
    else if (parseInt(t, 10)) n += 1;
  }
  return n;
}

const ENGINE_LABEL = { postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', oracle: 'Oracle', mssql: 'SQL Server', mongodb: 'MongoDB', redis: 'Redis', cassandra: 'Cassandra', db2: 'Db2' };
const PAAS_DEPLOYMENTS = ['rds', 'aurora', 'azuresql', 'cloudsql', 'atlas', 'oci', 'cosmos'];

// Map a backend discovery_candidates row to the shape this page renders.
function mapCandidate(c) {
  const isPaas = PAAS_DEPLOYMENTS.includes((c.deployment_type || '').toLowerCase()) || (!!c.cloud_provider && c.source === 'cloud_api');
  return {
    id: c.id,
    ep: c.endpoint,
    eng: ENGINE_LABEL[c.engine] || c.engine || 'Unknown',
    src: c.source === 'cloud_api' ? `${c.cloud_provider || 'Cloud'} API` : c.source === 'manual' ? 'Manual' : 'Network',
    loc: c.region || (c.deployment_type === 'onprem' ? 'on-prem' : c.deployment_type) || '—',
    sig: c.signal === 'sensitive' ? 'sensitive' : 'ok',
    mode: isPaas ? 'paas' : 'agent',
    cloud: c.cloud_provider || 'On-prem',
    reachable: c.reachable !== false,
    lastSeen: c.last_seen,
  };
}

function jobAge(ts) {
  if (!ts) return '—';
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export default function Discovery() {
  const navigate = useNavigate();
  const { data: candData, refetch: refetchCands } = useApiData('/discovery/candidates', { poll: 30000 });
  const { data: jobData, refetch: refetchJobs } = useApiData('/discovery/jobs', { poll: 30000 });
  const { data: dbData, refetch: refetchDbs } = useApiData('/databases', { poll: 30000 });
  const [scanCfg, setScanCfg] = useState(null); // open scan-config modal when set
  const [confirmCand, setConfirmCand] = useState(null); // unreachable-approve confirmation

  // Live data only — no sample/static data.
  const candidates = Array.isArray(candData) ? candData.map(mapCandidate) : [];
  const jobs = Array.isArray(jobData)
    ? jobData.map((j) => ({ job: j.id, type: j.scan_type === 'cloud_api' ? 'Cloud API' : j.scan_type === 'manual' ? 'Manual' : 'Network', scope: j.scope || '—', ports: j.port_set, found: `${j.found || 0} new`, status: j.status, when: jobAge(j.created_at) }))
    : [];
  const registered = Array.isArray(dbData) ? dbData.length : 0;
  const cloudsScanned = new Set(candidates.map((c) => c.cloud)).size;
  const sensitiveCount = candidates.filter((c) => c.sig === 'sensitive').length;

  const openScan = () => setScanCfg({ scanType: 'network', preset: 'common', customPorts: '', scope: 'client-postgres, client-mysql, client-mongo' });

  const runScan = async () => {
    const cfg = scanCfg;
    const ports_count = cfg.preset === 'custom' ? countCustomPorts(cfg.customPorts) : PORT_PRESETS[cfg.preset].count;
    const res = await apiPost('/discovery/scan', {
      scan_type: cfg.scanType,
      scope: cfg.scope,
      port_set: cfg.preset === 'custom' ? cfg.customPorts : cfg.preset,
      ports_count,
    });
    setScanCfg(null);
    if (res && res.ok) {
      toast(`Scan ${res.data.id} queued — ${ports_count.toLocaleString()} ports/host`, 'ok');
      refetchJobs();
      setTimeout(refetchCands, 1500);
    } else {
      toast('Could not start scan', 'err');
    }
  };

  // Discovery only REGISTERS the asset (instance + database). Agent monitoring is
  // deployed separately from the Agent Fleet page. Unreachable candidates confirm first.
  const approve = (c) => {
    if (!c.reachable) { setConfirmCand(c); return; }
    register(c);
  };
  const register = async (c) => {
    if (!c.id) return;
    const res = await apiPost(`/discovery/candidates/${c.id}/approve`, { database_name: c.ep.split(':')[0] });
    if (res && res.ok) {
      toast(`Registered ${c.ep} — deploy monitoring from the Agent Fleet page`, 'ok');
      refetchCands(); refetchDbs();
    } else {
      toast('Could not register database', 'err');
    }
  };

  return (
    <Layout lastRefresh={new Date()} onRefresh={refetchCands}>
      <PageHeader title="Discovery" meta={['cloud API + network scan + manual', `${candidates.length} candidates`]}>
        <button className="btn-secondary" onClick={openScan}>⊞ Run scan</button>
        <button className="btn-primary" onClick={() => navigate('/databases')}>View registered</button>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="▣" iconBg="var(--green-soft)" iconColor="var(--green)" label="Registered" value={registered} detail="monitored" />
        <KpiCard icon="⊹" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Candidates" value={candidates.length} detail="awaiting review" detailType="down" />
        <KpiCard icon="⚠" iconBg="var(--danger-soft)" iconColor="var(--danger)" label="Unmonitored sensitive" value={sensitiveCount} detail="PII detected" detailType="down" />
        <KpiCard icon="☁" iconBg="var(--info-soft)" iconColor="var(--info)" label="Clouds covered" value={cloudsScanned} detail="across discovered candidates" />
      </section>

      <div className="card">
        <div className="card-header"><span className="card-title">Discovery candidates</span><span className="card-sub">approve to register · deploy agents from Agent Fleet</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Endpoint</th><th>Engine</th><th>Source</th><th>Location</th><th>Reachability</th><th>Signal</th><th /></tr></thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={c.ep} style={c.reachable ? undefined : { opacity: 0.6 }}>
                  <td className="mono" style={{ fontSize: 12 }}>{c.ep}</td>
                  <td><span className="badge">{c.eng}</span>{c.mode === 'paas' && <span className="badge blue" style={{ marginLeft: 4 }}>PaaS</span>}</td>
                  <td>{c.src}</td><td>{c.loc}</td>
                  <td>{c.reachable ? <span className="badge green dot">reachable</span> : <span className="badge red dot">unreachable</span>}</td>
                  <td>{c.sig === 'sensitive' ? <span className="badge red">sensitive ports open</span> : <span className="badge">clean</span>}</td>
                  <td style={{ textAlign: 'right' }}><button className="btn-secondary" style={{ padding: '6px 14px' }} onClick={() => approve(c)}>Approve</button></td>
                </tr>
              ))}
              {candidates.length === 0 && <tr><td colSpan={7} className="chart-empty">No candidates awaiting review</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-header"><span className="card-title">Recent scan jobs</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Job</th><th>Type</th><th>Scope</th><th>Port set</th><th>Found</th><th>Status</th><th>When</th></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.job}>
                  <td className="mono">{j.job}</td><td>{j.type}</td><td>{j.scope}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{j.ports || '—'}</td><td>{j.found}</td>
                  <td><span className={`badge ${j.status === 'done' ? 'green' : j.status === 'failed' ? 'red' : ''}`}>{j.status || 'done'}</span></td>
                  <td className="muted">{j.when}</td>
                </tr>
              ))}
              {jobs.length === 0 && <tr><td colSpan={7} className="chart-empty">No scans run yet</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={!!scanCfg} onClose={() => setScanCfg(null)} title="Run discovery scan" width={560}>
        {scanCfg && (() => {
          const portCount = scanCfg.preset === 'custom' ? countCustomPorts(scanCfg.customPorts) : PORT_PRESETS[scanCfg.preset].count;
          return (
            <>
              <div className="form-field">
                <label>Scan type</label>
                <select value={scanCfg.scanType} onChange={(e) => setScanCfg({ ...scanCfg, scanType: e.target.value })}>
                  <option value="network">Network scan (IaaS / on-prem)</option>
                  <option value="cloud_api">Cloud API enumeration (PaaS)</option>
                </select>
              </div>
              <div className="form-field">
                <label>{scanCfg.scanType === 'cloud_api' ? 'Cloud accounts / regions' : 'Targets (hosts / CIDR)'}</label>
                <input value={scanCfg.scope} onChange={(e) => setScanCfg({ ...scanCfg, scope: e.target.value })}
                  placeholder={scanCfg.scanType === 'cloud_api' ? 'aws:us-east-1, azure:westeurope' : '10.20.0.0/16, client-postgres'} />
              </div>

              {scanCfg.scanType === 'network' && (
                <>
                  <div className="form-field">
                    <label>Port set</label>
                    <select value={scanCfg.preset} onChange={(e) => setScanCfg({ ...scanCfg, preset: e.target.value })}>
                      {Object.entries(PORT_PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </select>
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{PORT_PRESETS[scanCfg.preset].hint}</div>
                  </div>
                  {scanCfg.preset === 'custom' && (
                    <div className="form-field">
                      <label>Ports / ranges</label>
                      <input className="mono" value={scanCfg.customPorts} onChange={(e) => setScanCfg({ ...scanCfg, customPorts: e.target.value })} placeholder="5432, 3300-3400, 27017-27019" />
                    </div>
                  )}
                  <div style={{ background: 'var(--info-soft)', borderRadius: 10, padding: '10px 14px', fontSize: 12.5, lineHeight: 1.5 }}>
                    Probes <b>≈ {Number(portCount).toLocaleString()} ports/host</b>, then identifies each open port by protocol <b>handshake</b> — so databases on non-default ports are still found.
                    {scanCfg.preset === 'full' && <div style={{ color: 'var(--amber)', marginTop: 4 }}>⚠ Full-range scans are slow and trip IDS — rate-limit in production.</div>}
                  </div>
                </>
              )}
              {scanCfg.scanType === 'cloud_api' && (
                <div style={{ background: 'var(--green-soft)', borderRadius: 10, padding: '10px 14px', fontSize: 12.5, lineHeight: 1.5 }}>
                  Managed databases are enumerated via the provider control-plane API (read-only IAM) — no port scanning. Port set does not apply.
                </div>
              )}

              <div className="modal-footer" style={{ padding: '16px 0 0', justifyContent: 'flex-end' }}>
                <button className="btn-secondary" onClick={() => setScanCfg(null)}>Cancel</button>
                <button className="btn-primary" onClick={runScan}>Start scan</button>
              </div>
            </>
          );
        })()}
      </Modal>

      <Modal open={!!confirmCand} onClose={() => setConfirmCand(null)} title="Database unreachable" width={460}>
        {confirmCand && (
          <>
            <p style={{ fontSize: 13.5, lineHeight: 1.55, margin: '0 0 8px' }}>
              <b className="mono">{confirmCand.ep}</b> is currently <b style={{ color: 'var(--danger)' }}>unreachable</b>
              {confirmCand.lastSeen ? <> (last seen {jobAge(confirmCand.lastSeen)})</> : ''}.
            </p>
            <p className="muted" style={{ fontSize: 13, lineHeight: 1.55, margin: 0 }}>
              You can register it now, but monitoring will only begin once a scan can reach the database again.
            </p>
            <div className="modal-footer" style={{ padding: '18px 0 0', justifyContent: 'flex-end' }}>
              <button className="btn-secondary" onClick={() => setConfirmCand(null)}>Cancel</button>
              <button className="btn-primary" onClick={() => { const c = confirmCand; setConfirmCand(null); register(c); }}>Register anyway</button>
            </div>
          </>
        )}
      </Modal>
    </Layout>
  );
}
