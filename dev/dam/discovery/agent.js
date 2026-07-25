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
const INTERVAL = parseInt(process.env.DISCOVERY_INTERVAL || '300000', 10); // 5 min
const PRESET = process.env.DISCOVERY_PRESET || 'common';
const CUSTOM_PORTS = process.env.DISCOVERY_PORTS || '';
const MAX_HOSTS = process.env.DISCOVERY_MAX_HOSTS ? parseInt(process.env.DISCOVERY_MAX_HOSTS, 10) : undefined;
// What to sweep. Tokens may be hostnames, single IPs, CIDR blocks, or dashed IP
// ranges (see targets.js) — e.g. "10.40.0.0/24,10.50.0.10-40". In production a
// discovery hub sets this to the CIDR of each spoke VNet it is peered to. In dev
// these are the simulated customer DB hosts on client-net.
const TARGETS = (process.env.DISCOVERY_TARGETS || 'client-postgres,client-mysql,client-mongo')
  .split(',').map((s) => s.trim()).filter(Boolean);

async function runOnce() {
  const job = 'scan-' + Date.now().toString(36);
  try {
    const res = await scan({ targets: TARGETS, preset: PRESET, customPorts: CUSTOM_PORTS, maxHosts: MAX_HOSTS });
    console.log(`[discovery] ${job}: ${res.hosts} host(s) expanded, ${res.openPorts} open / ${res.scanned} probed → ${res.candidates.length} db(s)`);

    const body = {
      token: ENROLL_TOKEN,
      agent_id: AGENT_ID,
      agent_name: AGENT_NAME,
      job,
      scan_type: 'network',
      scope: TARGETS.join(', '),
      scanned_hosts: TARGETS,
      scanned_hosts_count: res.hosts,
      port_set: CUSTOM_PORTS || PRESET,
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
    console.log(`[discovery] reported → ${resp.status} ${JSON.stringify(out)}`);
  } catch (e) {
    console.log('[discovery] cycle failed:', e.message);
  }
}

async function main() {
  console.log('=== TooVix DAM Discovery Agent ===');
  console.log(`targets=${TARGETS.join(',')} preset=${PRESET}${CUSTOM_PORTS ? ` ports=${CUSTOM_PORTS}` : ''} every ${INTERVAL / 1000}s`);
  await new Promise((r) => setTimeout(r, 20000)); // let the stack come up
  await runOnce();
  setInterval(runOnce, INTERVAL);
}

main();
