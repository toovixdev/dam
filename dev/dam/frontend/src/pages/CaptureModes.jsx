import { Fragment } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import { useNavigate } from 'react-router-dom';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

// ── Capture mode × engine/deployment support matrix ──────────────────────────
// Grounded in what the agent / consumer actually build today (not aspirational):
//   network = MySQL/PG/MSSQL wire decode · host(eBPF) = MySQL/PG · inline proxy = MySQL only
//   AgentLite = all five engines (log tail or remote poll) · agentless = Pub/Sub + Event Hub
// state: 'built' (shipping) · 'possible' (viable, not implemented) · 'na' (doesn't apply)
// v: verified end-to-end against a live instance.
const MODES = [
  ['Network', 'passive · wire'],
  ['Host (eBPF)', 'on host · below TLS'],
  ['Inline Proxy', 'gateway · blocks'],
  ['AgentLite', 'audit-forward'],
  ['Agentless', 'cloud stream'],
];

const MATRIX = [
  {
    engine: 'MySQL / MariaDB', tag: 'open protocol · often cleartext', rows: [
      { dep: 'Self-managed', sub: 'VM · on-prem', cells: [
        { s: 'built', n: 'passive sniff' }, { s: 'built', n: 'below TLS' }, { s: 'built', n: 'can block' },
        { s: 'built', n: 'general log tail', v: true }, { s: 'na', n: 'PaaS path' }] },
      { dep: 'Managed (PaaS)', sub: 'Cloud SQL · RDS', cells: [
        { s: 'na', n: 'no host' }, { s: 'na', n: 'no host' }, { s: 'possible', n: 'proxy in your VPC' },
        { s: 'na', n: 'no host to tail' }, { s: 'built', n: 'Cloud SQL → Pub/Sub · RDS planned', v: true }] },
    ],
  },
  {
    engine: 'PostgreSQL', tag: 'clean protocol · pgAudit native', rows: [
      { dep: 'Self-managed', sub: 'VM · on-prem', cells: [
        { s: 'built', n: 'passive sniff' }, { s: 'built', n: 'below TLS' }, { s: 'possible', n: 'proxy is MySQL-only today' },
        { s: 'built', n: 'statement / pgAudit log', v: true }, { s: 'na', n: 'PaaS path' }] },
      { dep: 'Managed (PaaS)', sub: 'Cloud SQL · RDS · Azure', cells: [
        { s: 'na', n: 'no host' }, { s: 'na', n: 'no host' }, { s: 'possible', n: 'proxy in your VPC' },
        { s: 'na', n: 'no host to tail' }, { s: 'built', n: 'Cloud SQL pgAudit → Pub/Sub · RDS/Azure planned', v: true }] },
    ],
  },
  {
    engine: 'SQL Server', tag: 'encrypts by default · rich native audit', rows: [
      { dep: 'Self-managed', sub: 'VM · on-prem', cells: [
        { s: 'possible', n: 'TDS decoder built · TLS-blind by default' }, { s: 'na', n: 'Windows · no eBPF' },
        { s: 'possible', n: 'proxy is MySQL-only today' }, { s: 'built', n: 'Audit or XEvents poll · XEvents = row counts', v: true },
        { s: 'na', n: 'PaaS path' }] },
      { dep: 'Azure SQL (PaaS)', sub: 'DB · Managed Instance', cells: [
        { s: 'na', n: 'no host' }, { s: 'na', n: 'no host' }, { s: 'possible', n: 'proxy in your VPC' },
        { s: 'built', n: 'XEvents → blob poll · row counts', v: true }, { s: 'built', n: 'Auditing → Event Hub', v: true }] },
    ],
  },
  {
    engine: 'MongoDB', tag: 'profiler is the native source', rows: [
      { dep: 'Self-managed', sub: 'VM · on-prem', cells: [
        { s: 'possible', n: 'no wire decoder · low value' }, { s: 'na', n: 'pointless vs profiler' },
        { s: 'possible', n: 'mongos-style · not built' }, { s: 'built', n: 'profiler poll (system.profile)', v: true },
        { s: 'na', n: 'PaaS path' }] },
      { dep: 'Atlas (PaaS)', sub: 'managed cluster', cells: [
        { s: 'na', n: 'no host' }, { s: 'na', n: 'no host' }, { s: 'na', n: '—' },
        { s: 'built', n: 'profiler poll via MONGO_URI' }, { s: 'possible', n: 'Atlas webhook · planned' }] },
    ],
  },
  {
    engine: 'Oracle', tag: 'proprietary TNS · unified audit best-in-class', rows: [
      { dep: 'Self-managed', sub: 'VM · on-prem', cells: [
        { s: 'possible', n: 'TNS · usually encrypted' }, { s: 'possible', n: 'below TLS · not built' },
        { s: 'possible', n: '≈ Oracle DB Firewall · not built' }, { s: 'built', n: 'unified audit poll · row counts (V$SQLSTATS)', v: true },
        { s: 'na', n: 'PaaS path' }] },
      { dep: 'Managed (PaaS)', sub: 'RDS · OCI Autonomous', cells: [
        { s: 'na', n: 'no host' }, { s: 'na', n: 'no host' }, { s: 'na', n: '—' },
        { s: 'built', n: 'unified audit over SQL*Net · OCI ADB verified', v: true }, { s: 'possible', n: 'OCI Streaming / Data Safe · planned' }] },
    ],
  },
];

