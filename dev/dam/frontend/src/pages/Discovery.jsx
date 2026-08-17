import { useState } from 'react';
import { fmtTs, getTimezone } from '../hooks/useTimezone';
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
const PAAS_DEPLOYMENTS = ['rds', 'aurora', 'redshift', 'azuresql', 'cloudsql', 'atlas', 'oci', 'cosmos'];

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
    os: c.os || null,
    osConf: c.os_confidence || null,
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
  const { data: agentData } = useApiData('/discovery/agents', { poll: 30000 });
  const { data: cloudCfg } = useApiData('/settings/cloud-providers', { poll: 0 });
  const tenantClouds = Array.isArray(cloudCfg?.providers) ? cloudCfg.providers : [];
  const cloudLabel = (id) => (cloudCfg?.available || []).find((a) => a.id === id)?.label || id;
  const [scanCfg, setScanCfg] = useState(null); // open scan-config modal when set
  const [confirmCand, setConfirmCand] = useState(null); // unreachable-approve confirmation
  const [showTopology, setShowTopology] = useState(false); // recommended-topology modal

  // Network scanning is done BY an in-network discovery agent (scanner VM). Until one
  // is deployed there is nothing to run a scan, so the scan action is gated on it.
  const discoveryAgents = Array.isArray(agentData) ? agentData : [];
  const hasAgent = discoveryAgents.length > 0;
  const onlineAgent = discoveryAgents.find((a) => a.online) || null;

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
    if (cfg.scanType === 'network' && !hasAgent) { toast('Deploy a discovery agent before running a network scan', 'err'); return; }
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
      toast(`Scan queued — the discovery agent will run it within ~20s (${ports_count.toLocaleString()} ports/host)`, 'ok');
      refetchJobs();
      setTimeout(() => { refetchJobs(); refetchCands(); }, 25000);
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
        <button className="btn-secondary" onClick={openScan} disabled={!hasAgent}
          title={hasAgent ? 'Run a discovery scan' : 'Deploy a discovery agent first'}>⊞ Run scan</button>
        <button className="btn-primary" onClick={() => navigate('/databases')}>View registered</button>
      </PageHeader>

      {!hasAgent ? (
        <div className="card" style={{ marginBottom: 14, borderLeft: '3px solid var(--amber)' }}>
          <div className="card-body" style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
            <div style={{ fontSize: 22, lineHeight: 1 }}>🛰️</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>No discovery agent deployed</div>
              <div className="muted" style={{ fontSize: 13, lineHeight: 1.55 }}>
                Network discovery is run by an in-network <b>discovery agent</b> (a scanner VM with
                reachability to your database subnets). Deploy one, and it will sweep your VNet CIDRs
                and report candidates here. Network scanning stays disabled until an agent checks in.
                {' '}<a href="#" onClick={(e) => { e.preventDefault(); setShowTopology(true); }}>How to deploy a discovery agent →</a>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 14, borderLeft: `3px solid var(${onlineAgent ? '--green' : '--amber'})` }}>
          <div className="card-body" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={`badge ${onlineAgent ? 'green' : 'amber'} dot`}>{onlineAgent ? 'agent online' : 'agent offline'}</span>
            <span style={{ fontSize: 13 }}>
              {discoveryAgents.length} discovery agent{discoveryAgents.length > 1 ? 's' : ''} deployed
              {discoveryAgents[0]?.scope && <> · sweeping <span className="mono" style={{ fontSize: 12 }}>{discoveryAgents[0].scope}</span></>}
            </span>
            <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
              last check-in {jobAge(discoveryAgents[0]?.last_seen)} · <a href="#" onClick={(e) => { e.preventDefault(); setShowTopology(true); }}>deploy another →</a>
            </span>
          </div>
        </div>
      )}

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
            <thead><tr><th>Endpoint</th><th>Engine</th><th>OS</th><th>Source</th><th>Location</th><th>Reachability</th><th>Signal</th><th /></tr></thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={c.ep} style={c.reachable ? undefined : { opacity: 0.6 }}>
                  <td className="mono" style={{ fontSize: 12 }}>{c.ep}</td>
                  <td><span className="badge">{c.eng}</span>{c.mode === 'paas' && <span className="badge blue" style={{ marginLeft: 4 }}>PaaS</span>}</td>
                  <td>{c.os ? <span title={c.osConf === 'high' ? 'From service banner' : 'From TTL (low confidence)'}>{c.os}{c.osConf === 'low' && <span style={{ color: 'var(--muted)', fontSize: 11 }}> ?</span>}</span> : <span style={{ color: 'var(--muted)' }}>unknown</span>}</td>
                  <td>{c.src}</td><td>{c.loc}</td>
                  <td>{c.reachable ? <span className="badge green dot">reachable</span> : <span className="badge red dot">unreachable</span>}</td>
                  <td>{c.sig === 'sensitive' ? <span className="badge red">sensitive ports open</span> : <span className="badge">clean</span>}</td>
                  <td style={{ textAlign: 'right' }}><button className="btn-secondary" style={{ padding: '6px 14px' }} onClick={() => approve(c)}>Approve</button></td>
                </tr>
              ))}
              {candidates.length === 0 && <tr><td colSpan={8} className="chart-empty">No candidates awaiting review</td></tr>}
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

      <TopologyModal open={showTopology} onClose={() => setShowTopology(false)} />

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

