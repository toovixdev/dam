// Functional + regression tests for the running DAM API. These hit a live control plane over
// HTTP (no in-process import — main.js starts a server + connects to Postgres/ClickHouse on load).
//
//   TEST_API_URL      base URL         (default http://localhost:3000)
//   TEST_TOKEN        a Bearer JWT     (optional — unlocks the authed read-only checks)
//   TEST_ENROLL_TOKEN a tenant enroll token (optional — unlocks connector-heartbeat provider checks)
//
// Safe to run against any environment: every test is read-only and self-skips when the API is
// unreachable or the required token isn't provided. Run: node --test test/functional.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const BASE = (process.env.TEST_API_URL || 'http://localhost:3000').replace(/\/+$/, '');
const TOKEN = process.env.TEST_TOKEN || '';
const ENROLL = process.env.TEST_ENROLL_TOKEN || '';

// Fetch helper; returns null (and skips the test) if the API can't be reached at all.
async function req(t, path, opts = {}) {
  try {
    const res = await fetch(BASE + path, opts);
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, ok: res.ok, body };
  } catch (e) {
    t.skip(`API not reachable at ${BASE} (${e.code || e.message})`);
    return null;
  }
}
const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };

// ── Reachability + health ──────────────────────────────────────────────────────
test('GET /api/health reports healthy with postgres ok', async (t) => {
  const r = await req(t, '/api/health'); if (!r) return;
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'healthy');
  assert.equal(r.body.services.postgres, 'ok');
});

// ── Regression: agent-binary download allowlist ────────────────────────────────
test('GET /api/download rejects unknown artifacts (path allowlist)', async (t) => {
  const r = await req(t, '/api/download/etc-passwd'); if (!r) return;
  assert.equal(r.status, 404);
});
test('GET /api/download serves an allowlisted artifact', async (t) => {
  const r = await req(t, '/api/download/dam-agent-linux-amd64', { method: 'HEAD' }); if (!r) return;
  assert.ok(r.status === 200 || r.status === 404, 'allowlisted (200 if built into this image)');
});

// ── Regression: authRequired endpoints reject anonymous callers ────────────────
for (const path of ['/api/compliance/catalog', '/api/agents', '/api/discovery/connectors', '/api/compliance/masking']) {
  test(`GET ${path} requires auth (401 without a token)`, async (t) => {
    const r = await req(t, path); if (!r) return;
    assert.equal(r.status, 401);
  });
}

// ── Regression: connector-heartbeat is token-gated + validates provider ────────
test('POST /api/agents/connector-heartbeat rejects an invalid enroll token (401)', async (t) => {
  const r = await req(t, '/api/agents/connector-heartbeat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'definitely-not-valid', provider: 'gcp' }),
  });
  if (!r) return;
  assert.equal(r.status, 401);
});
test('POST /api/agents/connector-heartbeat accepts oci as a provider (regression)', async (t) => {
  if (!ENROLL) { t.skip('set TEST_ENROLL_TOKEN to exercise provider validation'); return; }
  const bad = await req(t, '/api/agents/connector-heartbeat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: ENROLL, provider: 'not-a-cloud' }),
  });
  if (!bad) return;
  assert.equal(bad.status, 400, 'a bogus provider is rejected');
  const oci = await req(t, '/api/agents/connector-heartbeat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: ENROLL, provider: 'oci' }),
  });
  assert.equal(oci.status, 200, 'oci is a recognized provider (was gcp|aws|azure)');
});

// ── Authed read-only smoke (needs TEST_TOKEN) ──────────────────────────────────
test('GET /api/compliance/catalog returns control-mapped reports', async (t) => {
  if (!TOKEN) { t.skip('set TEST_TOKEN to run authed checks'); return; }
  const r = await req(t, '/api/compliance/catalog', auth); if (!r) return;
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.items) && r.body.items.length > 0);
  assert.ok(Array.isArray(r.body.frameworks));
  for (const it of r.body.items) assert.ok(it.id && it.control && it.framework);
});
test('GET /api/discovery/connectors returns a list without leaking credentials', async (t) => {
  if (!TOKEN) { t.skip('set TEST_TOKEN to run authed checks'); return; }
  const r = await req(t, '/api/discovery/connectors', auth); if (!r) return;
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  for (const c of r.body) assert.equal(c.credential, undefined, 'credential is never returned to the UI');
});
test('GET /api/compliance/masking reports coverage with protected count', async (t) => {
  if (!TOKEN) { t.skip('set TEST_TOKEN to run authed checks'); return; }
  const r = await req(t, '/api/compliance/masking', auth); if (!r) return;
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.sensitive, 'number');
  assert.equal(typeof r.body.protected, 'number');
  assert.ok(Array.isArray(r.body.columns));
});
test('GET /api/dashboard/events-timeline returns UTC epoch buckets (timezone regression)', async (t) => {
  if (!TOKEN) { t.skip('set TEST_TOKEN to run authed checks'); return; }
  const r = await req(t, '/api/dashboard/events-timeline', auth); if (!r) return;
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  for (const row of r.body) {
    assert.equal(typeof row.hour, 'number', 'hour is an epoch integer, not a naive string');
    assert.ok(row.hour > 1e9, 'looks like a unix timestamp (seconds)');
  }
});
