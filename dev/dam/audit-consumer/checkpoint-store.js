/**
 * File-backed Event Hub CheckpointStore.
 *
 * Without a checkpoint store the consumer restarts at EVENTHUB_START every time. With
 * EVENTHUB_START=earliest that replays the hub's whole retention window on every restart and
 * RE-INGESTS everything already stored — silently inflating event counts, bulk-read row totals
 * and alert volume. (Observed: one statement stored three times, once per restart.)
 *
 * Azure's own store is @azure/eventhubs-checkpointstore-blob, which needs a Storage account.
 * This consumer runs as a SINGLE instance next to the control plane, so partition ownership
 * needs no distributed arbitration — a local file is sufficient and adds no cloud dependency.
 * If the consumer is ever scaled out, swap this for the blob store: the interface is identical.
 *
 * Durability: the file lives on a mounted volume and is written atomically (tmp + rename) so a
 * crash mid-write cannot truncate it. Losing the file is not fatal — it degrades to the old
 * behaviour of replaying from EVENTHUB_START.
 */
const fs = require('fs');
const path = require('path');

const key = (c) => `${c.fullyQualifiedNamespace}|${c.eventHubName}|${c.consumerGroup}|${c.partitionId}`;

class FileCheckpointStore {
  constructor(file) {
    this.file = file;
    this.checkpoints = new Map();
    this.ownerships = new Map();
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const c of raw.checkpoints || []) this.checkpoints.set(key(c), c);
    } catch (e) {
      // Missing or corrupt → start clean; the subscribe() startPosition then applies.
      if (e.code !== 'ENOENT') console.error(`[checkpoint] unreadable (${e.message}) — starting from EVENTHUB_START`);
    }
  }

  _persist() {
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ checkpoints: [...this.checkpoints.values()] }));
      fs.renameSync(tmp, this.file); // atomic on the same filesystem
    } catch (e) {
      console.error(`[checkpoint] persist failed: ${e.message}`);
    }
  }

  async listOwnership(fullyQualifiedNamespace, eventHubName, consumerGroup) {
    return [...this.ownerships.values()].filter(
      (o) => o.fullyQualifiedNamespace === fullyQualifiedNamespace
        && o.eventHubName === eventHubName && o.consumerGroup === consumerGroup
    );
  }

  // Single instance: every claim succeeds. A real multi-owner store would arbitrate on etag.
  async claimOwnership(partitionOwnership) {
    const now = Date.now();
    const claimed = partitionOwnership.map((o) => ({ ...o, etag: String(now), lastModifiedTimeInMs: now }));
    for (const o of claimed) this.ownerships.set(key(o), o);
    return claimed;
  }

  async listCheckpoints(fullyQualifiedNamespace, eventHubName, consumerGroup) {
    return [...this.checkpoints.values()].filter(
      (c) => c.fullyQualifiedNamespace === fullyQualifiedNamespace
        && c.eventHubName === eventHubName && c.consumerGroup === consumerGroup
    );
  }

  async updateCheckpoint(checkpoint) {
    this.checkpoints.set(key(checkpoint), {
      fullyQualifiedNamespace: checkpoint.fullyQualifiedNamespace,
      eventHubName: checkpoint.eventHubName,
      consumerGroup: checkpoint.consumerGroup,
      partitionId: checkpoint.partitionId,
      sequenceNumber: checkpoint.sequenceNumber,
      offset: checkpoint.offset,
    });
    this._persist();
  }
}

module.exports = { FileCheckpointStore };
