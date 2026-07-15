import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import { useNavigate } from 'react-router-dom';

const AGENTS = [
  { name: 'Network agent', tag: 'installed · passive', color: 'var(--primary)', desc: 'Sniffs the database’s network traffic and decodes the MySQL, PostgreSQL & SQL Server (TDS) wire protocols (libpcap-style). No path change, ~0 overhead. Sees every networked connection — including ones that bypass a proxy. Cleartext only — TLS-encrypted connections are opaque, and SQL Server clients encrypt by default (use the inline proxy or host/eBPF for those). Blind to local/IPC; cannot block.' },
  { name: 'Host agent (eBPF)', tag: 'installed · passive', color: 'var(--info)', desc: 'Runs on the DB host kernel. Sees every connection reaching the DB process — including local sockets / shared memory / IPC nothing else can. Deepest visibility; limited local enforcement.' },
  { name: 'Inline proxy', tag: 'installed · inline', color: 'var(--amber)', desc: 'A gateway in the data path — clients connect through it. The only mode that can block / quarantine, and the only one that sees the real end-user behind a pooled connection. Only sees traffic routed through it.' },
  { name: 'AgentLite (VM audit forwarder)', tag: 'lightweight · self-managed', color: 'var(--green)', desc: 'For self-managed DBs on a VM / on-prem: a lightweight forwarder on the host tails the database’s own native audit trail (MySQL/Percona audit, pgaudit, SQL Server Audit, Oracle Unified Audit/FGA, Mongo profiler) and ships it out — no wire tap, no path change, no SQL touched. Transport-independent, so it captures even TLS-encrypted sessions. After-the-fact — cannot block.' },
  { name: 'Agentless (PaaS cloud stream)', tag: 'no install', color: 'var(--green)', desc: 'For managed / PaaS DBs (RDS / Aurora, Cloud SQL, Azure SQL, Atlas, OCI Autonomous): the cloud emits its native audit to a stream (Pub/Sub / Kinesis / Event Hub) and the DAM consumes it. Zero software on the host, nothing in the path — the only option for PaaS. Transport-independent; after-the-fact — cannot block.' },
];

const PATHS = [
  ['App routed through the proxy', ['✓ + real client IP', 'g'], ['✓ source = proxy', 'a'], ['✓', 'g']],
  ['Direct TCP (bypasses proxy)', ['✗', 'm'], ['✓', 'g'], ['✓', 'g']],
  ['Local / IPC (Unix socket, shared mem)', ['✗', 'm'], ['✗', 'm'], ['✓ only one', 'g']],
];

const COMBO_COLS = ['Network', 'Host', 'Proxy', 'Net + Host', 'Proxy + Net', 'All 3'];
const COMBO_ROWS = [
  ['Networked SQL visibility', [['✓', 'g'], ['✓', 'g'], ['Routed only', 'a'], ['✓', 'g'], ['✓', 'g'], ['✓', 'g']]],
  ['Local / IPC visibility', [['✗', 'm'], ['✓', 'g'], ['✗', 'm'], ['✓', 'g'], ['✗', 'm'], ['✓', 'g']]],
  ['Real end-user attribution', [['✗', 'm'], ['Partial', 'a'], ['✓', 'g'], ['Partial', 'a'], ['✓', 'g'], ['✓', 'g']]],
  ['Block / quarantine', [['✗', 'm'], ['Local only', 'a'], ['✓', 'g'], ['✗', 'm'], ['✓', 'g'], ['✓', 'g']]],
  ['Reroutes clients?', [['no', 'm'], ['no', 'm'], ['YES', 'a'], ['no', 'm'], ['YES', 'a'], ['YES', 'a']]],
  ['Install on DB host?', [['no', 'm'], ['YES', 'a'], ['no', 'm'], ['on host', 'a'], ['no', 'm'], ['on host', 'a']]],
  ['Containers to deploy', [['1', 'n'], ['1', 'n'], ['1', 'n'], ['2', 'n'], ['2', 'n'], ['3', 'n']]],
];

