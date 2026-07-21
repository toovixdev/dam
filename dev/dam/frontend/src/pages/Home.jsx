import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import './Home.css';

// Public marketing homepage (ported from mockups/index.html). CTAs are wired to
// the real /login and /signup routes; section links scroll within the page.

const CAPS = [
  ['var(--primary-soft)', 'var(--primary)', '◎', 'Real-Time Activity Monitoring', 'Every query, every user, every session — captured in real-time with full context. Privileged accounts, application traffic, and local connections.'],
  ['var(--danger-soft)', 'var(--danger)', '⚠', 'Behavioral Threat Detection', 'Continuous learning builds per-user baselines. Detects anomalies: off-hours access, volume spikes, first-time sensitive reads, credential stuffing.'],
  ['var(--green-soft)', 'var(--green)', '⚖', 'Compliance Automation', 'Pre-built packs for PCI-DSS, GDPR, HIPAA, SOX, DPDPA, and RBI. Continuous control validation with one-click audit reports.'],
  ['var(--amber-soft)', 'var(--amber)', '◧', 'Sensitive Data Discovery', 'Auto-classify SSN, Aadhaar, PAN, credit cards, PHI across all engines. ML + regex + exact-match with region-specific validators.'],
  ['var(--info-soft)', 'var(--info)', '⛓', 'Tamper-Evident Audit Trail', 'BLAKE3 hash-chain with KMS-signed hourly checkpoints. Prove 30 days of integrity by verifying 720 checkpoints, not billions of events.'],
  ['var(--danger-soft)', 'var(--danger)', '⛔', 'Inline Blocking + Proxy', 'DAM Proxy Gateway blocks threats in real-time. Monitor mode → blocking mode per policy. Virtual patching shields unpatched databases.'],
  ['var(--primary-soft)', 'var(--primary)', '▦', 'Dynamic & Static Masking', 'Query-time masking for non-privileged users. Format-preserving for analytics. Static masking for non-prod clones with referential integrity.'],
  ['var(--green-soft)', 'var(--green)', '⊠', 'Access Governance', 'Discover privileged + dormant accounts. Entitlement recertification campaigns. Service-account identity resolution behind connection pools.'],
  ['var(--amber-soft)', 'var(--amber)', '✦', 'LLM & AI Data Security', 'Monitor what users send to ChatGPT, Bedrock, Azure OpenAI. Redact PII in prompts before they reach the LLM. AI firewall for enterprises.'],
];

const ENGINES = [['🔴', 'Oracle'], ['🔷', 'SQL Server'], ['🔵', 'IBM Db2'], ['🐘', 'PostgreSQL'], ['🐬', 'MySQL / MariaDB'], ['🍃', 'MongoDB']];

// Deployment architecture — the three capture models, and how each engine maps to them.
// Each cell is [status, label]: 'full' = supported, 'part' = limited/roadmap, 'na' = the
// engine's design rules it out. Kept honest: eBPF needs OpenSSL, so Oracle (own crypto) and
// MongoDB have no host-agent hook; SQL Server's wire is TLS-by-default so network is limited.
const MODELS = [
  ['AgentLite', 'var(--green)', 'var(--green-soft)', 'audit-forward · recommended',
    <>A lightweight forwarder that reads the telemetry the database <b>already produces</b> — no wire tap, no path change. Because it reads <b>after</b> decryption, it captures TLS-encrypted <b>and local/IPC</b> sessions the network never sees.</>],
  ['Agent', 'var(--amber)', 'var(--amber-soft)', 'network · host · proxy',
    <>Taps the connection itself — <b>network</b> (passive, zero path change), <b>host eBPF</b> (below TLS), or an <b>inline proxy</b>, the only mode that can <b>block</b> a query in real time. Carries exact row counts.</>],
  ['Agentless', 'var(--info)', 'var(--info-soft)', 'cloud stream · PaaS',
    <>The managed database emits its native audit to a cloud <b>stream</b> — Pub/Sub, Event Hub, Kinesis — and DAM consumes it. Zero software on the host: the only option for RDS, Cloud SQL, Azure SQL and other PaaS you don&apos;t control.</>],
];

