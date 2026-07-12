import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/KpiCard';
import Modal from '../components/shared/Modal';
import { toast } from '../components/shared/Toast';
import useApiData from '../hooks/useApiData';
import { apiPost, apiDelete } from '../api/client';

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
  const { data: cloudCfg } = useApiData('/settings/cloud-providers', { poll: 0 });
  const tenantClouds = Array.isArray(cloudCfg?.providers) ? cloudCfg.providers : [];
  const cloudLabel = (id) => (cloudCfg?.available || []).find((a) => a.id === id)?.label || id;
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

  const openScan = () => setScanCfg({ scanType: 'network', preset: 'common', customPorts: '', scope: 'client-postgres, client-mysql, client-mongo', providers: [] });

  const runScan = async () => {
    const cfg = scanCfg;
    if (cfg.scanType === 'cloud_api') {
      if (!(cfg.providers || []).length) { toast('Pick at least one cloud to enumerate', 'err'); return; }
      const res = await apiPost('/discovery/scan', { scan_type: 'cloud_api', scope: cfg.providers.join(', '), providers: cfg.providers });
      setScanCfg(null);
      if (res && res.ok) {
        const { found = 0, errors = [] } = res.data || {};
        if (errors.length) toast(`Cloud discovery: ${found} found · ${errors.join('; ')}`, found ? 'ok' : 'err');
        else toast(`Cloud discovery complete — ${found} instance(s) found`, 'ok');
        refetchJobs(); setTimeout(refetchCands, 1000);
      } else toast(res?.data?.error || 'Could not start cloud discovery', 'err');
      return;
    }
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
  const toggleProvider = (id) => setScanCfg((c) => ({ ...c, providers: c.providers.includes(id) ? c.providers.filter((x) => x !== id) : [...c.providers, id] }));

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

      <CloudConnectors tenantClouds={tenantClouds} cloudLabel={cloudLabel} onChanged={() => { refetchJobs(); refetchCands(); }} />

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
              {scanCfg.scanType === 'network' && (
                <div className="form-field">
                  <label>Targets (hosts / CIDR)</label>
                  <input value={scanCfg.scope} onChange={(e) => setScanCfg({ ...scanCfg, scope: e.target.value })}
                    placeholder="10.20.0.0/16, client-postgres" />
                </div>
              )}

              {scanCfg.scanType === 'cloud_api' && (
                <div className="form-field">
                  <label>Which cloud(s) to enumerate</label>
                  {tenantClouds.length === 0 ? (
                    <div style={{ background: 'var(--amber-soft)', borderRadius: 10, padding: '10px 14px', fontSize: 12.5, lineHeight: 1.5 }}>
                      No clouds configured for this workspace. Set your <b>Cloud environment</b> in
                      {' '}<a href="/settings">Settings → General</a> first, then run cloud discovery.
                    </div>
                  ) : (
                    <div style={{ display: 'grid', gap: 8 }}>
                      {tenantClouds.map((id) => (
                        <label key={id} className="approach-card" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', cursor: 'pointer' }}>
                          <input type="checkbox" checked={scanCfg.providers.includes(id)} onChange={() => toggleProvider(id)} />
                          <span style={{ fontSize: 13 }}><b style={{ textTransform: 'uppercase', marginRight: 6 }}>{id}</b><span className="muted">{cloudLabel(id)}</span></span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}

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
                <button className="btn-primary" onClick={runScan} disabled={scanCfg.scanType === 'cloud_api' && scanCfg.providers.length === 0}>
                  {scanCfg.scanType === 'cloud_api' ? 'Run cloud discovery' : 'Start scan'}
                </button>
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

// ── Cloud connectors — the READ-ONLY credential per cloud that agentless discovery uses ──
function CloudConnectors({ tenantClouds, cloudLabel, onChanged }) {
  const { data, refetch } = useApiData('/discovery/connectors', { poll: 0 });
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(null);
  const connectors = Array.isArray(data) ? data : [];

  const test = async (id) => {
    setBusy(id);
    const res = await apiPost(`/discovery/connectors/${id}/test`, {});
    setBusy(null);
    if (res?.ok && res.data.ok) toast(`Connector OK — ${res.data.count} instance(s) visible`, 'ok');
    else toast(res?.data?.error || 'Connector test failed', 'err');
    refetch();
  };
  const remove = async (id) => {
    setBusy(id);
    const res = await apiDelete(`/discovery/connectors/${id}`);
    setBusy(null);
    if (res?.ok) { toast('Connector removed', 'ok'); refetch(); onChanged?.(); }
    else toast('Could not remove', 'err');
  };

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-header">
        <span className="card-title">Cloud connectors</span>
        <span className="card-sub">read-only credentials for agentless (cloud-API) discovery</span>
        <button className="btn-secondary" style={{ marginLeft: 'auto', padding: '5px 12px', fontSize: 12.5 }} onClick={() => setAdding(true)}>＋ Connect a cloud</button>
      </div>
      <div className="card-body no-pad">
        <table className="data-table">
          <thead><tr><th>Cloud</th><th>Project / account</th><th>Identity</th><th>Status</th><th>Agentless ingest</th><th>Last run</th><th /></tr></thead>
          <tbody>
            {connectors.length === 0 && <tr><td colSpan={7} className="chart-empty">No cloud connectors. Add one to enumerate managed databases (Cloud SQL, RDS…) without a network scan.</td></tr>}
            {connectors.map((c) => (
              <tr key={c.id}>
                <td><b style={{ textTransform: 'uppercase' }}>{c.provider}</b></td>
                <td className="mono" style={{ fontSize: 12 }}>{c.project || '—'}</td>
                <td className="mono" style={{ fontSize: 11.5 }}>{c.identity || '—'}</td>
                <td>{c.status === 'ok' ? <span className="badge green dot">ok</span> : c.status === 'error' ? <span className="badge red dot" title={c.last_result}>error</span> : <span className="badge">configured</span>}</td>
                <td style={{ fontSize: 12 }}>{!c.subscription ? <span className="muted">off</span>
                  : c.ingest_status === 'ok' ? <span className="badge green dot" title={`${c.subscription}\n${c.last_result || ''}`}>streaming</span>
                  : c.ingest_status === 'error' ? <span className="badge red dot" title={c.last_result}>error</span>
                  : <span className="badge" title={c.subscription}>configured</span>}</td>
                <td style={{ fontSize: 12 }} title={c.last_result || ''}>{c.last_ingest_at || c.last_run_at ? new Date(c.last_ingest_at || c.last_run_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 11 }} disabled={busy === c.id} onClick={() => test(c.id)}>Test</button>{' '}
                  <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 11, color: 'var(--danger)', borderColor: 'var(--danger)' }} disabled={busy === c.id} onClick={() => remove(c.id)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal open={adding} onClose={() => setAdding(false)} title="Connect a cloud (read-only)" width={640}>
        <AddConnector tenantClouds={tenantClouds} cloudLabel={cloudLabel} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); refetch(); }} />
      </Modal>
    </div>
  );
}

const GCP_SETUP = `# Create a READ-ONLY service account for Cloud SQL discovery (run in your GCP project):
export PROJECT=YOUR_PROJECT_ID
gcloud iam service-accounts create toovix-dam-discovery \\
  --project=$PROJECT --display-name="TooVix DAM discovery (read-only)"
gcloud projects add-iam-policy-binding $PROJECT \\
  --member="serviceAccount:toovix-dam-discovery@$PROJECT.iam.gserviceaccount.com" \\
  --role="roles/cloudsql.viewer"
# Generate a key to paste below (or use Workload Identity Federation for keyless):
gcloud iam service-accounts keys create sa.json \\
  --iam-account=toovix-dam-discovery@$PROJECT.iam.gserviceaccount.com
cat sa.json   # paste the JSON contents into the field`;

function AddConnector({ tenantClouds, cloudLabel, onClose, onSaved }) {
  const clouds = tenantClouds?.length ? tenantClouds : ['gcp'];
  const [provider, setProvider] = useState(clouds[0]);
  const [project, setProject] = useState('');
  const [credential, setCredential] = useState('');
  const [keyless, setKeyless] = useState(false);
  const [subscription, setSubscription] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!keyless && !credential.trim()) return toast('Paste the read-only credential (key JSON) or enable keyless', 'err');
    if (keyless && !project.trim()) return toast('Project id is required for keyless', 'err');
    setBusy(true);
    const res = await apiPost('/discovery/connectors', { provider, project: project.trim() || undefined, keyless, credential: keyless ? undefined : credential, subscription: subscription.trim() || undefined });
    setBusy(false);
    if (res?.ok) { toast('Cloud connector saved', 'ok'); onSaved(); }
    else toast(res?.data?.error || 'Could not save connector', 'err');
  };

  return (
    <>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 14px' }}>
        Provide a <b>read-only</b> credential you create in your cloud (the DAM never creates identities).
        It calls the provider's control-plane API to list managed databases — it never connects to the DB
        or your network. The credential is stored write-only (never shown again).
      </p>
      <div className="form-row" style={{ display: 'flex', gap: 12 }}>
        <div className="form-field" style={{ flex: 1 }}><label>Cloud</label>
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {clouds.map((id) => <option key={id} value={id}>{id.toUpperCase()} — {cloudLabel(id)}</option>)}
          </select>
        </div>
        <div className="form-field" style={{ flex: 1 }}><label>Project / account id</label>
          <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="my-gcp-project (optional — read from key)" />
        </div>
      </div>
      {provider === 'gcp' && (
        <label className="form-field" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={keyless} onChange={(e) => setKeyless(e.target.checked)} style={{ marginTop: 3 }} />
          <span style={{ fontSize: 12.5, lineHeight: 1.5 }}><b>Keyless</b> — use the control-plane's own GCP identity (no key to paste). Recommended, and required if your org disables service-account keys. Grant that identity <code>roles/cloudsql.viewer</code> on the project.</span>
        </label>
      )}
      {!keyless && provider === 'gcp' && (
        <div className="form-field">
          <label>How to create the read-only service account</label>
          <pre className="dep-cmd" style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 11 }}>{GCP_SETUP}</pre>
        </div>
      )}
      {!keyless && (
        <div className="form-field"><label>{provider === 'gcp' ? 'Service-account key (JSON)' : 'Read-only credential (JSON)'}</label>
          <textarea className="mono" value={credential} onChange={(e) => setCredential(e.target.value)} rows={7} style={{ width: '100%', fontSize: 11 }} placeholder='{ "type": "service_account", "project_id": "…", "client_email": "…", "private_key": "-----BEGIN PRIVATE KEY-----\\n…" }' />
          <span className="muted" style={{ fontSize: 11 }}>Paste the key file contents. Stored write-only; used read-only against the cloud API.</span>
        </div>
      )}
      <div className="form-field"><label>Agentless ingestion — Pub/Sub subscription <span className="muted">(optional)</span></label>
        <input value={subscription} onChange={(e) => setSubscription(e.target.value)} placeholder="toovix-dam-db-audit-sub (or projects/…/subscriptions/…)" />
        <span className="muted" style={{ fontSize: 11 }}>The subscription the DAM pulls managed-DB audit events from (Cloud Logging → Pub/Sub). Leave blank for discovery-only.</span>
      </div>
      <div className="modal-footer" style={{ padding: '6px 0 0', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save connector'}</button>
      </div>
    </>
  );
}
