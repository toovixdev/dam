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

function cloudSqlLogEntry(entry, token) {
  if (!token) return null; // no tenant mapping for the PaaS path
  const dbId = entry?.resource?.labels?.database_id || ''; // "project:instance"
  const host = dbId.split(':').pop() || 'cloudsql';
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
      operation: synth ? synth.operation : verb(sql),
      event_class: synth ? synth.event_class : 'statement',
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

module.exports = { agentlite, cloudSqlLogEntry, azureSqlAudit };
