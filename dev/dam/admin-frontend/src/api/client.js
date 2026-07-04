// Admin console API client. Every /api/admin/* call carries the platform super-admin
// Bearer token; a 401 clears it and bounces to the login page.
const API_BASE = '/api';
const TOKEN_KEY = 'dam_admin_token';
const OP_KEY = 'dam_admin_operator';

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function getOperator() { try { return JSON.parse(localStorage.getItem(OP_KEY) || 'null'); } catch { return null; } }
function setSession(token, operator) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(OP_KEY, JSON.stringify(operator || null));
}
function clearSession() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(OP_KEY); }

function jsonHeaders(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  const t = getToken();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

function handleUnauthorized(status) {
  if (status === 401) { clearSession(); if (!location.pathname.startsWith('/login')) location.href = '/login'; }
}

async function apiFetch(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: jsonHeaders() });
  if (!res.ok) { handleUnauthorized(res.status); throw new Error(`API ${res.status} on ${path}`); }
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  handleUnauthorized(res.status);
  return { data, ok: res.ok, status: res.status };
}

async function apiPut(path, body) {
  const res = await fetch(`${API_BASE}${path}`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  handleUnauthorized(res.status);
  return { data, ok: res.ok, status: res.status };
}

async function apiDelete(path) {
  const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE', headers: jsonHeaders() });
  const data = await res.json().catch(() => ({}));
  handleUnauthorized(res.status);
  return { data, ok: res.ok, status: res.status };
}

// Platform admin login → stores the token; returns { ok, error }.
async function adminLogin(email, password) {
  const res = await fetch(`${API_BASE}/admin/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.token) { setSession(data.token, data.operator); return { ok: true }; }
  return { ok: false, error: data.error || 'Login failed' };
}
function adminLogout() { clearSession(); location.href = '/login'; }

export { apiFetch, apiPost, apiPut, apiDelete, adminLogin, adminLogout, getToken, getOperator };
