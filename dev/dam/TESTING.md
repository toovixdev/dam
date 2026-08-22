# SecurEra DAM — Test Suite

Functional + regression tests for the DAM stack, organised in layers so most of it runs with
**no live infrastructure**. One command runs everything:

```bash
cd dev/dam
./run-tests.sh                     # unit + component layers (no DB / no running server)
TEST_API_URL=https://dam.example TEST_TOKEN=<jwt> ./run-tests.sh   # + HTTP functional suite
```

## Layers

| Layer | Location | Runner | Needs |
|-------|----------|--------|-------|
| **API unit** — credential encryption, compliance catalog | `api/test/secrets.test.js`, `api/test/compliance-catalog.test.js` | `node --test` | nothing |
| **Consumer unit** — Cloud SQL / Azure SQL / AgentLite normalizers, noise & chunk filters | `audit-consumer/test/normalize.test.js` | `node --test` | nothing |
| **Agent unit (Go)** — masked-at-rest detection, identifier quoting | `agent/maskdetect/maskdetect_test.go` | `go test` (or Docker) | Go or Docker |
| **Functional / regression (HTTP)** — health, auth gating, download allowlist, connector heartbeat, compliance/masking/timeline shape | `api/test/functional.test.js` | `node --test` | a running API (`TEST_API_URL`) |

`main.js` starts a server and connects to Postgres/ClickHouse/Vault/NATS on load, so it can't be
imported in-process — that's why the pure logic (`secrets.js`, `compliance-catalog.js`, the agent's
`maskdetect` package, the consumer's `normalize.js`) was kept in importable modules and the
endpoint-level tests go over HTTP against a running instance.

## Running individual layers

```bash
cd dev/dam/api            && npm test          # API unit + functional (functional self-skips if no server)
cd dev/dam/audit-consumer && npm test          # consumer normalizers
cd dev/dam/agent          && go test ./maskdetect/   # agent detection (or via Docker, see run-tests.sh)
```

## Functional suite — environment

The HTTP suite is **read-only and safe against any environment**. Every test self-skips when the
API is unreachable or when the token it needs isn't set.

| Var | Purpose |
|-----|---------|
| `TEST_API_URL` | Base URL of the API (default `http://localhost:3000`) |
| `TEST_TOKEN` | A Bearer JWT — unlocks the authed read-only checks (compliance catalog, connectors, masking, events-timeline) |
| `TEST_ENROLL_TOKEN` | A tenant enroll token — unlocks the connector-heartbeat provider-validation check |

## Regression coverage (this suite locks in fixes shipped recently)

- **Credential-at-rest encryption** — round-trip, GCM tamper rejection, wrong-key rejection, legacy
  plaintext passthrough, JSONB pack/unpack, no-key no-op (`secrets.test.js`).
- **Compliance report catalog** — every report keeps its control mapping and its ClickHouse WHERE
  targets the right columns (`compliance-catalog.test.js`).
- **Masked-at-rest detection** — `XXX-XX-1234` / `****` / markers detected, real emails/names not,
  the 8-sample / 80% thresholds, per-engine identifier quoting (`maskdetect_test.go`).
- **Agentless normalizers** — Cloud SQL MySQL/PG mapping, Azure action→operation, AgentLite
  passthrough, internal-traffic noise drop, chunked-statement dedup, token gating (`normalize.test.js`).
- **API contracts** — `/api/health`, download allowlist, auth-required 401s, connector-heartbeat
  token gating + `oci` provider acceptance, events-timeline returns UTC epochs, connectors never
  leak `credential` (`functional.test.js`).

## Not yet covered (candidates for the next pass)
- React component/interaction tests (would add jsdom + a Vitest setup).
- A full mutating end-to-end flow (signup → enroll → ingest → alert) against an ephemeral stack.
- CI wiring (`.github/workflows`) to run `run-tests.sh` on every push.
