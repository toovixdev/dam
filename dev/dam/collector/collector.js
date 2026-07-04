/**
 * DAM Collector — bridges client databases and the DAM data plane.
 *
 * In production this would be an eBPF/libpcap agent. In dev, it polls
 * pg_stat_activity / SHOW PROCESSLIST / currentOp to capture live queries,
 * publishes them to NATS, and writes to ClickHouse.
 */

const { Client: PgClient } = require('pg');
const mysql = require('mysql2/promise');
const { connect: natsConnect, StringCodec } = require('nats');
const { createClient: createClickHouse } = require('@clickhouse/client');

let TENANT_ID = 'dev-tenant'; // resolved to the real tenant UUID at startup (see init)
const POLL_INTERVAL = 5000;
const CONTROL_PLANE = process.env.CONTROL_PLANE || 'http://dam-api:3000';
const ENROLL_TOKEN = process.env.AGENT_ENROLL_TOKEN || 'dev-agent-enroll-token';

let natsConn, clickhouse;
const sc = StringCodec();

async function init() {
  console.log('=== TooVix DAM Collector v0.1 ===');
  console.log('Waiting 15s for services...');
  await sleep(15000);

  // Connect to NATS
  try {
    natsConn = await natsConnect({ servers: process.env.NATS_URL || 'nats://dam-nats:4222' });
    console.log('[NATS] Connected');
  } catch (e) {
    console.log('[NATS] Not available, running without streaming:', e.message);
  }

  // Connect to ClickHouse
  try {
    clickhouse = createClickHouse({
      url: `http://${process.env.CLICKHOUSE_HOST || 'dam-clickhouse'}:${process.env.CLICKHOUSE_PORT || 8123}`,
      username: process.env.CLICKHOUSE_USER || 'dam_writer',
      password: process.env.CLICKHOUSE_PASSWORD || 'dam_click_secret',
      database: 'dam_analytics',
    });
    console.log('[ClickHouse] Connected');
  } catch (e) {
    console.log('[ClickHouse] Not available:', e.message);
  }

  // Resolve the real tenant UUID so captured events are attributed correctly
  // (per-tenant admin views). Falls back to the placeholder if unreachable.
  try {
    const res = await fetch(`${CONTROL_PLANE}/api/tenants`);
    const tenants = await res.json();
    if (Array.isArray(tenants) && tenants.length && tenants[0].id) {
      TENANT_ID = tenants[0].id;
      console.log(`[Collector] Tenant resolved: ${TENANT_ID}`);
    }
  } catch (e) {
    console.log('[Collector] Could not resolve tenant, using placeholder:', e.message);
  }

  console.log(`[Collector] Polling every ${POLL_INTERVAL / 1000}s\n`);

  // Start polling loops
  pollPostgres();
  pollMySQL();
  startClassification();
}

// ── PostgreSQL collector ────────────────────────────────────
async function pollPostgres() {
  const client = new PgClient({
    host: process.env.PG_HOST || 'client-postgres',
    user: process.env.PG_USER || 'app_crm',
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE || 'crm',
  });

  try {
    await client.connect();
    console.log('[PG Collector] Connected to client-postgres');
  } catch (e) {
    console.log('[PG Collector] Connection failed:', e.message);
    setTimeout(pollPostgres, 10000);
    return;
  }

  setInterval(async () => {
    try {
      const res = await client.query(`
        SELECT pid, usename, query, state, query_start, client_addr
        FROM pg_stat_activity
        WHERE datname = 'crm' AND state = 'active' AND query NOT LIKE '%pg_stat_activity%'
        LIMIT 20
      `);

      for (const row of res.rows) {
        const event = {
          tenant_id: TENANT_ID,
          database_name: 'PG-CRM-PROD',
          principal: row.usename,
          client_ip: row.client_addr || '127.0.0.1',
          operation: detectOperation(row.query),
          sql_text: row.query.substring(0, 500),
          sql_hash: simpleHash(row.query),
          tags: detectSensitiveTags(row.query),
          agent_type: 'collector_poll',
          timestamp: new Date().toISOString(),
        };

        await publishEvent(event);
      }
    } catch (e) {
      // Query errors are expected during idle periods
    }
  }, POLL_INTERVAL);
}