// ── Deploy a discovery agent — steps + a hub-VPC topology + a copy-paste install ──
function deploySnippet(cp, token) {
  return `# 1) Node 20+ (the agent uses global fetch)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt-get install -y nodejs

# 2) Put the agent source (dev/dam/discovery/*.js) in /opt/toovix-discovery, then configure:
sudo tee /etc/toovix-discovery.env >/dev/null <<'EOF'
CONTROL_PLANE=${cp}
AGENT_ENROLL_TOKEN=${token}
DISCOVERY_TARGETS=10.10.0.0/24,10.20.0.0/24   # ← your VNet CIDRs / hosts / ranges
DISCOVERY_PRESET=common
DISCOVERY_INTERVAL=300000
EOF

# 3) Run it under systemd (restarts on crash, survives reboot)
sudo systemctl enable --now toovix-discovery`;
}

function Step({ n, title, children }) {
  return (
    <li style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 12 }}>
      <span style={{ flex: '0 0 auto', width: 22, height: 22, borderRadius: '50%', background: 'var(--info-soft)', color: 'var(--info)', fontWeight: 700, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{n}</span>
      <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>{title}</div>
        <div className="muted">{children}</div>
      </div>
    </li>
  );
}

function SpokeBox({ label, cidr }) {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px', background: 'var(--surface)', minWidth: 110, textAlign: 'center' }}>
      <div style={{ fontSize: 15 }}>🗄️</div>
      <div style={{ fontSize: 11.5, fontWeight: 600 }}>{label}</div>
      <div className="mono muted" style={{ fontSize: 10 }}>{cidr}</div>
    </div>
  );
}

