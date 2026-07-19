// Exercise the pgAudit parser against realistic Cloud SQL log lines, including the
// cases a naive split(',') gets wrong.
const fs = require('fs');
const src = fs.readFileSync('/Users/vikramsharma/Documents/DAM/dev/dam/api/main.js', 'utf8');

// Pull just the parser functions out of the API module (it has side effects on import).
const names = ['splitPgAuditCsv', 'pgAuditToOp', 'isSystemNoisePG', 'logEntryToEventPGText', 'logEntryToEventCloudSqlPG', 'detectTagsSql'];
let code = '';
for (const n of names) {
  const re = new RegExp(`\\nfunction ${n}\\([\\s\\S]*?\\n\\}`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error('could not extract ' + n);
  code += m[0] + '\n';
}
const prefixRe = /const PG_PREFIX_RE = .*/.exec(src)[0];
code = prefixRe + '\n' + code + '\nmodule.exports = { splitPgAuditCsv, logEntryToEventPGText, logEntryToEventCloudSqlPG, pgAuditToOp };';
const mod = { exports: {} };
new Function('module', 'exports', code)(mod, mod.exports);
const { splitPgAuditCsv, logEntryToEventPGText: logEntryToEventPG, logEntryToEventCloudSqlPG } = mod.exports;

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

console.log('--- CSV scanning ---');
check('plain fields', splitPgAuditCsv('SESSION,1,1,READ,SELECT,TABLE,public.users,"SELECT 1",<none>'),
  ['SESSION', '1', '1', 'READ', 'SELECT', 'TABLE', 'public.users', 'SELECT 1', '<none>']);

// The case split(',') destroys: commas inside the quoted statement.
check('commas inside statement',
  splitPgAuditCsv('SESSION,1,1,WRITE,INSERT,TABLE,public.users,"INSERT INTO users (a,b,c) VALUES (1,2,3)",<none>')[7],
  'INSERT INTO users (a,b,c) VALUES (1,2,3)');

// Doubled quotes are pgAudit's escape for a literal quote.
check('escaped quotes',
  splitPgAuditCsv(`SESSION,1,1,READ,SELECT,TABLE,public.users,"SELECT * FROM users WHERE email=""a@b.c""",<none>`)[7],
  'SELECT * FROM users WHERE email="a@b.c"');

console.log('\n--- full log lines ---');
const mk = (text) => ({
  textPayload: text,
  timestamp: '2026-07-19T08:00:00Z',
  resource: { labels: { database_id: 'proj:db-paas-pg' } },
});

const sel = logEntryToEventPG(mk(
  '2026-07-19 08:00:00.123 UTC [1234] app@payments 10.30.0.5 LOG:  AUDIT: SESSION,1,1,READ,SELECT,TABLE,public.cards,"SELECT card_number FROM cards WHERE email=\'x@y.z\'",<not logged>'));
check('SELECT op', sel.operation, 'SELECT');
check('SELECT principal', sel.principal, 'app');
check('SELECT database', sel.database_name, 'payments');
check('SELECT client_ip', sel.client_ip, '10.30.0.5');
check('SELECT schema/table', [sel.schema_name, sel.table_name], ['public', 'cards']);
check('SELECT pii+pci tags', sel.tags.sort(), ['pci', 'pii']);

const ins = logEntryToEventPG(mk(
  '2026-07-19 08:00:01.000 UTC [1235] app@payments 10.30.0.5 LOG:  AUDIT: SESSION,2,1,WRITE,INSERT,TABLE,public.ledger,"INSERT INTO ledger (a,b) VALUES (1,2)",<not logged>'));
check('INSERT op', ins.operation, 'INSERT');
check('INSERT statement kept whole', ins.sql_text, 'INSERT INTO ledger (a,b) VALUES (1,2)');

const ddl = logEntryToEventPG(mk(
  '2026-07-19 08:00:02.000 UTC [1236] admin@payments 10.30.0.9 LOG:  AUDIT: SESSION,3,1,DDL,CREATE TABLE,TABLE,public.t2,"CREATE TABLE t2 (id int)",<not logged>'));
check('DDL op', ddl.operation, 'DDL');

const rol = logEntryToEventPG(mk(
  '2026-07-19 08:00:03.000 UTC [1237] admin@payments 10.30.0.9 LOG:  AUDIT: SESSION,4,1,ROLE,GRANT,,,"GRANT SELECT ON cards TO dam_svc",<not logged>'));
check('ROLE→GRANT op', rol.operation, 'GRANT');

console.log('\n--- filtering ---');
check('cloudsqladmin dropped', logEntryToEventPG(mk(
  '2026-07-19 08:00:04.000 UTC [1] cloudsqladmin@postgres 10.0.0.1 LOG:  AUDIT: SESSION,5,1,READ,SELECT,TABLE,public.x,"SELECT 1",<none>')), null);
check('non-audit line ignored', logEntryToEventPG(mk(
  '2026-07-19 08:00:05.000 UTC [1] app@payments 10.30.0.5 LOG:  connection authorized')), null);
check('missing prefix still parses', logEntryToEventPG(mk(
  'AUDIT: SESSION,6,1,READ,SELECT,TABLE,public.users,"SELECT 1 FROM users",<none>')).operation, 'SELECT');


console.log('\n--- Cloud SQL structured PgAuditEntry (real shape from db-paas-pg) ---');
const mkProto = (over) => ({
  timestamp: '2026-07-19T05:10:27.379Z',
  resource: { labels: { database_id: 'project-x:db-paas-pg' } },
  protoPayload: {
    '@type': 'type.googleapis.com/google.cloud.audit.AuditLog',
    methodName: 'cloudsql.instances.query',
    serviceName: 'cloudsql.googleapis.com',
    request: Object.assign({
      '@type': 'type.googleapis.com/google.cloud.sql.audit.v1.PgAuditEntry',
      auditClass: 'WRITE', auditType: 'SESSION', chunkCount: 1, chunkIndex: 1,
      command: 'INSERT', database: 'payments', object: '', objectType: '',
      parameter: '<not logged>', statement: "INSERT INTO ledger VALUES (1)",
      statementId: 1, substatementId: 1, user: 'admin',
    }, over),
  },
});
const p1 = logEntryToEventCloudSqlPG(mkProto({}));
check('proto INSERT op', p1.operation, 'INSERT');
check('proto principal', p1.principal, 'admin');
check('proto database', p1.database_name, 'payments');
check('proto agent_type', p1.agent_type, 'agentless');
const p2 = logEntryToEventCloudSqlPG(mkProto({
  auditClass: 'READ', command: 'SELECT',
  statement: "SELECT card_number, email FROM cards WHERE cardholder='x'" }));
check('proto SELECT op', p2.operation, 'SELECT');
check('proto pci+pii tags', p2.tags.sort(), ['pci', 'pii']);
check('proto object empty → no table attribution', [p2.schema_name, p2.table_name], ['', '']);
const p3 = logEntryToEventCloudSqlPG(mkProto({ object: 'public.cards', command: 'SELECT', auditClass: 'READ' }));
check('proto object populated → schema/table', [p3.schema_name, p3.table_name], ['public', 'cards']);
check('proto cloudsqladmin dropped', logEntryToEventCloudSqlPG(mkProto({ user: 'cloudsqladmin' })), null);
// Long statements are split across entries; only the first chunk should become an event.
check('proto chunk 1 of 3 kept', !!logEntryToEventCloudSqlPG(mkProto({ chunkCount: 3, chunkIndex: 1 })), true);
check('proto chunk 2 of 3 dropped', logEntryToEventCloudSqlPG(mkProto({ chunkCount: 3, chunkIndex: 2 })), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