// ── MySQL collector ─────────────────────────────────────────
async function pollMySQL() {
  let conn;
  try {
    conn = await mysql.createConnection({
      host: process.env.MYSQL_HOST || 'client-mysql',
      user: process.env.MYSQL_USER || 'app_payments',
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE || 'payments',
    });
    console.log('[MySQL Collector] Connected to client-mysql');
  } catch (e) {
    console.log('[MySQL Collector] Connection failed:', e.message);
    setTimeout(pollMySQL, 10000);
    return;
  }

  setInterval(async () => {
    try {
      const [rows] = await conn.query(`SHOW PROCESSLIST`);
      const active = rows.filter(r => r.Command === 'Query' && r.Info && !r.Info.includes('PROCESSLIST'));

      for (const row of active) {
        const event = {
          tenant_id: TENANT_ID,
          database_name: 'MYSQL-PAYMENTS-PROD',
          principal: row.User,
          client_ip: row.Host ? row.Host.split(':')[0] : '127.0.0.1',
          operation: detectOperation(row.Info),
          sql_text: (row.Info || '').substring(0, 500),
          sql_hash: simpleHash(row.Info || ''),
          tags: detectSensitiveTags(row.Info || ''),
          agent_type: 'collector_poll',
          timestamp: new Date().toISOString(),
        };

        await publishEvent(event);
      }
    } catch (e) {
      // Expected during idle
    }
  }, POLL_INTERVAL);
}

// ── Event publishing ────────────────────────────────────────
async function publishEvent(event) {
  const ts = new Date().toTimeString().slice(0, 8);
  const tagStr = event.tags.length ? ` [${event.tags.join(',')}]` : '';
  console.log(`[${ts}] ${event.database_name} | ${event.principal.padEnd(15)} | ${event.operation.padEnd(6)} | ${event.sql_text.substring(0, 60)}${tagStr}`);

  // Publish to NATS
  if (natsConn) {
    try {
      natsConn.publish('dam.events', sc.encode(JSON.stringify(event)));
    } catch (e) { /* non-fatal */ }
  }

  // Write to ClickHouse
  if (clickhouse) {
    try {
      await clickhouse.insert({
        table: 'events',
        values: [{
          tenant_id: event.tenant_id,
          database_name: event.database_name,
          principal: event.principal,
          client_ip: event.client_ip,
          operation: event.operation,
          sql_text: event.sql_text,
          sql_hash: event.sql_hash,
          tags: event.tags,
          agent_type: event.agent_type,
          row_count: 0,
          duration_ms: Math.floor(Math.random() * 100),
          anomaly_score: event.tags.length > 0 ? Math.floor(Math.random() * 40) + 30 : Math.floor(Math.random() * 20),
        }],
        format: 'JSONEachRow',
      });
    } catch (e) { /* non-fatal in dev */ }
  }
}

// ── Helpers ─────────────────────────────────────────────────
function detectOperation(sql) {
  if (!sql) return 'OTHER';
  const upper = sql.trim().toUpperCase();
  if (upper.startsWith('SELECT')) return 'SELECT';
  if (upper.startsWith('INSERT')) return 'INSERT';
  if (upper.startsWith('UPDATE')) return 'UPDATE';
  if (upper.startsWith('DELETE')) return 'DELETE';
  if (upper.startsWith('CREATE') || upper.startsWith('ALTER') || upper.startsWith('DROP')) return 'DDL';
  return 'OTHER';
}

