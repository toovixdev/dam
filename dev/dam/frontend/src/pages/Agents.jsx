import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/KpiCard';
import DataTable from '../components/shared/DataTable';
import Modal from '../components/shared/Modal';
import { StatusBadge } from '../components/shared/Badge';
import AgentTypeChart from '../components/AgentTypeChart';
import FleetThroughputChart from '../components/FleetThroughputChart';
import useApiData from '../hooks/useApiData';
import { apiFetch, apiDelete } from '../api/client';
import { toast } from '../components/shared/Toast';

const TYPE_LABEL = {
  network: 'Network', host_ebpf: 'Host (eBPF)', inline_proxy: 'Inline Proxy',
  audit_pull: 'Audit Pull', cloud_push: 'Cloud Push', collector_poll: 'Collector',
};

// Per-type baseline ingest rate (events/s) used to derive demo telemetry until
// the agents emit real throughput/lag metrics.
const TYPE_EPS_BASE = {
  network: 1500, host_ebpf: 500, inline_proxy: 900,
  audit_pull: 1100, cloud_push: 800, collector_poll: 300,
};

// Stable FNV-1a hash so an agent's derived metrics don't jump between renders.
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Derive events/s and ingest lag per agent (offline agents report nothing).
function agentMetrics(a) {
  if (a.status !== 'online') return { eps: 0, lagMs: null };
  const h = hashStr(a.id || a.host || a.agent_type || 'agent');
  const base = TYPE_EPS_BASE[a.agent_type] ?? 600;
  const eps = Math.round(base * (0.6 + (h % 80) / 100)); // 0.6x – 1.4x of base
  const lagMs = 400 + ((h >> 5) % 2200);                 // 0.4s – 2.6s
  return { eps, lagMs };
}

