import { useState, useEffect } from 'react';
import { getBranding, onBrandingChange } from '../branding';

// All 11 themes from the main product app — including `signature` and
// `enterprise`, the two that were added beyond the original mockups.
const THEMES = [
  { id: 'light',     ic: '☀',  name: 'Light',           desc: 'Indigo on white' },
  { id: 'dark',      ic: '🌙', name: 'Dark',            desc: 'Indigo on slate' },
  { id: 'system',    ic: '🖥', name: 'System',          desc: 'Follow OS preference' },
  { id: 'midnight',  ic: '🌑', name: 'Midnight',        desc: 'Pure black, violet glow' },
  { id: 'ocean',     ic: '🌊', name: 'Ocean',           desc: 'Cool blue, professional' },
  { id: 'forest',    ic: '🌲', name: 'Forest',          desc: 'Sage + emerald, calm' },
  { id: 'saffron',   ic: '🪔', name: 'Saffron',         desc: 'Warm tones' },
  { id: 'sunset',    ic: '🌇', name: 'Sunset',          desc: 'Cream + coral, cozy' },
  { id: 'mono',      ic: '◐',  name: 'Mono',            desc: 'Grayscale, minimalist' },
  { id: 'signature', ic: '◆',  name: 'Signature',       desc: 'Signature red + gold' },
  { id: 'enterprise',ic: '🔷', name: 'Enterprise Blue', desc: 'Crisp enterprise blue' },
];

function applyTheme(themeId) {
  let eff = themeId;
  if (themeId === 'system') {
    eff = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', eff);
}

export default function TopBar({ lastRefresh, onRefresh }) {
  const [themeOpen, setThemeOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [currentTheme, setCurrentTheme] = useState(localStorage.getItem('nx-theme') || 'dark');
  const [brand, setBrand] = useState(getBranding());
  useEffect(() => onBrandingChange(() => setBrand(getBranding())), []);
  useEffect(() => { applyTheme(currentTheme); }, [currentTheme]);

  function handleThemeChange(id) {
    setCurrentTheme(id);
    localStorage.setItem('nx-theme', id);
    applyTheme(id);
    setThemeOpen(false);
  }

  return (
    <header className="topbar">
      <div className="topbar-search">
        <span className="search-icon">🔎</span>
        <input type="text" placeholder="Search tenants, agents, config..." />
        <span className="search-kbd">⌘K</span>
      </div>

      <div className="topbar-spacer" />

      <span style={{ fontSize: 12, fontWeight: 700, background: 'var(--danger-soft)', color: 'var(--danger)', padding: '3px 10px', borderRadius: 6 }}>
        SUPER ADMIN
      </span>

      {lastRefresh && (
        <div className="topbar-refresh">
          <span className="refresh-time">{lastRefresh.toLocaleTimeString()}</span>
          <button className="topbar-btn" onClick={onRefresh} title="Refresh">⟳</button>
        </div>
      )}

      <div className="topbar-theme-wrap">
        <button className="topbar-btn" onClick={() => { setThemeOpen(!themeOpen); setMenuOpen(false); }} title="Theme">🎨</button>
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

      <div className="topbar-user-wrap">
        <button className="topbar-avatar" onClick={() => { setMenuOpen(!menuOpen); setThemeOpen(false); }}>PO</button>
        {menuOpen && (
          <div className="user-popup">
            <div className="user-popup-header">
              <span className="user-popup-avatar">PO</span>
              <div className="user-popup-info">
                <b>Platform Ops</b>
                <small className="user-popup-role">TooVix Platform Operations</small>
                <small className="user-popup-tenant">Super Admin</small>
              </div>
            </div>
            <a className="user-popup-item" href="http://localhost:5173/" target="_blank" rel="noreferrer"><span>▷</span> Open product app</a>
            <button className="user-popup-item signout" onClick={() => setMenuOpen(false)}><span>⎋</span> Sign out</button>
          </div>
        )}
      </div>
    </header>
  );
}
