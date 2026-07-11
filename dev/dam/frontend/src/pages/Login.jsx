import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const SSO_LOGO = { azure: { bg: '#0078d4', mark: '▲' }, okta: { bg: '#007dc1', mark: 'O' }, google: { bg: '#ea4335', mark: 'G' } };

export default function Login() {
  const navigate = useNavigate();
  const { login: authLogin, authenticated } = useAuth();
  const onLogin = () => navigate('/dashboard', { replace: true });

  // Email-first: enter email → resolve the workspace(s) silently → sign in. The tenant
  // name is never shown; the resolved `slug` is used internally (login POST + SSO redirect).
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [remember, setRemember] = useState(true);

  const [workspace, setWorkspace] = useState(null); // resolved { slug, sso:[], hasPassword }
  const [choices, setChoices] = useState([]);       // >1 workspace for this email → pick one
  const [resolving, setResolving] = useState(false);

  // MFA sub-flow (password verified, session not issued yet).
  const [mfaStage, setMfaStage] = useState(null); // null | 'verify' | 'setup' | 'backup'
  const [mfaToken, setMfaToken] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [mfaSetup, setMfaSetup] = useState(null); // { qr, secret }
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState([]);
  const [pendingSession, setPendingSession] = useState(null); // { token, user } after enroll
  const [mfaBusy, setMfaBusy] = useState(false);

  useEffect(() => {
    if (authenticated) { navigate('/dashboard', { replace: true }); return; }
    const savedEmail = localStorage.getItem('dam_remember_email');
    if (savedEmail) setEmail(savedEmail);

    const params = new URLSearchParams(window.location.search);
    if (params.get('error')) { setError(decodeURIComponent(params.get('error'))); }
    if (params.get('expired')) { setError('Your session expired — please sign in again.'); }

    // SSO round-trip completed → log in.
    if (params.get('sso_token') && params.get('sso_user')) {
      try {
        const userData = JSON.parse(decodeURIComponent(params.get('sso_user')));
        authLogin(params.get('sso_token'), userData);
      } catch (e) { localStorage.setItem('dam_token', params.get('sso_token')); localStorage.setItem('dam_user', decodeURIComponent(params.get('sso_user'))); }
      window.history.replaceState(null, '', '/login');
      onLogin();
      return;
    }
    if (params.get('error') || params.get('expired') || params.get('workspace')) window.history.replaceState(null, '', '/login');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function resolveByEmail(e) {
    e?.preventDefault?.();
    const em = email.trim().toLowerCase();
    if (!em) { setError('Enter your email.'); return; }
    setResolving(true); setError('');
    try {
      const res = await fetch('/api/auth/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: em }),
      });
      const data = await res.json();
      if (res.ok && data.found) {
        if (data.workspaces.length === 1) setWorkspace(data.workspaces[0]);
        else setChoices(data.workspaces);
      } else if (data.unverified) {
        setError('This account isn’t verified yet. Check your email for the activation link to finish setting it up (or ask an admin to resend it).');
      } else {
        setError("We couldn't find an account with that email. Check the address or create a workspace.");
      }
    } catch {
      setError('Unable to connect to the server.');
    } finally {
      setResolving(false);
    }
  }

  function useDifferentEmail() {
    setWorkspace(null); setChoices([]); setPassword(''); setError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!password) { setError('Please enter your password.'); return; }
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, workspace: workspace?.slug }),
      });
      const data = await res.json();
      if (res.ok && data.token) {
        completeLogin(data.token, data.user);
      } else if (res.ok && data.mfaRequired) {
        setMfaToken(data.mfaToken); setCode(''); setMfaStage('verify');
      } else if (res.ok && data.mfaSetupRequired) {
        setSetupToken(data.setupToken); await startMfaSetup(data.setupToken);
      } else {
        setError(data.error || 'Login failed.');
      }
    } catch {
      setError('Unable to connect to the server.');
    } finally {
      setLoading(false);
    }
  }

  function completeLogin(token, user) {
    authLogin(token, user);
    if (remember) localStorage.setItem('dam_remember_email', email);
    else localStorage.removeItem('dam_remember_email');
    onLogin();
  }

  async function startMfaSetup(token) {
    setError('');
    try {
      const res = await fetch('/api/auth/mfa/setup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setupToken: token }),
      });
      const data = await res.json();
      if (res.ok && data.qr) { setMfaSetup({ qr: data.qr, secret: data.secret }); setCode(''); setMfaStage('setup'); }
      else setError(data.error || 'Could not start MFA setup.');
    } catch { setError('Unable to connect to the server.'); }
  }

  async function submitEnroll(e) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) { setError('Enter the 6-digit code from your authenticator app.'); return; }
    setMfaBusy(true); setError('');
    try {
      const res = await fetch('/api/auth/mfa/enroll', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setupToken, code: code.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.token) { setPendingSession({ token: data.token, user: data.user }); setBackupCodes(data.backupCodes || []); setMfaStage('backup'); }
      else setError(data.error || 'That code is not valid.');
    } catch { setError('Unable to connect to the server.'); } finally { setMfaBusy(false); }
  }

  async function submitVerify(e) {
    e.preventDefault();
    if (!code.trim()) { setError('Enter your code.'); return; }
    setMfaBusy(true); setError('');
    try {
      const res = await fetch('/api/auth/mfa/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mfaToken, code: code.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.token) completeLogin(data.token, data.user);
      else setError(data.error || 'Invalid code.');
    } catch { setError('Unable to connect to the server.'); } finally { setMfaBusy(false); }
  }

  function resetMfa() { setMfaStage(null); setMfaToken(''); setSetupToken(''); setMfaSetup(null); setCode(''); setBackupCodes([]); setPendingSession(null); setError(''); }

  function handleSSO(providerKey) {
    if (!workspace) return;
    if (['azure', 'okta', 'google'].includes(providerKey)) window.location.href = `/auth/${providerKey}?tenant=${encodeURIComponent(workspace.slug)}`;
  }

  const showPasswordForm = workspace && (workspace.hasPassword || !(workspace.sso && workspace.sso.length));

  return (
    <div className="login-page">
      <div className="login-brand-panel">
        <div className="login-brand-top">
          <span className="brand-dot">T</span> TooVix <span className="brand-sub">DAM</span>
        </div>
        <div className="login-brand-content">
          <h2>See every query.<br />Stop every breach.</h2>
          <p>Database Activity Monitoring for the global enterprise — real-time visibility, behavioral analytics, and compliance across every engine and region.</p>
          <div className="login-features">
            <div className="login-feat"><span className="feat-icon" style={{ background: 'rgba(99,202,255,.2)', color: '#67e8f9' }}>◎</span> Real-time monitoring across Oracle, SQL Server, Db2, PostgreSQL, MySQL &amp; MongoDB</div>
            <div className="login-feat"><span className="feat-icon" style={{ background: 'rgba(74,222,128,.2)', color: '#4ade80' }}>⚖</span> PCI-DSS · GDPR · HIPAA · SOX · DPDPA compliance, continuously validated</div>
            <div className="login-feat"><span className="feat-icon" style={{ background: 'rgba(251,191,36,.2)', color: '#fbbf24' }}>⛓</span> Tamper-evident audit trail with signed hash-chain checkpoints</div>
            <div className="login-feat"><span className="feat-icon" style={{ background: 'rgba(192,132,252,.2)', color: '#c084fc' }}>✦</span> LLM data-security — redact PII before it reaches ChatGPT</div>
          </div>
          <div className="login-quote">
            "TooVix gave us a single audited view across 240 production databases — and cut our compliance audit prep from weeks to a day."
            <span className="login-quote-who">— CISO, global financial services group</span>
          </div>
        </div>
      </div>

      <div className="login-form-panel">
        <div className="login-form-box">
          <div className="login-mini-brand"><span className="brand-dot-sm">T</span> TooVix <span className="brand-sub">DAM</span></div>

          {mfaStage === 'verify' ? (
            /* ── MFA · enter code ── */
            <>
              <h1>Two-factor authentication</h1>
              <p className="login-sub">Enter the 6-digit code from your authenticator app.</p>
              <form onSubmit={submitVerify}>
                <div className="form-field">
                  <label>Authentication code</label>
                  <input className="mfa-code-input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} placeholder="123456" autoFocus />
                </div>
                {error && <div className="login-error">{error}</div>}
                <button type="submit" className="login-submit" disabled={mfaBusy}>{mfaBusy ? 'Verifying…' : 'Verify'}</button>
                <div className="login-info">🔑 Lost your device? Enter one of your 8-character backup codes above.</div>
              </form>
              <p className="login-footer" style={{ textAlign: 'center' }}><button type="button" className="pw-toggle" style={{ position: 'static', padding: 0 }} onClick={resetMfa}>Back to sign in</button></p>
            </>
          ) : mfaStage === 'setup' ? (
            /* ── MFA · first-time enrolment ── */
            <>
              <h1>Set up two-factor authentication</h1>
              <p className="login-sub">Password sign-in requires MFA. Scan this with Google Authenticator, Authy, 1Password, or any TOTP app.</p>
              {mfaSetup && <div className="mfa-qr-wrap"><img src={mfaSetup.qr} alt="Scan this QR code with your authenticator app" /></div>}
              {mfaSetup && <div className="mfa-secret">Can’t scan? Enter this key manually:<br /><code>{mfaSetup.secret}</code></div>}
              <form onSubmit={submitEnroll}>
                <div className="form-field">
                  <label>Enter the 6-digit code to confirm</label>
                  <input className="mfa-code-input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} placeholder="123456" autoFocus />
                </div>
                {error && <div className="login-error">{error}</div>}
                <button type="submit" className="login-submit" disabled={mfaBusy}>{mfaBusy ? 'Verifying…' : 'Confirm & continue'}</button>
              </form>
              <p className="login-footer" style={{ textAlign: 'center' }}><button type="button" className="pw-toggle" style={{ position: 'static', padding: 0 }} onClick={resetMfa}>Cancel</button></p>
            </>
          ) : mfaStage === 'backup' ? (
            /* ── MFA · show one-time backup codes ── */
            <>
              <h1>Save your backup codes</h1>
              <p className="login-sub">Store these somewhere safe. Each works once if you lose your authenticator.</p>
              <div className="mfa-backup-grid">{backupCodes.map((c) => <span key={c} className="mfa-backup-code">{c}</span>)}</div>
              <button type="button" className="login-submit" onClick={() => pendingSession && completeLogin(pendingSession.token, pendingSession.user)}>I’ve saved my codes — continue</button>
              <div className="login-info">⚠️ These won’t be shown again. You can regenerate them later from your profile.</div>
            </>
          ) : choices.length > 0 ? (
            /* ── Pick a workspace (email is in more than one) ── */
            <>
              <h1>Choose your workspace</h1>
              <p className="login-sub"><b>{email}</b> belongs to more than one workspace. Pick one to continue.</p>
              <div className="ws-choice-list">
                {choices.map((w) => (
                  <button key={w.slug} type="button" className="ws-choice" onClick={() => { setChoices([]); setWorkspace(w); }}>
                    <span className="mono">{w.slug}</span>
                    <span className="ws-choice-arrow">→</span>
                  </button>
                ))}
              </div>
              <p className="login-footer" style={{ textAlign: 'center' }}><button type="button" className="pw-toggle" style={{ position: 'static', padding: 0 }} onClick={useDifferentEmail}>Use a different email</button></p>
            </>
          ) : !workspace ? (
            /* ── Step 1 · email ── */
            <>
              <h1>Sign in</h1>
              <p className="login-sub">Enter your work email to continue.</p>
              <form onSubmit={resolveByEmail}>
                <div className="form-field">
                  <label>Work email</label>
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="username" autoFocus required />
                </div>
                {error && <div className="login-error">{error}</div>}
                <button type="submit" className="login-submit" disabled={resolving}>{resolving ? 'Checking…' : 'Continue'}</button>
              </form>
              <p className="login-footer" style={{ textAlign: 'center' }}>New to TooVix? <Link to="/signup">Create a workspace</Link></p>
            </>
          ) : (
            /* ── Step 2 · credentials for the resolved workspace (no tenant name shown) ── */
            <>
              <h1>Sign in</h1>
              <p className="login-sub">Welcome back.</p>

              <div className="login-tenant-chip">
                ✉ <b>{email}</b>
                <button type="button" className="workspace-change" onClick={useDifferentEmail}>Change</button>
              </div>

              {workspace.sso && workspace.sso.length > 0 && (
                <>
                  <div className="sso-buttons">
                    {workspace.sso.map((p) => (
                      <button key={p.key} className="sso-btn" onClick={() => handleSSO(p.key)}>
                        <span className="sso-logo" style={{ background: (SSO_LOGO[p.key] || {}).bg || '#555' }}>{(SSO_LOGO[p.key] || {}).mark || '◆'}</span> Continue with {p.name}
                      </button>
                    ))}
                  </div>
                  {showPasswordForm && <div className="login-divider">or sign in with your password</div>}
                </>
              )}

              {showPasswordForm && (
                <form onSubmit={handleSubmit}>
                  <div className="form-field">
                    <label>Password</label>
                    <div className="pw-wrap">
                      <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" autoComplete="current-password" autoFocus required />
                      <button type="button" className="pw-toggle" onClick={() => setShowPw(!showPw)}>{showPw ? 'Hide' : 'Show'}</button>
                    </div>
                  </div>

                  {error && <div className="login-error">{error}</div>}

                  <div className="login-options">
                    <label className="remember-label">
                      <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> Remember this device
                    </label>
                  </div>

                  <button type="submit" className="login-submit" disabled={loading}>
                    {loading ? 'Signing in...' : 'Sign in'}
                  </button>

                  <div className="login-info">🔒 Password login requires two-factor authentication. SSO users use the buttons above — MFA is handled by your identity provider.</div>
                </form>
              )}

              {!showPasswordForm && error && <div className="login-error">{error}</div>}

              <p className="login-footer" style={{ textAlign: 'center' }}>New to TooVix? <Link to="/signup">Create a workspace</Link></p>
            </>
          )}
          <p className="login-footer">Protected by TooVix · all sign-ins are logged for audit</p>
        </div>
      </div>
    </div>
  );
}
