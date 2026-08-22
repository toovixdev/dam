import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import './Home.css';

// Public marketing homepage (ported from mockups/index.html). CTAs are wired to
// the real /login and /signup routes; section links scroll within the page.
// SecurEra is the platform brand; EvaSoft is the company behind it.

// ---------------------------------------------------------------------------
// PRODUCT CATALOGUE
// Add a new SecurEra product by appending an entry here — the grid, the badges
// and the responsive layout all follow automatically. `status: 'live'` renders
// the highlighted card with a working CTA; `status: 'soon'` renders the dashed
// "on the roadmap" placeholder. Rename or delete the placeholders below as the
// real products get designed.
// ---------------------------------------------------------------------------
const PRODUCTS = [
  {
    status: 'live',
    icon: '◎',
    name: 'SecurEra DAM',
    category: 'Database Activity Monitoring',
    body: 'Real-time monitoring, behavioural threat detection and compliance automation across Oracle, SQL Server, Db2, PostgreSQL, MySQL and MongoDB — on-prem, cloud or air-gapped.',
    tags: ['6 engines', 'UEBA', 'Inline blocking', '7 frameworks'],
    to: '/signup',
    cta: 'Start free trial →',
    more: { href: '#capabilities', label: 'See capabilities' },
  },
  {
    status: 'soon',
    icon: '▦',
    name: 'Data Security Posture',
    category: 'DSPM — on the roadmap',
    body: 'Continuous discovery and risk scoring of every data store you own, including the shadow ones. Placeholder card — swap in the real product once its scope is locked.',
    tags: ['Shadow data', 'Risk scoring', 'Attack paths'],
  },
  {
    status: 'soon',
    icon: '⛨',
    name: 'Cloud & SaaS Security',
    category: 'CSPM — on the roadmap',
    body: 'Misconfiguration and entitlement monitoring for the accounts your databases live in. Placeholder card — swap in the real product once its scope is locked.',
    tags: ['AWS · Azure · GCP', 'Entitlements', 'Drift'],
  },
  {
    status: 'soon',
    icon: '✦',
    name: 'AI & LLM Guardrails',
    category: 'AI security — on the roadmap',
    body: 'Prompt-level inspection of what applications send to hosted models, with PII controls before data ever reaches the LLM. Placeholder card — swap in the real product once its scope is locked.',
    tags: ['Prompt PII', 'Model routing', 'Audit trail'],
  },
];

const CAPS = [
  ['var(--primary-soft)', 'var(--primary)', '◎', 'Real-Time Activity Monitoring', 'Every query, every user, every session — captured in real-time with full context. Privileged accounts, application traffic, and local connections.'],
  ['var(--danger-soft)', 'var(--danger)', '⚠', 'Behavioral Threat Detection', 'Continuous learning builds per-user baselines. Detects anomalies: off-hours access, volume spikes, first-time sensitive reads, credential stuffing.'],
  ['var(--green-soft)', 'var(--green)', '⚖', 'Compliance Automation', 'Pre-built packs for PCI-DSS, GDPR, HIPAA, SOX, DPDPA, and RBI. Continuous control validation with one-click audit reports.'],
  ['var(--amber-soft)', 'var(--amber)', '◧', 'Sensitive Data Discovery', 'Auto-classify SSN, Aadhaar, PAN, credit cards, PHI across all engines. ML + regex + exact-match with region-specific validators.'],
  ['var(--info-soft)', 'var(--info)', '⛓', 'Tamper-Evident Audit Trail', 'Hash-chain with signed hourly checkpoints. Prove 30 days of integrity by verifying 720 checkpoints, not billions of events.'],
  ['var(--danger-soft)', 'var(--danger)', '⛔', 'Inline Blocking + Proxy', 'DAM Proxy Gateway blocks threats in real-time. Monitor mode → blocking mode per policy. Virtual patching shields unpatched databases.'],
  ['var(--primary-soft)', 'var(--primary)', '▦', 'Dynamic Data Masking', 'Query-time masking for non-privileged users, by role. Format-preserving for analytics. (Static masking for non-prod clones is on the roadmap.)'],
  ['var(--green-soft)', 'var(--green)', '⊠', 'Access Governance', 'Discover privileged + dormant accounts. Entitlement recertification campaigns. Service-account identity resolution behind connection pools.'],
  ['var(--amber-soft)', 'var(--amber)', '✦', 'LLM & AI Data Security', 'On the roadmap: monitor what apps send to ChatGPT, Bedrock and Azure OpenAI, with prompt-level PII controls before data reaches the LLM.'],
];

