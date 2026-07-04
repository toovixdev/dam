import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const SSO_LOGO = { azure: { bg: '#0078d4', mark: '▲' }, okta: { bg: '#007dc1', mark: 'O' }, google: { bg: '#ea4335', mark: 'G' } };

export default function Login() {
  const navigate = useNavigate();
  const { login: authLogin, authenticated } = useAuth();
  const onLogin = () => navigate('/dashboard', { replace: true });

  // Step 1 = choose workspace; Step 2 = sign in to the resolved workspace.
  const [workspace, setWorkspace] = useState(null); // { tenantName, slug, sso: [] }
  const [slugInput, setSlugInput] = useState('');
  const [wsLoading, setWsLoading] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [remember, setRemember] = useState(true);

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

    // Pre-fill the workspace: from an SSO error redirect, or the last one used here.
    const wsHint = params.get('workspace') || localStorage.getItem('dam_workspace') || '';
    if (params.get('error') || params.get('expired') || params.get('workspace')) window.history.replaceState(null, '', '/login');
    if (wsHint) { setSlugInput(wsHint); resolveWorkspace(wsHint); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function resolveWorkspace(slug) {
    const s = String(slug || '').toLowerCase().trim();
    if (!s) { setError('Enter your workspace name.'); return; }
    setWsLoading(true); setError('');
    try {
      const res = await fetch(`/api/auth/workspace?slug=${encodeURIComponent(s)}`);
      const data = await res.json();
      if (res.ok && data.found) {
        setWorkspace(data);
        localStorage.setItem('dam_workspace', data.slug);
      } else {
        setError(data.error || 'No workspace found with that name.');
      }
    } catch {
      setError('Unable to connect to the server.');
    } finally {
      setWsLoading(false);
    }
  }

  function changeWorkspace() {
    setWorkspace(null); setError(''); setPassword('');
    localStorage.removeItem('dam_workspace');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!email || !password) { setError('Please enter your email and password.'); return; }
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
    // All providers use the same /auth/<provider>?tenant=<slug> entry.
    if (['azure', 'okta', 'google'].includes(providerKey)) window.location.href = `/auth/${providerKey}?tenant=${encodeURIComponent(workspace.slug)}`;
  }

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

          {!workspace ? (
            /* ── Step 1 · choose workspace ── */
            <>
              <h1>Sign in to your workspace</h1>
              <p className="login-sub">Enter your workspace name to continue. Your sign-in options are set by your workspace.</p>

              <form onSubmit={(e) => { e.preventDefault(); resolveWorkspace(slugInput); }}>
                <div className="form-field">
                  <label>Workspace</label>
                  <div className="workspace-input">
                    <input type="text" value={slugInput} onChange={e => setSlugInput(e.target.value)} placeholder="your-workspace" autoFocus autoCapitalize="none" spellCheck="false" />
                    <span className="workspace-suffix">.toovix.app</span>
                  </div>
                </div>
                {error && <div className="login-error">{error}</div>}
                <button type="submit" className="login-submit" disabled={wsLoading}>
                  {wsLoading ? 'Finding workspace…' : 'Continue'}
                </button>
              </form>

              <p className="login-footer" style={{ textAlign: 'center' }}>New to TooVix? <Link to="/signup">Create a workspace</Link></p>
            </>
          ) : mfaStage === 'verify' ? (
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
              <p className="login-sub">Your workspace requires MFA. Scan this with Google Authenticator, Authy, 1Password, or any TOTP app.</p>
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
          ) : (
            /* ── Step 2 · sign in to the resolved workspace ── */
            <>
              <h1>Sign in</h1>
              <p className="login-sub">Welcome back to <b>{workspace.tenantName}</b>.</p>

              <div className="login-tenant-chip">
                🏛 <b>{workspace.tenantName}</b> · <span className="mono">{workspace.slug}</span>
                <button type="button" className="workspace-change" onClick={changeWorkspace}>Change</button>
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
                  <div className="login-divider">or sign in with email &amp; password</div>
                </>
              )}

              <form onSubmit={handleSubmit}>
                <div className="form-field">
                  <label>Work email</label>
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="username" required />
                </div>
                <div className="form-field">
                  <label>Password</label>
                  <div className="pw-wrap">
                    <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" autoComplete="current-password" required />
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

              <p className="login-footer" style={{ textAlign: 'center' }}>New to TooVix? <Link to="/signup">Create a workspace</Link></p>
            </>
          )}
          <p className="login-footer">Protected by TooVix · all sign-ins are logged for audit</p>
        </div>
      </div>
    </div>
  );
}
