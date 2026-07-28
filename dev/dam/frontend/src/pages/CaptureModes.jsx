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

// ── Capability matrix: what each configuration can do ────────────────────────
// bool rows: cell = [state, qualifier?]  ·  value rows (v:1): cell = [text, tone]
const CAP_MODES = [
  ['Network', 'passive · wire'], ['Host (eBPF)', 'kernel · below TLS'],
  ['Inline Proxy', 'gateway'], ['AgentLite', 'audit-forward'], ['Agentless', 'cloud stream'],
];
const G = { yes: ['var(--green)', '✓'], part: ['var(--amber)', '◐'], no: ['var(--muted)', '✗'] };
const VTONE = { warn: 'var(--amber)', dim: 'var(--muted)', num: 'var(--ink)', '': 'var(--ink)' };
const CAP_BANDS = [
  { band: 'Footprint & deployment', rows: [
    { name: 'Where it runs', v: 1, cells: [['DB host / SPAN', 'dim'], ['DB host (kernel)', 'dim'], ['in the data path', 'dim'], ['on host / any host', 'dim'], ['nothing (cloud)', 'dim']] },
    { name: 'Runs on the DB host', cells: [['part', 'host or SPAN'], ['yes'], ['no', 'separate box'], ['part', 'file-tail only'], ['no']] },
    { name: 'Reroutes clients', hint: 'connection-path change', v: 1, cells: [['no', ''], ['no', ''], ['YES', 'warn'], ['no', ''], ['no', '']] },
    { name: 'Overhead', v: 1, cells: [['~0 · passive', 'dim'], ['low · kernel', 'dim'], ['low–med', 'dim'], ['low · poll/tail', 'dim'], ['none · off-host', 'dim']] },
    { name: 'Components to deploy', v: 1, cells: [['1', 'num'], ['1', 'num'], ['1', 'num'], ['1', 'num'], ['0', 'num']] },
    { name: 'Covers managed / PaaS', cells: [['no'], ['no'], ['part', 'in your VPC'], ['part', 'reachable-PaaS'], ['yes', 'the PaaS option']] },
  ] },
  { band: 'What it can see', rows: [
    { name: 'Cleartext traffic', cells: [['yes'], ['yes'], ['yes'], ['yes'], ['yes']] },
    { name: 'TLS-encrypted sessions', cells: [['no', 'opaque'], ['yes', 'below TLS'], ['yes', 'terminates'], ['yes', 'post-decrypt'], ['yes', 'post-decrypt']] },
    { name: 'Local / IPC', hint: 'unix socket · shared mem', cells: [['no'], ['yes', 'only one'], ['no'], ['yes', 'audit sees all'], ['yes', 'audit sees all']] },
    { name: 'Result size / row counts', hint: 'powers mass-read detection', key: 1, cells: [['yes'], ['yes'], ['yes'], ['part', 'XEvents · Oracle'], ['no']] },
    { name: 'Real end-user', hint: 'behind a pooled connection', cells: [['no'], ['part'], ['yes', 'only one'], ['part'], ['part']] },
    { name: 'Private / no-public-IP DB', cells: [['yes'], ['yes'], ['yes'], ['yes'], ['yes', 'all outbound']] },
  ] },
  { band: 'Action & posture', rows: [
    { name: 'Block / quarantine', hint: 'real-time prevention', key: 1, cells: [['no'], ['part', 'local only'], ['yes', 'only mode'], ['no'], ['no']] },
    { name: 'Posture', v: 1, cells: [['detective', 'dim'], ['detective', 'dim'], ['preventive', 'warn'], ['detective', 'dim'], ['detective', 'dim']] },
    { name: 'Engines', v: 1, cells: [['MySQL · PG · MSSQL', 'dim'], ['MySQL · PG', 'dim'], ['MySQL', 'dim'], ['all five', ''], ['managed DBs', 'dim']] },
  ] },
  { band: 'Data classification', rows: [
    // Orthogonal to capture: a least-privilege catalog read (CLASSIFY=true), so any mode that
    // ships an agent can do it; Agentless has no agent to log in and read the schema.
    { name: 'Classify PII/PCI columns', hint: 'orthogonal — least-privilege catalog read, not the capture path', cells: [['yes'], ['yes'], ['yes'], ['yes', 'not MongoDB'], ['no', 'no agent to read']] },
    { name: 'Discovers sensitive data at rest', hint: 'schema scan · independent of live traffic', cells: [['yes'], ['yes'], ['yes'], ['yes', 'MySQL·PG·MSSQL·Oracle'], ['no']] },
  ] },
];