const ENGINES = [['🔴', 'Oracle'], ['🔷', 'SQL Server'], ['🔵', 'IBM Db2'], ['🐘', 'PostgreSQL'], ['🐬', 'MySQL / MariaDB'], ['🍃', 'MongoDB']];

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
  ['"We replaced two legacy DAM appliances with SecurEra and had Oracle + Db2 under watch the same afternoon. RBI audit prep went from weeks to a day."', 'RK', 'Rajesh K.', 'CISO · Indian private-sector bank'],
  ['"The behavioral baselines caught a compromised service account at 2am that our SIEM completely missed. That alone justified the investment."', 'ML', 'Marie L.', 'Head of SOC · European insurance group'],
  ['"One policy for \'bulk PII read\' fires identically across our Oracle, Postgres, and MongoDB fleet. No more writing the same rule six times."', 'JC', 'Jason C.', 'Security Engineering · US fintech'],
];

const PLANS = [
  { name: 'Starter', price: 'Free', unit: '/ 14 days', desc: 'Up to 5 databases', pop: false, cta: 'Start free trial',
    feats: ['All 6 engines supported', 'Real-time monitoring + alerts', '30-day retention', 'PCI-DSS + 1 framework', 'Community support'] },
  { name: 'Business', price: 'Custom', unit: '/ db / month', desc: 'Unlimited databases', pop: true, cta: 'Start free trial',
    feats: ['Everything in Starter', 'UEBA + behavioral analytics', '1-year retention + cold archive', 'All compliance frameworks', 'SSO (Azure AD / Okta)', 'Inline blocking + proxy', 'Priority support + SLA'] },
  { name: 'Enterprise', price: 'Custom', unit: '', desc: 'On-prem / air-gapped / multi-region', pop: false, cta: 'Contact sales',
    feats: ['Everything in Business', 'Customer-managed keys (roadmap)', 'On-prem deploy (air-gap on roadmap)', 'Multi-region data planes', 'Dedicated support + TAM', 'Custom retention + legal hold'] },
];

