import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import useTimezone, { TIMEZONES, tzShortName, formatInTz } from '../hooks/useTimezone';
import { getBranding, onBrandingChange } from '../branding';

const THEMES = [
  { id: 'light',    ic: '☀',  name: 'Light',    desc: 'Indigo on white' },
  { id: 'dark',     ic: '🌙', name: 'Dark',     desc: 'Indigo on slate' },
  { id: 'system',   ic: '🖥', name: 'System',   desc: 'Follow OS preference' },
  { id: 'midnight', ic: '🌑', name: 'Midnight', desc: 'Pure black, violet glow' },
  { id: 'ocean',    ic: '🌊', name: 'Ocean',    desc: 'Cool blue, professional' },
  { id: 'forest',   ic: '🌲', name: 'Forest',   desc: 'Sage + emerald, calm' },
  { id: 'saffron',  ic: '🪔', name: 'Saffron',  desc: 'Warm tones' },
  { id: 'sunset',   ic: '🌇', name: 'Sunset',   desc: 'Cream + coral, cozy' },
  { id: 'mono',     ic: '◐', name: 'Mono',     desc: 'Grayscale, minimalist' },
  { id: 'signature', ic: '◆', name: 'Signature', desc: 'Signature red + gold' },
  { id: 'enterprise', ic: '🔷', name: 'Enterprise Blue', desc: 'Crisp enterprise blue' },
];

