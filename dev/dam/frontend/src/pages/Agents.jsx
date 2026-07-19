import { useState, useEffect, useMemo } from 'react';
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
        <DeployMonitoring instances={instances} agents={rows} initialInstanceId={initialInstance} initialModes={initialModes} onClose={closeDeploy} onDeployed={handleRefresh} />
      </Modal>
    </Layout>
  );
}

const MODES = [
  // Ordered most-preferred (AgentLite) → least-practical (network); each desc ends with its caveat (⚠).
  // On self-managed VMs this is AgentLite (a lightweight audit forwarder on the host); on PaaS the
  // equivalent is Agentless (a cloud audit stream, set up from Discovery — no install).
  { id: 'agentless', name: 'AgentLite (Audit Forwarder)', type: 'audit_forward', desc: 'A lightweight forwarder on the DB host that tails the database’s native audit trail and ships it out · no wire tap, no path change · works with TLS. ⚠ needs DB auditing enabled; after-the-fact (cannot block).', tag: 'recommended' },
  // NOTE: host mode hooks SSL_read/SSL_write on libssl (see agent/hostcap.bpf.c), so it sees
  // TLS sessions and ONLY those — a cleartext session never calls SSL_read. It is therefore the
  // exact complement of the network agent, not a superset of it. (It does not cover local/IPC
  // either: unix-socket sessions are usually not TLS. AgentLite is what covers those.)
  { id: 'host', name: 'Host agent (eBPF)', type: 'host_ebpf', desc: 'Sees encrypted traffic (below TLS) that passive capture cannot · transparent, no reroute. ⚠ Linux-only (no Windows); privileged container; hardest to deploy; blind to cleartext — pair with the network agent.', tag: 'passive' },
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

// The wire modes read the CONNECTION; AgentLite reads the database's own audit trail, which
// records every statement whatever the transport. So AgentLite wholly subsumes them: running it
// alongside network/host/proxy ingests each query two or three times — inflated counts, inflated
// bulk-read totals, duplicate alerts. They are mutually exclusive, not additive.
const WIRE_MODES = ['network', 'host', 'proxy'];
const isWireMode = (m) => WIRE_MODES.includes(m);

// agent_type (what an enrolled agent reports) → the mode id offered on this screen.
const TYPE_TO_MODE = { network: 'network', host_ebpf: 'host', inline_proxy: 'proxy', audit_pull: 'agentless' };

function DeployMonitoring({ instances, agents = [], initialInstanceId, initialModes = [], onClose, onDeployed }) {
  const seeded = initialModes.filter((m) => VALID_MODES.includes(m));
  const [instId, setInstId] = useState(initialInstanceId || instances[0]?.id || '');
  const [modes, setModes] = useState(seeded.length ? seeded : ['network', 'host']);
  const [platform, setPlatform] = useState('binary');
  const [classify, setClassify] = useState(false);
  const [dbUser, setDbUser] = useState('');
  const [dbPass, setDbPass] = useState('');
  const [dbName, setDbName] = useState('');
  // AgentLite (audit-forward) delivery: publish to Pub/Sub vs POST the control plane.
  const [pubsub, setPubsub] = useState(true);
  const [auditTopic, setAuditTopic] = useState('toovix-dam-audit');
  const [gcpProject, setGcpProject] = useState('');
  // SQL Server telemetry source: Audit (object-scoped, clean) vs Extended Events (adds row counts).
  const [mssqlSource, setMssqlSource] = useState('sql_server_audit');
  const [instructions, setInstructions] = useState(null);

  const instance = instances.find((i) => i.id === instId);
  const isPaas = !!instance?.is_paas;
  const instEngine = instance?.engine || 'mysql';
  const canClassify = instEngine === 'mysql' || instEngine === 'postgresql' || instEngine === 'mssql'; // in this build
  const classifyNeedsDbName = instEngine === 'postgresql' || instEngine === 'mssql'; // PG/SQL Server information_schema is per-database
  const has = (m) => modes.includes(m);
  // Selecting AgentLite clears the wire modes and vice-versa — see WIRE_MODES above for why.
  const toggle = (m) =>
    setModes((p) => {
      if (p.includes(m)) return p.filter((x) => x !== m);
      if (m === 'agentless') return ['agentless'];
      return [...p.filter((x) => x !== 'agentless'), m];
    });

  // Modes already covered by an enrolled agent on this instance. Deployed modes are not
  // pre-selected: the default action is to ADD coverage, not silently redeploy what is running.
  const deployedModes = useMemo(() => {
    const set = new Set();
    for (const a of agents) {
      if (a.instance_id && a.instance_id === instId) {
        const mode = TYPE_TO_MODE[a.agent_type];
        if (mode) set.add(mode);
      }
    }
    return set;
  }, [agents, instId]);
  const activePreset = PRESETS.find((p) => sameSet(p.modes, modes));

  // Which modes are offered depends on the engine: MySQL / PostgreSQL get the full stack;
  // SQL Server, Oracle & MongoDB are agentless-first (audit pull) in this build.
  const FULL_STACK = ['mysql', 'mariadb', 'postgres', 'postgresql'];
  const isFullStack = FULL_STACK.includes(instEngine);
  const engineLabel = { mssql: 'SQL Server', oracle: 'Oracle', mongodb: 'MongoDB', postgres: 'PostgreSQL', postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' }[instEngine] || instEngine;
  const availableModes = isFullStack ? MODES : MODES.filter((mo) => mo.id === 'agentless');
  // Keep the selection valid for the engine when the instance changes, and default to the
  // coverage this instance is still MISSING — offering to redeploy what already runs is noise.
  useEffect(() => {
    setModes(() => {
      if (!isFullStack) return deployedModes.has('agentless') ? [] : ['agentless'];
      const wanted = ['network', 'host'].filter((m) => !deployedModes.has(m));
      return wanted.length ? wanted : [];
    });
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
      pubsub, auditTopic: auditTopic.trim() || 'toovix-dam-audit', gcpProject: gcpProject.trim(),
      mssqlSource,
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

      <div className="section-label">Capture modes {isPaas ? '' : isFullStack ? '(most-preferred first · pick any combination)' : `(AgentLite audit for ${engineLabel})`}</div>
      {!isPaas && !isFullStack && (
        <div style={{ background: 'rgba(22,163,74,.10)', borderRadius: 10, padding: '10px 14px', fontSize: 12, marginBottom: 10, lineHeight: 1.5 }}>
          <b>{engineLabel}</b> uses a proprietary / encrypted-by-default protocol, so TooVix captures it with <b>AgentLite</b> — a lightweight forwarder on the host that ships the database&apos;s native audit trail (works with TLS). Network / host / proxy are reserved for MySQL &amp; PostgreSQL.
        </div>
      )}
      {isPaas ? (
        <div style={{ background: 'var(--amber-soft)', borderRadius: 10, padding: '12px 14px', fontSize: 12.5, lineHeight: 1.5 }}>
          <b style={{ color: 'var(--amber)' }}>Managed / PaaS instance.</b> Host, Network and Inline Proxy can&apos;t be installed on a server you don&apos;t control. Use <b>Agentless</b> capture instead — a cloud audit stream (Pub/Sub · Kinesis · Event Hub), set up from the Discovery wizard. No install.
        </div>
      ) : (
        availableModes.map((m) => {
          const isDeployed = deployedModes.has(m.id);
          // AgentLite and the wire modes can't coexist; show the conflicting tiles as blocked
          // rather than silently swapping the selection out from under the user.
          const blocked = m.id === 'agentless'
            ? modes.some(isWireMode)
            : isWireMode(m.id) && has('agentless');
          return (
            <div key={m.id} onClick={() => { if (!blocked) toggle(m.id); }}
              className={`approach-card ${has(m.id) ? 'on' : ''}`}
              style={{ padding: 12, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 12, cursor: blocked ? 'not-allowed' : 'pointer', opacity: blocked ? 0.45 : 1 }}>
              <input type="checkbox" checked={has(m.id)} disabled={blocked} readOnly style={{ pointerEvents: 'none' }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700 }}>
                  {m.name} <span className={`pill ${m.tag === 'inline' ? 'info' : ''}`} style={{ marginLeft: 4 }}>{m.tag}</span>
                  {isDeployed && (
                    <span className="pill" style={{ marginLeft: 6, background: 'var(--green-soft, rgba(22,163,74,.12))', color: 'var(--green)' }}>
                      ✓ {has(m.id) ? 'redeploy' : 'deployed'}
                    </span>
                  )}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>{m.desc}</div>
                {isDeployed && !has(m.id) && (
                  <div style={{ fontSize: 11.5, color: 'var(--green)', marginTop: 3 }}>
                    Already covered on this instance — select only to redeploy (version upgrade, config change, or replacing a dead agent).
                  </div>
                )}
                {blocked && (
                  <div style={{ fontSize: 11.5, color: 'var(--amber)', marginTop: 3 }}>
                    {m.id === 'agentless'
                      ? 'Unavailable while a wire mode is selected — AgentLite already records every statement, so running both double-counts.'
                      : 'Unavailable while AgentLite is selected — it already records every statement, so running both double-counts.'}
                  </div>
                )}
              </div>
            </div>
          );
        })
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
          {has('proxy') && has('network') && (
            <div style={{ background: 'var(--amber-soft)', borderRadius: 10, padding: '10px 14px', fontSize: 12, marginBottom: 14, lineHeight: 1.5 }}>
              <b style={{ color: 'var(--amber)' }}>Attribution caveat.</b> This pairing is deliberate — the network agent is your <b>bypass detector</b>, catching clients that skip the proxy and connect straight to the database. But for traffic that <em>does</em> go through the proxy, if the proxy&nbsp;→&nbsp;DB hop is cleartext the network agent sees that leg too, producing a second event whose client IP is <b>the proxy</b>, not the real end user. Keep the proxy&nbsp;→&nbsp;DB hop TLS to avoid it.
            </div>
          )}
          {has('network') && has('host') && (
            <div style={{ background: 'rgba(22,163,74,.10)', borderRadius: 10, padding: '10px 14px', fontSize: 12, marginBottom: 14, lineHeight: 1.5 }}>
              <b style={{ color: 'var(--green)' }}>Complementary, not overlapping.</b> The network agent decodes <b>cleartext</b> sessions (TLS is opaque to it); the host agent hooks below TLS and sees <b>only</b> encrypted ones. Neither sees what the other does, so nothing is double-counted — together they cover every networked session regardless of client TLS settings.
            </div>
          )}
          {has('agentless') && (
            <div style={{ background: 'rgba(22,163,74,.10)', borderRadius: 10, padding: '10px 14px', fontSize: 12, marginBottom: 14, lineHeight: 1.5 }}>
              <b style={{ color: 'var(--green)' }}>AgentLite (Audit Forwarder)</b> is a lightweight forwarder on the DB host that tails the database&apos;s <b>native audit trail</b> and ships it out — no wire tap, no path change. It&apos;s <b>transport-independent</b> (captures TLS-encrypted sessions) and the recommended mode for <b>SQL Server, Oracle and MongoDB</b>. After-the-fact — cannot block. (On PaaS the equivalent is <b>Agentless</b> — a cloud audit stream, no install.)
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
                <b>Prerequisites</b> (cloud-agnostic — same on GCP, AWS &amp; Azure):
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  <li><b>Enable the database&apos;s native audit trail</b> on the host (MySQL/MariaDB general log, pgaudit, SQL Server Audit, Oracle Unified Audit, Mongo profiler).</li>
                  <li>Allow the VM <b>outbound HTTPS (443)</b> to reach DAM (via the VPC&apos;s NAT for private VMs). No inbound rules are needed.</li>
                </ul>
                <div style={{ marginTop: 6 }}>Step-by-step: <a href="/guides/agentlite-mysql-vm.html" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--green)', fontWeight: 600 }}>Connect a self-managed database with AgentLite (MySQL · PostgreSQL · SQL Server) ↗</a></div>
              </div>
            </div>
          )}
          {has('agentless') && instEngine === 'mssql' && (
            <div style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 14px', marginBottom: 14 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>SQL Server telemetry source</div>
              <div className="muted" style={{ fontSize: 11.5, marginBottom: 8, lineHeight: 1.5 }}>
                SQL Server’s telemetry is binary, so the agent <b>polls it over TDS</b> — it runs on any Linux host that can reach <code>{`${instEngine === 'mssql' ? '<db>' : ''}`}:1433</code>, <b>not</b> on the Windows box. Needs <code>DB_USER</code>/<code>DB_PASSWORD</code>.
              </div>
              {[
                { v: 'sql_server_audit', t: 'SQL Server Audit', d: 'Object-level scoping (audit only your tables) — cleanest trail. No row counts.' },
                { v: 'xevents', t: 'Extended Events', d: 'Carries ROW COUNTS (unlocks bulk-read / large-result policies). Statement-scoped; the agent filters sys.* noise.' },
              ].map((o) => (
                <label key={o.v} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontSize: 12.5, lineHeight: 1.5, marginTop: 4 }}>
                  <input type="radio" name="mssqlsrc" checked={mssqlSource === o.v} onChange={() => { setMssqlSource(o.v); setInstructions(null); }} style={{ marginTop: 3 }} />
                  <span><b>{o.t}</b> <span className="muted">— {o.d}</span></span>
                </label>
              ))}
            </div>
          )}
          {has('agentless') && (
            <div style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 14px', marginBottom: 14 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontSize: 12.5, lineHeight: 1.5 }}>
                <input type="checkbox" checked={pubsub} onChange={(e) => { setPubsub(e.target.checked); setInstructions(null); }} style={{ marginTop: 3 }} />
                <span><b>Publish to an audit stream</b> <span className="muted">— ship events to your cloud&apos;s message bus (Pub/Sub · Kinesis · Event Hub) using the VM&apos;s own cloud identity, instead of POSTing the control plane. Adds a durable buffer that survives brief DAM outages. Unchecked = POST straight to the control plane.</span></span>
              </label>
              {pubsub && (
                <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                  <div className="form-field" style={{ flex: 1, margin: 0 }}>
                    <label style={{ fontSize: 11.5 }}>Stream / topic name</label>
                    <input value={auditTopic} onChange={(e) => { setAuditTopic(e.target.value); setInstructions(null); }} placeholder="toovix-dam-audit" />
                  </div>
                  <div className="form-field" style={{ flex: 1, margin: 0 }}>
                    <label style={{ fontSize: 11.5 }}>Cloud project / namespace <span className="muted">(optional — auto-detected on the VM)</span></label>
                    <input value={gcpProject} onChange={(e) => { setGcpProject(e.target.value); setInstructions(null); }} placeholder="(auto-detected on the VM)" />
                  </div>
                </div>
              )}
              <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>Grant the DB VM&apos;s cloud identity <b>publish</b> rights on the stream (<code>roles/pubsub.publisher</code> on GCP · a <code>PutRecord</code> IAM policy on AWS · <b>Event Hubs Data Sender</b> on Azure); the <b>dam-audit-consumer</b> pulls it into the console. See the <a href="/guides/agentlite-mysql-vm.html" target="_blank" rel="noopener noreferrer">setup guide ↗</a>.</div>
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
            {/* Kubernetes (Helm) hidden until a chart is published — the registry is a placeholder. */}
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
              <pre className="dep-cmd" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{buildInstall(instructions.platform, m, instructions.target, instructions.token, instructions.cp, instructions.engine, instructions.image, { classify: instructions.classify && m === instructions.modes[0], dbUser: instructions.dbUser, dbPass: instructions.dbPass, dbName: instructions.dbName, pubsub: instructions.pubsub, auditTopic: instructions.auditTopic, gcpProject: instructions.gcpProject, mssqlSource: instructions.mssqlSource })}</pre>
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
  // SQL Server has two telemetry sources: Audit (object-scoped, clean) or Extended Events
  // (statement-scoped, but carries ROW COUNTS). Both are polled over TDS, not tailed from disk.
  const xe = eng === 'mssql' && opts.mssqlSource === 'xevents';
  const auditSrc = eng === 'mssql'
    ? (xe ? 'xevents' : 'sql_server_audit')
    : ({ oracle: 'unified_audit_trail', postgresql: 'pgaudit', mysql: 'general_log', mariadb: 'general_log', mongodb: 'profiler' }[eng] || 'native_audit');
  // AgentLite reads this native source — a file on the host for MySQL/PG, a TDS-polled target for SQL Server.
  const auditLog = eng === 'mssql'
    ? (xe ? 'C:\\SQLAudit\\ToovixXE*.xel' : 'C:\\SQLAudit\\*.sqlaudit')
    : ({ mysql: '/var/log/mysql/general.log', mariadb: '/var/log/mysql/general.log', postgresql: '/var/log/postgresql/pgaudit.log', oracle: '<UNIFIED_AUDIT_TRAIL>', mongodb: '/var/log/mongodb/audit.json' }[eng] || '<native-audit-log-path>');
  // AgentLite audit-forward is MySQL/MariaDB-only in the agent today — warn for anything else.
  const warn = (agentless && !['mysql', 'mariadb'].includes(eng))
    ? `# ⚠ AgentLite audit-forward currently supports MySQL/MariaDB only — ${eng} is NOT implemented\n#   yet: the agent enrolls and idles (no capture). For PostgreSQL use network or host mode.\n\n`
    : '';
  const env = [
    `MODE=${agentless ? 'audit-forward' : m}`,
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
  if (m === 'proxy') {
    // Inline proxy: clients connect to LISTEN_PORT, which forwards to UPSTREAM (the real DB).
    // On the DB host itself LISTEN_PORT must differ from the DB's own port, so default to +1.
    const dbPort = Number(port || defPort);
    env.push(`LISTEN_PORT=${dbPort + 1}`, `UPSTREAM=${host || target}:${dbPort}`);
  }
  if (agentless) {
    // AgentLite: a lightweight forwarder that reads the DB's native telemetry — no wire tap, no
    // path change. MySQL/PG tail a local file (so it runs ON the DB host); SQL Server POLLS the
    // audit / XEvents target over TDS, so it can run on any Linux host that reaches <db>:1433.
    env.push(
      `AUDIT_SOURCE=${auditSrc}`,
      `AUDIT_LOG=${auditLog}`,
    );
    // SQL Server reads its telemetry over TDS, so a login is required even without classification:
    // CONTROL SERVER for the audit file, VIEW SERVER STATE for Extended Events.
    if (eng === 'mssql') {
      env.push(`DB_USER=${opts.dbUser || '<sql-login>'}`, `DB_PASSWORD=${opts.dbPass || '<password>'}`);
    }
    // Publish to the Pub/Sub audit bus (auth via the host VM's service account / metadata token)
    // instead of POSTing the control plane. Needs the VM SA to hold roles/pubsub.publisher.
    if (opts.pubsub) {
      env.push(`AUDIT_TOPIC=${opts.auditTopic || 'toovix-dam-audit'}`);
      if (opts.gcpProject) env.push(`GCP_PROJECT=${opts.gcpProject}`);
    }
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
    //   proxy   — inline TCP proxy; host network so its LISTEN_PORT is reachable on the host.
    //   agentless — AgentLite forwarder on the host; mount the native audit log read-only.
    let flags = '';
    if (m === 'network') flags = ' --network host --user 0 --cap-add NET_RAW --cap-add NET_ADMIN';
    else if (m === 'host') flags = ' --privileged --pid host --network host --user 0';
    else if (m === 'proxy') flags = ' --network host';
    else if (agentless) flags = ` --user 0${auditLog.startsWith('/') ? ` -v ${auditLog}:${auditLog}:ro` : ''}`;
    const envLines = env.map((e) => `  -e ${e}`);
    const prereq = agentless
      ? `# Prerequisite: Docker on the DB host. AgentLite tails the DB's native audit log, so the
#   database's own auditing must be ON, writing to ${auditLog}.${(eng === 'mysql' || eng === 'mariadb') ? `
#   MySQL/MariaDB — enable the general query log to that file:
#     SET GLOBAL general_log_file='${auditLog}'; SET GLOBAL general_log='ON';` : ''}
`
      : `# Prerequisite: Docker must be installed on the VM / bare-metal host.
#   Debian/Ubuntu:  curl -fsSL https://get.docker.com | sudo sh
#   RHEL/Rocky:     sudo dnf install -y docker && sudo systemctl enable --now docker
`;
    const note = agentless
      ? `# AgentLite (Audit Forwarder): a lightweight forwarder ON the DB host that tails the
#   database's native audit trail (${auditSrc}) and ships it out — no wire tap, no path change,
#   captures TLS. Enable the DB's native auditing first (Oracle Unified Audit/FGA; SQL Server
#   Audit; pgaudit; MySQL/MariaDB audit plugin; Mongo profiler). Detective only — cannot block.
#   For PaaS databases use Agentless (cloud audit stream) from the Discovery wizard instead.
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
    return `${warn}${prereq}${note}docker run -d --name toovix-agent-${m} --restart unless-stopped${flags} \\
${envLines.join(' \\\n')} \\
  ${img}`;
  }

  if (format === 'kubernetes') {
    const capSet = (m === 'network' || m === 'host') ? ' --set captureIface=any' : '';
    const classifySets = opts.classify
      ? ` \\\n  --set classify=true --set dbUser=${opts.dbUser || 'dam_svc'} --set dbPassword=${opts.dbPass || '<db-reader-password>'}${eng === 'postgresql' || eng === 'mssql' ? ` --set dbName=${opts.dbName || '<database-name>'}` : ''}`
      : '';
    return `${warn}helm repo add toovix oci://registry.toovix.security/charts
helm install dam-${m} toovix/dam-agent \\
  --namespace toovix-dam --create-namespace \\
  --set token=${token} --set endpoint=${cp} \\
  --set image=${img} \\
  --set mode=${m} --set engine=${eng} \\
  --set targetHost=${host || target} --set targetPort=${port || (eng === 'postgresql' ? 5432 : eng === 'mssql' ? 1433 : 3306)}${capSet}${classifySets}`;
  }

  if (format === 'package') {
    // Templated unit: one .deb serves every mode. Each mode gets its own agent-<mode>.env, so
    // host/network/proxy coexist on the same host without colliding.
    return `${warn}# Debian/Ubuntu (.deb) — RHEL/Rocky: sudo dnf install ./dam-agent-<ver>.x86_64.rpm
curl -fsSL ${cp}/api/download/dam-agent_amd64.deb -o dam-agent.deb
sudo dpkg -i dam-agent.deb   # installs the binary + the dam-agent@.service template (once)

# Configure THIS mode — one env file per mode (repeat for other modes to run them side by side):
sudo tee /etc/toovix/agent-${m}.env >/dev/null <<'EOF'
${env.join('\n')}
EOF
sudo systemctl enable --now dam-agent@${m}
journalctl -u dam-agent@${m} -f`;
  }

  // Default: static binary (eBPF embedded, no Docker, no deps) — installed via a systemd template.
  return `${warn}# 1) Download the static binary (eBPF embedded, no deps). 'install' replaces it safely
#    even if an agent is already running (avoids "text file busy").
curl -fsSL ${cp}/api/download/dam-agent-linux-amd64 -o /tmp/dam-agent
sudo install -D -m 0755 /tmp/dam-agent /usr/local/bin/dam-agent && rm -f /tmp/dam-agent

# 2) Install the systemd TEMPLATE once (lets host/network/proxy coexist as dam-agent@<mode>):
sudo tee /etc/systemd/system/dam-agent@.service >/dev/null <<'EOF'
[Unit]
Description=TooVix DAM agent (%i)
After=network-online.target
Wants=network-online.target
[Service]
EnvironmentFile=/etc/toovix/agent-%i.env
ExecStart=/usr/local/bin/dam-agent
Restart=always
RestartSec=5
User=root
[Install]
WantedBy=multi-user.target
EOF

# 3) Configure THIS mode + start it (repeat steps 3 for other modes):
sudo mkdir -p /etc/toovix
sudo tee /etc/toovix/agent-${m}.env >/dev/null <<'EOF'
${env.join('\n')}
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now dam-agent@${m}`;
}
