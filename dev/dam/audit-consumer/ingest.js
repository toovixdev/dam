// Shared, stateless bridge to the control plane. POST /api/agents/events resolves the tenant
// from the envelope's enroll token and writes the per-tenant ClickHouse events — so no DB or
// ClickHouse logic lives in the consumer; every source funnels through here.
const CONTROL_PLANE = (process.env.CONTROL_PLANE || 'http://dam-api:3000').replace(/\/+$/, '');

async function postEvents(body) {
  const res = await fetch(`${CONTROL_PLANE}/api/agents/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ingest ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Liveness ping: refreshes the cloud connector's heartbeat WITHOUT writing any events. Keeps an
// idle-but-connected managed DB marked "monitored" (see /api/agents/connector-heartbeat).
async function postConnectorHeartbeat({ token, provider }) {
  const res = await fetch(`${CONTROL_PLANE}/api/agents/connector-heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, provider }),
  });
  if (!res.ok) throw new Error(`heartbeat ${res.status}`);
  return res.json();
}

module.exports = { postEvents, postConnectorHeartbeat, CONTROL_PLANE };
