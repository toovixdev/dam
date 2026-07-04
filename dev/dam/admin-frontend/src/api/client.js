// Admin console API client. The Super-Admin endpoints are read-only platform
// aggregations served unauthenticated in this prototype (same as the main app's
// /api/dashboard/* reads). A dedicated admin login can be layered on later by
// reintroducing the Bearer token + 401 handling the product app uses.
const API_BASE = '/api';

function jsonHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', ...extra };
}

async function apiFetch(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: jsonHeaders() });
  if (!res.ok) throw new Error(`API ${res.status} on ${path}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { data, ok: res.ok, status: res.status };
}

async function apiPut(path, body) {
  const res = await fetch(`${API_BASE}${path}`, { method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { data, ok: res.ok, status: res.status };
}

async function apiDelete(path) {
  const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE', headers: jsonHeaders() });
  const data = await res.json().catch(() => ({}));
  return { data, ok: res.ok, status: res.status };
}

export { apiFetch, apiPost, apiPut, apiDelete };
