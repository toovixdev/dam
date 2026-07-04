import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

// Strength = length + character-class variety. `ok` mirrors the backend policy
// (≥8 chars and at least 3 of {lowercase, uppercase, digit, symbol}).
function pwStrength(pw) {
  const len = pw.length;
  const cats = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  let score = 0;
  if (len >= 8) score++;
  if (len >= 12) score++;
  score = Math.min(4, score + Math.max(0, cats - 1));
  const ok = len >= 8 && cats >= 3;
  return { score, ok,
    label: ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'][score],
    color: ['var(--danger)', 'var(--danger)', 'var(--amber)', 'var(--info)', 'var(--green)'][score] };
}

// Self-serve plans. Trial = shared infra (14-day); Business = dedicated data plane.
// Enterprise is contact-sales (no instant provisioning) — handled specially below.
const PLANS = [
  { key: 'trial',      name: 'Trial',      price: 'Free · 14 days', blurb: 'Full product on shared infrastructure. No card required.', badge: 'Popular' },
  { key: 'business',   name: 'Business',   price: 'Dedicated',      blurb: 'Your own isolated data plane, higher quotas, all detections.' },
  { key: 'enterprise', name: 'Enterprise', price: 'Contact sales',  blurb: 'SLA-backed, per-contract quotas, dedicated onboarding.', sales: true },
];
const SALES_EMAIL = 'sales@toovix.com';

