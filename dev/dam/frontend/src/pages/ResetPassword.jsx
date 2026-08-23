import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import BrandMark from '../components/BrandMark';

// Set a new password from a reset-link token. The token is validated on submit (no pre-check,
// so we never leak whether a token is valid). On success the user is sent to sign in — MFA
// still applies, and no session is issued here.
export default function ResetPassword() {
  const navigate = useNavigate();
  const [token] = useState(() => new URLSearchParams(window.location.search).get('token') || '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [state, setState] = useState(token ? 'form' : 'notoken'); // form | done | notoken
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setState('done');
        setTimeout(() => navigate('/login', { replace: true }), 2200);
      } else {
        setError(data.error || 'Could not reset your password.');
      }
    } catch {
      setError('Unable to reach the server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-brand-panel">
        <div className="login-brand-top">
          <BrandMark size={30} white /> SecurEra <span className="brand-sub">DAM</span>
        </div>
        <div className="login-brand-content">
          <h2>Set a new<br />password.</h2>
          <p>Choose a strong password you don't use anywhere else. After this you'll sign in as usual — multi-factor authentication still applies.</p>
        </div>
      </div>

      <div className="login-form-panel">
        <div className="login-form-box">
          <div className="login-mini-brand"><BrandMark size={24} /> SecurEra <span className="brand-sub">DAM</span></div>

          {state === 'notoken' && (
            <>
              <h1>Link not valid</h1>
              <p className="login-sub">This reset link is missing or malformed.</p>
              <div className="login-error">No reset token was provided. Request a new link and try again.</div>
              <button className="login-submit" style={{ marginTop: 8 }} onClick={() => navigate('/forgot-password')}>Request a new link</button>
            </>
          )}

          {state === 'done' && (
            <>
              <h1>Password updated ✅</h1>
              <p className="login-sub">Your password has been reset. Redirecting you to sign in…</p>
              <div className="login-info">Sign in with your new password. If you have MFA enabled, you'll be prompted for your code as usual.</div>
            </>
          )}

          {state === 'form' && (
            <>
              <h1>Choose a new password</h1>
              <p className="login-sub">Enter and confirm your new password below.</p>

              <form onSubmit={handleSubmit}>
                <div className="form-field">
                  <label>New password</label>
                  <div className="pw-wrap">
                    <input type={showPw ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" autoFocus required />
                    <button type="button" className="pw-toggle" onClick={() => setShowPw(!showPw)}>{showPw ? 'Hide' : 'Show'}</button>
                  </div>
                </div>
                <div className="form-field">
                  <label>Confirm new password</label>
                  <input type={showPw ? 'text' : 'password'} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Re-enter password" autoComplete="new-password" required />
                </div>

                {error && <div className="login-error">{error}</div>}

                <button type="submit" className="login-submit" disabled={submitting}>
                  {submitting ? 'Updating…' : 'Reset password'}
                </button>
              </form>

              <p className="login-footer" style={{ textAlign: 'center' }}><Link to="/login">← Back to sign in</Link></p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
