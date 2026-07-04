/**
 * DAM Discovery Scanner — network database discovery.
 *
 * Two phases, deliberately decoupled:
 *   1. Port scan      — TCP-connect to the configured port set, keep the OPEN ones.
 *   2. Fingerprint    — speak each DB's wire-protocol handshake against every open
 *                       port and identify the engine by what answers, NOT by the
 *                       port number. So a Postgres on :48291 is still identified.
 *
 * Built-ins only (net/tls) so the scanner has no dependency footprint.
 */

const net = require('net');
const { expandPortSet } = require('./portsets');

const DEFAULTS = { connectTimeout: 800, fingerprintTimeout: 1500, concurrency: 200 };

// ── Phase 1: is the port open? ──────────────────────────────
function probePort(host, port, timeout) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (open) => { if (done) return; done = true; sock.destroy(); resolve(open); };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false)); // closed / filtered / refused
    sock.connect(port, host);
  });
}

// ── Phase 2: fingerprinters ─────────────────────────────────
// Each returns { engine, version|null, confidence } or null. They either send a
// protocol-specific probe and read the reply, or (MySQL) just read the greeting
// the server volunteers on connect.

// MySQL/MariaDB volunteer a handshake packet immediately on connect:
//   [3B payload len][1B seq][1B protocol=0x0a][server-version cstring]...
function fingerprintMySQL(host, port, timeout) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (r) => { if (done) return; done = true; sock.destroy(); resolve(r); };
    sock.setTimeout(timeout);
    sock.once('timeout', () => finish(null));
    sock.once('error', () => finish(null));
    sock.once('data', (buf) => {
      if (buf.length < 6 || buf[4] !== 0x0a) return finish(null); // protocol v10
      const end = buf.indexOf(0x00, 5);
      const version = end > 5 ? buf.slice(5, end).toString('latin1') : null;
      const engine = version && /maria/i.test(version) ? 'mariadb' : 'mysql';
      finish({ engine, version, confidence: 'high' });
    });
    sock.connect(port, host);
  });
}

// PostgreSQL: client speaks first. Send an SSLRequest (len=8, code=80877103);
// Postgres uniquely replies with a single byte 'S' (TLS available) or 'N'.
function fingerprintPostgres(host, port, timeout) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (r) => { if (done) return; done = true; sock.destroy(); resolve(r); };
    sock.setTimeout(timeout);
    sock.once('timeout', () => finish(null));
    sock.once('error', () => finish(null));
    sock.once('connect', () => {
      const req = Buffer.alloc(8);
      req.writeInt32BE(8, 0);
      req.writeInt32BE(80877103, 4); // 0x04D2162F SSLRequest magic
      sock.write(req);
    });
    sock.once('data', (buf) => {
      const c = buf[0];
      if (c === 0x53 /* S */ || c === 0x4e /* N */) {
        finish({ engine: 'postgres', version: null, confidence: 'high', tls: c === 0x53 });
      } else {
        finish(null);
      }
    });
    sock.connect(port, host);
  });
}

// MongoDB: legacy OP_QUERY (opcode 2004) of admin.$cmd {isMaster:1}. A reply with
// header opCode 1 (OP_REPLY) confirms MongoDB; maxWireVersion → approx version.
const WIRE_TO_VERSION = { 6: '3.6', 7: '4.0', 8: '4.2', 9: '4.4', 13: '5.0', 17: '6.0', 21: '7.0', 25: '8.0' };
function fingerprintMongo(host, port, timeout) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (r) => { if (done) return; done = true; sock.destroy(); resolve(r); };
    sock.setTimeout(timeout);
    sock.once('timeout', () => finish(null));
    sock.once('error', () => finish(null));
    sock.once('connect', () => sock.write(buildIsMasterQuery()));
    sock.once('data', (buf) => {
      if (buf.length < 16) return finish(null);
      const opCode = buf.readInt32LE(12);
      if (opCode !== 1) return finish(null); // OP_REPLY
      let version = null;
      const m = buf.indexOf(Buffer.from('maxWireVersion'));
      if (m !== -1 && m + 15 < buf.length) {
        const wire = buf.readInt32LE(m + 'maxWireVersion'.length + 1);
        version = WIRE_TO_VERSION[wire] || null;
      }
      finish({ engine: 'mongodb', version, confidence: 'high' });
    });
    sock.connect(port, host);
  });
}