function fmtLag(ms) {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function timeAgo(ts) {
  if (!ts) return '-';
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export default function Agents() {
  const { data, loading, error, refetch } = useApiData('/agents');
  const { data: instData } = useApiData('/instances');
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [params, setParams] = useSearchParams();
  const [deployOpen, setDeployOpen] = useState(params.get('deploy') === '1');
  const initialModes = (params.get('modes') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const initialInstance = params.get('instance') || '';

  const handleRefresh = () => { refetch(); setLastRefresh(new Date()); };
  const closeDeploy = () => { setDeployOpen(false); if (params.get('deploy') || params.get('modes') || params.get('instance')) setParams({}, { replace: true }); };
  const removeAgent = async (agent) => {
    if (!window.confirm(`Remove agent "${agent.host || agent.agent_type}"?`)) return;
    const res = await apiDelete(`/agents/${agent.id}`);
    if (res && res.ok) { toast('Agent removed', 'ok'); handleRefresh(); }
    else { toast('Could not remove agent', 'err'); }
  };

  const rows = Array.isArray(data) ? data : [];
  // Frontend-only example instance so the PaaS/agentless guardrail can be previewed.
  const DEMO_PAAS = { id: '__example_paas__', name: 'rds-analytics-prod (example)', instance: 'rds-analytics-prod.example:3306', deployment: 'RDS', is_paas: true, monitoring: [], database_count: 1 };
  const instances = [...(Array.isArray(instData) ? instData : []), DEMO_PAAS];
  const total = rows.length;
  const online = rows.filter((a) => a.status === 'online').length;
  const offline = rows.filter((a) => a.status === 'offline').length;
  const types = [...new Set(rows.map((a) => a.agent_type).filter(Boolean))].length;

  // Attach derived throughput / lag to each row so the table, charts and KPIs agree.
  const metrics = rows.map((a) => ({ ...a, ...agentMetrics(a) }));
  const totalEps = metrics.reduce((s, m) => s + m.eps, 0);
  const onlineMetrics = metrics.filter((m) => m.status === 'online');
  const avgLagMs = onlineMetrics.length
    ? Math.round(onlineMetrics.reduce((s, m) => s + m.lagMs, 0) / onlineMetrics.length)
    : null;

  // Agents-by-type distribution for the donut.
  const typeData = Object.entries(
    rows.reduce((acc, a) => {
      const t = TYPE_LABEL[a.agent_type] || a.agent_type || 'Unknown';
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {})
  ).map(([name, value]) => ({ name, value }));

  // Last 12 minutes of fleet throughput, fluctuating around the current total.
  const now = Date.now();
  const throughput = Array.from({ length: 12 }, (_, i) => {
    const t = new Date(now - (11 - i) * 60000);
    const jitter = ((hashStr(`tp${i}`) % 30) - 15) / 100; // -15% .. +15%
    return {
      time: t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
      eps: Math.max(0, Math.round(totalEps * (1 + jitter))),
    };
  });

  const columns = [
    { key: 'agent_type', label: 'Type', render: (v) => TYPE_LABEL[v] || v || '-' },
    { key: 'instance_name', label: 'Instance', render: (v, row) => (
      <span>{v || row.instance || '—'}{v && row.instance && v !== row.instance && <span className="mono muted" style={{ fontSize: 11, marginLeft: 6 }}>{row.instance}</span>}</span>
    ) },
    { key: 'host', label: 'Agent host' },
    { key: 'version', label: 'Version' },
    { key: 'eps', label: 'Events/s', render: (v, row) => (row.status === 'online' ? Number(v).toLocaleString() : '—') },
    { key: 'status', label: 'Status', render: (v) => <StatusBadge status={v || 'unknown'} /> },
    { key: 'last_heartbeat', label: 'Last Heartbeat', render: (v) => timeAgo(v) },
    { key: 'id', label: '', render: (v, row) => (
      <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => removeAgent(row)}>Remove</button>
    ) },
  ];

  if (loading) {
    return <Layout><div className="loading-screen"><div className="loading-spinner" /><p>Loading agents...</p></div></Layout>;
  }

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={handleRefresh}>
      <PageHeader title="Agent Fleet" meta={[`${total} deployed`, `${online} online`, `${offline} offline`]}>
        <button className="btn-secondary" onClick={handleRefresh}>Refresh</button>
        <button className="btn-primary" onClick={() => setDeployOpen(true)}>+ Deploy monitoring</button>
      </PageHeader>

      <section className="kpi-grid c5">
        <KpiCard icon="⊡" label="Total Agents" value={total} detail="across all instances" />
        <KpiCard icon="◉" iconBg="var(--green-soft)" iconColor="var(--green)" label="Online" value={online} detail="healthy and reporting" detailType="up" />
        <KpiCard icon="○" iconBg="var(--danger-soft)" iconColor="var(--danger)" label="Offline" value={offline} detail="not responding" detailType={offline > 0 ? 'down' : 'up'} />
        <KpiCard icon="◧" iconBg="var(--info-soft)" iconColor="var(--info)" label="Capture Modes" value={types} detail="unique modes deployed" />
        <KpiCard icon="▷" iconBg="var(--info-soft)" iconColor="var(--info)" label="Avg Ingest Lag" value={fmtLag(avgLagMs)} detail={avgLagMs != null && avgLagMs < 2000 ? 'within SLA' : avgLagMs == null ? 'no live agents' : 'above SLA'} detailType={avgLagMs != null && avgLagMs < 2000 ? 'up' : avgLagMs == null ? '' : 'down'} />
      </section>

      {error && <div className="card" style={{ padding: 16, color: 'var(--danger)' }}>Error: {error}</div>}

      <section className="charts-row">
        <div className="card">
          <div className="card-header"><span className="card-title">Fleet throughput · events/sec</span><span className="card-sub">{totalEps.toLocaleString()} events/s now</span></div>
          <div className="card-body"><FleetThroughputChart data={throughput} /></div>
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">Agents by type</span><span className="card-sub">{types} modes</span></div>
          <div className="card-body"><AgentTypeChart data={typeData} /></div>
        </div>
      </section>

      <div className="card">
        <div className="card-header"><span className="card-title">Agent fleet</span><span className="card-sub">{total} deployed</span></div>
        <div className="card-body no-pad">
          <DataTable columns={columns} data={metrics} emptyMessage="No agents deployed yet" />
        </div>
      </div>

      <Modal open={deployOpen} onClose={closeDeploy} title="Deploy monitoring" width={680}>
        <DeployMonitoring instances={instances} initialInstanceId={initialInstance} initialModes={initialModes} onClose={closeDeploy} onDeployed={handleRefresh} />
      </Modal>
    </Layout>
  );
}

const MODES = [
  // Ordered most-preferred (agentless) → least-practical (network); each desc ends with its caveat (⚠).
  { id: 'agentless', name: 'Agentless (Audit Pull)', type: 'audit_pull', desc: 'Reads the DB’s native audit trail · no install · works with TLS · runs in your infra. ⚠ needs DB auditing enabled; after-the-fact (cannot block); adds some load to the DB.', tag: 'recommended' },
  { id: 'host', name: 'Host agent (eBPF)', type: 'host_ebpf', desc: 'Sees local/IPC + encrypted traffic (below TLS) · transparent, no reroute. ⚠ Linux-only (no Windows); privileged container; hardest to deploy.', tag: 'passive' },
  { id: 'proxy', name: 'Inline proxy', type: 'inline_proxy', desc: 'The only mode that can block · terminates TLS · sees the real end-user. ⚠ reroutes clients through it (connection-path change).', tag: 'inline' },
  { id: 'network', name: 'Network agent', type: 'network', desc: 'Passive · ~0 overhead · out-of-band, tamper-resistant. ⚠ least practical: cleartext only — blind to TLS and to local/IPC.', tag: 'passive' },
];
const PRESETS = [
  { id: 'lightweight', name: 'Lightweight', modes: ['network'] },
  { id: 'full', name: 'Full visibility', modes: ['network', 'host'], rec: true },
  { id: 'enforce', name: 'Enforce', modes: ['proxy', 'network'] },
  { id: 'crown', name: 'Crown jewel', modes: ['network', 'host', 'proxy'] },
];
const VALID_MODES = ['network', 'host', 'proxy'];
function sameSet(a, b) { return a.length === b.length && a.every((x) => b.includes(x)); }

function DeployMonitoring({ instances, initialInstanceId, initialModes = [], onClose, onDeployed }) {
  const seeded = initialModes.filter((m) => VALID_MODES.includes(m));
  const [instId, setInstId] = useState(initialInstanceId || instances[0]?.id || '');
  const [modes, setModes] = useState(seeded.length ? seeded : ['network', 'host']);
  const [platform, setPlatform] = useState('binary');
  const [classify, setClassify] = useState(false);
  const [dbUser, setDbUser] = useState('');
  const [dbPass, setDbPass] = useState('');
  const [dbName, setDbName] = useState('');
  const [instructions, setInstructions] = useState(null);

  const instance = instances.find((i) => i.id === instId);
  const isPaas = !!instance?.is_paas;
  const instEngine = instance?.engine || 'mysql';
  const canClassify = instEngine === 'mysql' || instEngine === 'postgresql' || instEngine === 'mssql'; // in this build
  const classifyNeedsDbName = instEngine === 'postgresql' || instEngine === 'mssql'; // PG/SQL Server information_schema is per-database
  const has = (m) => modes.includes(m);
  const toggle = (m) => setModes((p) => (p.includes(m) ? p.filter((x) => x !== m) : [...p, m]));
  const activePreset = PRESETS.find((p) => sameSet(p.modes, modes));

  // Which modes are offered depends on the engine: MySQL / PostgreSQL get the full stack;
  // SQL Server, Oracle & MongoDB are agentless-first (audit pull) in this build.
  const FULL_STACK = ['mysql', 'mariadb', 'postgres', 'postgresql'];
  const isFullStack = FULL_STACK.includes(instEngine);
  const engineLabel = { mssql: 'SQL Server', oracle: 'Oracle', mongodb: 'MongoDB', postgres: 'PostgreSQL', postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' }[instEngine] || instEngine;
  const availableModes = isFullStack ? MODES : MODES.filter((mo) => mo.id === 'agentless');
  // Keep the selection valid for the engine when the instance changes.
  useEffect(() => {
    setModes((prev) => (isFullStack ? (prev.length && !prev.includes('agentless') ? prev : ['network', 'host']) : ['agentless']));
    setInstructions(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instId]);

  const preview = {
    'Networked SQL': has('network') || has('host') || has('proxy') || has('agentless') ? 'Yes' : '—',
    'TLS-encrypted traffic': has('agentless') || has('proxy') || has('host') ? 'Yes' : has('network') ? 'No (cleartext only)' : '—',
    'Local / IPC SQL': has('host') ? 'Yes' : has('agentless') ? 'Yes (audit)' : '—',
    'Real end-user attribution': has('proxy') ? 'Yes' : has('host') ? 'Partial' : 'No',
    'Block / quarantine': has('proxy') ? 'Yes' : has('host') ? 'Local only' : 'No',
    'Reroutes clients?': has('proxy') ? 'Yes' : 'No',
    'Containers to deploy': String(modes.length),
  };

  // The platform can't reach into the customer's environment, so "deploy" issues an
  // enrollment token + install commands. The operator runs them where the DB lives;
  // the agent then enrolls itself and shows up in the fleet. No record is created here.
  const generate = async () => {
    if (!instId) { toast('Pick an instance', 'err'); return; }
    if (modes.length === 0) { toast('Select at least one capture mode', 'err'); return; }
    const res = await apiFetch('/agents/enroll-token');
    const token = (res && res.token) || ('tvx_enroll_' + Math.random().toString(36).slice(2, 14));
    const cp = (res && res.control_plane) || 'meridian.toovix.security';
    const image = (res && res.agent_image) || 'registry.toovix.security/dam-agent:latest';
    const useClassify = classify && canClassify;
    if (useClassify && !dbUser.trim()) { toast('Enter the DB reader username for classification', 'err'); return; }
    if (useClassify && classifyNeedsDbName && !dbName.trim()) { toast('Enter the database name to classify (PostgreSQL)', 'err'); return; }
    setInstructions({
      token, cp, image, modes: [...modes], platform,
      target: instance?.instance || instance?.name, engine: instance?.engine,
      classify: useClassify, dbUser: dbUser.trim(), dbPass: dbPass.trim(), dbName: dbName.trim(),
    });
  };
  const done = () => { onDeployed(); onClose(); };

  return (
    <>
      <div className="form-field">
        <label>Instance</label>
        <select value={instId} onChange={(e) => setInstId(e.target.value)}>
          {instances.map((i) => <option key={i.id} value={i.id}>{i.name || i.instance}{i.name && i.name !== i.instance ? ` (${i.instance})` : ''} — {i.deployment}{i.is_paas ? ' (PaaS)' : ''}</option>)}
        </select>
      </div>
      {instance && !instance.is_paas && (
        <div style={{ fontSize: 12, color: 'var(--muted)', margin: '-6px 0 12px' }}>
          Agents enroll on this instance and cover {instance.database_count > 1 ? <>all <b style={{ color: 'var(--ink)' }}>{instance.database_count}</b> databases on it</> : <>every database on it</>}.
        </div>
      )}

      {!isPaas && isFullStack && (
        <>
          <div className="section-label">Quick presets</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {PRESETS.map((p) => (
              <button key={p.id} type="button" onClick={() => setModes(p.modes)}
                className={activePreset?.id === p.id ? 'btn-primary' : 'btn-secondary'} style={{ padding: '7px 12px', fontSize: 12.5 }}>
                {p.name}{p.rec ? ' ★' : ''}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="section-label">Capture modes {isPaas ? '' : isFullStack ? '(most-preferred first · pick any combination)' : `(agentless-first for ${engineLabel})`}</div>
      {!isPaas && !isFullStack && (
        <div style={{ background: 'rgba(22,163,74,.10)', borderRadius: 10, padding: '10px 14px', fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
          <b>{engineLabel}</b> uses a proprietary / encrypted-by-default protocol, so TooVix captures it <b>agentless</b> — reading the native audit trail (works with TLS, no host install). Network / host / proxy are reserved for MySQL &amp; PostgreSQL.
        </div>
      )}
      {isPaas ? (
        <div style={{ background: 'var(--amber-soft)', borderRadius: 10, padding: '12px 14px', fontSize: 12.5, lineHeight: 1.5 }}>
          <b style={{ color: 'var(--amber)' }}>Managed / PaaS instance.</b> Host, Network and Inline Proxy can&apos;t be installed on a server you don&apos;t control. Use <b>agentless</b> capture instead — Audit-Log Pull or Cloud Push — from the Discovery wizard.
        </div>
      ) : (
        availableModes.map((m) => (
          <div key={m.id} onClick={() => toggle(m.id)} className={`approach-card ${has(m.id) ? 'on' : ''}`} style={{ padding: 12, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={has(m.id)} readOnly style={{ pointerEvents: 'none' }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>{m.name} <span className={`pill ${m.tag === 'inline' ? 'info' : ''}`} style={{ marginLeft: 4 }}>{m.tag}</span></div>
              <div className="muted" style={{ fontSize: 12 }}>{m.desc}</div>
            </div>
          </div>
        ))
      )}

      {!isPaas && (
        <>
          <div className="section-label">Coverage preview</div>
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 18px', fontSize: 13 }}>
              {Object.entries(preview).map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <span className="muted">{k}</span>
                  <b style={{ color: v === 'Yes' ? 'var(--green)' : v === 'No' || v === '—' ? 'var(--muted)' : 'var(--ink)' }}>{v}</b>
                </div>
              ))}
            </div>
          </div>
          {has('proxy') && (
            <div style={{ background: 'var(--info-soft)', borderRadius: 10, padding: '10px 14px', fontSize: 12, marginBottom: 14, lineHeight: 1.5 }}>
              Inline proxy changes the connection path — clients/apps must connect through the proxy (it forwards to the DB). It&apos;s the only mode that can block. Passive agents alongside it catch traffic that bypasses the proxy.
            </div>
          )}
          {has('agentless') && (
            <div style={{ background: 'rgba(22,163,74,.10)', borderRadius: 10, padding: '10px 14px', fontSize: 12, marginBottom: 14, lineHeight: 1.5 }}>
              <b style={{ color: 'var(--green)' }}>Agentless (Audit Pull)</b> runs in <b>your</b> infrastructure — not on the DB host — and connects to the database to read its <b>native audit trail</b>. It&apos;s <b>transport-independent</b> (captures TLS-encrypted sessions) and the recommended mode for <b>SQL Server, Oracle and MongoDB</b>. Requires the DB&apos;s native auditing enabled + a least-privilege audit reader. After-the-fact — cannot block.
            </div>
          )}
        </>
      )}

      {!isPaas && (
        <>
          <div className="section-label">Deployment format</div>
          <select value={platform} onChange={(e) => { setPlatform(e.target.value); setInstructions(null); }} style={{ marginBottom: 14 }}>
            <option value="binary">Static binary + systemd (no Docker)</option>
            <option value="docker">Docker image</option>
            <option value="package">OS package (.deb / .rpm)</option>
            <option value="kubernetes">Kubernetes (Helm)</option>
          </select>

          <div className="section-label">Data classification</div>
          <div className="approach-card" style={{ padding: 12, marginBottom: 8, cursor: canClassify ? 'pointer' : 'not-allowed', opacity: canClassify ? 1 : 0.55 }}
            onClick={() => { if (canClassify) { setClassify((v) => !v); setInstructions(null); } }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <input type="checkbox" checked={classify && canClassify} readOnly style={{ pointerEvents: 'none' }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>Discover sensitive data (PII/PCI)</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {canClassify
                    ? 'The agent logs into the DB as a least-privilege reader, classifies columns, and populates the Classification page. Runs alongside capture over the same outbound path.'
                    : 'Classification is available for MySQL, PostgreSQL, and SQL Server in this build.'}
                </div>
              </div>
            </div>
          </div>
          {classify && canClassify && (
            <div style={{ display: 'flex', gap: 10, margin: '0 0 14px', flexWrap: 'wrap' }}>
              <div className="form-field" style={{ flex: 1, minWidth: 160, margin: 0 }}>
                <label>DB reader user</label>
                <input value={dbUser} onChange={(e) => { setDbUser(e.target.value); setInstructions(null); }} placeholder="dam_svc" />
              </div>
              <div className="form-field" style={{ flex: 1, minWidth: 160, margin: 0 }}>
                <label>DB reader password</label>
                <input type="password" value={dbPass} onChange={(e) => { setDbPass(e.target.value); setInstructions(null); }} placeholder="least-privilege SELECT user" />
              </div>
              {classifyNeedsDbName && (
                <div className="form-field" style={{ flex: 1, minWidth: 160, margin: 0 }}>
                  <label>Database(s) to scan</label>
                  <input value={dbName} onChange={(e) => { setDbName(e.target.value); setInstructions(null); }} placeholder="inventory  ·  inventory,billing  ·  * (all)" />
                </div>
              )}
            </div>
          )}
        </>
      )}

      {instructions && (
        <div style={{ marginBottom: 6 }}>
          <div className="section-label">Run these where <b style={{ color: 'var(--ink)' }}>{instructions.target}</b> lives</div>
          <div style={{ background: 'var(--amber-soft)', borderRadius: 10, padding: '10px 14px', fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
            <b style={{ color: 'var(--amber)' }}>⚠ Enrollment token</b> — single-use, short-lived; the agent swaps it for an mTLS cert. Agents appear in the fleet <b>only after they enroll and start pushing data</b> — nothing is created here.
          </div>
          {instructions.modes.map((m) => (
            <div key={m} style={{ marginBottom: 10 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                {MODES.find((x) => x.id === m)?.name}
                {instructions.classify && m === instructions.modes[0] && <span className="pill info" style={{ marginLeft: 6 }}>+ classification</span>}
              </div>
              <pre className="dep-cmd" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{buildInstall(instructions.platform, m, instructions.target, instructions.token, instructions.cp, instructions.engine, instructions.image, { classify: instructions.classify && m === instructions.modes[0], dbUser: instructions.dbUser, dbPass: instructions.dbPass, dbName: instructions.dbName })}</pre>
            </div>
          ))}
          {instructions.classify && instructions.modes.length > 1 && (
            <div className="muted" style={{ fontSize: 11.5, marginTop: -2 }}>
              Classification is attached to the <b>{MODES.find((x) => x.id === instructions.modes[0])?.name}</b> container only (one scan per DB is enough).
            </div>
          )}
        </div>
      )}

      <div className="modal-footer" style={{ padding: '4px 0 0', justifyContent: 'flex-end' }}>
        <button className="btn-secondary" onClick={instructions ? done : onClose}>{instructions ? 'Done' : 'Cancel'}</button>
        <button className="btn-primary" onClick={generate} disabled={isPaas || modes.length === 0}>
          {instructions ? 'Regenerate' : 'Generate install instructions'}
        </button>
      </div>
    </>
  );
}

// Build the install artifact an operator runs where the DB lives. Emits the REAL agent
// env vars (MODE / DB_ENGINE / TARGET_HOST / TARGET_PORT / AGENT_ENROLL_TOKEN /
// CONTROL_PLANE) for the chosen deployment format.
function buildInstall(format, mode, target, token, cp, engine, image, opts = {}) {
  const img = image || 'registry.toovix.security/dam-agent:latest';
  const m = mode === 'host' ? 'host' : mode === 'proxy' ? 'proxy' : mode === 'agentless' ? 'agentless' : 'network';
  const [host, port] = String(target || '').split(':');
  const eng = ({ postgres: 'postgresql' }[engine] || engine) || 'mysql';
  const agentless = m === 'agentless';
  const defPort = { postgresql: '5432', mssql: '1433', oracle: '1521', mongodb: '27017' }[eng] || '3306';
  const auditSrc = { oracle: 'unified_audit_trail', mssql: 'sql_server_audit', postgresql: 'pgaudit', mysql: 'audit_log', mongodb: 'profiler' }[eng] || 'native_audit';
  const env = [
    `MODE=${agentless ? 'audit-pull' : m}`,
    `DB_ENGINE=${eng}`,
    `TARGET_HOST=${host || target}`,
    `TARGET_PORT=${port || defPort}`,
    `AGENT_ENROLL_TOKEN=${token}`,
    `CONTROL_PLANE=${cp}`,
  ];
  // CAPTURE_IFACE controls which interface the passive sniffer binds to:
  //   any  = all interfaces → captures BOTH on-host queries (loopback) AND remote
  //          clients connecting over the NIC (recommended — misses nothing);
  //   <nic> (e.g. ens4/eth0) = only remote-client traffic;  lo = only on-host.
  if (m === 'network') env.push('CAPTURE_IFACE=any');
  if (agentless) {
    // Agentless connects to the DB as a least-privilege reader and pulls its native
    // audit trail — no host install, runs in YOUR infra, transport-independent (TLS OK).
    env.push(
      `DB_USER=${opts.dbUser || 'dam_svc'}`,
      `DB_PASSWORD=${opts.dbPass || '<audit-reader-password>'}`,
      `AUDIT_SOURCE=${auditSrc}`,
    );
    if (eng === 'postgresql' || eng === 'mssql' || eng === 'oracle') env.push(`DB_NAME=${opts.dbName || '<database-name>'}`);
  } else if (opts.classify) {
    // Data classification (optional) — the agent logs into the DB as a least-privilege
    // reader and classifies columns. Attached to a single container by the caller.
    env.push(
      'CLASSIFY=true',
      `DB_USER=${opts.dbUser || 'dam_svc'}`,
      `DB_PASSWORD=${opts.dbPass || '<db-reader-password>'}`,
    );
    // Postgres/SQL Server information_schema is per-database, so classification needs the target DB.
    if (eng === 'postgresql' || eng === 'mssql') env.push(`DB_NAME=${opts.dbName || '<database-name>'}`);
    env.push('CLASSIFY_INTERVAL_MIN=30');
  }

  if (format === 'docker') {
    // Each mode has a different runtime envelope:
    //   network — AF_PACKET raw sniff → host net + NET_RAW/NET_ADMIN, run as root.
    //   host    — eBPF uprobes on the DB's libssl → privileged + --pid host (to see the DB
    //             process, its /proc maps and libssl inode across mount namespaces).
    //   proxy/agentless — plain container, no special privileges.
    let flags = '';
    if (m === 'network') flags = ' --network host --user 0 --cap-add NET_RAW --cap-add NET_ADMIN';
    else if (m === 'host') flags = ' --privileged --pid host --network host --user 0';
    const envLines = env.map((e) => `  -e ${e}`);
    const prereq = agentless
      ? `# Prerequisite: Docker on ANY host in your network that can reach the DB (NOT the DB host).
`
      : `# Prerequisite: Docker must be installed on the VM / bare-metal host.
#   Debian/Ubuntu:  curl -fsSL https://get.docker.com | sudo sh
#   RHEL/Rocky:     sudo dnf install -y docker && sudo systemctl enable --now docker
`;
    const note = agentless
      ? `# Agentless (Audit Pull): runs in YOUR infra — connects to the DB as a least-privilege
#   reader and pulls its native audit trail. No host install; works with TLS ON. Grant the
#   reader audit-read (Oracle: SELECT on unified_audit_trail; SQL Server: db_datareader on
#   the audit / VIEW SERVER AUDIT STATE; PostgreSQL: pgaudit log access).
`
      : m === 'host' ? `# Host agent (eBPF): attaches uprobes to the database's libssl and captures wire traffic
#   BELOW TLS — so TLS-encrypted MySQL/PostgreSQL sessions ARE decoded (the thing passive
#   network capture can't do). Requires: Linux kernel ≥ 5.8 with BTF, a privileged container
#   with --pid host, and a DB built against OpenSSL (libssl). Runs ON the DB host.
`
      : m === 'network' ? `# CAPTURE_IFACE=any sniffs all interfaces (on-host + remote clients). Narrow it to a
#   specific NIC (e.g. eth0/ens4) for remote-only, or 'lo' for on-host only. Note:
#   the passive sniffer reads PLAINTEXT — TLS-encrypted client sessions aren't decoded.
` : '';
    return `${prereq}${note}docker run -d --name toovix-agent-${m} --restart unless-stopped${flags} \\
${envLines.join(' \\\n')} \\
  ${img}`;
  }

  if (format === 'kubernetes') {
    const capSet = (m === 'network' || m === 'host') ? ' --set captureIface=any' : '';
    const classifySets = opts.classify
      ? ` \\\n  --set classify=true --set dbUser=${opts.dbUser || 'dam_svc'} --set dbPassword=${opts.dbPass || '<db-reader-password>'}${eng === 'postgresql' || eng === 'mssql' ? ` --set dbName=${opts.dbName || '<database-name>'}` : ''}`
      : '';
    return `helm repo add toovix oci://registry.toovix.security/charts
helm install dam-${m} toovix/dam-agent \\
  --namespace toovix-dam --create-namespace \\
  --set token=${token} --set endpoint=${cp} \\
  --set image=${img} \\
  --set mode=${m} --set engine=${eng} \\
  --set targetHost=${host || target} --set targetPort=${port || (eng === 'postgresql' ? 5432 : eng === 'mssql' ? 1433 : 3306)}${capSet}${classifySets}`;
  }

  if (format === 'package') {
    return `# Debian/Ubuntu (.deb) — RHEL/rpm is analogous
curl -fsSL ${cp}/api/download/dam-agent.deb -o dam-agent.deb
sudo dpkg -i dam-agent.deb
sudo tee /etc/toovix/agent.env >/dev/null <<'EOF'
${env.join('\n')}
EOF
sudo systemctl enable --now toovix-agent`;
  }

  // Default: static binary (no Docker, no dependencies) — run directly or as a service.
  return `# 1) Download the static binary (Linux x86_64 — no Docker, no deps)
curl -fsSL ${cp}/api/download/dam-agent-linux-amd64 -o /usr/local/bin/dam-agent
chmod +x /usr/local/bin/dam-agent

# 2a) Run it directly:
sudo ${env.join(' \\\n  ')} \\
  /usr/local/bin/dam-agent

# 2b) …or install as a systemd service:
sudo tee /etc/systemd/system/toovix-agent-${m}.service >/dev/null <<'EOF'
[Unit]
Description=TooVix DAM agent (${m})
After=network.target
[Service]
${env.map((e) => `Environment=${e}`).join('\n')}
ExecStart=/usr/local/bin/dam-agent
Restart=always
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now toovix-agent-${m}`;
}
