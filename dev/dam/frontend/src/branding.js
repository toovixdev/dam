// White-label branding — SERVER-BACKED and PER-TENANT.
// Source of truth is the API (logo bytes in S3/MinIO, metadata in Postgres). The
// browser keeps a small per-tenant cache (in-memory + localStorage) so the sidebar/header
// paint instantly, then `loadBranding()` refreshes it from the server on login/app-load.
// Keys are namespaced by tenant so one workspace's branding can never bleed into another.

import { apiFetch, apiPut, apiDelete } from './api/client';

const PREFIX = 'nx-brand';
const EVT = 'nx-branding';
const DEFAULT_NAME = 'TooVix DAM';
const DEFAULT_PLACEMENT = 'sidebar'; // 'sidebar' | 'header' | 'both'

function tenantId() {
  try { return JSON.parse(localStorage.getItem('dam_user') || '{}').tenantId || 'anon'; }
  catch { return 'anon'; }
}
function ck(field) { return `${PREFIX}:${tenantId()}:${field}`; }

// One-time purge of legacy GLOBAL (un-namespaced) keys that leaked across tenants.
(function purgeLegacyGlobalBranding() {
  try { ['nx-brand-name', 'nx-brand-logo', 'nx-brand-placement'].forEach((k) => localStorage.removeItem(k)); }
  catch { /* ignore */ }
})();

const mem = {}; // per-tenant in-memory cache: { [tenantId]: branding }

function readCache() {
  const tid = tenantId();
  if (mem[tid]) return mem[tid];
  const name = localStorage.getItem(ck('name')) || '';
  const b = {
    name: name || DEFAULT_NAME,
    custom: !!name,
    logo: localStorage.getItem(ck('logo')) || '',
    placement: localStorage.getItem(ck('placement')) || DEFAULT_PLACEMENT,
  };
  mem[tid] = b;
  return b;
}

function writeCache(b) {
  const tid = tenantId();
  mem[tid] = b;
  if (b.custom && b.name) localStorage.setItem(ck('name'), b.name); else localStorage.removeItem(ck('name'));
  if (b.logo) localStorage.setItem(ck('logo'), b.logo); else localStorage.removeItem(ck('logo'));
  if (b.placement && b.placement !== DEFAULT_PLACEMENT) localStorage.setItem(ck('placement'), b.placement); else localStorage.removeItem(ck('placement'));
}

// Synchronous read (used by components during render) — returns the cached branding.
export function getBranding() { return readCache(); }

// Fetch the tenant's branding from the server and refresh the cache. Call on login/app-load.
export async function loadBranding() {
  try {
    const d = await apiFetch('/branding');
    if (!d) return;
    writeCache({
      name: d.name || DEFAULT_NAME,
      custom: !!d.custom,
      logo: d.logo || '',
      placement: d.placement || DEFAULT_PLACEMENT,
    });
    window.dispatchEvent(new Event(EVT));
  } catch { /* keep the cache on network error */ }
}

// Persist branding server-side (logo = image data URL, '' to clear, or omit to keep).
export async function setBranding({ name, logo, placement }) {
  const cur = readCache();
  const next = { ...cur };
  if (name !== undefined) { next.name = name || DEFAULT_NAME; next.custom = !!name; }
  if (logo !== undefined) next.logo = logo || '';
  if (placement !== undefined) next.placement = placement || DEFAULT_PLACEMENT;
  writeCache(next);
  window.dispatchEvent(new Event(EVT)); // optimistic paint
  const body = {};
  if (name !== undefined) body.name = name || '';
  if (logo !== undefined) body.logo = logo || '';
  if (placement !== undefined) body.placement = placement;
  const res = await apiPut('/branding', body);
  return res && res.ok;
}

export async function resetBranding() {
  writeCache({ name: DEFAULT_NAME, custom: false, logo: '', placement: DEFAULT_PLACEMENT });
  window.dispatchEvent(new Event(EVT));
  const res = await apiDelete('/branding');
  return res && res.ok;
}

export function onBrandingChange(cb) {
  window.addEventListener(EVT, cb);
  return () => window.removeEventListener(EVT, cb);
}

export const DEFAULT_BRAND_NAME = DEFAULT_NAME;
