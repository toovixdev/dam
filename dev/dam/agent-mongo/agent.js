'use strict';
// TooVix DAM — MongoDB capture agent.
//
// MongoDB Community (standalone) has no native audit log, so we capture activity via the
// built-in database profiler: enable profiling (level 2 = all ops) on the target DB, then
// tail `system.profile` and forward each operation to the platform as a DAM event —
// mirroring what the MySQL agent does. Agentless "audit pull" style: observe, don't block.

const os = require('os');
const { MongoClient } = require('mongodb');

const env = (k, d) => process.env[k] || d;
const CONTROL_PLANE = env('CONTROL_PLANE', 'http://dam-api:3000').replace(/\/$/, '');
const CLICKHOUSE_URL = env('CLICKHOUSE_URL', 'http://dam-clickhouse:8123').replace(/\/$/, '');
const CH_USER = env('CLICKHOUSE_USER', 'dam_writer');
const CH_PASS = env('CLICKHOUSE_PASSWORD', '');
const ENROLL_TOKEN = env('AGENT_ENROLL_TOKEN', 'dev-agent-enroll-token');
const TARGET_HOST = env('TARGET_HOST', 'client-mongo');
const TARGET_PORT = parseInt(env('TARGET_PORT', '27017'), 10);
const TARGET_DB = env('TARGET_DB', 'profiles');
const MONGO_USER = env('MONGO_USER', 'admin');
const MONGO_PASS = env('MONGO_PASSWORD', '');
const AGENT_TYPE = 'audit_pull';
const HOSTNAME = os.hostname();

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Collections whose access is sensitive → tag the event (drives PII/risk views + policies).
const SENSITIVE = { kyc_documents: ['pii', 'kyc'], users: ['pii'], profiles: ['pii'] };

let tenantId = 'dev-tenant';
let agentId = null;

function mapOperation(doc) {
  const op = doc.op;
  if (op === 'query' || op === 'getmore') return 'SELECT';
  if (op === 'insert') return 'INSERT';
  if (op === 'update') return 'UPDATE';
  if (op === 'remove') return 'DELETE';
  if (op === 'command') {
    const c = doc.command || {};
    if (c.find || c.aggregate || c.count || c.distinct || c.getMore) return 'SELECT';
    if (c.insert) return 'INSERT';
    if (c.update) return 'UPDATE';
    if (c.delete || c.findAndModify) return 'UPDATE';
    if (c.create || c.createIndexes || c.drop || c.dropDatabase || c.collMod) return 'DDL';
    if (c.createUser || c.grantRolesToUser || c.updateUser) return 'GRANT';
    return 'COMMAND';
  }
  return (op || 'OTHER').toUpperCase();
}

function collOf(doc) {
  const ns = doc.ns || '';
  const dot = ns.indexOf('.');
  return dot >= 0 ? ns.slice(dot + 1) : (doc.command && doc.command.collection) || '';
}

function principalOf(doc) {
  if (Array.isArray(doc.users) && doc.users.length && doc.users[0].user) return doc.users[0].user;
  if (doc.user) return String(doc.user);
  return doc.appName || 'mongo_app';
}

function pseudoQuery(doc, coll) {
  const c = doc.command || {};
  let verb = 'op', arg = {};
  if (c.find) { verb = 'find'; arg = c.filter || {}; }
  else if (c.aggregate) { verb = 'aggregate'; arg = (c.pipeline || []).slice(0, 2); }
  else if (c.insert) { verb = 'insertMany'; arg = { count: (c.documents || []).length }; }
  else if (c.update) { verb = 'update'; arg = (c.updates && c.updates[0] && c.updates[0].q) || {}; }
  else if (c.delete) { verb = 'deleteMany'; arg = (c.deletes && c.deletes[0] && c.deletes[0].q) || {}; }
  else if (doc.op === 'query') { verb = 'find'; arg = (c.filter) || doc.query || {}; }
  else if (doc.op === 'insert') { verb = 'insert'; arg = {}; }
  else { verb = doc.op || 'command'; }
  let a = '';
  try { a = JSON.stringify(arg); } catch { a = '{}'; }
  return `db.${coll}.${verb}(${a})`.slice(0, 500);
}

function chDateTime(d) {
  const t = (d instanceof Date) ? d : new Date(d || Date.now());
  return t.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23); // YYYY-MM-DD HH:MM:SS.mmm
}

