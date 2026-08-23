import { useState } from 'react';
import { Link } from 'react-router-dom';
import BrandMark from '../components/BrandMark';

// Request a password-reset link. The API always responds generically (it never reveals
// whether an account exists), so on success we show the same "check your email" message.
export default function ForgotPassword() {
  const q = new URLSearchParams(window.location.search);
  const [email, setEmail] = useState(q.get('email') || '');
  const [workspace, setWorkspace] = useState(q.get('workspace') || '');
  const [state, setState] = useState('form'); // form | sent
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!email.trim()) { setError('Please enter your email address.'); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), workspace: workspace.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setState('sent');
      else setError(data.error || 'Could not send the reset link. Please try again.');
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
          <h2>Forgot your<br />password?</h2>
          <p>Enter your email and we'll send a secure link to set a new one. The link expires in 1 hour and can be used once.</p>
          <div className="login-features">
            <div className="login-feat"><span className="feat-icon" style={{ background: 'rgba(74,222,128,.2)', color: '#4ade80' }}>✓</span> Reset links are single-use</div>
            <div className="login-feat"><span className="feat-icon" style={{ background: 'rgba(99,202,255,.2)', color: '#67e8f9' }}>◎</span> Your MFA stays enabled</div>
            <div className="login-feat"><span className="feat-icon" style={{ background: 'rgba(251,191,36,.2)', color: '#fbbf24' }}>⛓</span> Every reset is audited</div>
          </div>
        </div>
      </div>

      <div className="login-form-panel">
        <div className="login-form-box">
          <div className="login-mini-brand"><BrandMark size={24} /> SecurEra <span className="brand-sub">DAM</span></div>

          {state === 'sent' ? (
            <>
              <h1>Check your email 📬</h1>
              <p className="login-sub">If an account exists for <b>{email}</b>, we've sent a link to reset your password. It expires in 1 hour.</p>
              <div className="login-info">Didn't get it? Check your spam folder, or confirm you used the right email and workspace.</div>
              <p className="login-footer" style={{ textAlign: 'center' }}><Link to="/login">← Back to sign in</Link></p>
            </>
          ) : (
            <>
              <h1>Reset your password</h1>
              <p className="login-sub">We'll email you a secure link to set a new password.</p>

              <form onSubmit={handleSubmit}>
                <div className="form-field">
                  <label>Email</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" autoFocus required />
                </div>
                <div className="form-field">
                  <label>Workspace <span className="muted">(optional)</span></label>
                  <input type="text" value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="your workspace ID (if you have more than one)" autoComplete="off" />
                </div>

                {error && <div className="login-error">{error}</div>}

                <button type="submit" className="login-submit" disabled={submitting}>
                  {submitting ? 'Sending…' : 'Send reset link'}
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