const STATE = {
  built: { label: '✓ built', color: 'var(--green)' },
  possible: { label: '○ possible', color: 'var(--amber)' },
  na: { label: '—', color: 'var(--muted)' },
};

function SupCell({ s, n, v }) {
  const st = STATE[s];
  return (
    <td style={{ padding: '11px 14px', verticalAlign: 'middle', borderBottom: '1px solid var(--line)' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', fontFamily: MONO, fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 6, letterSpacing: '.02em', color: st.color, background: `color-mix(in srgb, ${st.color} 14%, transparent)` }}>{st.label}</span>
      <span style={{ display: 'block', marginTop: 6, fontFamily: MONO, fontSize: 10.5, lineHeight: 1.35, color: v ? 'var(--ink)' : 'var(--muted)', maxWidth: '21ch' }}>
        {n}
        {v && <em style={{ display: 'block', marginTop: 3, fontStyle: 'normal', fontSize: 9.5, letterSpacing: '.06em', color: 'var(--primary)', borderBottom: '2px solid var(--primary)', paddingBottom: 1, width: 'fit-content' }}>✓ tested</em>}
      </span>
    </td>
  );
}

// ── Per-mode capability cards ────────────────────────────────────────────────
const CAPS = [
  { k: '01 · Passive', name: 'Network agent',
    desc: "Sniffs the DB's traffic and decodes the wire protocol out-of-band. Zero path change, tamper-resistant — but cleartext only.",
    attrs: [['Runs', 'on host / SPAN', ''], ['Sees TLS', '✗ no', 'no'], ['Row counts', '✓ yes', 'yes'], ['Can block', '✗ no', 'no'], ['Engines', 'MySQL · PG · MSSQL', '']] },
  { k: '02 · Kernel', name: 'Host agent (eBPF)',
    desc: 'Hooks the TLS library on the DB host, reading sessions below encryption — the exact complement of passive capture.',
    attrs: [['Runs', 'on DB host (Linux)', ''], ['Sees TLS', '✓ below it', 'yes'], ['Row counts', '✓ yes', 'yes'], ['Can block', '✗ no', 'no'], ['Engines', 'MySQL · PG', '']] },
  { k: '03 · Gateway', name: 'Inline proxy',
    desc: "Clients connect through it, so it's the only mode that can block or quarantine, and the only one that sees the real end-user behind a pool.",
    attrs: [['Runs', 'in the data path', ''], ['Sees TLS', '✓ terminates', 'yes'], ['Row counts', '✓ yes', 'yes'], ['Can block', '✓ only mode', 'yes'], ['Engines', 'MySQL', '']] },
  { k: '04 · Audit-forward', name: 'AgentLite',
    desc: "Reads the DB's own audit source — a log file (MySQL/PG) or a polled view (SQL Server / Mongo / Oracle). Runs off-host for the polled engines, covering managed services.",
    attrs: [['Runs', 'on host / any host', ''], ['Sees TLS', '✓ post-decrypt', 'yes'], ['Row counts', '◐ XEvents · Oracle', 'part'], ['Can block', '✗ no', 'no'], ['Engines', 'all five', '']] },
  { k: '05 · Cloud stream', name: 'Agentless',
    desc: "The cloud routes a managed DB's native audit into a stream (Pub/Sub · Event Hub) that DAM consumes. Zero install — the only option where nothing can be deployed.",
    attrs: [['Runs', 'nothing on host', ''], ['Sees TLS', '✓ post-decrypt', 'yes'], ['Row counts', '✗ no', 'no'], ['Can block', '✗ no', 'no'], ['Engines', 'managed DBs', '']] },
];
const TONE = { yes: 'var(--green)', no: 'var(--muted)', part: 'var(--amber)', '': 'var(--ink)' };

// ── "Who sees what" by connection path (still accurate) ──────────────────────
const PATHS = [
  ['App routed through the proxy', ['✓ + real client IP', 'g'], ['✓ source = proxy', 'a'], ['✓', 'g']],
  ['Direct TCP (bypasses proxy)', ['✗', 'm'], ['✓', 'g'], ['✓', 'g']],
  ['Local / IPC (Unix socket, shared mem)', ['✗', 'm'], ['✗', 'm'], ['✓ only one', 'g']],
];
const PATH_COLOR = { g: 'var(--green)', a: 'var(--amber)', m: 'var(--muted)' };
function PathCell({ v }) {
  const [text, tone] = v;
  return <span style={{ color: PATH_COLOR[tone] || 'var(--ink)', fontWeight: tone === 'g' ? 600 : 500, fontSize: 12.5 }}>{text}</span>;
}

// ── At-a-glance architecture diagram (token-driven, theme-aware) ──────────────
const V = {
  line: 'var(--line)', ink: 'var(--ink)', muted: 'var(--muted)', surf: 'var(--surface-2)',
  net: 'var(--primary)', host: 'var(--info)', proxy: 'var(--amber)', agentless: 'var(--green)',
};
const T = (x, y, text, color = V.ink, size = 11.5, weight = 600, anchor = 'middle') =>
  <text x={x} y={y} textAnchor={anchor} style={{ fill: color, fontSize: size, fontWeight: weight }}>{text}</text>;
function LegendItem({ c, t }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: c, flex: 'none' }} />{t}</span>;
}

