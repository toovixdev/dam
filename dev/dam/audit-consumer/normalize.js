/**
 * Per-cloud audit-record normalizers. Each maps a raw stream message into the internal
 * envelope the control plane's POST /api/agents/events already understands:
 *   { source, token, host, engine, agent_type, events:[ {event}, ... ] }
 * An `event` is: { database_name, principal, client_ip, operation, sql_text, row_count,
 *                  tags, agent_type, source_host, timestamp }.
 *
 * Keep these forgiving/heuristic — cloud audit payload shapes vary by config; refine against
 * real samples. Adding a new cloud = adding a normalizer here + a source adapter in sources.js.
 */

const SQL_VERB = /\b(SELECT|INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|EXEC(?:UTE)?)\b[\s\S]*/i;

function verb(sql) {
  return (String(sql || '').trim().split(/\s+/)[0] || 'OTHER').toUpperCase();
}
function ts(v) {
  return String(v || new Date().toISOString()).replace('T', ' ').slice(0, 19);
}

// ── Non-statement audit records ──────────────────────────────────────────────
// Cloud audit streams carry more than statements: logins, and changes to the audit
// configuration itself. These were previously dropped for having no SQL text, which
// silently discarded the entire authentication trail — and AUDIT SESSION CHANGED, the
// one event that reveals someone tampering with auditing.
//
// The events schema is statement-shaped (sql_text / operation / row_count), so until it
// carries a proper event class these are represented as synthetic statements: a real
// operation verb plus a human-readable description in place of SQL. `event_class` is set
// on the event for consumers that understand it and ignored by those that don't.
const AUTH_ACTIONS = {
  DBAS: { op: 'LOGIN', class: 'auth', desc: 'Database authentication succeeded' },
  DBAF: { op: 'LOGIN_FAILED', class: 'auth', desc: 'Database authentication FAILED' },
  LGIS: { op: 'LOGIN', class: 'auth', desc: 'Server login succeeded' },
  LGIF: { op: 'LOGIN_FAILED', class: 'auth', desc: 'Server login FAILED' },
  AUSC: { op: 'AUDIT_CHANGE', class: 'audit_config', desc: 'Audit session changed' },
  AASC: { op: 'AUDIT_CHANGE', class: 'audit_config', desc: 'Audit specification changed' },
};

// Falls back to the action name when the id is unknown, so a new action type degrades to a
// recorded event rather than a silent drop.
function nonStatementEvent(p) {
  const id = String(p.action_id || '').trim().toUpperCase();
  const name = String(p.action_name || '').trim();
  const known = AUTH_ACTIONS[id];
  if (!known && !name) return null;
  const succeeded = String(p.succeeded ?? 'true').toLowerCase() !== 'false';
  const meta = known || {
    op: /FAIL/i.test(name) ? 'LOGIN_FAILED' : 'OTHER',
    class: /AUDIT/i.test(name) ? 'audit_config' : 'auth',
    desc: name || id,
  };
  const bits = [meta.desc];
  if (p.session_id) bits.push(`session ${p.session_id}`);
  if (!succeeded && !/fail/i.test(meta.desc)) bits.push('FAILED');
  return { operation: meta.op, event_class: meta.class, sql_text: bits.join(' · ') };
}

// ── GCP: AgentLite forwarder already speaks our envelope; Cloud SQL sink = a Logging LogEntry.
function agentlite(json) {
  return (json && json.token && Array.isArray(json.events)) ? json : null;
}

// Cloud SQL does NOT emit its DB audit as text. Both engines publish a STRUCTURED proto in
// protoPayload.request — verified against live db-paas2 / db-paas-pg:
//   MySQL      → google.cloud.sql.audit.v1.MysqlAuditEntry  { query, cmd, user, ip, objects[] }
//   PostgreSQL → google.cloud.sql.audit.v1.PgAuditEntry     { statement, command, auditClass,
//                                                             database, user, object }
// The text path below only ever matched a general-log style line, so with the real payloads it
// found nothing and every Cloud SQL record was skipped — the agentless path ingested zero.

// Cloud SQL runs constant internal traffic (replication heartbeat, health probes, metadata
// polls) under its own maintenance users. With an audit rule of '*' that is ~99% of the
// stream, so it must be dropped here or it floods the trail.
const CLOUDSQL_SYS_DB = new Set(['mysql', 'performance_schema', 'information_schema', 'sys']);
function cloudSqlNoise(user, db, sql) {
  const p = String(user || '').toLowerCase();
  if (p.startsWith('cloudsql') || p.startsWith('mysql.')) return true;
  const u = String(sql || '').trim().toLowerCase();
  if (u.startsWith('select @@') || /^select\s+1\s*;?$/.test(u) || u.includes('mysql.heartbeat')) return true;
  if (p === 'root' && (CLOUDSQL_SYS_DB.has(String(db || '').toLowerCase()) || !db)) return true;
  return false;
}