export default function Signup() {
  const navigate = useNavigate();
  const { login: authLogin, authenticated } = useAuth();
  const [companyName, setCompanyName] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [plan, setPlan] = useState('trial');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(''); // email a verification link was sent to
  const [slug, setSlug] = useState(''); // the workspace ID assigned at signup
  const isSales = plan === 'enterprise';

  useEffect(() => { if (authenticated) navigate('/dashboard', { replace: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e) {
    e.preventDefault();
    if (!companyName || !fullName || !email || !password) { setError('Please fill in every field.'); return; }
    if (!pwStrength(password).ok) { setError('Password too weak — 8+ characters with at least 3 of: lowercase, uppercase, number, symbol.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyName, fullName, email, password, confirmPassword: confirm, plan }),
      });
      const data = await res.json();
      if (res.ok && data.pending) {
        setSlug(data.slug || '');
        setSent(data.email || email);
      } else {
        setError(data.error || 'Could not create your account.');
      }
    } catch {
      setError('Unable to connect to the server.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-brand-panel">
        <div className="login-brand-top">
          <span className="brand-dot">T</span> TooVix <span className="brand-sub">DAM</span>
        </div>
        <div className="login-brand-content">
          <h2>Start monitoring<br />in minutes.</h2>
          <p>Create your workspace and get real-time Database Activity Monitoring, behavioral analytics, and continuous compliance across every engine.</p>
          <div className="login-features">
            <div className="login-feat"><span className="feat-icon" style={{ background: 'rgba(99,202,255,.2)', color: '#67e8f9' }}>◎</span> Real-time monitoring across Oracle, SQL Server, Db2, PostgreSQL, MySQL &amp; MongoDB</div>
            <div className="login-feat"><span className="feat-icon" style={{ background: 'rgba(74,222,128,.2)', color: '#4ade80' }}>⚖</span> PCI-DSS · GDPR · HIPAA · SOX · DPDPA, continuously validated</div>
            <div className="login-feat"><span className="feat-icon" style={{ background: 'rgba(251,191,36,.2)', color: '#fbbf24' }}>⛓</span> Tamper-evident audit trail with signed hash-chain checkpoints</div>
            <div className="login-feat"><span className="feat-icon" style={{ background: 'rgba(192,132,252,.2)', color: '#c084fc' }}>✦</span> JIT access, dynamic masking, deception &amp; LLM data-security built in</div>
          </div>
        </div>
      </div>

      <div className="login-form-panel">
        <div className="login-form-box">
          <div className="login-mini-brand"><span className="brand-dot-sm">T</span> TooVix <span className="brand-sub">DAM</span></div>

          {sent ? (
            <>
              <h1>Check your email</h1>
              <p className="login-sub">We sent a verification link to <b>{sent}</b>. Click it to activate <b>{companyName}</b> and sign in. The link expires in 24 hours.</p>
              {slug && (
                <div className="login-tenant-chip" style={{ marginTop: 16, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', borderRadius: 10, gap: 2 }}>
                  <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em', fontWeight: 700, color: 'var(--muted)' }}>Your workspace ID</span>
                  <span className="mono" style={{ fontSize: 15, color: 'var(--ink)' }}>{slug}</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>You'll enter this to sign in each time. It's in your email too.</span>
                </div>
              )}
              <div className="login-info" style={{ marginTop: 16 }}>📬 Didn't get it? Check spam, or make sure the workspace admin's mailbox is reachable. You can't sign in until the email is verified.</div>
              <p className="login-footer" style={{ textAlign: 'center', marginTop: 18 }}>Wrong address? <button className="pw-toggle" style={{ position: 'static', padding: 0 }} onClick={() => setSent('')}>Start over</button> · <Link to="/login">Sign in</Link></p>
            </>
          ) : (
          <>
          <h1>Create your workspace</h1>
          <p className="login-sub">Set up a new tenant. You'll verify your email, then land in the console as its first admin.</p>

          <div className="plan-picker">
            {PLANS.map((p) => (
              <button key={p.key} type="button" className={`plan-card${plan === p.key ? ' selected' : ''}`} onClick={() => setPlan(p.key)}>
                <div className="plan-card-top">
                  <span className="plan-name">{p.name}</span>
                  {p.badge && <span className="plan-badge">{p.badge}</span>}
                </div>
                <div className="plan-price">{p.price}</div>
                <div className="plan-blurb">{p.blurb}</div>
              </button>
            ))}
          </div>

          {isSales ? (
            <div className="sales-panel">
              <div className="login-info" style={{ marginTop: 4 }}>🏢 <b>Enterprise</b> plans are configured with our team — SLA, custom quotas, dedicated data plane and onboarding. Tell us about your workspace and we'll set it up.</div>
              <a className="login-submit" style={{ display: 'block', textAlign: 'center', textDecoration: 'none', marginTop: 14 }}
                 href={`mailto:${SALES_EMAIL}?subject=${encodeURIComponent('Enterprise plan enquiry' + (companyName ? ' — ' + companyName : ''))}&body=${encodeURIComponent(`Company: ${companyName}\nContact: ${fullName}\nEmail: ${email}\n\nWe'd like to discuss an Enterprise workspace.`)}`}>
                Contact sales
              </a>
              <p className="login-footer" style={{ textAlign: 'center', marginTop: 12 }}>
                Just exploring? <button type="button" className="pw-toggle" style={{ position: 'static', padding: 0 }} onClick={() => setPlan('trial')}>Start a free trial instead</button>
              </p>
            </div>
          ) : (
          <form onSubmit={handleSubmit}>
            <div className="form-field">
              <label>Company / workspace name</label>
              <input type="text" value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Acme Corp" required />
            </div>
            <div className="form-field">
              <label>Your name</label>
              <input type="text" value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Jane Doe" autoComplete="name" required />
            </div>
            <div className="form-field">
              <label>Work email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="username" required />
            </div>
            <div className="form-field">
              <label>Password</label>
              <div className="pw-wrap">
                <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Create a strong password" autoComplete="new-password" required />
                <button type="button" className="pw-toggle" onClick={() => setShowPw(!showPw)}>{showPw ? 'Hide' : 'Show'}</button>
              </div>
              {password && (() => { const s = pwStrength(password); return (
                <div style={{ marginTop: 6 }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {[0, 1, 2, 3].map(i => <span key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: i < s.score ? s.color : 'var(--line)' }} />)}
                  </div>
                  <span style={{ fontSize: 11.5, color: s.color, fontWeight: 600 }}>{s.label}</span>
                  {!s.ok && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}> · use 8+ chars with 3 of: lower, upper, number, symbol</span>}
                </div>
              ); })()}
            </div>
            <div className="form-field">
              <label>Confirm password</label>
              <input type={showPw ? 'text' : 'password'} value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Re-enter your password" autoComplete="new-password" required />
              {confirm && confirm !== password && <span style={{ fontSize: 11.5, color: 'var(--danger)' }}>Passwords don't match</span>}
            </div>

            {error && <div className="login-error">{error}</div>}

            <button type="submit" className="login-submit" disabled={loading}>
              {loading ? 'Creating workspace…' : plan === 'business' ? 'Start Business workspace' : 'Start free trial'}
            </button>

            <div className="login-info">🔒 You'll be the tenant admin (local account). The workspace starts empty — add your databases and agents once you're in.{plan === 'trial' && ' Your 14-day trial runs on shared infrastructure.'}{plan === 'business' && ' Business provisions a dedicated, isolated data plane.'}</div>
          </form>
          )}

          <p className="login-footer" style={{ textAlign: 'center' }}>Already have a workspace? <Link to="/login">Sign in</Link></p>
          </>
          )}
        </div>
      </div>
    </div>
  );
}
