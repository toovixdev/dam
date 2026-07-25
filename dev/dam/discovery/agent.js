/**
 * DAM Discovery Agent — runs the scanner on a schedule from inside the
 * customer network (client-net) and reports candidates to the control plane.
 *
 * Mirrors how a real in-network discovery scanner is deployed: it has L3
 * reachability to the DB subnets, fingerprints what it finds, and pushes
 * candidates over a token-gated channel (it is not a user).
 */

const os = require('os');
const { scan } = require('./scanner');

const CONTROL_PLANE = process.env.CONTROL_PLANE || 'http://dam-api:3000';
const ENROLL_TOKEN = process.env.AGENT_ENROLL_TOKEN || 'dev-agent-enroll-token';
// Stable identity so the control plane can track this scanner as a DEPLOYED
// discovery agent (heartbeat) — the Discovery page gates network scanning on it.
const AGENT_ID = process.env.AGENT_ID || `disco-${os.hostname()}`;
const AGENT_NAME = process.env.DISCOVERY_AGENT_NAME || os.hostname();
const INTERVAL = parseInt(process.env.DISCOVERY_INTERVAL || '300000', 10); // autonomous rescan, 5 min
const POLL_INTERVAL = parseInt(process.env.DISCOVERY_POLL_INTERVAL || '20000', 10); // on-demand "Run scan" pickup
const PRESET = process.env.DISCOVERY_PRESET || 'common';
const CUSTOM_PORTS = process.env.DISCOVERY_PORTS || '';
const MAX_HOSTS = process.env.DISCOVERY_MAX_HOSTS ? parseInt(process.env.DISCOVERY_MAX_HOSTS, 10) : undefined;
// What to sweep. Tokens may be hostnames, single IPs, CIDR blocks, or dashed IP
// ranges (see targets.js) — e.g. "10.40.0.0/24,10.50.0.10-40". In production a
// discovery hub sets this to the CIDR of each spoke VNet it is peered to. In dev
// these are the simulated customer DB hosts on client-net.
const TARGETS = (process.env.DISCOVERY_TARGETS || 'client-postgres,client-mysql,client-mongo')
  .split(',').map((s) => s.trim()).filter(Boolean);

const KNOWN_PRESETS = new Set(['default', 'common', 'top', 'full']);
let busy = false; // one scan at a time — autonomous and on-demand never overlap

// Run one scan against `targets` and report the candidates under `job`.
async function doScan({ job, targets, preset, customPorts }) {
  const res = await scan({ targets, preset, customPorts, maxHosts: MAX_HOSTS });
  console.log(`[discovery] ${job}: ${res.hosts} host(s) expanded, ${res.openPorts} open / ${res.scanned} probed → ${res.candidates.length} db(s)`);
  const body = {
    token: ENROLL_TOKEN,
    agent_id: AGENT_ID,
    agent_name: AGENT_NAME,
    job,
    scan_type: 'network',
    scope: targets.join(', '),
    scanned_hosts: targets,
    scanned_hosts_count: res.hosts,
    port_set: customPorts || preset,
    ports_count: res.ports.length,
    candidates: res.candidates.map((c) => ({
      endpoint: `${c.host}:${c.port}`,
      host: c.host, port: c.port,
      engine: c.engine, version: c.version,
      source: 'network', deployment_type: 'onprem',
      confidence: c.confidence,
    })),
  };
  const resp = await fetch(`${CONTROL_PLANE}/api/discovery/candidates`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const out = await resp.json().catch(() => ({}));
  console.log(`[discovery] reported ${job} → ${resp.status} ${JSON.stringify(out)}`);
}

// Autonomous sweep on the interval, using the agent's configured targets/ports.
async function runOnce() {
  if (busy) return;
  busy = true;
  try {
    await doScan({ job: 'scan-' + Date.now().toString(36), targets: TARGETS, preset: PRESET, customPorts: CUSTOM_PORTS });
  } catch (e) {
    console.log('[discovery] cycle failed:', e.message);
  } finally { busy = false; }
}

// Pick up UI-queued ("Run scan") jobs and run them on demand. Reserve the scan lock
// BEFORE claiming jobs so an autonomous cycle can't start one mid-poll.
async function pollPending() {
  if (busy) return;
  busy = true;
  try {
    let jobs = [];
    const resp = await fetch(`${CONTROL_PLANE}/api/discovery/pending`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: ENROLL_TOKEN }),
    });
    if (resp.ok) jobs = await resp.json().catch(() => []);
    for (const j of (Array.isArray(jobs) ? jobs : [])) {
      const ps = (j.port_set || '').trim();
      const preset = KNOWN_PRESETS.has(ps) ? ps : (ps ? 'custom' : PRESET);
      const customPorts = preset === 'custom' ? ps : '';
      const targets = (j.scope || '').split(',').map((s) => s.trim()).filter(Boolean);
      console.log(`[discovery] on-demand job ${j.id} (scope=${j.scope || 'default'})`);
      await doScan({ job: j.id, targets: targets.length ? targets : TARGETS, preset, customPorts });
    }
  } catch (e) {
    console.log('[discovery] on-demand poll failed:', e.message);
  } finally { busy = false; }
}

async function main() {
  const autonomous = INTERVAL > 0; // DISCOVERY_INTERVAL=0 → on-demand ("Run scan") only
  console.log('=== TooVix DAM Discovery Agent ===');
  console.log(`targets=${TARGETS.join(',')} preset=${PRESET}${CUSTOM_PORTS ? ` ports=${CUSTOM_PORTS}` : ''} · ${autonomous ? `rescan ${INTERVAL / 1000}s` : 'autonomous rescan OFF'} · on-demand poll ${POLL_INTERVAL / 1000}s`);
  await new Promise((r) => setTimeout(r, 20000)); // let the stack come up
  if (autonomous) {
    await runOnce();
    setInterval(runOnce, INTERVAL);
  }
  setInterval(pollPending, POLL_INTERVAL);
}

main();
