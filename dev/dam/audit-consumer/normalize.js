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
  if (!sql) return null;
  const pm = String(text).match(/([A-Za-z0-9_.-]+)@([A-Za-z0-9_.%-]+)/);
  const ev = {
    database_name: host, principal: pm ? pm[1] : 'unknown', client_ip: '',
    operation: verb(sql), sql_text: sql.slice(0, 500), row_count: 0, tags: [],
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
    if (!sql) continue; // skip login/auth-only records (no statement)
    // resourceId: /SUBSCRIPTIONS/…/SERVERS/<srv>/DATABASES/<db>
    const rid = String(r.resourceId || '');
    const dbFromRid = (rid.match(/DATABASES\/([^/]+)/i) || [])[1];
    const db = p.database_name || dbFromRid || 'appdb';
    host = p.server_instance_name || (rid.match(/SERVERS\/([^/]+)/i) || [])[1] || db;
    events.push({
      database_name: db,
      principal: p.server_principal_name || p.database_principal_name || 'unknown',
      client_ip: p.client_ip || '',
      operation: verb(sql),
      sql_text: String(sql).slice(0, 500),
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
