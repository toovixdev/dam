import { getUser } from '../api/client';

export default function Header({ lastRefresh, onRefresh }) {
  const user = getUser();
  const name = user?.fullName || 'User';
  const initials = name.split(' ').map(p => p[0]).join('').substring(0, 2).toUpperCase();
  const tenant = user?.tenantName || 'TooVix DAM';

  function handleSignOut() {
    // Only SSO users need their IdP session cleared; local users just go to /login.
    const sso = user?.authProvider === 'azure_ad';
    localStorage.removeItem('dam_token');
    localStorage.removeItem('dam_user');
    localStorage.removeItem('nx-role');
    window.location.href = sso ? '/auth/logout?sso=azure' : '/login';
  }

  function handleBack() {
    window.location.href = 'http://localhost:8091/dashboard.html';
  }

  return (
    <header className="app-header">
      <div className="header-left">
        <div className="brand">
          <span className="brand-dot">T</span>
          <span className="brand-text">TooVix <span className="brand-sub">DAM</span></span>
        </div>
      </div>
      <div className="header-center">
        <h1>Security Dashboard</h1>
        <div className="header-meta">
          <span>🏢 {tenant}</span>
          {lastRefresh && (
            <span className="refresh-info">
              Last updated: {lastRefresh.toLocaleTimeString()}
              <button className="refresh-btn" onClick={onRefresh} title="Refresh now">⟳</button>
            </span>
          )}
        </div>
      </div>
      <div className="header-right">
        <div className="user-menu">
          <span className="user-avatar">{initials}</span>
          <div className="user-info">
            <b>{name}</b>
            <small>{user?.role?.replace('_', ' ')}</small>
          </div>
          <button className="sign-out-btn" onClick={handleSignOut} title="Sign out">⎋</button>
        </div>
      </div>
    </header>
  );
}
