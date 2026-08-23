import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { adminResetPassword } from '../api/client';

// Set a new super-admin password from a reset-link token. Validated on submit (no pre-check);
// on success the operator is sent back to sign in. No session is issued here.
export default function ResetPassword() {
  const navigate = useNavigate();
  const [token] = useState(() => new URLSearchParams(window.location.search).get('token') || '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setLoading(true); setError('');
    const res = await adminResetPassword(token, password);
    setLoading(false);
    if (res.ok) { setDone(true); setTimeout(() => navigate('/login', { replace: true }), 2200); }
    else setError(res.error || 'Could not reset your password.');
  }

  const wrap = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg, #0b1220)', fontFamily: 'Inter, system-ui, sans-serif' };
  const card = { width: 380, maxWidth: '90vw', background: 'var(--surface, #111a2e)', border: '1px solid var(--line, #1e2a44)', borderRadius: 16, padding: 32, color: 'var(--ink, #e8eefb)' };
  const field = { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--line, #1e2a44)', background: 'var(--surface-2, #0e1626)', color: 'inherit', fontSize: 14, marginTop: 6 };
  const linkStyle = { color: 'var(--muted, #94a3b8)', fontSize: 13, textDecoration: 'none' };
  const errBox = { marginTop: 14, padding: '9px 12px', borderRadius: 8, background: 'rgba(225,29,72,.12)', color: '#fda4af', fontSize: 13 };

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 4 }}>SecurEra <span style={{ color: 'var(--muted, #94a3b8)', fontWeight: 500 }}>DAM Admin</span></div>

        {!token ? (
          <>
            <h1 style={{ fontSize: 20, margin: '10px 0 4px' }}>Link not valid</h1>
            <p style={{ fontSize: 13, color: 'var(--muted, #94a3b8)', margin: '0 0 16px' }}>No reset token was provided. Request a new link and try again.</p>
            <Link to="/forgot-password" style={linkStyle}>Request a new link</Link>
          </>
        ) : done ? (
          <>
            <h1 style={{ fontSize: 20, margin: '10px 0 4px' }}>Password updated ✅</h1>
            <p style={{ fontSize: 13, color: 'var(--muted, #94a3b8)', margin: '0 0 8px' }}>Your password has been reset. Redirecting you to sign in…</p>
          </>
        ) : (
          <>
            <h1 style={{ fontSize: 20, margin: '10px 0 4px' }}>Choose a new password</h1>
            <p style={{ fontSize: 13, color: 'var(--muted, #94a3b8)', margin: '0 0 20px' }}>Enter and confirm your new super-admin password.</p>
            <form onSubmit={handleSubmit}>
              <label style={{ fontSize: 13, fontWeight: 600 }}>New password
                <div style={{ position: 'relative' }}>
                  <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" autoFocus style={field} />
                  <button type="button" onClick={() => setShowPw(!showPw)} style={{ position: 'absolute', right: 8, top: 12, background: 'none', border: 'none', color: 'var(--muted, #94a3b8)', fontSize: 12, cursor: 'pointer' }}>{showPw ? 'Hide' : 'Show'}</button>
                </div>
              </label>
              <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginTop: 14 }}>Confirm new password
                <input type={showPw ? 'text' : 'password'} value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Re-enter password" autoComplete="new-password" style={field} />
              </label>
              {error && <div style={errBox}>{error}</div>}
              <button type="submit" disabled={loading} style={{ width: '100%', marginTop: 20, padding: '11px', borderRadius: 8, border: 'none', background: 'var(--primary, #6366f1)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', opacity: loading ? 0.6 : 1 }}>
                {loading ? 'Updating…' : 'Reset password'}
              </button>
            </form>
            <p style={{ marginTop: 18, textAlign: 'center' }}><Link to="/login" style={linkStyle}>← Back to sign in</Link></p>
          </>
        )}
      </div>
    </div>
  );
}