const APPLIC_COLS = ['Deployment', 'Network', 'Host', 'Inline Proxy', 'AgentLite / Agentless', 'Recommended'];
const APPLIC_ROWS = [
  ['On-prem (bare metal)', ['✓', 'g'], ['✓', 'g'], ['✓', 'g'], ['✓ AgentLite', 'g'], 'Network + Host for MySQL/PG · AgentLite forwarder for SQL Server/Oracle/Mongo · Proxy to block'],
  ['IaaS (VM — EC2 / Azure VM / GCE)', ['✓', 'g'], ['✓', 'g'], ['✓', 'g'], ['✓ AgentLite', 'g'], 'Network + Host for MySQL/PG · AgentLite forwarder for SQL Server/Oracle/Mongo · Proxy to block'],
  ['AWS RDS / Aurora', ['✗', 'm'], ['✗', 'm'], ['⚠ in your VPC', 'a'], ['✓ Agentless', 'g'], 'Agentless (cloud stream)'],
  ['Azure SQL / Managed Instance', ['✗', 'm'], ['✗', 'm'], ['⚠ in your VPC', 'a'], ['✓ Agentless', 'g'], 'Agentless (cloud stream)'],
  ['Google Cloud SQL', ['✗', 'm'], ['✗', 'm'], ['⚠ in your VPC', 'a'], ['✓ Agentless', 'g'], 'Agentless (cloud stream)'],
  ['MongoDB on VM / on-prem', ['⚠ wire decode', 'a'], ['⚠ host eBPF', 'a'], ['⚠ for blocking', 'a'], ['✓ AgentLite', 'g'], 'AgentLite (profiler forwarder) — wire-protocol agents N/A yet'],
  ['MongoDB Atlas', ['✗', 'm'], ['✗', 'm'], ['✗', 'm'], ['✓ Agentless', 'g'], 'Agentless (Atlas webhook)'],
  ['OCI Autonomous', ['✗', 'm'], ['✗', 'm'], ['✗', 'm'], ['✓ Agentless', 'g'], 'Agentless (cloud stream)'],
];

const PRESETS = [
  { name: 'Lightweight', modes: ['network'], buys: 'Cheapest passive monitoring. Networked visibility only — no blocking, blind to local/IPC.', when: 'Low-risk, self-managed DBs', containers: 1 },
  { name: 'Full visibility', rec: true, modes: ['network', 'host'], buys: 'Complete passive capture (wire + local). No blocking, no path change.', when: 'Recommended default for self-managed DBs', containers: 2 },
  { name: 'Enforce', modes: ['proxy', 'network'], buys: 'Block routed traffic + catch proxy-bypass. Blind to local/IPC.', when: 'DBs that must block', containers: 2 },
  { name: 'Crown jewel', modes: ['network', 'host', 'proxy'], buys: 'Everything + bypass + local. Highest overhead, redundant on the routed path.', when: 'Few highest-value, regulated DBs', containers: 3 },
];

const MODE_LABEL = { network: 'Network', host: 'Host (eBPF)', proxy: 'Inline Proxy' };
const COLOR = { g: 'var(--green)', a: 'var(--amber)', m: 'var(--muted)', n: 'var(--ink)' };

function Cell({ v }) {
  const [text, tone] = v;
  return <span style={{ color: COLOR[tone] || 'var(--ink)', fontWeight: tone === 'g' || tone === 'n' ? 600 : 500, fontSize: 12.5 }}>{text}</span>;
}

// How PRACTICAL each capture mode is per engine (real-world viability, independent of
// build status) — driven by protocol openness, default encryption, and native-audit richness.
const ENGINE_COLS = ['Engine', 'Network', 'Host (eBPF)', 'Inline Proxy', 'Agentless (audit)', 'Best fit'];
const ENGINE_ROWS = [
  ['MySQL',
    ['High', 'g', 'simple protocol, often cleartext'],
    ['High', 'g', 'Linux, below TLS, sees local'],
    ['High', 'g', 'proxy-friendly; TLS-term + block'],
    ['Med', 'a', 'PaaS great; audit plugin self-mgd'],
    'Network (self-mgd) · Agentless (PaaS)'],
  ['PostgreSQL',
    ['High', 'g', 'clean protocol, cleartext common'],
    ['High', 'g', 'Linux, below TLS'],
    ['High', 'g', 'PgBouncer-style; TLS-term + block'],
    ['High', 'g', 'pgaudit (free) / PaaS logs'],
    'Network · pgaudit'],
  ['SQL Server',
    ['Low', 'r', 'encrypts by default → blind'],
    ['Med', 'a', 'below TLS, but Windows = no eBPF'],
    ['Med', 'a', 'TDS proxy viable; big build'],
    ['High', 'g', 'SQL Audit / Event Hub, native'],
    'Agentless (audit)'],
  ['MongoDB',
    ['Low', 'r', 'low value; TLS common (Atlas)'],
    ['Low', 'r', 'pointless vs. profiler'],
    ['Med', 'a', 'mongos-style; only to block'],
    ['High', 'g', 'native profiler / audit — all ops'],
    'Agentless (profiler)'],
  ['Oracle',
    ['Low', 'r', 'proprietary TNS + usually encrypted'],
    ['Med', 'a', 'below encryption; low ROI'],
    ['Low', 'r', '≈ rebuilding Oracle DB Firewall'],
    ['High', 'g', 'Unified Audit + FGA, best-in-class'],
    'Agentless (audit)'],
];
const PRAC_COLOR = { g: 'var(--green)', a: 'var(--amber)', r: 'var(--danger)' };
function PracCell({ v }) {
  const [label, tone, reason] = v;
  return (
    <div style={{ minWidth: 130 }}>
      <div style={{ color: PRAC_COLOR[tone], fontWeight: 700, fontSize: 12.5 }}>{label}</div>
      <div style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.35, marginTop: 2 }}>{reason}</div>
    </div>
  );
}

