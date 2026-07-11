import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';

export default function VerifyEmail() {
  const navigate = useNavigate();
  const [state, setState] = useState('verifying'); // verifying | ok | error
  const [error, setError] = useState('');

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) { setState('error'); setError('No verification token in the link.'); return; }
    (async () => {
      try {
        const res = await fetch('/api/auth/verify-email', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const data = await res.json();
        if (res.ok && data.verified) {
          if (data.slug) localStorage.setItem('dam_workspace', data.slug); // remember workspace for next sign-in
          if (data.email) localStorage.setItem('dam_remember_email', data.email); // prefill on the login page
          setState('ok');
          // No auto-login: sign in next so the MFA-setup gate runs before any session.
          setTimeout(() => navigate('/login', { replace: true }), 1600);
        } else {
          setState('error'); setError(data.error || 'Verification failed.');
        }
      } catch {
        setState('error'); setError('Unable to reach the server.');
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="login-page">
      <div className="login-brand-panel">
        <div className="login-brand-top"><span className="brand-dot">T</span> TooVix <span className="brand-sub">DAM</span></div>
        <div className="login-brand-content">
          <h2>Email verification</h2>
          <p>Confirming you own this address activates your workspace and keeps every sign-in accountable.</p>
        </div>
      </div>
      <div className="login-form-panel">
        <div className="login-form-box" style={{ textAlign: 'center' }}>
          <div className="login-mini-brand" style={{ justifyContent: 'center' }}><span className="brand-dot-sm">T</span> TooVix <span className="brand-sub">DAM</span></div>
          {state === 'verifying' && <><h1>Verifying…</h1><p className="login-sub">Activating your workspace.</p></>}
          {state === 'ok' && <><h1>✓ Verified</h1><p className="login-sub">Your workspace is active — sign in to set up multi-factor authentication and finish…</p></>}
          {state === 'error' && (
            <>
              <h1>Couldn't verify</h1>
              <div className="login-error" style={{ marginTop: 12 }}>{error}</div>
              <p className="login-footer" style={{ textAlign: 'center', marginTop: 18 }}><Link to="/signup">Sign up again</Link> · <Link to="/login">Sign in</Link></p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