const ARCH = [
  ['Oracle', 'proprietary · own crypto', ['full', 'UNIFIED_AUDIT_TRAIL'], ['na', 'no eBPF hook'], ['part', 'stream on roadmap']],
  ['MySQL', 'open protocol', ['full', 'general log'], ['full', 'all four modes'], ['full', 'Cloud SQL · RDS']],
  ['PostgreSQL', 'open protocol', ['full', 'pgaudit'], ['full', 'network + eBPF'], ['full', 'Cloud SQL · RDS']],
  ['SQL Server', 'proprietary · TDS', ['full', 'Audit / XEvents'], ['part', 'network only'], ['full', 'Azure SQL']],
  ['MongoDB', 'wire protocol', ['full', 'profiler'], ['na', 'no eBPF hook'], ['part', 'Cosmos · Atlas']],
];

const SUP_DOT = { full: 'var(--green)', part: 'var(--amber)', na: 'var(--subtle)' };
const supCell = ([status, label]) => (
  <span className={`sup${status === 'na' ? ' na' : ''}`}>
    <span className="d" style={{ background: SUP_DOT[status] }} />{label}
  </span>
);

const FRAMEWORKS = [
  ['💳', 'PCI-DSS 4.0', 'Cardholder data monitoring'], ['🌐', 'GDPR', 'EU data-subject rights'],
  ['🏥', 'HIPAA', 'Protected health information'], ['📊', 'SOX', 'Financial data integrity'],
  ['🇮🇳', 'DPDPA 2023', 'India data protection'], ['🏦', 'RBI CSF', 'Banking security baseline'],
  ['🛡', 'CERT-In', 'Incident reporting & logs'], ['📜', 'ISO 27001', 'ISMS access controls'],
];

const REGIONS = [
  ['🇺🇸', 'United States', 'Virginia & Oregon'], ['🇪🇺', 'European Union', 'Frankfurt'],
  ['🇮🇳', 'India', 'Mumbai'], ['🇬🇧', 'United Kingdom', 'London'], ['🇨🇦', 'Canada', 'Montreal'],
];

const TESTIMONIALS = [
  ['"We replaced two legacy DAM appliances with TooVix and had Oracle + Db2 under watch the same afternoon. RBI audit prep went from weeks to a day."', 'RK', 'Rajesh K.', 'CISO · Indian private-sector bank'],
  ['"The behavioral baselines caught a compromised service account at 2am that our SIEM completely missed. That alone justified the investment."', 'ML', 'Marie L.', 'Head of SOC · European insurance group'],
  ['"One policy for \'bulk PII read\' fires identically across our Oracle, Postgres, and MongoDB fleet. No more writing the same rule six times."', 'JC', 'Jason C.', 'Security Engineering · US fintech'],
];

const PLANS = [
  { name: 'Starter', price: 'Free', unit: '/ 14 days', desc: 'Up to 5 databases', pop: false, cta: 'Start free trial',
    feats: ['All 6 engines supported', 'Real-time monitoring + alerts', '30-day retention', 'PCI-DSS + 1 framework', 'Community support'] },
  { name: 'Business', price: 'Custom', unit: '/ db / month', desc: 'Unlimited databases', pop: true, cta: 'Start free trial',
    feats: ['Everything in Starter', 'UEBA + behavioral analytics', '1-year retention + cold archive', 'All compliance frameworks', 'SSO (Azure AD / Okta)', 'Inline blocking + proxy', 'Priority support + SLA'] },
  { name: 'Enterprise', price: 'Custom', unit: '', desc: 'On-prem / air-gapped / multi-region', pop: false, cta: 'Contact sales',
    feats: ['Everything in Business', 'BYOK (all major KMS)', 'On-prem + air-gapped deploy', 'Multi-region data planes', 'LLM / AI data security', 'Dedicated support + TAM', 'Custom retention + legal hold'] },
];