// What TooVix actually builds per engine: MySQL/PG get the full stack; Oracle, SQL
// Server and MongoDB are agentless-first (audit) — where passive/proxy/eBPF are low-ROI.
const STRATEGY_COLS = ['Engine', 'Network', 'Host (eBPF)', 'Inline Proxy', 'Agentless (audit)', 'Approach'];
const STRATEGY_ROWS = [
  ['MySQL', 'y', 'y', 'y', 'y', 'Full stack — all four modes'],
  ['PostgreSQL', 'y', 'y', 'y', 'y', 'Full stack — all four modes'],
  ['SQL Server', 'n', 'n', 'n', 'y', 'Audit-first (AgentLite / Agentless)'],
  ['Oracle', 'n', 'n', 'n', 'y', 'Audit-first (AgentLite / Agentless)'],
  ['MongoDB', 'n', 'n', 'n', 'y', 'Audit-first (AgentLite / Agentless)'],
];
function StratCell({ v }) {
  return v === 'y'
    ? <span style={{ color: 'var(--green)', fontWeight: 700, fontSize: 12.5 }}>✓ build</span>
    : <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>—</span>;
}

const V = {
  line: 'var(--line)', ink: 'var(--ink)', muted: 'var(--muted)', surf: 'var(--surface-2)',
  net: 'var(--primary)', host: 'var(--info)', proxy: 'var(--amber)', agentless: 'var(--green)',
};
const T = (x, y, text, color = V.ink, size = 11.5, weight = 600, anchor = 'middle') =>
  <text x={x} y={y} textAnchor={anchor} style={{ fill: color, fontSize: size, fontWeight: weight }}>{text}</text>;

function LegendItem({ c, t }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: c, flex: 'none' }} />{t}</span>;
}

// Visual "at a glance" of where each capture mode sits and what it can do.
function CaptureDiagram() {
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-header"><span className="card-title">At a glance — the four capture modes</span><span className="card-sub">where each sits · what it can do</span></div>
      <div className="card-body">
        <svg viewBox="0 0 900 262" width="100%" style={{ maxHeight: 300 }} role="img" aria-label="Capture modes architecture diagram">
          <defs>
            <marker id="cmArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="userSpaceOnUse">
              <path d="M0,0 L6,3 L0,6 Z" fill="context-stroke" />
            </marker>
          </defs>

          {/* DAM control plane */}
          <rect x="30" y="8" width="840" height="32" rx="8" style={{ fill: V.surf, stroke: V.line }} />
          {T(450, 28, '🛡  TooVix DAM — Control Plane   ·   events in → alerts out', V.ink, 12.5, 700)}

          {/* telemetry (dashed, agent-initiated outbound) — every agent dials out */}
          <line x1="530" y1="146" x2="530" y2="42" style={{ stroke: V.net }} strokeDasharray="4 3" markerEnd="url(#cmArrow)" />
          <line x1="302" y1="166" x2="302" y2="42" style={{ stroke: V.proxy }} strokeDasharray="4 3" markerEnd="url(#cmArrow)" />
          <line x1="575" y1="204" x2="575" y2="42" style={{ stroke: V.host }} strokeDasharray="4 3" markerEnd="url(#cmArrow)" />
          <line x1="806" y1="168" x2="806" y2="42" style={{ stroke: V.agentless }} strokeDasharray="4 3" markerEnd="url(#cmArrow)" />

          {/* data path: App → proxy → DB host (wire at y=190) */}
          <rect x="30" y="170" width="96" height="40" rx="8" style={{ fill: V.surf, stroke: V.line }} />
          {T(78, 187, 'App /', V.ink, 11, 600)}{T(78, 201, 'Clients', V.ink, 11, 600)}
          <line x1="126" y1="190" x2="248" y2="190" style={{ stroke: V.ink }} markerEnd="url(#cmArrow)" />

          <rect x="250" y="166" width="104" height="48" rx="8" style={{ fill: V.surf, stroke: V.proxy, strokeWidth: 2 }} />
          {T(302, 186, '③ Inline proxy', V.proxy, 11, 700)}{T(302, 202, 'GATE · blocks', V.proxy, 9.5, 600)}
          <line x1="354" y1="190" x2="594" y2="190" style={{ stroke: V.ink }} markerEnd="url(#cmArrow)" />

          {/* DB host — BOTH the network and host agents run ON the host (different capture layers) */}
          <rect x="438" y="118" width="300" height="124" rx="10" style={{ fill: 'none', stroke: V.host }} strokeDasharray="5 4" />
          {T(446, 135, 'DB host (e.g. db-vm-a)', V.muted, 9.5, 600, 'start')}
          <rect x="452" y="146" width="106" height="30" rx="6" style={{ fill: V.surf, stroke: V.net, strokeWidth: 1.5 }} />
          {T(505, 160, '① Network agent', V.net, 10, 700)}{T(505, 171, 'NIC / pcap layer', V.muted, 8.5, 500)}
          <rect x="452" y="204" width="106" height="30" rx="6" style={{ fill: V.surf, stroke: V.host, strokeWidth: 1.5 }} />
          {T(505, 218, '② Host eBPF', V.host, 10, 700)}{T(505, 229, 'kernel syscalls', V.muted, 8.5, 500)}
          <rect x="594" y="168" width="126" height="46" rx="6" style={{ fill: V.surf, stroke: V.line }} />
          {T(657, 195, 'DB', V.ink, 12, 700)}
          <line x1="505" y1="176" x2="505" y2="190" style={{ stroke: V.net }} strokeDasharray="3 3" />
          <line x1="505" y1="204" x2="505" y2="190" style={{ stroke: V.host }} strokeDasharray="3 3" />

          {/* ④ Agentless (reads audit logs — no install; off-host) */}
          <line x1="720" y1="191" x2="740" y2="191" style={{ stroke: V.agentless }} markerEnd="url(#cmArrow)" />
          {T(730, 184, 'audit', V.muted, 8.5, 500)}
          <rect x="742" y="168" width="128" height="46" rx="6" style={{ fill: V.surf, stroke: V.agentless, strokeWidth: 1.5 }} />
          {T(806, 185, '④ Audit-based', V.agentless, 10.5, 700)}{T(806, 199, 'AgentLite · Agentless', V.agentless, 8.5, 500)}
        </svg>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', marginTop: 8, fontSize: 12 }}>
          <LegendItem c="var(--primary)" t="① Network — on-host NIC sniff (pcap); or off-host SPAN/tap · observe" />
          <LegendItem c="var(--info)" t="② Host eBPF — on the DB host, kernel layer · observe (local + IPC)" />
          <LegendItem c="var(--amber)" t="③ Inline proxy — in the path · observe + BLOCK" />
          <LegendItem c="var(--green)" t="④ Audit-based — AgentLite forwarder (VM) / Agentless cloud stream (PaaS) · observe" />
        </div>
        <p className="muted" style={{ fontSize: 11.5, margin: '10px 2px 0', lineHeight: 1.5 }}>
          The <b style={{ color: 'var(--primary)' }}>network</b> and <b style={{ color: 'var(--info)' }}>host</b> agents both run <b>on the DB host</b> — they differ by capture layer (NIC/pcap vs kernel), not location. The network agent can alternatively run off-host as a <b>SPAN port / traffic mirror</b>. Dashed lines = telemetry each agent sends <b>outbound</b> to the DAM (the control plane never connects into your DB network — which is why this works for private, no-public-IP databases). Only the <b style={{ color: 'var(--amber)' }}>inline proxy</b> sits in the traffic path, so it’s the only mode that can block in real time.
        </p>
      </div>
    </div>
  );
}