function TopologyModal({ open, onClose }) {
  const { data: enroll } = useApiData('/agents/enroll-token', { poll: 0 });
  const token = enroll?.token || 'tvxenr_… (this workspace)';
  const cp = enroll?.control_plane ? (/^https?:\/\//.test(enroll.control_plane) ? enroll.control_plane : `https://${enroll.control_plane}`) : 'https://<your-dam-host>';

  return (
    <Modal open={open} onClose={onClose} title="Deploy a discovery agent" width={760}>
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.55, margin: '0 0 16px' }}>
        A discovery agent is an in-network scanner that sweeps your database subnets and reports what it
        finds back here. Put one in a <b>hub VPC</b> peered to each VNet that holds databases — it reaches
        every spoke over the peering and reports outbound over HTTPS. No agent in every app VPC, nothing inbound.
      </p>

      {/* Topology */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, justifyContent: 'center', flexWrap: 'wrap', padding: '4px 0 18px' }}>
        <div style={{ border: '2px solid var(--info)', borderRadius: 10, padding: '10px 14px', background: 'var(--info-soft)', textAlign: 'center', minWidth: 150 }}>
          <div style={{ fontSize: 20 }}>🛰️</div>
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>Discovery hub VPC</div>
          <div className="mono muted" style={{ fontSize: 10 }}>scanner · outbound HTTPS</div>
        </div>
        <div className="muted" style={{ fontSize: 11, textAlign: 'center', lineHeight: 1.3 }}>peered<br />⇄⇄⇄</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <SpokeBox label="app-a VNet" cidr="10.10.0.0/24" />
          <SpokeBox label="app-b VNet" cidr="10.20.0.0/24" />
          <SpokeBox label="app-c VNet" cidr="10.40.0.0/24" />
          <SpokeBox label="app-d VNet" cidr="10.50.0.0/24" />
        </div>
      </div>

      {/* Steps */}
      <ol style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
        <Step n={1} title="Place it with network line-of-sight">
          Deploy on a host in a hub VPC that reaches the DB subnets. Allow its IP on DB ports from the
          spokes' firewalls; it needs only <b>outbound HTTPS</b> to the control plane. Peering requires
          <b> unique CIDRs</b> — overlapping ranges can't be peered.
        </Step>
        <Step n={2} title="Use this workspace's enroll token">
          The token below is scoped to <b>this workspace</b>, so the agent enrolls into the right tenant.
          Don't use a shared/global token — the agent would land in the wrong tenant and never appear here.
        </Step>
        <Step n={3} title="Install & run the agent">
          It's a dependency-free Node service (Node 18+). Drop the source in, set the env, run under systemd —
          see the commands below.
        </Step>
        <Step n={4} title="Point it at your CIDRs">
          <span className="mono">DISCOVERY_TARGETS</span> takes hostnames, IPs, <b>CIDR blocks</b> (10.40.0.0/24)
          and <b>ranges</b> (10.50.0.10-40). Engines are identified by protocol handshake, so DBs on non-default
          ports are still found. Managed/PaaS DBs use <b>cloud-API discovery</b> (Cloud connectors) instead — no network path.
        </Step>
        <Step n={5} title="Verify">
          Within ~20s it reports; the status strip above flips to <b>agent online</b>, Run scan enables, and
          discovered databases appear as candidates.
        </Step>
      </ol>

      <div className="form-field" style={{ margin: 0 }}>
        <label>Install commands <span className="muted">(token pre-filled for this workspace)</span></label>
        <pre className="dep-cmd" style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 11 }}>{deploySnippet(cp, token)}</pre>
      </div>
    </Modal>
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
                <td style={{ fontSize: 12 }} title={c.last_result || ''}>{c.last_ingest_at || c.last_run_at ? fmtTs(c.last_ingest_at || c.last_run_at, getTimezone(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
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

const AWS_SETUP = `# A READ-ONLY IAM user for RDS discovery:
aws iam create-user --user-name toovix-dam-discovery
aws iam attach-user-policy --user-name toovix-dam-discovery \\
  --policy-arn arn:aws:iam::aws:policy/AmazonRDSReadOnlyAccess
aws iam create-access-key --user-name toovix-dam-discovery
# paste the AccessKeyId + SecretAccessKey below`;
const AZURE_SETUP = `# A READ-ONLY service principal (Reader on the subscription):
az ad sp create-for-rbac --name toovix-dam-discovery \\
  --role Reader --scopes /subscriptions/<SUBSCRIPTION_ID>
# → appId = client id · password = client secret · tenant = tenant id`;
const OCI_SETUP = `# A READ-ONLY API key (grant a group: 'inspect autonomous-database-family in tenancy'):
oci setup keys        # writes oci_api_key.pem + prints the fingerprint
# upload the PUBLIC key to your OCI user, then paste the PRIVATE key + OCIDs + fingerprint below`;

function AddConnector({ tenantClouds, cloudLabel, onClose, onSaved }) {
  const clouds = tenantClouds?.length ? tenantClouds : ['gcp', 'aws', 'azure', 'oci'];
  const [provider, setProvider] = useState(clouds[0]);
  const [project, setProject] = useState('');       // GCP project id
  const [gcpKey, setGcpKey] = useState('');          // GCP SA key JSON
  const [keyless, setKeyless] = useState(false);
  const [subscription, setSubscription] = useState('');
  const [f, setF] = useState({});                    // provider-specific discrete fields
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const v = (k) => (f[k] || '').trim();

  const save = async () => {
    let credential, projArg;
    if (provider === 'gcp') {
      if (!keyless && !gcpKey.trim()) return toast('Paste the SA key JSON, or enable keyless', 'err');
      if (keyless && !project.trim()) return toast('Project id is required for keyless', 'err');
      credential = keyless ? undefined : gcpKey;
      projArg = project.trim() || undefined;
    } else if (provider === 'aws') {
      if (!v('accessKeyId') || !v('secretAccessKey') || !v('region')) return toast('Enter AWS access key, secret, and region', 'err');
      credential = { accessKeyId: v('accessKeyId'), secretAccessKey: v('secretAccessKey'), region: v('region') };
      projArg = v('region');
    } else if (provider === 'azure') {
      if (!v('tenantId') || !v('clientId') || !v('clientSecret') || !v('subscriptionId')) return toast('Enter Azure tenant, client id, secret, and subscription', 'err');
      credential = { tenantId: v('tenantId'), clientId: v('clientId'), clientSecret: v('clientSecret'), subscriptionId: v('subscriptionId') };
      projArg = v('subscriptionId');
    } else if (provider === 'oci') {
      if (!v('tenancy') || !v('user') || !v('fingerprint') || !v('region') || !(f.privateKey || '').trim()) return toast('Enter OCI tenancy, user, fingerprint, region, and the private key', 'err');
      credential = { tenancy: v('tenancy'), user: v('user'), fingerprint: v('fingerprint'), region: v('region'), compartmentId: v('compartmentId') || undefined, privateKey: f.privateKey };
      projArg = v('compartmentId') || v('tenancy');
    }
    setBusy(true);
    const res = await apiPost('/discovery/connectors', {
      provider, project: projArg, keyless: provider === 'gcp' ? keyless : undefined,
      credential, subscription: subscription.trim() || undefined,
    });
    setBusy(false);
    if (res?.ok) { toast('Cloud connector saved', 'ok'); onSaved(); }
    else toast(res?.data?.error || 'Could not save connector', 'err');
  };

  const field = (label, key, opts = {}) => (
    <div className="form-field" style={{ flex: 1, minWidth: 180, margin: 0 }}>
      <label>{label}</label>
      <input className={opts.mono ? 'mono' : undefined} type={opts.password ? 'password' : 'text'} value={f[key] || ''} onChange={set(key)} placeholder={opts.placeholder} style={opts.mono ? { fontSize: 11.5 } : undefined} />
    </div>
  );

  return (
    <>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 14px' }}>
        Provide a <b>read-only</b> credential you create in your cloud (the DAM never creates identities).
        It calls the provider's control-plane API to list managed databases — it never connects to the DB
        or your network. The credential is stored write-only (never shown again).
      </p>
      <div className="form-field"><label>Cloud</label>
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          {clouds.map((id) => <option key={id} value={id}>{id.toUpperCase()} — {cloudLabel(id)}</option>)}
        </select>
      </div>

      {provider === 'gcp' && (<>
        <div className="form-field"><label>Project id</label>
          <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="my-gcp-project (optional — read from key)" />
        </div>
        <label className="form-field" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={keyless} onChange={(e) => setKeyless(e.target.checked)} style={{ marginTop: 3 }} />
          <span style={{ fontSize: 12.5, lineHeight: 1.5 }}><b>Keyless</b> — use the control-plane's own GCP identity (no key to paste). Recommended, and required if your org disables service-account keys. Grant that identity <code>roles/cloudsql.viewer</code> on the project.</span>
        </label>
        {!keyless && (<>
          <div className="form-field"><label>How to create the read-only service account</label>
            <pre className="dep-cmd" style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 11 }}>{GCP_SETUP}</pre></div>
          <div className="form-field"><label>Service-account key (JSON)</label>
            <textarea className="mono" value={gcpKey} onChange={(e) => setGcpKey(e.target.value)} rows={6} style={{ width: '100%', fontSize: 11 }} placeholder='{ "type": "service_account", "project_id": "…", "client_email": "…", "private_key": "-----BEGIN PRIVATE KEY-----\\n…" }' /></div>
        </>)}
        <div className="form-field"><label>Agentless ingestion — Pub/Sub subscription <span className="muted">(optional)</span></label>
          <input value={subscription} onChange={(e) => setSubscription(e.target.value)} placeholder="toovix-dam-audit-sub (or projects/…/subscriptions/…)" />
          <span className="muted" style={{ fontSize: 11 }}>The subscription the DAM pulls managed-DB audit events from (Cloud Logging → Pub/Sub). Leave blank for discovery-only.</span></div>
      </>)}

      {provider === 'aws' && (<>
        <div className="form-field"><label>Set up a read-only IAM user</label>
          <pre className="dep-cmd" style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 11 }}>{AWS_SETUP}</pre></div>
        <div className="form-row" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {field('Access key id', 'accessKeyId', { mono: true, placeholder: 'AKIA…' })}
          {field('Secret access key', 'secretAccessKey', { mono: true, password: true, placeholder: '••••••••' })}
          {field('Region', 'region', { placeholder: 'us-east-1' })}
        </div>
        <span className="muted" style={{ fontSize: 11 }}>RDS/Aurora is per-region — add one connector per region you use.</span>
      </>)}

      {provider === 'azure' && (<>
        <div className="form-field"><label>Set up a read-only service principal</label>
          <pre className="dep-cmd" style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 11 }}>{AZURE_SETUP}</pre></div>
        <div className="form-row" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {field('Subscription id', 'subscriptionId', { mono: true, placeholder: '00000000-0000-…' })}
          {field('Tenant id', 'tenantId', { mono: true, placeholder: '00000000-0000-…' })}
          {field('Client (app) id', 'clientId', { mono: true, placeholder: '00000000-0000-…' })}
          {field('Client secret', 'clientSecret', { mono: true, password: true, placeholder: '••••••••' })}
        </div>
      </>)}

      {provider === 'oci' && (<>
        <div className="form-field"><label>Set up a read-only API key</label>
          <pre className="dep-cmd" style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 11 }}>{OCI_SETUP}</pre></div>
        <div className="form-row" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {field('Tenancy OCID', 'tenancy', { mono: true, placeholder: 'ocid1.tenancy.oc1…' })}
          {field('User OCID', 'user', { mono: true, placeholder: 'ocid1.user.oc1…' })}
          {field('Fingerprint', 'fingerprint', { mono: true, placeholder: 'aa:bb:cc:…' })}
          {field('Region', 'region', { placeholder: 'us-phoenix-1' })}
          {field('Compartment OCID', 'compartmentId', { mono: true, placeholder: 'ocid1.compartment.oc1… (optional — defaults to tenancy)' })}
        </div>
        <div className="form-field"><label>API private key (PEM)</label>
          <textarea className="mono" value={f.privateKey || ''} onChange={set('privateKey')} rows={5} style={{ width: '100%', fontSize: 11 }} placeholder="-----BEGIN PRIVATE KEY-----&#10;…&#10;-----END PRIVATE KEY-----" /></div>
      </>)}

      <div className="modal-footer" style={{ padding: '10px 0 0', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save connector'}</button>
      </div>
    </>
  );
}