function detectSensitiveTags(sql) {
  if (!sql) return [];
  const upper = sql.toUpperCase();
  const tags = [];
  if (upper.includes('SSN') || upper.includes('SOCIAL_SECURITY')) tags.push('ssn');
  if (upper.includes('CARD_NUMBER') || upper.includes('CARD_NO') || upper.includes('PAN_VAULT')) tags.push('pci');
  if (upper.includes('AADHAAR')) tags.push('aadhaar');
  if (upper.includes('SIN ') || upper.includes('.SIN')) tags.push('sin');
  if (upper.includes('NI_NUMBER')) tags.push('ni');
  if (upper.includes('DATE_OF_BIRTH') || upper.includes('DOB')) tags.push('pii');
  if (upper.includes('PHONE') || upper.includes('EMAIL') || upper.includes('ADDRESS')) tags.push('pii');
  return [...new Set(tags)];
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Classification scanner ──────────────────────────────────
// Introspects real schemas and classifies columns by NAME + CONTENT SAMPLING
// (regex/validators against sample values). Only classified (sensitive) columns
// are reported; the object still records its true total column count.
const SEV_RANK = { critical: 3, high: 2, medium: 1, low: 0 };
const maxSens = (a, b) => (SEV_RANK[b] > SEV_RANK[a] ? b : a);

// Name-based hints (tightened to avoid metadata false positives like table_name).
const CLASSIFIERS = [
  { re: /aadhaar|aadhar/i, tag: 'aadhaar', sens: 'critical' },
  { re: /ssn|social_security|(^|_)sin(_|$)/i, tag: 'ssn', sens: 'critical' },
  { re: /card_number|card_no|ccnum|creditcard|card_num|pan_number/i, tag: 'pci', sens: 'critical' },
  { re: /\bcvv\b|cvc|card_sec/i, tag: 'pci', sens: 'critical' },
  { re: /card_expiry|exp_date|(^|_)expiry/i, tag: 'pci', sens: 'high' },
  { re: /card_last4|last4/i, tag: 'pci', sens: 'medium' },
  { re: /(^|_)email/i, tag: 'email', sens: 'high' },
  { re: /first_name|last_name|full_name|fullname|cardholder|customer_name|contact_name/i, tag: 'name', sens: 'high' },
  { re: /(^|_)dob(_|$)|date_of_birth|birth_date/i, tag: 'dob', sens: 'high' },
  { re: /passport|tax_id|taxid|(^|_)tin(_|$)|(^|_)pan(_|$)/i, tag: 'gov_id', sens: 'high' },
  { re: /(^|_)phone|mobile_no|contact_no/i, tag: 'phone', sens: 'medium' },
  { re: /(^|_)address|postal_code|pincode|zip_code/i, tag: 'address', sens: 'medium' },
];
const nameHit = (name) => CLASSIFIERS.find((c) => c.re.test(name)) || null;

// Content validators — run against sampled values.
function luhn(s) {
  const d = String(s).replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(d)) return false;
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return sum % 10 === 0;
}
const CONTENT = [
  { tag: 'pci', sens: 'critical', test: (v) => luhn(v) },
  { tag: 'aadhaar', sens: 'critical', test: (v) => /^\d{4}\s?\d{4}\s?\d{4}$/.test(v) },
  { tag: 'pan', sens: 'high', test: (v) => /^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/.test(v.trim()) },
  { tag: 'gstin', sens: 'high', test: (v) => /^\d{2}[A-Za-z]{5}\d{4}[A-Za-z]\d[A-Za-z\d]Z[A-Za-z\d]$/.test(v.trim()) },
  { tag: 'email', sens: 'high', test: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(v) },
  { tag: 'ssn', sens: 'critical', test: (v) => /^\d{3}-?\d{2}-?\d{4}$/.test(v) },
  { tag: 'ip', sens: 'low', test: (v) => /^(\d{1,3}\.){3}\d{1,3}$/.test(v) },
  { tag: 'phone', sens: 'medium', test: (v) => { const d = v.replace(/\D/g, ''); return d.length >= 10 && d.length <= 13 && /^[\d\s+()-]+$/.test(v); } },
];
function contentHit(samples) {
  if (!samples || !samples.length) return null;
  for (const c of CONTENT) {
    const m = samples.filter((v) => v != null && c.test(String(v))).length;
    if (m / samples.length >= 0.6) return c;
  }
  return null;
}

// Combine name + content. Returns a classification or null (not sensitive → dropped).
function classify(colName, samples) {
  const n = nameHit(colName);
  const c = contentHit(samples);
  // Content is authoritative for the TAG (it inspected real values); name only
  // corroborates (→ 'validator', higher confidence). Name-only stays 'pattern'.
  if (c) return { tag: c.tag, sensitivity: c.sens, detection_method: n ? 'validator' : 'content', confidence: n ? 0.99 : 0.9 };
  if (n) return { tag: n.tag, sensitivity: n.sens, detection_method: 'pattern', confidence: 0.85 };
  return null;
}
function rollup(cols) { let best = 'low'; for (const c of cols) best = maxSens(best, c.sensitivity); return best; }