// Where the audit-based modes get their data: AgentLite (VM forwarder) + Agentless (PaaS
// native stream) both converge on one Pub/Sub backbone the DAM consumes.
function AgentlessFlow() {
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-header"><span className="card-title">Audit collection — AgentLite &amp; Agentless</span><span className="card-sub">both feed one Pub/Sub backbone · no wire tap</span></div>
      <div className="card-body">
        <svg viewBox="0 0 900 196" width="100%" style={{ maxHeight: 244 }} role="img" aria-label="AgentLite and Agentless audit data flow">
          <defs>
            <marker id="afArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="userSpaceOnUse">
              <path d="M0,0 L6,3 L0,6 Z" fill="context-stroke" />
            </marker>
          </defs>
          {/* PaaS source — native audit, no install */}
          <rect x="16" y="30" width="176" height="46" rx="8" style={{ fill: V.surf, stroke: V.agentless, strokeWidth: 1.5 }} />
          {T(104, 49, 'Managed DB (PaaS)', V.ink, 11, 700)}{T(104, 64, 'RDS · Cloud SQL · Azure SQL', V.muted, 8.5, 500)}
          {/* VM source */}
          <rect x="16" y="120" width="176" height="46" rx="8" style={{ fill: V.surf, stroke: V.line }} />
          {T(104, 139, 'Self-managed DB VM', V.ink, 11, 700)}{T(104, 154, 'native audit → log file', V.muted, 8.5, 500)}
          {/* AgentLite forwarder (VM path only) */}
          <rect x="244" y="120" width="150" height="46" rx="8" style={{ fill: V.surf, stroke: V.agentless, strokeWidth: 2 }} />
          {T(319, 139, 'AgentLite forwarder', V.agentless, 10.5, 700)}{T(319, 154, 'tails audit · ships', V.muted, 8.5, 500)}
          {/* Pub/Sub backbone */}
          <rect x="472" y="66" width="150" height="60" rx="10" style={{ fill: V.surf, stroke: V.host, strokeWidth: 1.5 }} />
          {T(547, 90, 'Pub/Sub', V.host, 13, 700)}{T(547, 107, 'audit backbone', V.muted, 9, 500)}
          {/* DAM */}
          <rect x="700" y="72" width="184" height="48" rx="10" style={{ fill: V.surf, stroke: V.line }} />
          {T(792, 92, '🛡 TooVix DAM', V.ink, 11.5, 700)}{T(792, 107, 'events → alerts', V.muted, 8.5, 500)}
          {/* arrows */}
          <line x1="192" y1="53" x2="468" y2="86" style={{ stroke: V.agentless }} markerEnd="url(#afArrow)" />
          {T(330, 58, 'native audit stream', V.muted, 8.5, 500)}
          <line x1="192" y1="143" x2="240" y2="143" style={{ stroke: V.ink }} markerEnd="url(#afArrow)" />
          <line x1="394" y1="143" x2="468" y2="114" style={{ stroke: V.agentless }} markerEnd="url(#afArrow)" />
          {T(432, 160, '→ Cloud Logging → bus', V.muted, 8.5, 500)}
          <line x1="622" y1="96" x2="696" y2="96" style={{ stroke: V.host }} markerEnd="url(#afArrow)" />
          {T(660, 90, 'consume', V.muted, 8.5, 500)}
        </svg>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', marginTop: 8, fontSize: 12 }}>
          <LegendItem c="var(--green)" t="AgentLite — lightweight forwarder on the self-managed VM (tails native audit)" />
          <LegendItem c="var(--green)" t="Agentless — PaaS emits audit natively; nothing installed" />
          <LegendItem c="var(--info)" t="Pub/Sub — one audit backbone the DAM consumes" />
        </div>
        <p className="muted" style={{ fontSize: 11.5, margin: '10px 2px 0', lineHeight: 1.5 }}>
          Both paths converge on one <b style={{ color: 'var(--info)' }}>Pub/Sub</b> backbone. <b style={{ color: 'var(--green)' }}>PaaS</b> emits its audit to the stream with zero footprint; a <b style={{ color: 'var(--green)' }}>self-managed VM</b> uses the <b>AgentLite</b> forwarder to tail the DB’s native audit and ship it — no wire tap, no path change, transport-independent (captures TLS). Audit-based, so it’s <b>detective only</b> (after-the-fact) — for real-time blocking use the inline proxy.
        </p>
      </div>
    </div>
  );
}