function buildIsMasterQuery() {
  // BSON for { isMaster: 1 }
  const key = Buffer.from('isMaster\0', 'latin1');
  const bson = Buffer.alloc(4 + 1 + key.length + 4 + 1);
  let o = 0;
  bson.writeInt32LE(bson.length, o); o += 4;
  bson.writeUInt8(0x10, o); o += 1;             // type int32
  key.copy(bson, o); o += key.length;           // key cstring
  bson.writeInt32LE(1, o); o += 4;              // value
  bson.writeUInt8(0x00, o);                      // doc terminator

  const ns = Buffer.from('admin.$cmd\0', 'latin1');
  const body = Buffer.concat([
    int32(0),          // flags
    ns,                // fullCollectionName
    int32(0),          // numberToSkip
    int32(-1),         // numberToReturn
    bson,              // query
  ]);
  const header = Buffer.concat([int32(16 + body.length), int32(1), int32(0), int32(2004)]);
  return Buffer.concat([header, body]);
}
function int32(n) { const b = Buffer.alloc(4); b.writeInt32LE(n, 0); return b; }

const FINGERPRINTERS = [fingerprintMySQL, fingerprintPostgres, fingerprintMongo];

async function fingerprint(host, port, timeout) {
  for (const fp of FINGERPRINTERS) {
    const r = await fp(host, port, timeout); // sequential: each owns its own socket
    if (r) return { host, port, source: 'network', ...r };
  }
  return { host, port, source: 'network', engine: 'unknown', version: null, confidence: 'low' };
}

// ── Orchestration ───────────────────────────────────────────
async function pool(items, worker, concurrency) {
  const results = [];
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) { const idx = i++; results[idx] = await worker(items[idx]); }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Scan hosts for databases.
 * @param {{targets: string[], preset?: string, customPorts?: string,
 *          connectTimeout?: number, fingerprintTimeout?: number, concurrency?: number}} config
 * @returns {Promise<{ports: number[], scanned: number, candidates: object[]}>}
 */
async function scan(config) {
  const opts = { ...DEFAULTS, ...config };
  const ports = expandPortSet({ preset: config.preset, customPorts: config.customPorts });
  const targets = config.targets || [];

  const work = [];
  for (const host of targets) for (const port of ports) work.push({ host, port });

  const openFlags = await pool(work, ({ host, port }) => probePort(host, port, opts.connectTimeout), opts.concurrency);
  const open = work.filter((_, idx) => openFlags[idx]);

  const fingerprints = await pool(open, ({ host, port }) => fingerprint(host, port, opts.fingerprintTimeout), opts.concurrency);
  const candidates = fingerprints.filter((c) => c.engine !== 'unknown');

  return { ports, scanned: targets.length * ports.length, openPorts: open.length, candidates };
}

module.exports = { scan, probePort, fingerprint, expandPortSet };

// ── CLI: node scanner.js --targets a,b --preset common [--ports "5432,3300-3400"] ──
if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : undefined; };
  const targets = (get('--targets') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const preset = get('--preset') || 'common';
  const customPorts = get('--ports');
  if (!targets.length) { console.error('usage: node scanner.js --targets host1,host2 [--preset default|common|top|full|custom] [--ports "5432,3300-3400"]'); process.exit(1); }

  console.log(`[discovery] scanning ${targets.length} host(s), preset=${preset}${customPorts ? ` ports=${customPorts}` : ''}`);
  scan({ targets, preset, customPorts }).then((res) => {
    console.log(`[discovery] ${res.openPorts} open / ${res.scanned} probed → ${res.candidates.length} database(s):`);
    for (const c of res.candidates) {
      console.log(`  ${c.host}:${c.port}\t${c.engine}${c.version ? ' ' + c.version : ''}\t(${c.confidence})`);
    }
  }).catch((e) => { console.error('[discovery] scan failed:', e.message); process.exit(1); });
}
