const API_BASE = '/api';

function getToken() {
  return localStorage.getItem('dam_token') || '';
}

function getUser() {
  try {
    return JSON.parse(localStorage.getItem('dam_user') || 'null');
  } catch {
    return null;
  }
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json', ...extra };
}

function handle401() {
  localStorage.removeItem('dam_token');
  localStorage.removeItem('dam_user');
  // Full reload to /login so AuthContext re-initialises with no token (an SPA
  // navigate leaves stale in-memory auth state, which bounces back to the dashboard).
  if (window.location.pathname !== '/login') window.location.assign('/login?expired=1');
}

async function apiFetch(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
  if (res.status === 401) { handle401(); return null; }
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
  if (res.status === 401) { handle401(); return null; }
  const data = await res.json();
  return { data, ok: res.ok, status: res.status };
}

async function apiPut(path, body) {
  const res = await fetch(`${API_BASE}${path}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(body) });
  if (res.status === 401) { handle401(); return null; }
  const data = await res.json();
  return { data, ok: res.ok, status: res.status };
}

async function apiDelete(path) {
  const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE', headers: authHeaders() });
  if (res.status === 401) { handle401(); return null; }
  const data = await res.json();
  return { data, ok: res.ok, status: res.status };
}

export { apiFetch, apiPost, apiPut, apiDelete, getToken, getUser };