function toEvent(doc) {
  const coll = collOf(doc);
  const op = mapOperation(doc);
  const tags = SENSITIVE[coll] || [];
  return {
    tenant_id: tenantId,
    database_name: TARGET_DB,
    principal: principalOf(doc),
    client_ip: String(doc.client || doc.remote || '').split(':')[0] || '',
    operation: op,
    schema_name: (doc.ns || '').split('.')[0] || TARGET_DB,
    table_name: coll,
    columns_accessed: [],
    row_count: doc.nreturned != null ? doc.nreturned : (doc.nModified != null ? doc.nModified : (doc.ninserted || 0)),
    sql_hash: String(Math.abs(hash(doc.ns + op + (doc.millis || 0)))),
    sql_text: pseudoQuery(doc, coll),
    duration_ms: doc.millis || 0,
    anomaly_score: 0,
    tags,
    agent_type: AGENT_TYPE,
    source_host: `${TARGET_HOST}:${TARGET_PORT}`,
    timestamp: chDateTime(doc.ts),
  };
}

function hash(s) { let h = 0; s = String(s); for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return h; }

async function writeEvents(events) {
  if (!events.length) return;
  const body = events.map((e) => JSON.stringify(e)).join('\n');
  const q = new URLSearchParams({ query: 'INSERT INTO dam_analytics.events FORMAT JSONEachRow', user: CH_USER, password: CH_PASS });
  const res = await fetch(`${CLICKHOUSE_URL}/?${q.toString()}`, { method: 'POST', body });
  if (!res.ok) log('[clickhouse] insert failed', res.status, (await res.text()).slice(0, 200));
  else events.forEach((e) => log(`[capture] ${e.operation.padEnd(7)} ${e.principal.padEnd(12)} ${e.sql_text.slice(0, 70)}`));
}

async function enroll() {
  try {
    const res = await fetch(`${CONTROL_PLANE}/api/agents/enroll`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: ENROLL_TOKEN, host: TARGET_HOST, port: TARGET_PORT, engine: 'mongodb', agent_type: AGENT_TYPE, agent_host: HOSTNAME, version: '0.1.0' }),
    });
    const j = await res.json();
    if (res.ok && j.agent_id) { agentId = j.agent_id; tenantId = j.tenant_id || tenantId; log(`enrolled: agent=${agentId} instance=${j.instance_id} tenant=${tenantId}`); return true; }
    log('[enroll] rejected', res.status, JSON.stringify(j)); return false;
  } catch (e) { log('[enroll] error', e.message); return false; }
}

async function heartbeat() {
  if (!agentId) return;
  try { await fetch(`${CONTROL_PLANE}/api/agents/${agentId}/heartbeat`, { method: 'POST' }); } catch { /* best effort */ }
}

async function main() {
  const uri = `mongodb://${encodeURIComponent(MONGO_USER)}:${encodeURIComponent(MONGO_PASS)}@${TARGET_HOST}:${TARGET_PORT}/?authSource=admin`;
  log(`=== TooVix DAM Mongo Agent v0.1.0 · target=${TARGET_HOST}:${TARGET_PORT} db=${TARGET_DB} ===`);
  let client;
  for (;;) {
    try { client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 4000 }); break; }
    catch (e) { log('[mongo] connect retry:', e.message); await sleep(3000); }
  }
  const db = client.db(TARGET_DB);
  // Enable full profiling on the target DB (level 2 = every operation).
  try { await db.command({ profile: 2 }); log('profiling enabled (level 2) on', TARGET_DB); }
  catch (e) { log('[profile] could not enable:', e.message); }

  // Enroll (retry until the control plane accepts us).
  while (!(await enroll())) await sleep(4000);
  setInterval(heartbeat, 10000);

  const profile = db.collection('system.profile');
  let lastTs = new Date(); // only capture activity from now on (don't backfill history)
  log('tailing system.profile for new operations…');
  for (;;) {
    try {
      const docs = await profile.find({ ts: { $gt: lastTs }, ns: { $nin: [`${TARGET_DB}.system.profile`] } })
        .sort({ ts: 1 }).limit(200).toArray();
      const events = [];
      for (const d of docs) {
        lastTs = d.ts > lastTs ? d.ts : lastTs;
        const coll = collOf(d);
        if (!coll || coll.startsWith('system.')) continue; // skip internal
        events.push(toEvent(d));
      }
      await writeEvents(events);
    } catch (e) { log('[tail] error', e.message); }
    await sleep(2000);
  }
}

main().catch((e) => { console.error('fatal', e); process.exit(1); });