function mysqlCmdOp(cmd) {
  const c = String(cmd || '').toLowerCase();
  const M = {
    select: 'SELECT', insert: 'INSERT', insert_select: 'INSERT', replace: 'INSERT',
    update: 'UPDATE', update_multi: 'UPDATE', delete: 'DELETE', delete_multi: 'DELETE',
    truncate: 'DDL', grant: 'GRANT', revoke: 'GRANT', revoke_all: 'GRANT',
    connect: 'LOGIN', disconnect: 'LOGOUT',
  };
  if (M[c]) return M[c];
  if (/^(create|drop|alter|rename)/.test(c)) return 'DDL';
  return 'OTHER';
}

function pgAuditOp(command, cls) {
  const c = String(command || '').toUpperCase().trim();
  if (c.startsWith('SELECT')) return 'SELECT';
  if (c.startsWith('INSERT')) return 'INSERT';
  if (c.startsWith('UPDATE')) return 'UPDATE';
  if (c.startsWith('DELETE')) return 'DELETE';
  if (c.startsWith('GRANT') || c.startsWith('REVOKE')) return 'GRANT';
  if (/^(CREATE|ALTER|DROP|TRUNCATE|RENAME)/.test(c)) return 'DDL';
  return ({ READ: 'SELECT', WRITE: 'UPDATE', DDL: 'DDL', ROLE: 'GRANT' })[String(cls || '').toUpperCase()] || 'OTHER';
}

// Structured Cloud SQL audit protos → the internal envelope. Returns null when the entry is
// not one of these, so the caller can fall through to the text path.
function cloudSqlAuditProto(entry, token, host) {
  const req = entry?.protoPayload?.request;
  const type = String(req?.['@type'] || '');
  if (!req || !type.includes('AuditEntry')) return null;

  let engine, user, db, sql, operation, table;
  if (type.includes('MysqlAuditEntry')) {
    engine = 'mysql';
    user = req.user || req.privUser || 'unknown';
    const obj = (Array.isArray(req.objects) && req.objects[0]) || {};
    db = obj.db || '';
    table = obj.name || '';
    sql = req.query || '';
    operation = mysqlCmdOp(req.cmd);
  } else if (type.includes('PgAuditEntry')) {
    engine = 'postgresql';
    user = req.user || 'unknown';
    db = req.database || '';
    // Long statements are SPLIT across entries; keep only the first so one statement is one
    // event rather than N duplicates.
    if (Number(req.chunkCount || 1) > 1 && Number(req.chunkIndex || 1) !== 1) return null;
    const objectName = String(req.object || '');
    table = objectName.includes('.') ? objectName.split('.').slice(1).join('.') : objectName;
    sql = req.statement || '';
    operation = pgAuditOp(req.command, req.auditClass);
  } else {
    return null;
  }

  if (!String(sql).trim()) return null;
  if (cloudSqlNoise(user, db, sql)) return null;

  return {
    source: 'cloudsql-sink', token, host, engine, agent_type: 'audit_pull',
    events: [{
      database_name: db || host,
      principal: user,
      // MySQL carries the client address; the PgAuditEntry has no such field.
      client_ip: req.ip || '',
      operation,
      event_class: 'statement',
      table_name: table || '',
      sql_text: String(sql).slice(0, 500),
      row_count: 0,
      tags: [],
      agent_type: 'audit_pull',
      source_host: host,
      timestamp: ts(entry.timestamp || req.date),
    }],
  };
}