function CaptureDiagram() {
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="card-header"><span className="card-title">At a glance — where each mode sits</span><span className="card-sub">observe vs. block · on-path vs. out-of-band</span></div>
      <div className="card-body">
        <svg viewBox="0 0 900 262" width="100%" style={{ maxHeight: 300 }} role="img" aria-label="Capture modes architecture diagram">
          <defs>
            <marker id="cmArrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="userSpaceOnUse">
              <path d="M0,0 L6,3 L0,6 Z" fill="context-stroke" />
            </marker>
          </defs>
          <rect x="30" y="8" width="840" height="32" rx="8" style={{ fill: V.surf, stroke: V.line }} />
          {T(450, 28, '🛡  TooVix DAM — Control Plane   ·   events in → alerts out', V.ink, 12.5, 700)}
          <line x1="530" y1="146" x2="530" y2="42" style={{ stroke: V.net }} strokeDasharray="4 3" markerEnd="url(#cmArrow)" />
          <line x1="302" y1="166" x2="302" y2="42" style={{ stroke: V.proxy }} strokeDasharray="4 3" markerEnd="url(#cmArrow)" />
          <line x1="575" y1="204" x2="575" y2="42" style={{ stroke: V.host }} strokeDasharray="4 3" markerEnd="url(#cmArrow)" />
          <line x1="806" y1="168" x2="806" y2="42" style={{ stroke: V.agentless }} strokeDasharray="4 3" markerEnd="url(#cmArrow)" />
          <rect x="30" y="170" width="96" height="40" rx="8" style={{ fill: V.surf, stroke: V.line }} />
          {T(78, 187, 'App /', V.ink, 11, 600)}{T(78, 201, 'Clients', V.ink, 11, 600)}
          <line x1="126" y1="190" x2="248" y2="190" style={{ stroke: V.ink }} markerEnd="url(#cmArrow)" />
          <rect x="250" y="166" width="104" height="48" rx="8" style={{ fill: V.surf, stroke: V.proxy, strokeWidth: 2 }} />
          {T(302, 186, '③ Inline proxy', V.proxy, 11, 700)}{T(302, 202, 'GATE · blocks', V.proxy, 9.5, 600)}
          <line x1="354" y1="190" x2="594" y2="190" style={{ stroke: V.ink }} markerEnd="url(#cmArrow)" />
          <rect x="438" y="118" width="300" height="124" rx="10" style={{ fill: 'none', stroke: V.host }} strokeDasharray="5 4" />
          {T(446, 135, 'DB host', V.muted, 9.5, 600, 'start')}
          <rect x="452" y="146" width="106" height="30" rx="6" style={{ fill: V.surf, stroke: V.net, strokeWidth: 1.5 }} />
          {T(505, 160, '① Network agent', V.net, 10, 700)}{T(505, 171, 'NIC / pcap layer', V.muted, 8.5, 500)}
          <rect x="452" y="204" width="106" height="30" rx="6" style={{ fill: V.surf, stroke: V.host, strokeWidth: 1.5 }} />
          {T(505, 218, '② Host eBPF', V.host, 10, 700)}{T(505, 229, 'kernel syscalls', V.muted, 8.5, 500)}
          <rect x="594" y="168" width="126" height="46" rx="6" style={{ fill: V.surf, stroke: V.line }} />
          {T(657, 195, 'DB', V.ink, 12, 700)}
          <line x1="505" y1="176" x2="505" y2="190" style={{ stroke: V.net }} strokeDasharray="3 3" />
          <line x1="505" y1="204" x2="505" y2="190" style={{ stroke: V.host }} strokeDasharray="3 3" />
          <line x1="720" y1="191" x2="740" y2="191" style={{ stroke: V.agentless }} markerEnd="url(#cmArrow)" />
          {T(730, 184, 'audit', V.muted, 8.5, 500)}
          <rect x="742" y="168" width="128" height="46" rx="6" style={{ fill: V.surf, stroke: V.agentless, strokeWidth: 1.5 }} />
          {T(806, 185, '④ Audit-based', V.agentless, 10.5, 700)}{T(806, 199, 'AgentLite · Agentless', V.agentless, 8.5, 500)}
        </svg>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', marginTop: 8, fontSize: 12 }}>
          <LegendItem c="var(--primary)" t="① Network — on-host NIC sniff (pcap) or SPAN · observe" />
          <LegendItem c="var(--info)" t="② Host eBPF — on the DB host, below TLS · observe (local + IPC)" />
          <LegendItem c="var(--amber)" t="③ Inline proxy — in the path · observe + BLOCK" />
          <LegendItem c="var(--green)" t="④ Audit-based — AgentLite (host/remote) · Agentless (cloud stream) · observe" />
        </div>
        <p className="muted" style={{ fontSize: 11.5, margin: '10px 2px 0', lineHeight: 1.5 }}>
          Dashed lines are telemetry each collector sends <b>outbound</b> to the control plane — DAM never connects into your DB network, which is why every mode works for private, no-public-IP databases. Only the <b style={{ color: 'var(--amber)' }}>inline proxy</b> sits in the traffic path, so it is the only mode that can block in real time.
        </p>
      </div>
    </div>
  );
}