function CapCell({ v, cell }) {
  if (v) {
    const [text, tone] = cell;
    return <td style={{ padding: '11px 14px', textAlign: 'center', borderBottom: '1px solid var(--line)' }}>
      <span style={{ fontFamily: MONO, fontSize: tone === 'num' ? 13 : 11.5, fontWeight: (tone === 'warn' || tone === 'num') ? 700 : (tone === 'dim' ? 500 : 600), color: VTONE[tone] || 'var(--ink)', fontVariantNumeric: tone === 'num' ? 'tabular-nums' : 'normal' }}>{text}</span>
    </td>;
  }
  const [state, q] = cell;
  const [color, glyph] = G[state];
  return <td style={{ padding: '11px 14px', textAlign: 'center', borderBottom: '1px solid var(--line)' }}>
    <span style={{ fontFamily: MONO, fontWeight: 800, fontSize: 15, color }}>{glyph}</span>
    {q && <span style={{ display: 'block', marginTop: 3, fontFamily: MONO, fontSize: 10, color: 'var(--muted)', lineHeight: 1.3 }}>{q}</span>}
  </td>;
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

      {/* ── Capability matrix — what each configuration can do ── */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header">
          <span className="card-title">What each configuration can do</span>
          <span className="card-sub">footprint · visibility · enforcement · classification · ★ = decision-driver</span>
        </div>
        <div className="card-body no-pad" style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 840 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '13px 16px', minWidth: 210, borderBottom: '1px solid var(--line)', background: 'var(--surface-2)' }}>
                  <span style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>Capability</span>
                </th>
                {CAP_MODES.map(([name, sub]) => (
                  <th key={name} style={{ textAlign: 'center', padding: '13px 14px 12px', borderBottom: '1px solid var(--line)', background: 'var(--surface-2)', verticalAlign: 'bottom' }}>
                    <span style={{ fontSize: 13, fontWeight: 640, letterSpacing: '-.01em', display: 'block' }}>{name}</span>
                    <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--muted)', letterSpacing: '.03em', textTransform: 'uppercase', marginTop: 3, display: 'block' }}>{sub}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CAP_BANDS.map((b) => (
                <Fragment key={b.band}>
                  <tr>
                    <td colSpan={6} style={{ background: 'var(--surface-2)', padding: '8px 16px', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', fontFamily: MONO, fontSize: 10.5, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 600 }}>{b.band}</td>
                  </tr>
                  {b.rows.map((r) => (
                    <tr key={r.name} style={r.key ? { background: 'color-mix(in srgb, var(--primary) 7%, transparent)' } : undefined}>
                      <td style={{ padding: '11px 16px', borderRight: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
                        <span style={{ fontSize: 13, fontWeight: 560, color: 'var(--ink)', display: 'block' }}>{r.name}{r.key ? <span style={{ color: 'var(--primary)', fontSize: 10, marginLeft: 6, verticalAlign: 'top' }}>★</span> : null}</span>
                        {r.hint ? <span style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, display: 'block' }}>{r.hint}</span> : null}
                      </td>
                      {r.cells.map((c, i) => <CapCell key={i} v={r.v} cell={c} />)}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Reading the matrix ── */}
      <div className="card" style={{ marginBottom: 14, background: 'var(--surface-2)' }}>
        <div className="card-body" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
          <span className="muted">
            <b style={{ color: 'var(--ink)' }}>Reading the matrix.</b> Cleartext, open-protocol, self-managed engines get the full wire stack (<b style={{ color: 'var(--ink)' }}>Network + Host</b>); managed and proprietary engines shift to <b style={{ color: 'var(--ink)' }}>AgentLite</b> (self-managed &amp; reachable-PaaS) and <b style={{ color: 'var(--ink)' }}>Agentless</b> (where nothing can be installed). Only the <b style={{ color: 'var(--amber)' }}>inline proxy</b> can block in real time. <b style={{ color: 'var(--ink)' }}>Row counts</b> — the signal behind mass-read / exfiltration detection — come from the wire modes always, and from AgentLite only on SQL Server <span style={{ fontFamily: MONO }}>xevents</span> and Oracle; audit-log and cloud-stream sources carry none.
          </span>
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