function ReferenceTopology() {
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-header">
        <span className="card-title">Reference deployment topology — a cloud estate</span>
        <span className="card-sub">how the modes land in practice · one VPC per DB · push to the bus</span>
      </div>
      <div className="card-body">
        <svg viewBox="0 0 940 300" width="100%" style={{ maxHeight: 350 }} role="img" aria-label="Reference cloud topology: VM path via Cloud NAT, PaaS path via Cloud Logging, both to Pub/Sub then DAM">
          <defs>
            <marker id="gtArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="userSpaceOnUse">
              <path d="M0,0 L6,3 L0,6 Z" fill="context-stroke" />
            </marker>
          </defs>

          {/* Customer estate frame */}
          <rect x="8" y="8" width="266" height="284" rx="12" style={{ fill: 'none', stroke: V.line, strokeDasharray: '4 4' }} />
          {T(20, 25, 'CUSTOMER ESTATE · per-DB VPC', V.muted, 9, 700, 'start')}

          {/* VPC A — VM (AgentLite) */}
          <rect x="18" y="34" width="248" height="58" rx="9" style={{ fill: V.surf, stroke: V.net, strokeWidth: 1.5 }} />
          {T(32, 53, 'db-vm-a-vpc', V.ink, 11, 700, 'start')}{T(252, 53, '10.10.0.0/24', V.muted, 8.5, 600, 'end')}
          {T(32, 68, 'MySQL on VM · orders', V.muted, 8.5, 500, 'start')}
          {T(32, 83, '● AgentLite forwarder (on the VM)', V.net, 8.5, 700, 'start')}

          {/* VPC B — VM (AgentLite) */}
          <rect x="18" y="102" width="248" height="58" rx="9" style={{ fill: V.surf, stroke: V.net, strokeWidth: 1.5 }} />
          {T(32, 121, 'db-vm-b-vpc', V.ink, 11, 700, 'start')}{T(252, 121, '10.20.0.0/24', V.muted, 8.5, 600, 'end')}
          {T(32, 136, 'MySQL on VM · customers', V.muted, 8.5, 500, 'start')}
          {T(32, 151, '● AgentLite forwarder (on the VM)', V.net, 8.5, 700, 'start')}

          {/* VPC C — PaaS */}
          <rect x="18" y="170" width="248" height="64" rx="9" style={{ fill: V.surf, stroke: V.agentless, strokeWidth: 1.5 }} />
          {T(32, 189, 'db-paas-vpc', V.ink, 11, 700, 'start')}{T(252, 189, '10.30.0.0/24', V.muted, 8.5, 600, 'end')}
          {T(32, 205, 'Cloud SQL · PRIVATE IP · no agent', V.muted, 8.5, 500, 'start')}
          {T(32, 221, '● native audit (emitted by GCP)', V.agentless, 8.5, 700, 'start')}

          {/* Route A — Cloud NAT (VM / IaaS egress) */}
          <rect x="316" y="66" width="92" height="60" rx="8" style={{ fill: V.surf, stroke: V.net, strokeWidth: 1.5 }} />
          {T(362, 90, 'Cloud NAT', V.net, 10.5, 700)}{T(362, 105, 'customer', V.muted, 8, 500)}{T(362, 116, 'egress', V.muted, 8, 500)}

          {/* Route B — Cloud Logging (PaaS only, Google-internal) */}
          <rect x="316" y="176" width="112" height="58" rx="8" style={{ fill: V.surf, stroke: V.agentless, strokeWidth: 1.5 }} />
          {T(372, 197, 'Cloud Logging', V.agentless, 10, 700)}{T(372, 211, '+ Log Sink', V.muted, 8.5, 600)}{T(372, 224, 'Google-internal', V.muted, 7.5, 500)}

          {/* Pub/Sub backbone */}
          <rect x="484" y="112" width="150" height="78" rx="10" style={{ fill: V.surf, stroke: V.host, strokeWidth: 1.5 }} />
          {T(559, 140, 'Pub/Sub', V.host, 13, 700)}{T(559, 158, 'toovix-dam-audit', V.muted, 8.5, 600)}
          {T(559, 173, 'one shared bus', V.muted, 8, 500)}

          {/* DAM control plane */}
          <rect x="712" y="115" width="216" height="72" rx="10" style={{ fill: V.surf, stroke: V.line }} />
          {T(820, 141, '🛡 TooVix DAM', V.ink, 12, 700)}{T(820, 158, 'connector pulls (keyless ADC)', V.muted, 8.5, 500)}
          {T(820, 172, 'events → ClickHouse → alerts', V.muted, 8.5, 500)}

          {/* VM paths → Cloud NAT → Pub/Sub (publish, blue) */}
          <line x1="266" y1="63" x2="314" y2="88" style={{ stroke: V.net }} markerEnd="url(#gtArrow)" />
          <line x1="266" y1="131" x2="314" y2="104" style={{ stroke: V.net }} markerEnd="url(#gtArrow)" />
          <line x1="408" y1="96" x2="480" y2="140" style={{ stroke: V.net }} markerEnd="url(#gtArrow)" />
          {T(452, 112, 'publish', V.net, 8.5, 700)}
          {/* PaaS path → Cloud Logging → Pub/Sub (green, no NAT) */}
          <line x1="266" y1="205" x2="314" y2="205" style={{ stroke: V.agentless }} markerEnd="url(#gtArrow)" />
          <line x1="428" y1="200" x2="480" y2="166" style={{ stroke: V.agentless }} markerEnd="url(#gtArrow)" />
          {T(454, 196, 'log sink', V.agentless, 8.5, 700)}
          {/* Pub/Sub → DAM (outbound pull) */}
          <line x1="634" y1="151" x2="708" y2="151" style={{ stroke: V.host }} markerEnd="url(#gtArrow)" />
          {T(672, 144, 'pull ↩', V.host, 8.5, 700)}{T(672, 166, 'outbound', V.muted, 7.5, 500)}
        </svg>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', marginTop: 8, fontSize: 12 }}>
          <LegendItem c="var(--primary)" t="VM / IaaS — AgentLite forwarder publishes via Cloud NAT · NOT through Cloud Logging" />
          <LegendItem c="var(--green)" t="PaaS — Cloud SQL audit → Cloud Logging → Log Sink · Google-internal, no NAT" />
          <LegendItem c="var(--info)" t="Pub/Sub — the one bus both routes converge on; DAM pulls outbound" />
        </div>
        <p className="muted" style={{ fontSize: 11.5, margin: '10px 2px 0', lineHeight: 1.5 }}>
          The two paths reach the bus by <b>different routes</b>. A self-managed <b style={{ color: 'var(--primary)' }}>VM</b> runs the <b>AgentLite forwarder</b>, which reads the DB’s local audit log and publishes straight to Pub/Sub through the VPC’s <b style={{ color: 'var(--primary)' }}>Cloud NAT</b> — it <b>does not use Cloud Logging</b>. A managed <b style={{ color: 'var(--green)' }}>Cloud SQL</b> DB can’t run an agent, so GCP routes its native audit internally: DB → <b style={{ color: 'var(--green)' }}>Cloud Logging</b> → Log Sink → Pub/Sub, entirely <b>Google-internal</b> (no customer NAT). Both converge on one <b style={{ color: 'var(--info)' }}>Pub/Sub</b> bus that the DAM pulls <b>outbound</b> (keyless). Each DB stays in its own VPC — no inbound opened, no hub peering.
        </p>
      </div>
    </div>
  );
}

