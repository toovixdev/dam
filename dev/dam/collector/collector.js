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

const TENANT_ID = 'dev-tenant';
const POLL_INTERVAL = 5000;

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

  console.log(`[Collector] Polling every ${POLL_INTERVAL / 1000}s\n`);

  // Start polling loops
  pollPostgres();
  pollMySQL();
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

init().catch(console.error);
