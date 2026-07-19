// Cloud SQL audit normalization — the LIVE agentless path (dam-audit-consumer owns the
// Pub/Sub subscription). Payload shapes below are the real ones observed on db-paas2
// (MysqlAuditEntry) and db-paas-pg (PgAuditEntry).
const N = require('../normalize.js');

const T = 'type.googleapis.com/google.cloud.sql.audit.v1.';
const mk = (req, over = {}) => Object.assign({
  timestamp: '2026-07-19T06:12:00Z',
  resource: { labels: { database_id: 'proj:db-x' } },
  protoPayload: { request: req },
}, over);

let pass = 0, fail = 0;
const ck = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}`);
  if (!ok) console.log(`        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

console.log('--- Cloud SQL MySQL (MysqlAuditEntry) ---');
const my = N.cloudSqlLogEntry(mk({
  '@type': T + 'MysqlAuditEntry', cmd: 'select', user: 'admin', ip: '10.30.0.2',
  objects: [{ db: 'billing', name: 'cards' }], query: 'SELECT card_number FROM cards',
}), 'tok');
ck('engine', my.engine, 'mysql');
ck('operation', my.events[0].operation, 'SELECT');
ck('principal', my.events[0].principal, 'admin');
ck('client_ip carried', my.events[0].client_ip, '10.30.0.2');
ck('database from objects[]', my.events[0].database_name, 'billing');
ck('DDL mapping', N.cloudSqlLogEntry(mk({ '@type': T + 'MysqlAuditEntry', cmd: 'create_table',
  user: 'admin', objects: [{ db: 'billing', name: 't' }], query: 'CREATE TABLE t (id int)' }), 'tok')
  .events[0].operation, 'DDL');

console.log('\n--- Cloud SQL PostgreSQL (PgAuditEntry) ---');
const pg = N.cloudSqlLogEntry(mk({
  '@type': T + 'PgAuditEntry', command: 'INSERT', auditClass: 'WRITE', user: 'admin',
  database: 'payments', object: 'public.ledger', statement: 'INSERT INTO ledger VALUES (1)',
  chunkCount: 1, chunkIndex: 1,
}), 'tok');
ck('engine reported per record', pg.engine, 'postgresql');
ck('operation', pg.events[0].operation, 'INSERT');
ck('database', pg.events[0].database_name, 'payments');
ck('table from object', pg.events[0].table_name, 'ledger');
ck('no client_ip on this path', pg.events[0].client_ip, '');
ck('auditClass fallback when command unknown', N.cloudSqlLogEntry(mk({ '@type': T + 'PgAuditEntry',
  command: 'SOMETHING', auditClass: 'READ', user: 'admin', database: 'payments',
  statement: 'SELECT 1 FROM t' }), 'tok').events[0].operation, 'SELECT');

console.log('\n--- filtering ---');
// ~99% of the stream under an audit rule of '*' is Cloud SQL's own internal traffic.
ck('root→mysql.heartbeat dropped', N.cloudSqlLogEntry(mk({ '@type': T + 'MysqlAuditEntry',
  cmd: 'insert', user: 'root', objects: [{ db: 'mysql', name: 'heartbeat' }],
  query: 'INSERT INTO mysql.heartbeat(id, master_time) VALUE(1, UTC_TIMESTAMP(6))' }), 'tok'), null);
ck('cloudsqladmin dropped', N.cloudSqlLogEntry(mk({ '@type': T + 'PgAuditEntry', command: 'SELECT',
  user: 'cloudsqladmin', database: 'postgres', statement: 'SELECT 1' }), 'tok'), null);
ck('select @@version dropped', N.cloudSqlLogEntry(mk({ '@type': T + 'MysqlAuditEntry', cmd: 'select',
  user: 'admin', objects: [{ db: 'billing' }], query: 'select @@version_comment limit 1' }), 'tok'), null);
// A long statement is split across entries; one statement must be one event.
ck('pg chunk 1 of 3 kept', !!N.cloudSqlLogEntry(mk({ '@type': T + 'PgAuditEntry', command: 'SELECT',
  user: 'admin', database: 'payments', statement: 'SELECT 1 FROM t', chunkCount: 3, chunkIndex: 1 }), 'tok'), true);
ck('pg chunk 2 of 3 dropped', N.cloudSqlLogEntry(mk({ '@type': T + 'PgAuditEntry', command: 'SELECT',
  user: 'admin', database: 'payments', statement: 'SELECT 1 FROM t', chunkCount: 3, chunkIndex: 2 }), 'tok'), null);
ck('no CLOUDSQL_ENROLL_TOKEN → null', N.cloudSqlLogEntry(mk({ '@type': T + 'MysqlAuditEntry',
  cmd: 'select', user: 'admin', objects: [{ db: 'billing' }], query: 'SELECT 1 FROM cards' }), ''), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