export default function CaptureModes() {
  const navigate = useNavigate();

  return (
    <Layout>
      <PageHeader title="Capture Modes &amp; Coverage" meta={['understand the trade-offs', 'then deploy from Agents & Coverage']}>
        <button className="btn-primary" onClick={() => navigate('/agents?deploy=1')}>Go to deploy →</button>
      </PageHeader>

      {/* Visual overview */}
      <CaptureDiagram />

      {/* Audit-based collection: AgentLite (VM) + Agentless (PaaS) */}
      <AgentlessFlow />

      {/* Reference topology — modes mapped onto a real per-DB-VPC cloud estate */}
      <ReferenceTopology />

      {/* Mode primer */}
      <div className="grid2" style={{ marginBottom: 14 }}>
        {AGENTS.map((a) => (
          <div className="card" key={a.name}>
            <div className="card-body">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: a.color, flex: 'none' }} />
                <b style={{ fontSize: 14 }}>{a.name}</b>
                <span className="pill" style={{ marginLeft: 'auto' }}>{a.tag}</span>
              </div>
              <p className="muted" style={{ fontSize: 12.5, margin: 0, lineHeight: 1.5 }}>{a.desc}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 14, background: 'var(--surface-2)' }}>
        <div className="card-body" style={{ fontSize: 13, lineHeight: 1.55 }}>
          <b>Mental model:</b> the <b style={{ color: 'var(--amber)' }}>inline proxy is a gate</b> the traffic passes through (so it can stop it); the <b style={{ color: 'var(--primary)' }}>network</b> and <b style={{ color: 'var(--info)' }}>host</b> agents are <b>cameras pointed at the database</b> (they see traffic arrive but can’t stop it). Each catches a path the others can’t — so combining them closes blind spots.
        </div>
      </div>

      {/* Who sees what */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Who sees what — by connection path</span></div>
        <div className="card-body no-pad" style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead><tr><th>Connection path</th><th>Inline Proxy</th><th>Network agent</th><th>Host agent</th></tr></thead>
            <tbody>
              {PATHS.map((r) => (
                <tr key={r[0]}>
                  <td style={{ fontWeight: 600 }}>{r[0]}</td>
                  <td><Cell v={r[1]} /></td>
                  <td><Cell v={r[2]} /></td>
                  <td><Cell v={r[3]} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* What each combination buys */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">What each combination buys</span><span className="card-sub">pick a posture, not a checkbox</span></div>
        <div className="card-body no-pad" style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead><tr><th>Capability</th>{COMBO_COLS.map((c) => <th key={c} style={{ textAlign: 'center' }}>{c}</th>)}</tr></thead>
            <tbody>
              {COMBO_ROWS.map((row) => (
                <tr key={row[0]}>
                  <td style={{ fontWeight: 600 }}>{row[0]}</td>
                  {row[1].map((cell, i) => <td key={i} style={{ textAlign: 'center' }}><Cell v={cell} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Applicability by deployment type */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">What’s applicable by deployment type</span><span className="card-sub">self-managed → AgentLite forwarder · PaaS → Agentless (cloud stream)</span></div>
        <div className="card-body no-pad" style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead><tr>{APPLIC_COLS.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {APPLIC_ROWS.map((row) => (
                <tr key={row[0]}>
                  <td style={{ fontWeight: 600 }}>{row[0]}</td>
                  <td><Cell v={row[1]} /></td>
                  <td><Cell v={row[2]} /></td>
                  <td><Cell v={row[3]} /></td>
                  <td><Cell v={row[4]} /></td>
                  <td className="muted" style={{ fontSize: 12.5 }}>{row[5]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: '-6px 2px 16px' }}>
        ⚠ Inline proxy can front a PaaS database if it exposes a network endpoint you route through (you deploy the proxy in your own VPC, not on the managed host) — but agentless capture is the recommended fit for managed databases.
      </p>

      {/* How practical is each mode per engine */}
      <div className="card" style={{ marginBottom: 6 }}>
        <div className="card-header">
          <span className="card-title">How practical is each mode — by database engine</span>
          <span className="card-sub">protocol openness · default encryption · native-audit richness</span>
        </div>
        <div className="card-body no-pad" style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead><tr>{ENGINE_COLS.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {ENGINE_ROWS.map((row) => (
                <tr key={row[0]}>
                  <td style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{row[0]}</td>
                  <td><PracCell v={row[1]} /></td>
                  <td><PracCell v={row[2]} /></td>
                  <td><PracCell v={row[3]} /></td>
                  <td><PracCell v={row[4]} /></td>
                  <td style={{ fontSize: 12, fontWeight: 600 }}>{row[5]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-body" style={{ paddingTop: 10, display: 'flex', flexWrap: 'wrap', gap: '6px 16px', fontSize: 11.5 }}>
          <span><b style={{ color: 'var(--green)' }}>High</b> practical</span>
          <span><b style={{ color: 'var(--amber)' }}>Med</b> workable</span>
          <span><b style={{ color: 'var(--danger)' }}>Low</b> poor fit</span>
          <span className="muted">Passive <b>Network</b> can’t see TLS; <b>Proxy</b> / <b>Host</b> / <b>Agentless</b> can.</span>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: '4px 2px 16px', lineHeight: 1.5 }}>
        As protocols get more proprietary and encryption becomes the default, the practical mode shifts <b>Network → audit-based</b>. Rule of thumb: <b>Network</b> for open-protocol, cleartext, self-managed DBs; <b>Inline proxy</b> when you must <b>block</b> encrypted traffic; <b>audit-based</b> — an <b>AgentLite</b> forwarder on self-managed VMs, <b>Agentless</b> cloud stream on PaaS — for encrypted, PaaS, and proprietary engines (SQL Server, MongoDB, Oracle).
      </p>

      {/* TooVix build strategy per engine */}
      <div className="card" style={{ marginBottom: 6 }}>
        <div className="card-header">
          <span className="card-title">What TooVix builds — capture strategy per engine</span>
          <span className="card-sub">full stack for open protocols · audit-first for the rest</span>
        </div>
        <div className="card-body no-pad" style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead><tr>{STRATEGY_COLS.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {STRATEGY_ROWS.map((row) => (
                <tr key={row[0]}>
                  <td style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{row[0]}</td>
                  <td><StratCell v={row[1]} /></td>
                  <td><StratCell v={row[2]} /></td>
                  <td><StratCell v={row[3]} /></td>
                  <td><StratCell v={row[4]} /></td>
                  <td style={{ fontSize: 12, fontWeight: 600 }}>{row[5]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: '4px 2px 16px', lineHeight: 1.5 }}>
        <b>MySQL &amp; PostgreSQL</b> get all four modes — open protocols, often cleartext, Linux hosts. <b>SQL Server, Oracle &amp; MongoDB</b> start <b>audit-first</b>: their proprietary / encrypted-by-default protocols make passive, proxy and eBPF low-ROI, while native audit (SQL Server Audit, Oracle Unified Audit/FGA, Mongo profiler) is complete and transport-independent. That audit is collected two ways: an <b>AgentLite forwarder</b> on self-managed VMs / on-prem, and <b>Agentless (cloud stream)</b> for PaaS.
      </p>

      {/* Data classification — orthogonal to capture */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Data classification</span><span className="card-sub">separate from capture — any agent can do it</span></div>
        <div className="card-body" style={{ fontSize: 13, lineHeight: 1.6 }}>
          <p style={{ margin: '0 0 8px' }}>
            Classification — finding which columns hold <b>PII/PCI</b> — is <b>independent of the capture mode</b>.
            It doesn’t watch traffic: the agent logs into the database as a <b>least-privilege reader</b>
            (e.g. <code>dam_svc</code> with <code>SELECT</code>), reads <code>information_schema</code>, and matches
            column names against the PII/PCI pattern library (Aadhaar, SSN, card number/CVV, email, name, DOB,
            phone, address…). Results populate the <b>Classification</b> page.
          </p>
          <ul style={{ margin: '0 0 4px', paddingLeft: 18 }}>
            <li><b>Any agent can classify</b> — network, host or proxy. The same agent already on the DB host does the scan; no separate agent needed.</li>
            <li>Enable it with <code>CLASSIFY=true</code>, <code>DB_USER</code> and <code>DB_PASSWORD</code> on the agent (PostgreSQL also needs <code>DB_NAME</code>). Re-scans every <code>CLASSIFY_INTERVAL_MIN</code> min (default 30), all over the same outbound path — no inbound DB connection.</li>
            <li>For <b>agentless / PaaS</b> sources the standalone <b>collector</b> runs the same scan. Classification is available for <b>MySQL, PostgreSQL, and SQL Server</b> in this build.</li>
          </ul>
        </div>
      </div>

      {/* Posture presets → deploy */}
      <div className="page-header" style={{ marginBottom: 8 }}>
        <h1 style={{ fontSize: 15 }}>Ready? Pick a posture and deploy</h1>
      </div>
      <div className="grid2">
        {PRESETS.map((p) => (
          <div className="card" key={p.name}>
            <div className="card-body">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <b style={{ fontSize: 14.5 }}>{p.name}</b>
                {p.rec && <span className="pill ind">recommended</span>}
                <span className="pill" style={{ marginLeft: 'auto' }}>{p.containers} container{p.containers > 1 ? 's' : ''}</span>
              </div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', margin: '4px 0 8px' }}>
                {p.modes.map((m) => <span key={m} className={`mon-pill ${m === 'proxy' ? 'agentless' : 'agent'}`}>{MODE_LABEL[m]}</span>)}
              </div>
              <p className="muted" style={{ fontSize: 12.5, margin: '0 0 4px', lineHeight: 1.5 }}>{p.buys}</p>
              <p style={{ fontSize: 12, margin: '0 0 12px' }}><b>Use when:</b> {p.when}</p>
              <button className="btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => navigate(`/agents?deploy=1&modes=${p.modes.join(',')}`)}>
                Deploy this →
              </button>
            </div>
          </div>
        ))}
      </div>
    </Layout>
  );
}