// Build objects: classify each column (with a value sample); keep only sensitive ones.
async function scanEngine(columns, sample) {
  const byObj = {};
  for (const r of columns) {
    const key = `${r.schema}.${r.table}`;
    if (!byObj[key]) byObj[key] = { schema_name: r.schema, object_name: r.table, object_type: 'table', total: 0, columns: [] };
    byObj[key].total++;
    let samples = [];
    try { samples = await sample(r.schema, r.table, r.column); } catch (e) { /* sampling best-effort */ }
    const hit = classify(r.column, samples);
    if (hit) byObj[key].columns.push({ column_name: r.column, data_type: r.data_type, tags: [hit.tag], sensitivity: hit.sensitivity, detection_method: hit.detection_method, confidence: hit.confidence, is_masked: false });
  }
  return Object.values(byObj).map((o) => ({ schema_name: o.schema_name, object_name: o.object_name, object_type: o.object_type, column_count: o.total, sensitivity: rollup(o.columns), columns: o.columns }));
}

async function scanPostgres(host, database, user, password) {
  const c = new PgClient({ host, user, password, database });
  await c.connect();
  try {
    const { rows } = await c.query(
      `SELECT table_schema AS schema, table_name AS table, column_name AS column, data_type
       FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_name, ordinal_position`
    );
    const qid = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const sample = async (s, t, col) => {
      const r = await c.query(`SELECT ${qid(col)}::text AS v FROM ${qid(s)}.${qid(t)} WHERE ${qid(col)} IS NOT NULL LIMIT 25`);
      return r.rows.map((x) => x.v);
    };
    return await scanEngine(rows, sample);
  } finally { await c.end().catch(() => {}); }
}

async function scanMySQL(host, port, database, user, password) {
  const conn = await mysql.createConnection({ host, port, user, password, database });
  try {
    const [rows] = await conn.query(
      `SELECT table_schema AS \`schema\`, table_name AS \`table\`, column_name AS \`column\`, data_type
       FROM information_schema.columns WHERE table_schema = ? ORDER BY table_name, ordinal_position`,
      [database]
    );
    const qid = (s) => `\`${String(s).replace(/`/g, '``')}\``;
    const sample = async (s, t, col) => {
      const [r] = await conn.query(`SELECT ${qid(col)} AS v FROM ${qid(s)}.${qid(t)} WHERE ${qid(col)} IS NOT NULL LIMIT 25`);
      return r.map((x) => (x.v == null ? null : String(x.v)));
    };
    return await scanEngine(rows, sample);
  } finally { await conn.end().catch(() => {}); }
}

async function classifyDatabases() {
  const results = [];
  const root = process.env.MYSQL_PASSWORD;
  // Map each registered database name → how to introspect it.
  const targets = [
    { name: process.env.PG_DATABASE || 'crm', kind: 'pg', host: process.env.PG_HOST || 'client-postgres', user: process.env.PG_USER || 'app_crm', password: process.env.PG_PASSWORD, database: process.env.PG_DATABASE || 'crm' },
    { name: process.env.MYSQL_DATABASE || 'payments', kind: 'mysql', host: process.env.MYSQL_HOST || 'client-mysql', port: 3306, user: 'root', password: root, database: process.env.MYSQL_DATABASE || 'payments' },
    { name: 'inventory', kind: 'mysql', host: 'client-mysql-2', port: 3307, user: 'root', password: root, database: 'inventory' },
  ];
  for (const t of targets) {
    try {
      const objects = t.kind === 'pg'
        ? await scanPostgres(t.host, t.database, t.user, t.password)
        : await scanMySQL(t.host, t.port, t.database, t.user, t.password);
      results.push({ name: t.name, objects }); // include empty → clears stale data
      console.log(`[Classify] ${t.name}: ${objects.length} objects`);
    } catch (e) {
      console.log(`[Classify] ${t.name} skipped: ${e.message}`);
    }
  }
  if (!results.length) return;
  try {
    const resp = await fetch(`${CONTROL_PLANE}/api/classification/scan-results`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: ENROLL_TOKEN, databases: results }),
    });
    const out = await resp.json().catch(() => ({}));
    console.log(`[Classify] reported → ${resp.status} ${JSON.stringify(out)}`);
  } catch (e) { console.log('[Classify] report failed:', e.message); }
}

// Run on startup, then on-demand whenever the UI requests a scan.
function startClassification() {
  setTimeout(classifyDatabases, 8000);
  setInterval(async () => {
    try {
      const r = await fetch(`${CONTROL_PLANE}/api/classification/scan-pending`);
      const j = await r.json().catch(() => ({}));
      if (j && j.pending) { console.log('[Classify] on-demand scan requested'); await classifyDatabases(); }
    } catch (e) { /* control plane optional */ }
  }, 10000);
}

init().catch(console.error);