const HERO_SVG = `<svg viewBox="0 0 900 380" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="hgBg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#08203d"/><stop offset="100%" stop-color="#041226"/></linearGradient>
    <linearGradient id="hgShield" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#4da3fa"/><stop offset="100%" stop-color="#117FF7"/></linearGradient>
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
    <rect x="40" y="55" width="110" height="60" rx="10" fill="rgba(17,127,247,.15)" stroke="#4da3fa" stroke-width="1.5"/>
    <ellipse cx="95" cy="72" rx="28" ry="8" fill="rgba(77,163,250,.2)"/>
    <ellipse cx="95" cy="82" rx="28" ry="8" fill="none" stroke="rgba(77,163,250,.3)" stroke-width=".7"/>
    <ellipse cx="95" cy="92" rx="28" ry="8" fill="none" stroke="rgba(77,163,250,.2)" stroke-width=".5"/>
    <text x="95" y="123" font-size="10" fill="#8fc4fb" text-anchor="middle" font-family="Inter,sans-serif" font-weight="700">Oracle 19c</text>
    <circle cx="142" cy="62" r="4" fill="#4ade80" class="hg-blink"/>
  </g>
  <g class="hg-pulse" style="animation-delay:.5s">
    <rect x="40" y="145" width="110" height="60" rx="10" fill="rgba(17,127,247,.15)" stroke="#4da3fa" stroke-width="1.5"/>
    <ellipse cx="95" cy="162" rx="28" ry="8" fill="rgba(77,163,250,.2)"/>
    <ellipse cx="95" cy="172" rx="28" ry="8" fill="none" stroke="rgba(77,163,250,.3)" stroke-width=".7"/>
    <ellipse cx="95" cy="182" rx="28" ry="8" fill="none" stroke="rgba(77,163,250,.2)" stroke-width=".5"/>
    <text x="95" y="213" font-size="10" fill="#8fc4fb" text-anchor="middle" font-family="Inter,sans-serif" font-weight="700">SQL Server</text>
    <circle cx="142" cy="152" r="4" fill="#4ade80" class="hg-blink" style="animation-delay:.3s"/>
  </g>
  <g class="hg-pulse" style="animation-delay:1s">
    <rect x="40" y="235" width="110" height="60" rx="10" fill="rgba(17,127,247,.15)" stroke="#4da3fa" stroke-width="1.5"/>
    <ellipse cx="95" cy="252" rx="28" ry="8" fill="rgba(77,163,250,.2)"/>
    <ellipse cx="95" cy="262" rx="28" ry="8" fill="none" stroke="rgba(77,163,250,.3)" stroke-width=".7"/>
    <ellipse cx="95" cy="272" rx="28" ry="8" fill="none" stroke="rgba(77,163,250,.2)" stroke-width=".5"/>
    <text x="95" y="303" font-size="10" fill="#8fc4fb" text-anchor="middle" font-family="Inter,sans-serif" font-weight="700">PostgreSQL</text>
    <circle cx="142" cy="242" r="4" fill="#fbbf24" class="hg-blink" style="animation-delay:.6s"/>
  </g>
  <g class="hg-pulse" style="animation-delay:1.5s" opacity=".7">
    <rect x="55" y="320" width="80" height="42" rx="8" fill="rgba(17,127,247,.1)" stroke="rgba(77,163,250,.4)" stroke-width="1"/>
    <text x="95" y="346" font-size="9" fill="#8fc4fb" text-anchor="middle" font-family="Inter,sans-serif" font-weight="600">MongoDB</text>
  </g>
  <path d="M152 85 Q220 85 270 140" stroke="#4da3fa" stroke-width="2" fill="none" class="hg-flow" opacity=".7"/>
  <path d="M152 175 L270 175" stroke="#4da3fa" stroke-width="2" fill="none" class="hg-flow" style="animation-delay:.3s" opacity=".7"/>
  <path d="M152 265 Q220 265 270 210" stroke="#4da3fa" stroke-width="2" fill="none" class="hg-flow" style="animation-delay:.6s" opacity=".7"/>
  <path d="M135 341 Q200 330 270 230" stroke="rgba(77,163,250,.4)" stroke-width="1.5" fill="none" class="hg-flow" style="animation-delay:.9s"/>
  <circle cx="370" cy="190" r="88" fill="none" stroke="rgba(77,163,250,.2)" stroke-width="1"/>
  <circle cx="370" cy="190" r="68" fill="none" stroke="rgba(77,163,250,.15)" stroke-width="1"/>
  <circle cx="370" cy="190" r="48" fill="rgba(27,91,208,.1)"/>
  <g class="hg-scan" filter="url(#hgGlowSm)">
    <line x1="370" y1="190" x2="370" y2="108" stroke="rgba(77,163,250,.6)" stroke-width="2"/>
    <circle cx="370" cy="108" r="4" fill="#4da3fa"/>
  </g>
  <g filter="url(#hgGlow)">
    <circle cx="370" cy="190" r="30" fill="url(#hgShield)"/>
    <text x="370" y="196" font-size="22" text-anchor="middle" fill="#fff">🛡️</text>
  </g>
  <text x="370" y="245" font-size="11" fill="#cfe6fd" text-anchor="middle" font-family="Inter,sans-serif" font-weight="700">SecurEra DAM Engine</text>
  <text x="370" y="261" font-size="9" fill="rgba(143,196,251,.7)" text-anchor="middle" font-family="Inter,sans-serif">Detect · Protect · Comply</text>
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
    <rect x="520" y="295" width="170" height="60" rx="10" fill="rgba(17,127,247,.08)" stroke="rgba(77,163,250,.4)" stroke-width="1.3"/>
    <text x="536" y="319" font-size="10" fill="#8fc4fb" font-family="Inter,sans-serif" font-weight="700">⛔ BLOCKED</text>
    <text x="536" y="335" font-size="8.5" fill="rgba(143,196,251,.6)" font-family="Inter,sans-serif">SQLi attempt auto-blocked</text>
    <text x="536" y="349" font-size="8" fill="rgba(143,196,251,.5)" font-family="Inter,sans-serif">Virtual patch · CVE-2025-1842</text>
  </g>
  <path d="M440 155 Q480 100 520 76" stroke="rgba(251,113,133,.4)" stroke-width="1.5" fill="none"/>
  <path d="M440 175 L520 161" stroke="rgba(251,191,36,.3)" stroke-width="1.5" fill="none"/>
  <path d="M440 210 L520 246" stroke="rgba(74,222,128,.3)" stroke-width="1.5" fill="none"/>
  <path d="M440 225 Q480 280 520 320" stroke="rgba(77,163,250,.3)" stroke-width="1.5" fill="none"/>
  <g>
    <rect x="720" y="70" width="150" height="240" rx="12" fill="rgba(255,255,255,.03)" stroke="rgba(255,255,255,.08)" stroke-width="1"/>
    <text x="795" y="94" font-size="9" fill="rgba(207,230,253,.8)" text-anchor="middle" font-family="Inter,sans-serif" font-weight="700">DATA RESIDENCY</text>
    <g><text x="740" y="122" font-size="14">🇺🇸</text><text x="758" y="122" font-size="9" fill="rgba(255,255,255,.75)" font-family="Inter,sans-serif" font-weight="600">US-East</text><text x="758" y="134" font-size="8" fill="rgba(255,255,255,.4)" font-family="Inter,sans-serif">48 databases</text></g>
    <g><text x="740" y="162" font-size="14">🇪🇺</text><text x="758" y="162" font-size="9" fill="rgba(255,255,255,.75)" font-family="Inter,sans-serif" font-weight="600">EU-West</text><text x="758" y="174" font-size="8" fill="rgba(255,255,255,.4)" font-family="Inter,sans-serif">42 databases</text></g>
    <g><text x="740" y="202" font-size="14">🇮🇳</text><text x="758" y="202" font-size="9" fill="rgba(255,255,255,.75)" font-family="Inter,sans-serif" font-weight="600">India</text><text x="758" y="214" font-size="8" fill="rgba(255,255,255,.4)" font-family="Inter,sans-serif">38 databases</text></g>
    <g><text x="740" y="242" font-size="14">🇬🇧</text><text x="758" y="242" font-size="9" fill="rgba(255,255,255,.75)" font-family="Inter,sans-serif" font-weight="600">UK-South</text><text x="758" y="254" font-size="8" fill="rgba(255,255,255,.4)" font-family="Inter,sans-serif">32 databases</text></g>
    <g><text x="740" y="282" font-size="14">🇨🇦</text><text x="758" y="282" font-size="9" fill="rgba(255,255,255,.75)" font-family="Inter,sans-serif" font-weight="600">Canada</text><text x="758" y="294" font-size="8" fill="rgba(255,255,255,.4)" font-family="Inter,sans-serif">26 databases</text></g>
  </g>
  <rect x="20" y="362" width="860" height="4" rx="2" fill="rgba(255,255,255,.04)"/>
  <rect x="20" y="362" width="600" height="4" rx="2" fill="rgba(27,91,208,.4)">
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
        <Link className="logo" to="/">
          <img src="/brand/securera-logo-horizontal.svg" alt="SecurEra" />
          <span className="logo-tag">DAM</span>
        </Link>
        <div className="links">
          <a href="#products">Products</a>
          <a href="#capabilities">Capabilities</a>
          <a href="#engines">Engines</a>
          <a href="#compliance">Compliance</a>
          <a href="#pricing">Pricing</a>
          <a href="/tutorial.html" target="_blank" rel="noopener noreferrer">Guide</a>
        </div>
        <Link className="cta-ghost" to="/login">Sign in</Link>
        <Link className="cta" to="/signup">Start free trial</Link>
      </nav>

      {/* Hero */}
      <section className="hero">
        <div className="hero-badge">✦ Now with just-in-time access &amp; deception</div>
        <h1>See every query.<br /><span className="grad">Stop every breach.</span></h1>
        <p><b>SecurEra DAM</b> is Database Activity Monitoring for the global enterprise — real-time visibility, behavioural analytics and compliance automation across every engine, every cloud, every region.</p>
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
        {[['6', 'Database engines at GA'], ['5', 'Capture modes · agent to agentless'], ['< 3s', 'Alert latency end-to-end'], ['5', 'Data residency regions'], ['7', 'Compliance frameworks'], ['100B+', 'Events processed / month']].map(([sv, sl]) => (
          <div className="stat" key={sl}><div className="sv">{sv}</div><div className="sl">{sl}</div></div>
        ))}
      </div>

      {/* Products */}
      <section className="sec" id="products">
        <div className="sec-head">
          <h2>The SecurEra platform</h2>
          <p>One security platform from EvaSoft. Database Activity Monitoring is live today — the rest of the suite is being built on the same engine, console and audit trail.</p>
        </div>
        <div className="prod-grid">
          {PRODUCTS.map((p) => (
            <div className={`prod ${p.status === 'live' ? 'live' : 'soon'}`} key={p.name}>
              <span className={`pill ${p.status === 'live' ? 'pill-live' : 'pill-soon'}`}>
                {p.status === 'live' ? 'Available now' : 'Coming soon'}
              </span>
              <div className="prod-top">
                <div className="pi">{p.icon}</div>
                <div>
                  <h3>{p.name}</h3>
                  <div className="pcat">{p.category}</div>
                </div>
              </div>
              <p className="pbody">{p.body}</p>
              <div className="ptags">{p.tags.map((t) => <span key={t}>{t}</span>)}</div>
              <div className="pfoot">
                {p.status === 'live' ? (
                  <>
                    <Link className="plink" to={p.to}>{p.cta}</Link>
                    {p.more && <a className="plink muted" href={p.more.href}>{p.more.label}</a>}
                  </>
                ) : (
                  <Link className="plink muted" to="/signup">Get notified at launch →</Link>
                )}
              </div>
            </div>
          ))}
        </div>
        <p className="prod-note">
          Building something specific? <Link to="/signup">Talk to us about the roadmap →</Link>
        </p>
      </section>

      {/* Capabilities */}
      <section className="sec" id="capabilities" style={{ paddingTop: 0 }}>
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
      <section className="sec sec-band" id="engines">
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
      <section className="sec sec-band">
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
        <div className="fl">
          <img src="/brand/securera-logo-horizontal.svg" alt="SecurEra" />
          <span className="by">An <b>EvaSoft</b> product</span>
        </div>
        <div className="fr">
          <Link to="/login">Sign in</Link>
          <Link to="/signup">Free trial</Link>
          <Link to="/login">Live demo</Link>
          <a href="#products">Products</a>
          <span className="legal">© 2026 EvaSoft · SecurEra® · SOC 2 · ISO 27001 · Built for global enterprise</span>
        </div>
      </footer>
    </div>
  );
}
