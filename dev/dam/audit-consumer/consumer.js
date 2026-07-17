/**
 * TooVix DAM — Audit Consumer (consolidated).
 *
 * ONE service that ingests cloud audit streams into DAM. It runs a pluggable set of source
 * adapters (see sources.js) — GCP Pub/Sub and Azure Event Hub today, AWS Kinesis next — each
 * of which normalizes its cloud's audit records into a common envelope and funnels them
 * through the shared bridge to POST /api/agents/events (which resolves the tenant + writes
 * the per-tenant ClickHouse events). No DB/ClickHouse logic lives here.
 *
 * A source is active when its env is configured, so the same image serves every cloud:
 *   • GCP Pub/Sub   → PUBSUB_SUBSCRIPTION (+ CLOUDSQL_ENROLL_TOKEN for the sink path)
 *   • Azure EventHub→ EVENTHUB_CONNECTION_STRING (+ EVENTHUB_NAME/CONSUMER_GROUP, AZURESQL_ENROLL_TOKEN)
 */
const { postEvents } = require('./ingest');
const adapters = require('./sources');

const stats = { ingested: 0, failed: 0, skipped: 0 };
const log = (m) => console.log(`[consumer] ${m}`);

// Shared handler every source calls. Returns {ok} so the source can ack/checkpoint (ok) or
// retry/redeliver (!ok) on a transient control-plane failure.
async function handle(envelope) {
  if (!envelope || !envelope.token || !Array.isArray(envelope.events) || envelope.events.length === 0) {
    stats.skipped++;
    return { ok: true, skipped: true }; // unrecognized/empty — drop so it doesn't redeliver forever
  }
  try {
    const res = await postEvents(envelope);
    stats.ingested += (res && res.ingested) || envelope.events.length;
    return { ok: true };
  } catch (e) {
    stats.failed++;
    log(`ingest failed (will retry): ${e.message}`);
    return { ok: false };
  }
}

async function main() {
  console.log('=== TooVix DAM Audit Consumer ===');
  const active = Object.values(adapters).filter((s) => s.enabled(process.env));
  if (active.length === 0) {
    log('no sources enabled — set PUBSUB_SUBSCRIPTION and/or EVENTHUB_CONNECTION_STRING. Idling.');
    setInterval(() => {}, 1 << 30);
    return;
  }
  log(`starting sources: ${active.map((s) => s.name).join(', ')}`);
  const ctx = { handle, log };
  const closers = [];
  for (const s of active) {
    try {
      closers.push(await s.start(ctx));
    } catch (e) {
      log(`source ${s.name} failed to start: ${e.message}`);
    }
  }
  setInterval(() => log(`ingested=${stats.ingested} failed=${stats.failed} skipped=${stats.skipped}`), 60000);

  const shutdown = async () => {
    log('shutting down');
    for (const c of closers) { try { await (c && c()); } catch { /* ignore */ } }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { console.error('[consumer] fatal:', e); process.exit(1); });