export default function CaptureModes() {
  const navigate = useNavigate();

  return (
    <Layout>
      <PageHeader title="Capture Modes &amp; Coverage" meta={['which collector for which database', 'then deploy from Agents & Coverage']}>
        <button className="btn-primary" onClick={() => navigate('/agents?deploy=1')}>Go to deploy →</button>
      </PageHeader>

      {/* ── Support matrix — the centerpiece ── */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header">
          <span className="card-title">Capture mode × database engine</span>
          <span className="card-sub">what's built · what's viable · verified end-to-end</span>
        </div>
        <div className="card-body no-pad" style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 880 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '13px 16px', minWidth: 186, borderBottom: '1px solid var(--line)', background: 'var(--surface-2)' }}>
                  <span style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>Engine / Deployment</span>
                </th>
                {MODES.map(([name, sub]) => (
                  <th key={name} style={{ textAlign: 'left', padding: '13px 14px 12px', minWidth: 150, borderBottom: '1px solid var(--line)', background: 'var(--surface-2)', verticalAlign: 'bottom' }}>
                    <span style={{ fontSize: 13, fontWeight: 640, letterSpacing: '-.01em', display: 'block' }}>{name}</span>
                    <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--muted)', letterSpacing: '.03em', textTransform: 'uppercase', marginTop: 3, display: 'block' }}>{sub}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MATRIX.map((g) => (
                <Fragment key={g.engine}>
                  <tr>
                    <td colSpan={6} style={{ background: 'var(--surface-2)', padding: '9px 16px', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
                      <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.02em', color: 'var(--ink)' }}>{g.engine}</span>
                      <span style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--muted)', marginLeft: 10 }}>{g.tag}</span>
                    </td>
                  </tr>
                  {g.rows.map((r) => (
                    <tr key={r.dep}>
                      <td style={{ padding: '13px 16px', verticalAlign: 'middle', borderRight: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
                        <span style={{ fontSize: 13, fontWeight: 560, color: 'var(--ink)', display: 'block' }}>{r.dep}</span>
                        <span style={{ fontFamily: MONO, fontSize: 10.5, color: 'var(--muted)', marginTop: 2, display: 'block' }}>{r.sub}</span>
                      </td>
                      {r.cells.map((c, i) => <SupCell key={i} {...c} />)}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-body" style={{ paddingTop: 12, display: 'flex', flexWrap: 'wrap', gap: '8px 18px', alignItems: 'center', fontSize: 12.5, color: 'var(--muted)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: 'var(--green)', background: 'color-mix(in srgb, var(--green) 14%, transparent)', padding: '2px 7px', borderRadius: 5 }}>✓ built</span> shipping today</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: 'var(--amber)', background: 'color-mix(in srgb, var(--amber) 14%, transparent)', padding: '2px 7px', borderRadius: 5 }}>○ possible</span> viable, not built</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: 'var(--muted)', background: 'color-mix(in srgb, var(--muted) 12%, transparent)', padding: '2px 7px', borderRadius: 5 }}>—</span> doesn't apply</span>
          <span><em style={{ fontStyle: 'normal', color: 'var(--primary)', borderBottom: '2px solid var(--primary)' }}>✓ tested</em> = verified end-to-end against a live instance</span>
        </div>
      </div>

      {/* ── Per-mode capability cards ── */}
      <div className="grid2" style={{ marginBottom: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', display: 'grid', gap: 14 }}>
        {CAPS.map((c) => (
          <div className="card" key={c.name}>
            <div className="card-body">
              <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--primary)', fontWeight: 600 }}>{c.k}</span>
              <h3 style={{ margin: '3px 0 0', fontSize: 14.5, fontWeight: 640, letterSpacing: '-.01em' }}>{c.name}</h3>
              <p className="muted" style={{ margin: '9px 0 12px', fontSize: 12, lineHeight: 1.45 }}>{c.desc}</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid var(--line)', paddingTop: 11 }}>
                {c.attrs.map(([l, val, tone]) => (
                  <div key={l} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 11.5 }}>
                    <span style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: '.03em', color: 'var(--muted)', textTransform: 'uppercase' }}>{l}</span>
                    <span style={{ fontWeight: 600, fontSize: 12, textAlign: 'right', color: TONE[tone] }}>{val}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Reading the matrix ── */}
      <div className="card" style={{ marginBottom: 14, background: 'var(--surface-2)' }}>
        <div className="card-body" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
          <span className="muted">
            <b style={{ color: 'var(--ink)' }}>Reading the matrix.</b> Cleartext, open-protocol, self-managed engines get the full wire stack (<b style={{ color: 'var(--ink)' }}>Network + Host</b>); managed and proprietary engines shift to <b style={{ color: 'var(--ink)' }}>AgentLite</b> (self-managed &amp; reachable-PaaS) and <b style={{ color: 'var(--ink)' }}>Agentless</b> (where nothing can be installed). Only the <b style={{ color: 'var(--amber)' }}>inline proxy</b> can block in real time. <b style={{ color: 'var(--ink)' }}>Row counts</b> — the signal behind mass-read / exfiltration detection — come from the wire modes always, and from AgentLite only on SQL Server <span style={{ fontFamily: MONO }}>xevents</span> and Oracle; audit-log and cloud-stream sources carry none.
          </span>
        </div>
      </div>

      {/* ── At-a-glance diagram ── */}
      <CaptureDiagram />

      {/* ── Who sees what by connection path ── */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Who sees what — by connection path</span><span className="card-sub">why combining modes closes blind spots</span></div>
        <div className="card-body no-pad" style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead><tr><th>Connection path</th><th>Inline Proxy</th><th>Network agent</th><th>Host agent</th></tr></thead>
            <tbody>
              {PATHS.map((r) => (
                <tr key={r[0]}>
                  <td style={{ fontWeight: 600 }}>{r[0]}</td>
                  <td><PathCell v={r[1]} /></td>
                  <td><PathCell v={r[2]} /></td>
                  <td><PathCell v={r[3]} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-body" style={{ paddingTop: 10, fontSize: 12.5, lineHeight: 1.55 }}>
          <span className="muted"><b style={{ color: 'var(--amber)' }}>Inline proxy</b> is a gate the traffic passes through (so it can stop it); the <b style={{ color: 'var(--primary)' }}>network</b> and <b style={{ color: 'var(--info)' }}>host</b> agents are cameras pointed at the database. Each catches a path the others can't — so combining them closes blind spots.</span>
        </div>
      </div>

      {/* ── Classification (orthogonal to capture) ── */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Data classification</span><span className="card-sub">separate from capture — a least-privilege read</span></div>
        <div className="card-body" style={{ fontSize: 13, lineHeight: 1.6 }}>
          <p style={{ margin: '0 0 8px' }}>
            Finding which columns hold <b>PII/PCI</b> is <b>independent of the capture mode</b>. The agent logs into the database as a
            <b> least-privilege reader</b> (e.g. <code>dam_svc</code>), reads the catalog (<code>information_schema</code> / <code>ALL_TAB_COLUMNS</code>),
            and matches column names against the PII/PCI pattern library. Results populate the <b>Classification</b> page.
          </p>
          <ul style={{ margin: '0 0 4px', paddingLeft: 18 }}>
            <li>Enable with <code>CLASSIFY=true</code>, <code>DB_USER</code> and <code>DB_PASSWORD</code> (PostgreSQL/Oracle also need the target database / service). Re-scans every <code>CLASSIFY_INTERVAL_MIN</code> (default 30), all over the same outbound path.</li>
            <li>Available for <b>MySQL, PostgreSQL, SQL Server and Oracle</b>. <b>MongoDB</b> is schemaless (no catalog), so its sensitive-collection classification is not built yet — capture still tags statements whose text names a sensitive field.</li>
          </ul>
        </div>
      </div>

    </Layout>
  );
}