function applyTheme(themeId) {
  let eff = themeId;
  if (themeId === 'system') {
    eff = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', eff);
}

export default function TopBar({ lastRefresh, onRefresh }) {
  const { user: authUser, logout } = useAuth();
  const name = authUser?.fullName || 'User';
  const initials = name.split(' ').map(p => p[0]).join('').substring(0, 2).toUpperCase();
  const role = (authUser?.role || '').replace(/_/g, ' ');
  const tenant = authUser?.tenantName || 'TooVix DAM';

  const [menuOpen, setMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [tzOpen, setTzOpen] = useState(false);
  const [currentTheme, setCurrentTheme] = useState(localStorage.getItem('nx-theme') || 'light');
  const [brand, setBrand] = useState(getBranding());
  useEffect(() => onBrandingChange(() => setBrand(getBranding())), []);

  const [tz, changeTz] = useTimezone();
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    applyTheme(currentTheme);
  }, [currentTheme]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const tzTime = formatInTz(tz, now);
  const tzAbbr = tzShortName(tz, now);

  function closeAll() { setMenuOpen(false); setNotifOpen(false); setThemeOpen(false); setTzOpen(false); }

  function handleThemeChange(id) {
    setCurrentTheme(id);
    localStorage.setItem('nx-theme', id);
    applyTheme(id);
    setThemeOpen(false);
  }

  function handleSignOut() {
    // Only SSO users need their IdP session cleared; local users just go to /login.
    const sso = authUser?.authProvider === 'azure_ad';
    logout();
    window.location.href = sso ? '/auth/logout?sso=azure' : '/login';
  }

  const currentThemeObj = THEMES.find(t => t.id === currentTheme) || THEMES[0];

  return (
    <header className="topbar">
      {brand.logo && (brand.placement === 'header' || brand.placement === 'both') && (
        <div className="topbar-brand" title={brand.name}>
          <img src={brand.logo} alt={brand.name} className="topbar-logo" />
        </div>
      )}

      <div className="topbar-search">
        <span className="search-icon">🔎</span>
        <input type="text" placeholder="Search databases, alerts, principals, queries..." />
        <span className="search-kbd">⌘K</span>
      </div>

      <div className="topbar-spacer" />

      <button className="topbar-btn ai-btn">✦ Ask TooVix AI</button>

      {lastRefresh && (
        <div className="topbar-refresh">
          <span className="refresh-time">{lastRefresh.toLocaleTimeString()}</span>
          <button className="topbar-btn" onClick={onRefresh} title="Refresh">⟳</button>
        </div>
      )}

      <div className="topbar-tz-wrap">
        <button className="topbar-btn tz-btn" onClick={() => { setTzOpen(!tzOpen); setNotifOpen(false); setMenuOpen(false); setThemeOpen(false); }} title={`Timezone · ${tz}`}>
          🌐 <span className="tz-clock">{tzTime}</span> <span className="tz-abbr">{tzAbbr}</span>
        </button>
        {tzOpen && (
          <div className="tz-popup">
            <div className="tz-popup-header"><b>Timezone</b><span>{tzAbbr} · {tzTime}</span></div>
            <div className="tz-list">
              {TIMEZONES.map(t => (
                <button
                  key={t.id}
                  className={`tz-item ${t.id === tz ? 'active' : ''}`}
                  onClick={() => { changeTz(t.id); setTzOpen(false); }}
                >
                  <span className="tz-item-label">{t.label}</span>
                  <span className="tz-item-meta">{t.id} · {formatInTz(t.id, now)}</span>
                  {t.id === tz && <span className="tz-check">✓</span>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="topbar-theme-wrap">
        <button className="topbar-btn" onClick={() => { setThemeOpen(!themeOpen); setNotifOpen(false); setMenuOpen(false); setTzOpen(false); }} title="Theme">
          🎨
        </button>
        {themeOpen && (
          <div className="theme-popup">
            <div className="theme-popup-header"><b>Theme</b><span>{THEMES.length} to choose from</span></div>
            <div className="theme-grid">
              {THEMES.map(t => (
                <button
                  key={t.id}
                  className={`theme-card ${t.id === currentTheme ? 'active' : ''}`}
                  onClick={() => handleThemeChange(t.id)}
                >
                  <span className={`theme-preview tp-${t.id}`}>
                    <span className="b1" />
                    <span className="b2" />
                    <span className="cta">CTA</span>
                  </span>
                  <span className="theme-card-name">{t.ic} {t.name}</span>
                  <span className="theme-card-desc">{t.desc}</span>
                  <span className="theme-card-check">✓</span>
                </button>
              ))}
            </div>
            <div className="theme-footer">Theme affects every screen. Semantic colours (critical / high / medium / info) stay consistent for accessibility.</div>
          </div>
        )}
      </div>

      <div className="topbar-notif-wrap">
        <button className="topbar-btn" onClick={() => { setNotifOpen(!notifOpen); setMenuOpen(false); setThemeOpen(false); setTzOpen(false); }} title="Notifications">
          🔔<span className="notif-dot" />
        </button>
        {notifOpen && (
          <div className="notif-popup">
            <div className="notif-header"><b>Notifications</b><button className="notif-clear" onClick={() => setNotifOpen(false)}>Mark all read</button></div>
            <div className="notif-list">
              <div className="notif-item unread"><span className="notif-icon" style={{background:'#fef2f2',color:'#dc2626'}}>⚠</span><div><b>Critical: mass PII read on PG-CRM-PROD</b><small>svc_analytics · 2 min ago</small></div></div>
              <div className="notif-item unread"><span className="notif-icon" style={{background:'#fffbeb',color:'#f59e0b'}}>◷</span><div><b>Off-hours DBA access detected</b><small>bi_reader · 6 min ago</small></div></div>
              <div className="notif-item"><span className="notif-icon" style={{background:'#f0fdf4',color:'#22c55e'}}>⚖</span><div><b>Compliance report generated</b><small>PCI-DSS Q2 · 1h ago</small></div></div>
            </div>
          </div>
        )}
      </div>

      <div className="topbar-user-wrap">
        <button className="topbar-avatar" onClick={() => { setMenuOpen(!menuOpen); setNotifOpen(false); setThemeOpen(false); setTzOpen(false); }}>{initials}</button>
        {menuOpen && (
          <div className="user-popup">
            <div className="user-popup-header">
              <span className="user-popup-avatar">{initials}</span>
              <div className="user-popup-info">
                <b>{name}</b>
                <small className="user-popup-role">{role}</small>
                <small className="user-popup-tenant">{tenant}</small>
              </div>
            </div>
            <Link className="user-popup-item" to="/profile" onClick={() => setMenuOpen(false)}><span>◑</span> My profile</Link>
            <Link className="user-popup-item" to="/settings" onClick={() => setMenuOpen(false)}><span>⚙</span> Settings</Link>
            <button className="user-popup-item signout" onClick={handleSignOut}><span>⎋</span> Sign out</button>
          </div>
        )}
      </div>
    </header>
  );
}
