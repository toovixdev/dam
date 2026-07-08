import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import { useNavigate } from 'react-router-dom';

const AGENTS = [
  { name: 'Network agent', tag: 'installed · passive', color: 'var(--primary)', desc: 'Sniffs the database’s network traffic (libpcap, protocol decode). No path change, ~0 overhead. Sees every networked connection — including ones that bypass a proxy. Blind to local/IPC; cannot block.' },
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

export default function CaptureModes() {
  const navigate = useNavigate();

  return (
    <Layout>
      <PageHeader title="Capture Modes &amp; Coverage" meta={['understand the trade-offs', 'then deploy from Agents & Coverage']}>
        <button className="btn-primary" onClick={() => navigate('/agents?deploy=1')}>Go to deploy →</button>
      </PageHeader>

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
