/**
 * DAM Discovery Agent — runs the scanner on a schedule from inside the
 * customer network (client-net) and reports candidates to the control plane.
 *
 * Mirrors how a real in-network discovery scanner is deployed: it has L3
 * reachability to the DB subnets, fingerprints what it finds, and pushes
 * candidates over a token-gated channel (it is not a user).
 */

const { scan } = require('./scanner');

const CONTROL_PLANE = process.env.CONTROL_PLANE || 'http://dam-api:3000';
const ENROLL_TOKEN = process.env.AGENT_ENROLL_TOKEN || 'dev-agent-enroll-token';
const INTERVAL = parseInt(process.env.DISCOVERY_INTERVAL || '300000', 10); // 5 min
const PRESET = process.env.DISCOVERY_PRESET || 'common';
const CUSTOM_PORTS = process.env.DISCOVERY_PORTS || '';
// Hosts to sweep. In dev these are the simulated customer DB hosts on client-net.
const TARGETS = (process.env.DISCOVERY_TARGETS || 'client-postgres,client-mysql,client-mongo')
  .split(',').map((s) => s.trim()).filter(Boolean);

async function runOnce() {
  const job = 'scan-' + Date.now().toString(36);
  try {
    const res = await scan({ targets: TARGETS, preset: PRESET, customPorts: CUSTOM_PORTS });
    console.log(`[discovery] ${job}: ${res.openPorts} open / ${res.scanned} probed → ${res.candidates.length} db(s)`);

    const body = {
      token: ENROLL_TOKEN,
      job,
      scan_type: 'network',
      scope: TARGETS.join(', '),
      scanned_hosts: TARGETS,
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