const HERO_SVG = `<svg viewBox="0 0 900 380" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="hgBg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#1e1b4b"/><stop offset="100%" stop-color="#0f0a2e"/></linearGradient>
    <linearGradient id="hgShield" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#818cf8"/><stop offset="100%" stop-color="#4f46e5"/></linearGradient>
    <linearGradient id="hgGreen" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#4ade80"/><stop offset="100%" stop-color="#16a34a"/></linearGradient>
    <linearGradient id="hgAmber" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#fbbf24"/><stop offset="100%" stop-color="#d97706"/></linearGradient>
    <linearGradient id="hgRed" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#fb7185"/><stop offset="100%" stop-color="#e11d48"/></linearGradient>
    <filter id="hgGlow"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="hgGlowSm"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect width="900" height="380" rx="18" fill="url(#hgBg)"/>
  <g opacity=".06">
    <line x1="0" y1="76" x2="900" y2="76" stroke="#fff"/><line x1="0" y1="152" x2="900" y2="152" stroke="#fff"/>
    <line x1="0" y1="228" x2="900" y2="228" stroke="#fff"/><line x1="0" y1="304" x2="900" y2="304" stroke="#fff"/>
    <line x1="180" y1="0" x2="180" y2="380" stroke="#fff"/><line x1="360" y1="0" x2="360" y2="380" stroke="#fff"/>
    <line x1="540" y1="0" x2="540" y2="380" stroke="#fff"/><line x1="720" y1="0" x2="720" y2="380" stroke="#fff"/>
  </g>
  <g class="hg-pulse" style="animation-delay:0s">
    <rect x="40" y="55" width="110" height="60" rx="10" fill="rgba(99,102,241,.15)" stroke="#818cf8" stroke-width="1.5"/>
    <ellipse cx="95" cy="72" rx="28" ry="8" fill="rgba(129,140,248,.2)"/>
    <ellipse cx="95" cy="82" rx="28" ry="8" fill="none" stroke="rgba(129,140,248,.3)" stroke-width=".7"/>
    <ellipse cx="95" cy="92" rx="28" ry="8" fill="none" stroke="rgba(129,140,248,.2)" stroke-width=".5"/>
    <text x="95" y="123" font-size="10" fill="#a5b4fc" text-anchor="middle" font-family="Inter,sans-serif" font-weight="700">Oracle 19c</text>
    <circle cx="142" cy="62" r="4" fill="#4ade80" class="hg-blink"/>
  </g>
  <g class="hg-pulse" style="animation-delay:.5s">
    <rect x="40" y="145" width="110" height="60" rx="10" fill="rgba(99,102,241,.15)" stroke="#818cf8" stroke-width="1.5"/>
    <ellipse cx="95" cy="162" rx="28" ry="8" fill="rgba(129,140,248,.2)"/>
    <ellipse cx="95" cy="172" rx="28" ry="8" fill="none" stroke="rgba(129,140,248,.3)" stroke-width=".7"/>
    <ellipse cx="95" cy="182" rx="28" ry="8" fill="none" stroke="rgba(129,140,248,.2)" stroke-width=".5"/>
    <text x="95" y="213" font-size="10" fill="#a5b4fc" text-anchor="middle" font-family="Inter,sans-serif" font-weight="700">SQL Server</text>
    <circle cx="142" cy="152" r="4" fill="#4ade80" class="hg-blink" style="animation-delay:.3s"/>
  </g>
  <g class="hg-pulse" style="animation-delay:1s">
    <rect x="40" y="235" width="110" height="60" rx="10" fill="rgba(99,102,241,.15)" stroke="#818cf8" stroke-width="1.5"/>
    <ellipse cx="95" cy="252" rx="28" ry="8" fill="rgba(129,140,248,.2)"/>
    <ellipse cx="95" cy="262" rx="28" ry="8" fill="none" stroke="rgba(129,140,248,.3)" stroke-width=".7"/>
    <ellipse cx="95" cy="272" rx="28" ry="8" fill="none" stroke="rgba(129,140,248,.2)" stroke-width=".5"/>
    <text x="95" y="303" font-size="10" fill="#a5b4fc" text-anchor="middle" font-family="Inter,sans-serif" font-weight="700">PostgreSQL</text>
    <circle cx="142" cy="242" r="4" fill="#fbbf24" class="hg-blink" style="animation-delay:.6s"/>
  </g>
  <g class="hg-pulse" style="animation-delay:1.5s" opacity=".7">
    <rect x="55" y="320" width="80" height="42" rx="8" fill="rgba(99,102,241,.1)" stroke="rgba(129,140,248,.4)" stroke-width="1"/>
    <text x="95" y="346" font-size="9" fill="#a5b4fc" text-anchor="middle" font-family="Inter,sans-serif" font-weight="600">MongoDB</text>
  </g>
  <path d="M152 85 Q220 85 270 140" stroke="#818cf8" stroke-width="2" fill="none" class="hg-flow" opacity=".7"/>
  <path d="M152 175 L270 175" stroke="#818cf8" stroke-width="2" fill="none" class="hg-flow" style="animation-delay:.3s" opacity=".7"/>
  <path d="M152 265 Q220 265 270 210" stroke="#818cf8" stroke-width="2" fill="none" class="hg-flow" style="animation-delay:.6s" opacity=".7"/>
  <path d="M135 341 Q200 330 270 230" stroke="rgba(129,140,248,.4)" stroke-width="1.5" fill="none" class="hg-flow" style="animation-delay:.9s"/>
  <circle cx="370" cy="190" r="88" fill="none" stroke="rgba(129,140,248,.2)" stroke-width="1"/>
  <circle cx="370" cy="190" r="68" fill="none" stroke="rgba(129,140,248,.15)" stroke-width="1"/>
  <circle cx="370" cy="190" r="48" fill="rgba(79,70,229,.1)"/>
  <g class="hg-scan" filter="url(#hgGlowSm)">
    <line x1="370" y1="190" x2="370" y2="108" stroke="rgba(129,140,248,.6)" stroke-width="2"/>
    <circle cx="370" cy="108" r="4" fill="#818cf8"/>
  </g>
  <g filter="url(#hgGlow)">
    <circle cx="370" cy="190" r="30" fill="url(#hgShield)"/>
    <text x="370" y="196" font-size="22" text-anchor="middle" fill="#fff">🛡️</text>
  </g>
  <text x="370" y="245" font-size="11" fill="#c7d2fe" text-anchor="middle" font-family="Inter,sans-serif" font-weight="700">TooVix DAM Engine</text>
  <text x="370" y="261" font-size="9" fill="rgba(167,139,250,.7)" text-anchor="middle" font-family="Inter,sans-serif">Detect · Protect · Comply</text>
  <circle cx="335" cy="135" r="5" fill="url(#hgRed)" class="hg-blink" style="animation-delay:0s"/>
  <circle cx="410" cy="155" r="4" fill="url(#hgAmber)" class="hg-blink" style="animation-delay:.7s"/>
  <circle cx="390" cy="240" r="3.5" fill="url(#hgGreen)" class="hg-blink" style="animation-delay:1.2s"/>
  <circle cx="320" cy="215" r="4" fill="url(#hgAmber)" class="hg-blink" style="animation-delay:1.8s"/>
  <g>
    <rect x="520" y="40" width="170" height="72" rx="10" fill="rgba(225,29,72,.08)" stroke="rgba(251,113,133,.5)" stroke-width="1.3"/>
    <circle cx="540" cy="60" r="5" fill="url(#hgRed)" class="hg-blink"/>
    <text x="554" y="64" font-size="10" fill="#fda4af" font-family="Inter,sans-serif" font-weight="700">CRITICAL ALERT</text>
    <text x="536" y="80" font-size="8.5" fill="rgba(253,164,175,.7)" font-family="Inter,sans-serif">Mass PII read · 87,300 rows</text>
    <text x="536" y="94" font-size="8" fill="rgba(253,164,175,.5)" font-family="Inter,sans-serif">svc_analytics · ORCL-TRADING</text>
    <text x="536" y="106" font-size="8" fill="rgba(253,164,175,.5)" font-family="Inter,sans-serif">z-score 42× · US-East</text>
  </g>
  <g>
    <rect x="520" y="125" width="170" height="72" rx="10" fill="rgba(251,191,36,.06)" stroke="rgba(251,191,36,.4)" stroke-width="1.3"/>
    <circle cx="540" cy="145" r="5" fill="url(#hgAmber)" class="hg-blink" style="animation-delay:.5s"/>
    <text x="554" y="149" font-size="10" fill="#fcd34d" font-family="Inter,sans-serif" font-weight="700">ANOMALY</text>
    <text x="536" y="165" font-size="8.5" fill="rgba(252,211,77,.7)" font-family="Inter,sans-serif">Off-hours DBA · EU region</text>
    <text x="536" y="179" font-size="8" fill="rgba(252,211,77,.5)" font-family="Inter,sans-serif">dba_mueller · 03:22 CET</text>
    <text x="536" y="191" font-size="8" fill="rgba(252,211,77,.5)" font-family="Inter,sans-serif">Risk score: 91/100</text>
  </g>
  <g>
    <rect x="520" y="210" width="170" height="72" rx="10" fill="rgba(74,222,128,.06)" stroke="rgba(74,222,128,.4)" stroke-width="1.3"/>
    <circle cx="540" cy="230" r="5" fill="url(#hgGreen)"/>
    <text x="554" y="234" font-size="10" fill="#86efac" font-family="Inter,sans-serif" font-weight="700">COMPLIANCE</text>
    <text x="536" y="250" font-size="8.5" fill="rgba(134,239,172,.7)" font-family="Inter,sans-serif">PCI-DSS 91% · GDPR 86%</text>
    <text x="536" y="264" font-size="8" fill="rgba(134,239,172,.5)" font-family="Inter,sans-serif">DPDPA 82% · RBI 91%</text>
    <text x="536" y="276" font-size="8" fill="rgba(134,239,172,.5)" font-family="Inter,sans-serif">7 frameworks · continuous</text>
  </g>
  <g>
    <rect x="520" y="295" width="170" height="60" rx="10" fill="rgba(99,102,241,.08)" stroke="rgba(129,140,248,.4)" stroke-width="1.3"/>
    <text x="536" y="319" font-size="10" fill="#a5b4fc" font-family="Inter,sans-serif" font-weight="700">⛔ BLOCKED</text>
    <text x="536" y="335" font-size="8.5" fill="rgba(165,180,252,.6)" font-family="Inter,sans-serif">SQLi attempt auto-blocked</text>
    <text x="536" y="349" font-size="8" fill="rgba(165,180,252,.5)" font-family="Inter,sans-serif">Virtual patch · CVE-2025-1842</text>
  </g>
  <path d="M440 155 Q480 100 520 76" stroke="rgba(251,113,133,.4)" stroke-width="1.5" fill="none"/>
  <path d="M440 175 L520 161" stroke="rgba(251,191,36,.3)" stroke-width="1.5" fill="none"/>
  <path d="M440 210 L520 246" stroke="rgba(74,222,128,.3)" stroke-width="1.5" fill="none"/>
  <path d="M440 225 Q480 280 520 320" stroke="rgba(129,140,248,.3)" stroke-width="1.5" fill="none"/>
  <g>
    <rect x="720" y="70" width="150" height="240" rx="12" fill="rgba(255,255,255,.03)" stroke="rgba(255,255,255,.08)" stroke-width="1"/>
    <text x="795" y="94" font-size="9" fill="rgba(199,210,254,.8)" text-anchor="middle" font-family="Inter,sans-serif" font-weight="700">DATA RESIDENCY</text>
    <g><text x="740" y="122" font-size="14">🇺🇸</text><text x="758" y="122" font-size="9" fill="rgba(255,255,255,.75)" font-family="Inter,sans-serif" font-weight="600">US-East</text><text x="758" y="134" font-size="8" fill="rgba(255,255,255,.4)" font-family="Inter,sans-serif">48 databases</text></g>
    <g><text x="740" y="162" font-size="14">🇪🇺</text><text x="758" y="162" font-size="9" fill="rgba(255,255,255,.75)" font-family="Inter,sans-serif" font-weight="600">EU-West</text><text x="758" y="174" font-size="8" fill="rgba(255,255,255,.4)" font-family="Inter,sans-serif">42 databases</text></g>
    <g><text x="740" y="202" font-size="14">🇮🇳</text><text x="758" y="202" font-size="9" fill="rgba(255,255,255,.75)" font-family="Inter,sans-serif" font-weight="600">India</text><text x="758" y="214" font-size="8" fill="rgba(255,255,255,.4)" font-family="Inter,sans-serif">38 databases</text></g>
    <g><text x="740" y="242" font-size="14">🇬🇧</text><text x="758" y="242" font-size="9" fill="rgba(255,255,255,.75)" font-family="Inter,sans-serif" font-weight="600">UK-South</text><text x="758" y="254" font-size="8" fill="rgba(255,255,255,.4)" font-family="Inter,sans-serif">32 databases</text></g>
    <g><text x="740" y="282" font-size="14">🇨🇦</text><text x="758" y="282" font-size="9" fill="rgba(255,255,255,.75)" font-family="Inter,sans-serif" font-weight="600">Canada</text><text x="758" y="294" font-size="8" fill="rgba(255,255,255,.4)" font-family="Inter,sans-serif">26 databases</text></g>
  </g>
  <rect x="20" y="362" width="860" height="4" rx="2" fill="rgba(255,255,255,.04)"/>
  <rect x="20" y="362" width="600" height="4" rx="2" fill="rgba(79,70,229,.4)">
    <animate attributeName="width" values="200;700;500;600" dur="4s" repeatCount="indefinite"/>
  </rect>
</svg>`;

