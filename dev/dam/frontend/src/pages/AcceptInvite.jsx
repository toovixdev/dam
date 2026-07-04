import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

const ROLE_LABELS = {
  tenant_admin: 'Tenant Admin', soc_analyst: 'SOC Analyst', compliance: 'Compliance Officer',
  auditor: 'Auditor', db_owner: 'DB Owner', viewer: 'Viewer',
};

export default function AcceptInvite() {
  const navigate = useNavigate();
  const [token] = useState(() => new URLSearchParams(window.location.search).get('token') || '');
  const [state, setState] = useState('loading'); // loading | ready | invalid | done
  const [invite, setInvite] = useState(null);
  const [loadError, setLoadError] = useState('');

  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [agree, setAgree] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) { setState('invalid'); setLoadError('No invitation token provided.'); return; }
    (async () => {
      try {
        const res = await fetch(`/api/invites/${encodeURIComponent(token)}`);
        const data = await res.json();
        if (res.ok) {
          setInvite(data);
          setFullName(data.full_name || '');
          setState('ready');
        } else {
          setLoadError(data.error || 'This invitation is not valid.');
          setState('invalid');
        }
      } catch {
        setLoadError('Unable to reach the server. Please try again.');
        setState('invalid');
      }
    })();
  }, [token]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!fullName.trim()) { setError('Please enter your full name.'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    if (!agree) { setError('Please accept the terms to continue.'); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/invites/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: fullName.trim(), password }),
      });
      const data = await res.json();
      if (res.ok) {
        setState('done');
        setTimeout(() => navigate('/login', { replace: true }), 2200);
      } else {
        setError(data.error || 'Could not accept the invitation.');
      }
    } catch {
      setError('Unable to reach the server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const roleLabel = invite ? (ROLE_LABELS[invite.role] || invite.role) : '';

  return (
    <div className="login-page">
      <div className="login-brand-panel">
        <div className="login-brand-top">
          <span className="brand-dot">T</span> TooVix <span className="brand-sub">DAM</span>
        </div>
        <div className="login-brand-content">
          <h2>You've been invited<br />to join your team.</h2>
          <p>Set your password and you'll join your organisation's database-activity-monitoring workspace with the role you've been assigned.</p>
          <div className="login-features">
            <div className="login-feat"><span className="feat-icon" style={{ background: 'rgba(74,222,128,.2)', color: '#4ade80' }}>✓</span> MFA required after sign-in</div>
            <div className="login-feat"><span className="feat-icon" style={{ background: 'rgba(99,202,255,.2)', color: '#67e8f9' }}>◎</span> All access is least-privilege</div>
            <div className="login-feat"><span className="feat-icon" style={{ background: 'rgba(251,191,36,.2)', color: '#fbbf24' }}>⛓</span> Your activity is audited for compliance</div>
          </div>
          {invite?.invited_by_name && (
            <div className="login-quote">
              Invited by <b>{invite.invited_by_name}</b>
              <span className="login-quote-who">{invite.tenant_name}</span>
            </div>
          )}
        </div>
      </div>

      <div className="login-form-panel">
        <div className="login-form-box">
          <div className="login-mini-brand"><span className="brand-dot-sm">T</span> TooVix <span className="brand-sub">DAM</span></div>

          {state === 'loading' && (
            <>
              <h1>Checking your invitation…</h1>
              <p className="login-sub">One moment while we verify your invite link.</p>
            </>
          )}

          {state === 'invalid' && (
            <>
              <h1>Invitation unavailable</h1>
              <p className="login-sub">{loadError}</p>
              <div className="login-error">{loadError}</div>
              <button className="login-submit" style={{ marginTop: 8 }} onClick={() => navigate('/login')}>Go to sign in</button>
            </>
          )}

          {state === 'done' && (
            <>
              <h1>You're all set 🎉</h1>
              <p className="login-sub">Your account is active. Redirecting you to sign in…</p>
              <div className="login-info">You can now sign in with your email and the password you just set. MFA setup follows on first sign-in.</div>
            </>
          )}

          {state === 'ready' && invite && (
            <>
              <h1>Join {invite.tenant_name}</h1>
              <p className="login-sub">
                You're joining as <span className="badge engine" style={{ fontWeight: 700 }}>{roleLabel}</span> · <b className="mono">{invite.email}</b>
              </p>

              <form onSubmit={handleSubmit}>
                <div className="form-field">
                  <label>Full name</label>
                  <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Your full name" required />
                </div>
                <div className="form-field">
                  <label>Create password</label>
                  <div className="pw-wrap">
                    <input type={showPw ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" required />
                    <button type="button" className="pw-toggle" onClick={() => setShowPw(!showPw)}>{showPw ? 'Hide' : 'Show'}</button>
                  </div>
                </div>
                <div className="form-field">
                  <label>Confirm password</label>
                  <input type={showPw ? 'text' : 'password'} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Re-enter password" autoComplete="new-password" required />
                </div>

                {error && <div className="login-error">{error}</div>}

                <div className="login-options">
                  <label className="remember-label">
                    <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I agree to the Terms and acknowledge my activity is audited.
                  </label>
                </div>

                <button type="submit" className="login-submit" disabled={submitting}>
                  {submitting ? 'Setting up…' : 'Join & continue'}
                </button>

                <div className="login-info">🔒 After joining you'll set up multi-factor authentication — it's required for everyone.</div>
              </form>

              <p className="login-footer">Invitation expires 7 days after it was sent · all sign-ins are logged for audit</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