function cloudSqlLogEntry(entry, token) {
  if (!token) return null; // no tenant mapping for the PaaS path
  const dbId = entry?.resource?.labels?.database_id || ''; // "project:instance"
  const host = dbId.split(':').pop() || 'cloudsql';
  // Structured proto first — that is what Cloud SQL actually publishes today.
  const proto = cloudSqlAuditProto(entry, token, host);
  if (proto) return proto;
  const text = entry.textPayload || entry.jsonPayload?.message || entry.protoPayload?.message || '';
  const m = String(text).match(SQL_VERB);
  const sql = m ? m[0].trim() : '';
  // The MySQL general log records connections too ("<id> Connect  user@host on db"). Those
  // carry no SQL, so the statement match misses them and the whole authentication trail was
  // being dropped — same defect as the Azure path. Represent them instead.
  const conn = sql ? null : String(text).match(/\b(Connect|Quit)\b\s*(.*)$/i);
  if (!sql && !conn) return null;
  const pm = String(text).match(/([A-Za-z0-9_.-]+)@([A-Za-z0-9_.%-]+)/);
  const isConnect = conn && /connect/i.test(conn[1]);
  const ev = {
    database_name: host, principal: pm ? pm[1] : 'unknown', client_ip: '',
    operation: conn ? (isConnect ? 'LOGIN' : 'LOGOUT') : verb(sql),
    event_class: conn ? 'auth' : 'statement',
    sql_text: conn
      ? `${isConnect ? 'Connection opened' : 'Connection closed'}${conn[2] ? ' · ' + conn[2].trim().slice(0, 200) : ''}`
      : sql.slice(0, 500),
    row_count: 0, tags: [],
    agent_type: 'audit_pull', source_host: host, timestamp: ts(entry.timestamp),
  };
  return { source: 'cloudsql-sink', token, host, engine: 'mysql', agent_type: 'audit_pull', events: [ev] };
}

// Azure SQL audit records name the action they represent (`action_name`), which is more
// reliable than the statement's first word — especially under object-level auditing, where the
// same statement text appears under several actions. Falls back to the text for records whose
// action isn't a DML/DDL one we recognise (e.g. BATCH COMPLETED under group auditing).
const AZ_ACTION_OP = {
  SELECT: 'SELECT', INSERT: 'INSERT', UPDATE: 'UPDATE', DELETE: 'DELETE',
  EXECUTE: 'EXECUTE', 'SCHEMA OBJECT CHANGE': 'DDL',
  'SCHEMA OBJECT ACCESS': 'SELECT', RECEIVE: 'SELECT', REFERENCES: 'SELECT',
};
function azureActionOp(actionName, sql) {
  const a = String(actionName || '').trim().toUpperCase();
  if (AZ_ACTION_OP[a]) return AZ_ACTION_OP[a];
  if (a.includes('OBJECT CHANGE') || a.includes('SCHEMA CHANGE')) return 'DDL';
  return verb(sql);
}

// ── Azure: SQL Auditing → Event Hub. A diagnostic message body is { records: [ {...}, ... ] };
// each SQLSecurityAuditEvents record carries the statement + principal under .properties.
function azureSqlAudit(body, token) {
  if (!token) return null; // tenant comes from AZURESQL_ENROLL_TOKEN (audit can't carry it)
  const records = Array.isArray(body?.records) ? body.records
                : (body && body.properties) ? [body] : [];
  let host = 'azuresql';
  const events = [];
  for (const r of records) {
    const p = r.properties || r;
    const sql = p.statement || p.batch_text || '';
    // A record with no statement is a login or an audit-config change — represent it rather
    // than dropping it (see nonStatementEvent). Only a record we can't identify at all is skipped.
    const synth = sql ? null : nonStatementEvent(p);
    if (!sql && !synth) continue;
    // resourceId: /SUBSCRIPTIONS/…/SERVERS/<srv>/DATABASES/<db>
    const rid = String(r.resourceId || '');
    const dbFromRid = (rid.match(/DATABASES\/([^/]+)/i) || [])[1];
    const db = p.database_name || dbFromRid || 'appdb';
    host = p.server_instance_name || (rid.match(/SERVERS\/([^/]+)/i) || [])[1] || db;
    events.push({
      database_name: db,
      principal: p.server_principal_name || p.database_principal_name || 'unknown',
      client_ip: p.client_ip || '',
      // Prefer the record's OWN action over parsing the statement text. With object-level
      // auditing SQL Server emits one record per audited action, and a write emits two: an
      // `UPDATE … WHERE` audits the SELECT that finds the rows AND the UPDATE that changes
      // them — both carrying the SAME statement text. Deriving the operation from the text
      // labelled both "UPDATE", which reads as a duplicated event rather than the read and
      // the write it actually was.
      operation: synth ? synth.operation : azureActionOp(p.action_name, sql),
      event_class: synth ? synth.event_class : 'statement',
      schema_name: p.schema_name || '',
      table_name: p.object_name || '',
      sql_text: synth ? synth.sql_text : String(sql).slice(0, 500),
      row_count: parseInt(p.affected_rows || p.row_count || 0, 10) || 0,
      tags: [],
      agent_type: 'audit_pull',
      source_host: host,
      timestamp: ts(r.time || p.event_time),
    });
  }
  if (!events.length) return null;
  return { source: 'azuresql-eventhub', token, host, engine: 'mssql', agent_type: 'audit_pull', events };
}

module.exports = { agentlite, cloudSqlLogEntry, azureSqlAudit, cloudSqlAuditProto };