export default function Home() {
  const { authenticated } = useAuth();
  const navigate = useNavigate();
  useEffect(() => { if (authenticated) navigate('/dashboard', { replace: true }); }, [authenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="hp-page">
      {/* Navigation */}
      <nav className="hp-nav">
        <Link className="logo" to="/"><span className="dot">T</span> TooVix <span style={{ fontWeight: 500, color: 'var(--muted)', fontSize: 13, marginLeft: -4 }}>DAM</span></Link>
        <div className="links">
          <a href="#capabilities">Capabilities</a>
          <a href="#engines">Engines</a>
          <a href="#architecture">Architecture</a>
          <a href="#compliance">Compliance</a>
          <a href="#pricing">Pricing</a>
          <a href="/tutorial.html" target="_blank" rel="noopener noreferrer">Guide</a>
        </div>
        <Link className="cta-ghost" to="/login">Sign in</Link>
        <Link className="cta" to="/signup">Start free trial</Link>
      </nav>

      {/* Hero */}
      <section className="hero">
        <div className="hero-badge">✦ Now with LLM data-security &amp; AI firewall</div>
        <h1>See every query.<br /><span className="grad">Stop every breach.</span></h1>
        <p>Database Activity Monitoring for the global enterprise. Real-time visibility, behavioral analytics, and compliance automation across every engine, every cloud, every region.</p>
        <div className="hero-ctas">
          <Link className="btn-lg btn-primary" to="/signup">Start 14-day free trial →</Link>
          <Link className="btn-lg btn-outline" to="/login">Live demo ↗</Link>
        </div>
        <p className="hero-guide">
          New to Database Activity Monitoring?{' '}
          <a href="/tutorial.html" target="_blank" rel="noopener noreferrer">Read the beginner’s guide →</a>
        </p>
        <div className="hero-trust">
          <span>● SOC 2 Type II certified</span>
          <span>● ISO 27001</span>
          <span>● GDPR &amp; DPDPA compliant</span>
          <span>● Multi-region data residency</span>
          <span>● No credit card required</span>
        </div>
      </section>

      {/* Hero graphic */}
      <div className="hero-graphic" dangerouslySetInnerHTML={{ __html: HERO_SVG }} />

      {/* Stats */}
      <div className="stats">
        {[['6', 'Database engines at GA'], ['6,000+', 'VA security tests'], ['< 3s', 'Alert latency end-to-end'], ['5', 'Data residency regions'], ['7', 'Compliance frameworks'], ['100B+', 'Events processed / month']].map(([sv, sl]) => (
          <div className="stat" key={sl}><div className="sv">{sv}</div><div className="sl">{sl}</div></div>
        ))}
      </div>

      {/* Capabilities */}
      <section className="sec" id="capabilities">
        <div className="sec-head">
          <h2>Everything you need to secure your database fleet</h2>
          <p>From discovery to compliance reporting — one platform that replaces legacy DAM appliances.</p>
        </div>
        <div className="cap-grid">
          {CAPS.map(([bg, color, icon, h, p]) => (
            <div className="cap" key={h}>
              <div className="ci" style={{ background: bg, color }}>{icon}</div>
              <h3>{h}</h3><p>{p}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Engines */}
      <section className="sec" id="engines" style={{ background: 'var(--surface)', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', maxWidth: 'none', padding: '56px 48px' }}>
        <div className="sec-head">
          <h2>One console for every database engine</h2>
          <p>Engine-specific capture, engine-neutral rules. A single policy fires identically across Oracle, SQL Server, and MongoDB.</p>
        </div>
        <div className="eng-row">
          {ENGINES.map(([ei, name]) => (
            <div className="eng" key={name}><span className="ei">{ei}</span> {name}</div>
          ))}
        </div>
        <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13, marginTop: 18 }}>SAP HANA, SAP ASE (Sybase), Teradata, Snowflake, BigQuery, Redis — on roadmap</p>
      </section>

      {/* Deployment architecture */}
      <section className="sec" id="architecture">
        <div className="sec-head">
          <h2>How TooVix captures your data</h2>
          <p>Three capture models, one control plane. Which applies depends on the engine and where it runs — a self-managed VM exposes all three; a managed PaaS instance exposes only Agentless.</p>
        </div>
        <div className="model-grid">
          {MODELS.map(([name, mc, mcSoft, tag, body]) => (
            <div className="model" key={name} style={{ '--mc': mc, '--mc-soft': mcSoft }}>
              <h3>{name}</h3>
              <p>{body}</p>
              <span className="mtag">{tag}</span>
            </div>
          ))}
        </div>
        <div className="matrix-wrap">
          <table className="arch-matrix">
            <thead>
              <tr><th>Engine</th><th>AgentLite</th><th>Agent</th><th>Agentless · PaaS</th></tr>
            </thead>
            <tbody>
              {ARCH.map(([db, note, lite, agent, less]) => (
                <tr key={db}>
                  <td className="db">{db}<small>{note}</small></td>
                  <td>{supCell(lite)}</td>
                  <td>{supCell(agent)}</td>
                  <td>{supCell(less)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="arch-legend">
          <span><span className="d" style={{ background: 'var(--green)' }} /> Supported</span>
          <span><span className="d" style={{ background: 'var(--amber)' }} /> Limited / roadmap</span>
          <span><span className="d" style={{ background: 'var(--subtle)' }} /> Not applicable by design</span>
        </div>
        <p className="arch-note">Every model feeds one ingest and one per-tenant event store — so data classification, threat detection, and the tamper-evident audit trail work identically however the activity was captured.</p>
      </section>

      {/* Compliance */}
      <section className="sec" id="compliance">
        <div className="sec-head">
          <h2>Compliance out of the box</h2>
          <p>Pre-built control mappings, masking rules, and report templates. Continuous posture scoring, not point-in-time checks.</p>
        </div>
        <div className="fw-grid">
          {FRAMEWORKS.map(([fi, b, s]) => (
            <div className="fw" key={b}><div className="fi">{fi}</div><b>{b}</b><small>{s}</small></div>
          ))}
        </div>
      </section>

      {/* Regions */}
      <section className="sec" style={{ paddingTop: 0 }}>
        <div className="sec-head">
          <h2>Data residency where you need it</h2>
          <p>Your audit data never leaves the chosen region. Air-gapped and on-premises deployments for sovereign environments.</p>
        </div>
        <div className="reg-grid">
          {REGIONS.map(([rf, b, s]) => (
            <div className="reg" key={b}><div className="rf">{rf}</div><b>{b}</b><small>{s}</small></div>
          ))}
        </div>
      </section>

      {/* Testimonials */}
      <section className="sec" style={{ background: 'var(--surface)', borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', maxWidth: 'none', padding: '56px 48px' }}>
        <div className="sec-head"><h2>Trusted by security teams worldwide</h2></div>
        <div className="test-grid" style={{ maxWidth: 1140, margin: '0 auto' }}>
          {TESTIMONIALS.map(([q, av, name, role]) => (
            <div className="test" key={name}>
              <div className="tq">{q}</div>
              <div className="ta"><span className="av">{av}</span><div><b>{name}</b><small>{role}</small></div></div>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section className="sec" id="pricing">
        <div className="sec-head">
          <h2>Simple, transparent pricing</h2>
          <p>Pay per monitored database. No per-event charges, no surprise overages.</p>
        </div>
        <div className="price-grid">
          {PLANS.map((pl) => (
            <div className={`plan${pl.pop ? ' pop' : ''}`} key={pl.name}>
              <h3>{pl.name}</h3>
              <div className="pp">{pl.price} {pl.unit && <small>{pl.unit}</small>}</div>
              <div className="pd">{pl.desc}</div>
              <ul>{pl.feats.map((f) => <li key={f}>{f}</li>)}</ul>
              <Link className={`pbtn ${pl.pop ? 'pbtn-primary' : 'pbtn-outline'}`} to="/signup">{pl.cta}</Link>
            </div>
          ))}
        </div>
      </section>

      {/* CTA banner */}
      <div className="cta-banner">
        <h2>Start monitoring your databases in minutes</h2>
        <p>No agents to wrangle, no SQL changes. Connect your first database and see live activity, risk scoring, and compliance posture.</p>
        <Link className="btn-white" to="/signup">Create your workspace →</Link>
      </div>

      {/* Footer */}
      <footer className="hp-footer">
        <div className="fl"><span className="dot">T</span> TooVix DAM</div>
        <div className="fr">
          <Link to="/login">Sign in</Link>
          <Link to="/signup">Free trial</Link>
          <Link to="/login">Live demo</Link>
          <span style={{ marginLeft: 12 }}>© 2026 TooVix · SOC 2 · ISO 27001 · Built for global enterprise</span>
        </div>
      </footer>
    </div>
  );
}
