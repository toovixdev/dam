import { useState } from 'react';
import { Link } from 'react-router-dom';
import { adminForgotPassword } from '../api/client';

// Request a super-admin password-reset link. The API responds generically (no operator
// enumeration), so on success we always show the same "check your email" message.
export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!email.trim()) { setError('Enter your email or username.'); return; }
    setLoading(true); setError('');
    const res = await adminForgotPassword(email.trim());
    setLoading(false);
    if (res.ok) setSent(true);
    else setError(res.error || 'Could not send the reset link.');
  }

  const wrap = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg, #0b1220)', fontFamily: 'Inter, system-ui, sans-serif' };
  const card = { width: 380, maxWidth: '90vw', background: 'var(--surface, #111a2e)', border: '1px solid var(--line, #1e2a44)', borderRadius: 16, padding: 32, color: 'var(--ink, #e8eefb)' };
  const field = { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--line, #1e2a44)', background: 'var(--surface-2, #0e1626)', color: 'inherit', fontSize: 14, marginTop: 6 };
  const linkStyle = { color: 'var(--muted, #94a3b8)', fontSize: 13, textDecoration: 'none' };

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 4 }}>SecurEra <span style={{ color: 'var(--muted, #94a3b8)', fontWeight: 500 }}>DAM Admin</span></div>

        {sent ? (
          <>
            <h1 style={{ fontSize: 20, margin: '10px 0 4px' }}>Check your email 📬</h1>
            <p style={{ fontSize: 13, color: 'var(--muted, #94a3b8)', margin: '0 0 20px' }}>If an admin account exists for that identifier, a reset link is on its way. It expires in 1 hour.</p>
            <p style={{ fontSize: 12, color: 'var(--subtle, #64748b)', margin: '0 0 16px' }}>Root accounts without an email address have the link written to the server log instead.</p>
            <Link to="/login" style={linkStyle}>← Back to sign in</Link>
          </>
        ) : (
          <>
            <h1 style={{ fontSize: 20, margin: '10px 0 4px' }}>Reset your password</h1>
            <p style={{ fontSize: 13, color: 'var(--muted, #94a3b8)', margin: '0 0 20px' }}>We'll email a secure link to the address on file for your operator account.</p>
            <form onSubmit={handleSubmit}>
              <label style={{ fontSize: 13, fontWeight: 600 }}>Email or username
                <input type="text" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com or superadmin" autoComplete="username" autoFocus style={field} />
              </label>
              {error && <div style={{ marginTop: 14, padding: '9px 12px', borderRadius: 8, background: 'rgba(225,29,72,.12)', color: '#fda4af', fontSize: 13 }}>{error}</div>}
              <button type="submit" disabled={loading} style={{ width: '100%', marginTop: 20, padding: '11px', borderRadius: 8, border: 'none', background: 'var(--primary, #6366f1)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', opacity: loading ? 0.6 : 1 }}>
                {loading ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
            <p style={{ marginTop: 18, textAlign: 'center' }}><Link to="/login" style={linkStyle}>← Back to sign in</Link></p>
          </>
        )}
      </div>
    </div>
  );
}
