import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import { useNavigate } from 'react-router-dom';

const AGENTS = [
  { name: 'Network agent', tag: 'installed · passive', color: 'var(--primary)', desc: 'Sniffs the database’s network traffic and decodes the MySQL & PostgreSQL wire protocols (libpcap-style). No path change, ~0 overhead. Sees every networked connection — including ones that bypass a proxy. Cleartext only — TLS-encrypted connections are opaque (use the inline proxy or host/eBPF for those). Blind to local/IPC; cannot block.' },
  { name: 'Host agent (eBPF)', tag: 'installed · passive', color: 'var(--info)', desc: 'Runs on the DB host kernel. Sees every connection reaching the DB process — including local sockets / shared memory / IPC nothing else can. Deepest visibility; limited local enforcement.' },
  { name: 'Inline proxy', tag: 'installed · inline', color: 'var(--amber)', desc: 'A gateway in the data path — clients connect through it. The only mode that can block / quarantine, and the only one that sees the real end-user behind a pooled connection. Only sees traffic routed through it.' },
  { name: 'Agentless (Pull / Push)', tag: 'no install', color: 'var(--green)', desc: 'Reads native DB audit logs / the DB profiler (Audit Pull, e.g. MongoDB’s system.profile) or consumes cloud audit streams (Cloud Push). Connects as a client — works for managed/PaaS and self-managed databases where you can’t (or don’t want to) install on the host. After-the-fact; cannot block.' },
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

const APPLIC_COLS = ['Deployment', 'Network', 'Host', 'Inline Proxy', 'Agentless', 'Recommended'];
const APPLIC_ROWS = [
  ['On-prem (bare metal)', ['✓', 'g'], ['✓', 'g'], ['✓', 'g'], ['✓ pull', 'g'], 'Network + Host (Full visibility); add Proxy to block'],
  ['IaaS (VM — EC2 / Azure VM / GCE)', ['✓', 'g'], ['✓', 'g'], ['✓', 'g'], ['✓', 'g'], 'Network + Host; Proxy if blocking required'],
  ['AWS RDS / Aurora', ['✗', 'm'], ['✗', 'm'], ['⚠ in your VPC', 'a'], ['✓ Cloud Push', 'g'], 'Cloud Push (agentless)'],
  ['Azure SQL / Managed Instance', ['✗', 'm'], ['✗', 'm'], ['⚠ in your VPC', 'a'], ['✓', 'g'], 'Cloud Push'],
  ['Google Cloud SQL', ['✗', 'm'], ['✗', 'm'], ['⚠ in your VPC', 'a'], ['✓', 'g'], 'Audit Pull / Push'],
  ['MongoDB on VM / on-prem', ['⚠ wire decode', 'a'], ['⚠ host eBPF', 'a'], ['⚠ for blocking', 'a'], ['✓ profiler pull', 'g'], 'Audit Pull (DB profiler) — wire-protocol agents N/A yet'],
  ['MongoDB Atlas', ['✗', 'm'], ['✗', 'm'], ['✗', 'm'], ['✓ webhook', 'g'], 'Cloud Push'],
  ['OCI Autonomous', ['✗', 'm'], ['✗', 'm'], ['✗', 'm'], ['✓', 'g'], 'Audit Pull / Push'],
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
          {T(806, 187, '④ Agentless', V.agentless, 11, 700)}{T(806, 202, 'Pull / Cloud Push', V.agentless, 9.5, 500)}
        </svg>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', marginTop: 8, fontSize: 12 }}>
          <LegendItem c="var(--primary)" t="① Network — on-host NIC sniff (pcap); or off-host SPAN/tap · observe" />
          <LegendItem c="var(--info)" t="② Host eBPF — on the DB host, kernel layer · observe (local + IPC)" />
          <LegendItem c="var(--amber)" t="③ Inline proxy — in the path · observe + BLOCK" />
          <LegendItem c="var(--green)" t="④ Agentless — native audit logs, off-host · observe (PaaS)" />
        </div>
        <p className="muted" style={{ fontSize: 11.5, margin: '10px 2px 0', lineHeight: 1.5 }}>
          The <b style={{ color: 'var(--primary)' }}>network</b> and <b style={{ color: 'var(--info)' }}>host</b> agents both run <b>on the DB host</b> — they differ by capture layer (NIC/pcap vs kernel), not location. The network agent can alternatively run off-host as a <b>SPAN port / traffic mirror</b>. Dashed lines = telemetry each agent sends <b>outbound</b> to the DAM (the control plane never connects into your DB network — which is why this works for private, no-public-IP databases). Only the <b style={{ color: 'var(--amber)' }}>inline proxy</b> sits in the traffic path, so it’s the only mode that can block in real time.
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
        <div className="card-header"><span className="card-title">What’s applicable by deployment type</span><span className="card-sub">IaaS / on-prem can install agents · PaaS goes agentless</span></div>
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
            <li>For <b>agentless / PaaS</b> sources the standalone <b>collector</b> runs the same scan. Classification is available for <b>MySQL and PostgreSQL</b> in this build.</li>
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
