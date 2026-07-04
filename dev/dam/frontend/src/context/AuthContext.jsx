import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { getUser as readUser, getToken } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);

  const checkAuth = useCallback(() => {
    const token = getToken();
    const u = readUser();
    if (!token || !u) { setAuthenticated(false); setUser(null); setLoading(false); return false; }
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.exp * 1000 < Date.now()) { logout(); setLoading(false); return false; }
    } catch { logout(); setLoading(false); return false; }
    setUser(u);
    setAuthenticated(true);
    setLoading(false);
    return true;
  }, []);

  useEffect(() => { checkAuth(); }, [checkAuth]);

  function login(token, userData) {
    localStorage.setItem('dam_token', token);
    localStorage.setItem('dam_user', JSON.stringify(userData));
    setUser(userData);
    setAuthenticated(true);
  }

  function logout() {
    localStorage.removeItem('dam_token');
    localStorage.removeItem('dam_user');
    localStorage.removeItem('nx-role');
    setUser(null);
    setAuthenticated(false);
  }

  return (
    <AuthContext.Provider value={{ user, authenticated, loading, login, logout, checkAuth }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
