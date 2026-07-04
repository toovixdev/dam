import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminLogin } from '../api/client';

// Platform super-admin sign-in for the DAM Admin console.
export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!email || !password) { setError('Enter your email and password.'); return; }
    setLoading(true); setError('');
    const res = await adminLogin(email.trim(), password);
    setLoading(false);
    if (res.ok) navigate('/', { replace: true });
    else setError(res.error || 'Login failed.');
  }

  const wrap = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg, #0b1220)', fontFamily: 'Inter, system-ui, sans-serif' };
  const card = { width: 380, maxWidth: '90vw', background: 'var(--surface, #111a2e)', border: '1px solid var(--line, #1e2a44)', borderRadius: 16, padding: 32, color: 'var(--ink, #e8eefb)' };
  const field = { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--line, #1e2a44)', background: 'var(--surface-2, #0e1626)', color: 'inherit', fontSize: 14, marginTop: 6 };

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 4 }}>TooVix <span style={{ color: 'var(--muted, #94a3b8)', fontWeight: 500 }}>DAM Admin</span></div>
        <h1 style={{ fontSize: 20, margin: '10px 0 4px' }}>Super-Admin sign-in</h1>
        <p style={{ fontSize: 13, color: 'var(--muted, #94a3b8)', margin: '0 0 20px' }}>Platform operations console. Restricted to platform administrators.</p>
        <form onSubmit={handleSubmit}>
          <label style={{ fontSize: 13, fontWeight: 600 }}>Email
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="superadmin@toovix.com" autoComplete="username" style={field} />
          </label>
          <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginTop: 14 }}>Password
            <div style={{ position: 'relative' }}>
              <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" autoComplete="current-password" style={field} />
              <button type="button" onClick={() => setShowPw(!showPw)} style={{ position: 'absolute', right: 8, top: 12, background: 'none', border: 'none', color: 'var(--muted, #94a3b8)', fontSize: 12, cursor: 'pointer' }}>{showPw ? 'Hide' : 'Show'}</button>
            </div>
          </label>
          {error && <div style={{ marginTop: 14, padding: '9px 12px', borderRadius: 8, background: 'rgba(225,29,72,.12)', color: '#fda4af', fontSize: 13 }}>{error}</div>}
          <button type="submit" disabled={loading} style={{ width: '100%', marginTop: 20, padding: '11px', borderRadius: 8, border: 'none', background: 'var(--primary, #6366f1)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', opacity: loading ? 0.6 : 1 }}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p style={{ fontSize: 11, color: 'var(--subtle, #64748b)', marginTop: 18, textAlign: 'center' }}>All platform actions are logged for audit.</p>
      </div>
    </div>
  );
}
