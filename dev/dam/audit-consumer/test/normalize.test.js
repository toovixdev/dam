// Unit tests for the agentless audit normalizers (normalize.js): Cloud SQL (MySQL/PG),
// Azure SQL → Event Hub, AgentLite passthrough, and the noise/chunk/token filters.
// Run: node --test test/*.test.js  (from dev/dam/audit-consumer) — pure functions, no I/O.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const N = require('../normalize.js');

const T = 'type.googleapis.com/google.cloud.sql.audit.v1.';
const mk = (req, over = {}) => Object.assign({
  timestamp: '2026-07-19T06:12:00Z',
  resource: { labels: { database_id: 'proj:db-x' } },
  protoPayload: { request: req },
}, over);

test('Cloud SQL MySQL (MysqlAuditEntry) maps engine/op/principal/ip/db', () => {
  const my = N.cloudSqlLogEntry(mk({
    '@type': T + 'MysqlAuditEntry', cmd: 'select', user: 'admin', ip: '10.30.0.2',
    objects: [{ db: 'billing', name: 'cards' }], query: 'SELECT card_number FROM cards',
  }), 'tok');
  assert.equal(my.engine, 'mysql');
  assert.equal(my.events[0].operation, 'SELECT');
  assert.equal(my.events[0].principal, 'admin');
  assert.equal(my.events[0].client_ip, '10.30.0.2');
  assert.equal(my.events[0].database_name, 'billing');
});

test('Cloud SQL MySQL DDL is classified as DDL (not SELECT)', () => {
  const e = N.cloudSqlLogEntry(mk({ '@type': T + 'MysqlAuditEntry', cmd: 'create_table',
    user: 'admin', objects: [{ db: 'billing', name: 't' }], query: 'CREATE TABLE t (id int)' }), 'tok');
  assert.equal(e.events[0].operation, 'DDL');
});

test('Cloud SQL PostgreSQL (PgAuditEntry) maps op/db/table + auditClass fallback', () => {
  const pg = N.cloudSqlLogEntry(mk({
    '@type': T + 'PgAuditEntry', command: 'INSERT', auditClass: 'WRITE', user: 'admin',
    database: 'payments', object: 'public.ledger', statement: 'INSERT INTO ledger VALUES (1)',
    chunkCount: 1, chunkIndex: 1,
  }), 'tok');
  assert.equal(pg.engine, 'postgresql');
  assert.equal(pg.events[0].operation, 'INSERT');
  assert.equal(pg.events[0].database_name, 'payments');
  assert.equal(pg.events[0].table_name, 'ledger');
  assert.equal(pg.events[0].client_ip, '');
  const fb = N.cloudSqlLogEntry(mk({ '@type': T + 'PgAuditEntry', command: 'SOMETHING',
    auditClass: 'READ', user: 'admin', database: 'payments', statement: 'SELECT 1 FROM t' }), 'tok');
  assert.equal(fb.events[0].operation, 'SELECT');
});

test('Cloud SQL internal traffic is filtered out', () => {
  assert.equal(N.cloudSqlLogEntry(mk({ '@type': T + 'MysqlAuditEntry', cmd: 'insert', user: 'root',
    objects: [{ db: 'mysql', name: 'heartbeat' }], query: 'INSERT INTO mysql.heartbeat VALUE(1)' }), 'tok'), null);
  assert.equal(N.cloudSqlLogEntry(mk({ '@type': T + 'PgAuditEntry', command: 'SELECT',
    user: 'cloudsqladmin', database: 'postgres', statement: 'SELECT 1' }), 'tok'), null);
  assert.equal(N.cloudSqlLogEntry(mk({ '@type': T + 'MysqlAuditEntry', cmd: 'select', user: 'admin',
    objects: [{ db: 'billing' }], query: 'select @@version_comment limit 1' }), 'tok'), null);
});

test('a chunked statement yields exactly one event (dedup by chunkIndex)', () => {
  const base = { '@type': T + 'PgAuditEntry', command: 'SELECT', user: 'admin',
    database: 'payments', statement: 'SELECT 1 FROM t', chunkCount: 3 };
  assert.ok(N.cloudSqlLogEntry(mk({ ...base, chunkIndex: 1 }), 'tok'));   // first chunk kept
  assert.equal(N.cloudSqlLogEntry(mk({ ...base, chunkIndex: 2 }), 'tok'), null); // rest dropped
});

test('no CLOUDSQL_ENROLL_TOKEN → dropped (tenant unresolvable)', () => {
  assert.equal(N.cloudSqlLogEntry(mk({ '@type': T + 'MysqlAuditEntry', cmd: 'select',
    user: 'admin', objects: [{ db: 'billing' }], query: 'SELECT 1 FROM cards' }), ''), null);
});

// ── Azure SQL → Event Hub ──────────────────────────────────────────────────────
const azRec = (props, over = {}) => Object.assign({
  resourceId: '/SUBSCRIPTIONS/s/SERVERS/srv1/DATABASES/appdb', time: '2026-07-19T06:12:00Z',
  properties: props,
}, over);

test('Azure SQL record maps engine/op/principal/db/rows', () => {
  const az = N.azureSqlAudit({ records: [azRec({
    statement: 'SELECT * FROM dbo.customers', action_name: 'SELECT', server_principal_name: 'appuser',
    client_ip: '10.0.0.5', database_name: 'appdb', schema_name: 'dbo', object_name: 'customers', affected_rows: 3,
  })] }, 'tok');
  assert.equal(az.engine, 'mssql');
  assert.equal(az.events[0].operation, 'SELECT');
  assert.equal(az.events[0].principal, 'appuser');
  assert.equal(az.events[0].database_name, 'appdb');
  assert.equal(az.events[0].table_name, 'customers');
  assert.equal(az.events[0].row_count, 3);
});

test('Azure action_name drives operation (SCHEMA OBJECT CHANGE → DDL)', () => {
  const az = N.azureSqlAudit({ records: [azRec({
    statement: 'ALTER TABLE t ADD c int', action_name: 'SCHEMA OBJECT CHANGE', server_principal_name: 'dbo',
  })] }, 'tok');
  assert.equal(az.events[0].operation, 'DDL');
});

test('Azure db falls back to resourceId when database_name is absent', () => {
  const az = N.azureSqlAudit({ records: [azRec({
    statement: 'SELECT 1', action_name: 'SELECT', server_principal_name: 'u',
  })] }, 'tok');
  assert.equal(az.events[0].database_name, 'appdb'); // from /DATABASES/appdb
});

test('Azure requires a token and non-empty records', () => {
  assert.equal(N.azureSqlAudit({ records: [azRec({ statement: 'SELECT 1', action_name: 'SELECT' })] }, ''), null);
  assert.equal(N.azureSqlAudit({ records: [] }, 'tok'), null);
});

// ── AgentLite forwarder passthrough ────────────────────────────────────────────
test('AgentLite envelope passes through only when token + events[] present', () => {
  const env = { token: 'tok', events: [{ operation: 'SELECT' }] };
  assert.equal(N.agentlite(env), env);
  assert.equal(N.agentlite({ token: 'tok' }), null);          // no events
  assert.equal(N.agentlite({ events: [] }), null);            // no token
  assert.equal(N.agentlite(null), null);
});
