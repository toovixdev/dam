/**
 * Stream source adapters. ONE consumer service, one adapter per cloud — because the client
 * SDKs and audit-record formats genuinely differ, but everything downstream (normalize →
 * envelope → control plane → ClickHouse) is shared. Adding a cloud (e.g. AWS Kinesis) = a new
 * adapter here + a normalizer in normalize.js. No new service, no compose change.
 *
 * Adapter contract:
 *   { name, enabled(env) -> bool, async start(ctx) -> closeFn }
 *   ctx = { handle(envelope) -> {ok}, log(msg) }   (handle posts to the control plane)
 */
const N = require('./normalize');

// ── GCP Pub/Sub (Cloud SQL agentless sink + AgentLite forwarder) ──────────────────────
const pubsub = {
  name: 'gcp-pubsub',
  enabled: (env) => !!env.PUBSUB_SUBSCRIPTION,
  async start(ctx) {
    const { PubSub } = require('@google-cloud/pubsub');
    const cloudsqlToken = process.env.CLOUDSQL_ENROLL_TOKEN || '';
    const sub = new PubSub({ projectId: process.env.GCP_PROJECT || undefined })
      .subscription(process.env.PUBSUB_SUBSCRIPTION, {
        flowControl: { maxMessages: parseInt(process.env.MAX_INFLIGHT || '50', 10) },
      });
    sub.on('message', async (msg) => {
      let env = null;
      try {
        const json = JSON.parse(msg.data.toString('utf8'));
        env = N.agentlite(json) || N.cloudSqlLogEntry(json, cloudsqlToken);
      } catch { /* non-JSON payload — treat as unrecognized */ }
      const r = await ctx.handle(env);
      r.ok ? msg.ack() : msg.nack(); // nack → Pub/Sub redelivers on transient control-plane failure
    });
    sub.on('error', (e) => ctx.log(`gcp-pubsub error: ${e.message}`));
    ctx.log(`gcp-pubsub: subscribed ${process.env.PUBSUB_SUBSCRIPTION}`);
    return async () => sub.close().catch(() => {});
  },
};

// ── Azure Event Hub (Azure SQL Auditing → Event Hub) ──────────────────────────────────
const eventhub = {
  name: 'azure-eventhub',
  enabled: (env) => !!env.EVENTHUB_CONNECTION_STRING,
  async start(ctx) {
    const { EventHubConsumerClient, earliestEventPosition, latestEventPosition } = require('@azure/event-hubs');
    const { FileCheckpointStore } = require('./checkpoint-store');
    const hub = process.env.EVENTHUB_NAME || 'toovix-dam-audit';
    const group = process.env.EVENTHUB_CONSUMER_GROUP || '$Default';
    const token = process.env.AZURESQL_ENROLL_TOKEN || '';
    // startPosition applies ONLY to partitions with no stored checkpoint — i.e. the first run.
    // Afterwards the store resumes exactly where the last processed event left off, so a restart
    // no longer replays (and re-ingests) the retention window.
    const startPosition = process.env.EVENTHUB_START === 'earliest' ? earliestEventPosition : latestEventPosition;
    const store = new FileCheckpointStore(process.env.EVENTHUB_CHECKPOINT_FILE || '/var/lib/toovix/eventhub-checkpoints.json');
    const client = new EventHubConsumerClient(group, process.env.EVENTHUB_CONNECTION_STRING, hub, store);
    const sub = client.subscribe({
      processEvents: async (events, context) => {
        if (!events.length) return;
        for (const e of events) {
          await ctx.handle(N.azureSqlAudit(e.body, token));
        }
        // Checkpoint once per batch, after the batch is handled. Delivery stays at-least-once —
        // a crash between handling and checkpointing replays that batch — but the window is one
        // batch rather than the entire hub.
        try { await context.updateCheckpoint(events[events.length - 1]); }
        catch (e) { ctx.log(`azure-eventhub: checkpoint failed: ${e.message}`); }
      },
      processError: async (err) => { ctx.log(`azure-eventhub error: ${err.message}`); },
    }, { startPosition, maxBatchSize: parseInt(process.env.MAX_INFLIGHT || '50', 10) });
    ctx.log(`azure-eventhub: subscribed hub=${hub} group=${group} start=${process.env.EVENTHUB_START || 'latest'} (checkpointed)`);
    return async () => { await sub.close().catch(() => {}); await client.close().catch(() => {}); };
  },
};

// AWS Kinesis would slot in here as a third adapter (client + N.rdsAudit normalizer).
module.exports = { pubsub, eventhub };
