/**
 * TooVix DAM — AgentLite Audit Consumer.
 *
 * Streaming-pulls the Pub/Sub audit bus (toovix-dam-audit-sub) and bridges each
 * message to the control plane's POST /api/agents/events — which already resolves
 * the tenant from the enroll token and writes the per-tenant ClickHouse events.
 * So this stays a thin, stateless bridge: no DB creds, no ClickHouse logic here.
 *
 * Two message shapes arrive on the bus (see pubsub.tf):
 *   • AgentLite (self-managed VMs) — the forwarder publishes our own envelope:
 *       { source:"agentlite", token, host, engine, agent_type, events:[...] }
 *     → passed straight through.
 *   • Cloud SQL sink (PaaS) — a GCP Logging LogEntry for the DB's native audit.
 *     → normalized (best-effort) into the same envelope, tenant via CLOUDSQL_ENROLL_TOKEN.
 *
 * Auth to Pub/Sub is ADC (the host VM's service account) — no key file, per org policy.
 */
const { PubSub } = require('@google-cloud/pubsub');

const SUBSCRIPTION = process.env.PUBSUB_SUBSCRIPTION || '';
const PROJECT = process.env.GCP_PROJECT || undefined; // ADC resolves the project when unset
const CONTROL_PLANE = (process.env.CONTROL_PLANE || 'http://dam-api:3000').replace(/\/+$/, '');
const CLOUDSQL_TOKEN = process.env.CLOUDSQL_ENROLL_TOKEN || ''; // tenant for Cloud SQL sink msgs
const MAX_MESSAGES = parseInt(process.env.MAX_INFLIGHT || '50', 10);

let ingested = 0, failed = 0, skipped = 0;

async function main() {
  console.log(`=== TooVix DAM AgentLite Audit Consumer ===`);
  console.log(`[consumer] subscription=${SUBSCRIPTION} control_plane=${CONTROL_PLANE}`);
  const sub = new PubSub({ projectId: PROJECT }).subscription(SUBSCRIPTION, {
    flowControl: { maxMessages: MAX_MESSAGES },
  });

  sub.on('message', async (msg) => {
    try {
      const body = normalize(msg.attributes || {}, JSON.parse(msg.data.toString('utf8')));
      if (!body || !body.token || !Array.isArray(body.events) || body.events.length === 0) {
        skipped++;
        return msg.ack(); // unrecognized / empty — drop so it doesn't redeliver forever
      }
      const res = await postEvents(body);
      ingested += res.ingested || body.events.length;
      msg.ack();
    } catch (e) {
      failed++;
      console.error(`[consumer] ingest failed (will redeliver): ${e.message}`);
      msg.nack(); // transient (control plane down / 5xx) → let Pub/Sub redeliver
    }
  });
  sub.on('error', (e) => console.error(`[consumer] subscription error: ${e.message}`));

  setInterval(() => console.log(`[consumer] ingested=${ingested} failed=${failed} skipped=${skipped}`), 60000);

  const shutdown = async () => { console.log('[consumer] shutting down'); await sub.close().catch(() => {}); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function postEvents(body) {
  const res = await fetch(`${CONTROL_PLANE}/api/agents/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ingest ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// normalize maps any bus message into the internal {token, host, engine, events:[...]} envelope.
function normalize(attributes, json) {
  const source = attributes.source || json.source || '';
  // AgentLite forwarder already speaks our envelope — pass through.
  if (source === 'agentlite' || (json.token && Array.isArray(json.events))) return json;
  // Otherwise treat it as a Cloud SQL audit LogEntry from the Cloud Logging sink.
  return normalizeCloudSqlLogEntry(json);
}

// normalizeCloudSqlLogEntry converts a GCP Logging LogEntry (Cloud SQL MySQL audit) into our
// envelope. Best-effort: Cloud SQL audit payload formats vary by plugin/config, so this is a
// heuristic first cut — validate against real sink output before relying on it. Tenant comes
// from CLOUDSQL_ENROLL_TOKEN (the sink can't carry an enroll token).
function normalizeCloudSqlLogEntry(entry) {
  if (!CLOUDSQL_TOKEN) return null; // no tenant mapping configured for the PaaS path
  const dbId = entry?.resource?.labels?.database_id || ''; // "project:instance"
  const host = dbId.split(':').pop() || 'cloudsql';
  const timestamp = String(entry.timestamp || new Date().toISOString()).replace('T', ' ').slice(0, 19);
  // Payload can be textPayload or a structured jsonPayload/protoPayload.message.
  const text = entry.textPayload || entry.jsonPayload?.message || entry.protoPayload?.message || '';
  const sql = extractSql(text);
  if (!sql) return null;
  const ev = {
    database_name: host,
    principal: extractPrincipal(text) || 'unknown',
    client_ip: '',
    operation: (sql.trim().split(/\s+/)[0] || 'OTHER').toUpperCase(),
    sql_text: sql.slice(0, 500),
    row_count: 0,
    tags: [],
    agent_type: 'audit_pull',
    source_host: host,
    timestamp,
  };
  return { source: 'cloudsql-sink', token: CLOUDSQL_TOKEN, host, engine: 'mysql', agent_type: 'audit_pull', events: [ev] };
}

// Heuristic extractors for Cloud SQL MySQL audit lines (e.g. "…\tQUERY\tSELECT …", or a
// tab/pipe-delimited record). Kept intentionally forgiving; refine with real samples.
function extractSql(text) {
  if (!text) return '';
  const m = text.match(/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|TRUNCATE)\b[\s\S]*/i);
  return m ? m[0].trim() : '';
}
function extractPrincipal(text) {
  const m = text.match(/([A-Za-z0-9_.-]+)@([A-Za-z0-9_.%-]+)/);
  return m ? m[1] : '';
}

if (!SUBSCRIPTION) {
  console.log('[consumer] PUBSUB_SUBSCRIPTION not set — idling (nothing to consume; set it on the GCP host).');
  setInterval(() => {}, 1 << 30);
} else {
  main().catch((e) => { console.error('[consumer] fatal:', e); process.exit(1); });
}
