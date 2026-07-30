# VA Scanner — Design & Scope

**Status:** **Phase 1 shipped (2026-07-30).** A real, agent-executed check engine runs read-only
CIS-derived checks for **MySQL + PostgreSQL** (~18 + ~15 checks: config, privilege, auth, TLS,
logging), upserts drift-tracked `va_findings`, and drives a **Vulnerability Assessment** page, the
`REPORTS.va` findings report, and the `iso.va`/`rbi.va` compliance controls (real scan state, not a
scheduled-report proxy). The `va-scanner` flag is GA. Phases 2–3 below (more engines, scheduled
scans + trend, version-EOL/CVE, Evidence-Pack PDF) remain future work.

---

## 1. What "VA" means for a DAM (scope boundaries)

A DAM's vulnerability assessment is **database security assessment** — configuration, privilege,
and version posture of the database *engine and instance* — not OS/host or network scanning. This
is the same category as Oracle DBSAT, Trustwave AppDetectivePRO, Imperva Scuba, and the **CIS
Database Benchmarks**.

**In scope**
- **Misconfiguration checks** — auditing off, TLS not enforced, `local_infile` on, symlinks, weak
  password policy, insecure defaults, backup/log exposure, world-readable data dirs (where visible).
- **Privilege / access checks** — excessive grants, `PUBLIC`/`%` host grants, default/unused/locked
  accounts, `WITH GRANT OPTION` sprawl, superuser count, roles that can read all data.
- **Authentication checks** — default or empty passwords, deprecated auth plugins, password
  lifetime/rotation policy.
- **Encryption checks** — TDE / at-rest, TLS version + cipher, `require_secure_transport`.
- **Version / patch currency** — engine version vs. a known **EOL / minimum-supported** table, and
  (v2) mapped **CVEs** for that version.

**Out of scope (call these out explicitly so we don't over-promise "6000+ tests / CIS, PCI-DSS")**
- OS/kernel CIS-CAT, container/image scanning, network port scanning, web/app DAST.
- Live exploitation. Everything here is **read-only, authenticated** assessment.

---

## 2. Architecture fit — reuse the agent + classification path

A VA scan is *the same shape as classification*: log into the DB as a **least-privilege reader**
(`dam_svc`), run **read-only catalog/config queries**, evaluate, ship results. So it slots straight
into the existing agent model with almost no new infrastructure.

```
 ┌ agent (any capture mode) ────────────────────────────────┐
 │  vaScanLoop()  ── read-only checks over the DB conn ──►   │  POST /api/va/scan-results
 │  (reuses DB_USER/DB_PASSWORD + eventsDbFor host)          │      (enroll-token authed)
 └──────────────────────────────────────────────────────────┘            │
                                                                          ▼
                          control plane ── va_scans / va_findings (Postgres) ── VA UI + Compliance
```

- **Executor lives in the agent** (`dev/dam/agent`), next to `classifyLoop`/`scanTriggerLoop`. It
  already holds a DB login and reachability (incl. private / no-public-IP DBs, TLS, PaaS collectors).
- **Trigger** mirrors classification exactly: a per-tenant `vaScanRequested` set + a
  `GET /api/va/scan-pending?token=…` the agent polls (see the classification `scanRequested` /
  `/api/classification/scan-pending` pattern), plus a scheduled cadence.
- **Results** POST to a new `/api/va/scan-results` (enroll-token authed, like
  `/api/classification/scan-results`), which upserts `va_findings`.
- Some checks need slightly more than the `SELECT, PROCESS` reader grant (e.g. `mysql.user`,
  `pg_authid`, `sys.configurations`). Define an **optional elevated read role** and degrade
  gracefully (status `error: insufficient_privilege`) when it's absent — never fail the whole scan.

---

## 3. The check engine + benchmark library (the core work)

**Approach: a native, per-engine check library.** Do **not** bolt on CIS-CAT (OS-oriented, Java,
CIS-CAT Pro needs paid membership) or OpenSCAP (SCAP/host content). DB-config VA is parameterized
catalog queries — that's what every DB VA tool actually does, and it fits the agent (pure Go, no
external deps, works air-gapped).

Each check is a declarative record:

```jsonc
{
  "id": "cis-mysql-4.3",
  "engine": "mysql",
  "benchmark": "CIS MySQL 8.0 v1.0",
  "section": "4.3",
  "title": "Ensure 'local_infile' is disabled",
  "severity": "high",
  "query": "SHOW VARIABLES LIKE 'local_infile'",
  "expect": { "op": "equals", "column": "Value", "value": "OFF" },
  "remediation": "SET GLOBAL local_infile = 0;  # and persist in my.cnf",
  "refs": ["CIS MySQL 8.0 §4.3", "PCI-DSS 2.2.5"]
}
```

- Checks are **data, not code** → adding coverage is adding rows, and each maps to CIS section +
  framework refs (PCI/HIPAA/…) so findings roll up into the Compliance Center.
- The engine evaluates `expect` against the query rows → `pass | fail | error`, attaches captured
  evidence (the actual value), severity, and remediation.
- Source of truth: the **CIS Database Benchmarks** (freely published) for MySQL/MariaDB, PostgreSQL,
  SQL Server, Oracle, MongoDB. A realistic **core set is ~40–70 checks per engine** (not "6000+").

---

## 4. Data model (Postgres, tenant-scoped)

```sql
CREATE TABLE va_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID, database_id UUID, instance_id UUID,
  engine VARCHAR(40), benchmark VARCHAR(80),
  status VARCHAR(20),                 -- running | complete | error
  checks_run INT, passed INT, failed INT, errored INT,
  score INT,                          -- % checks passed, severity-weighted
  started_at TIMESTAMPTZ DEFAULT now(), finished_at TIMESTAMPTZ,
  trigger VARCHAR(20)                 -- manual | scheduled
);

CREATE TABLE va_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID, database_id UUID, scan_id UUID,
  check_id VARCHAR(60), benchmark VARCHAR(80), section VARCHAR(20),
  title VARCHAR(200), severity VARCHAR(15),   -- critical|high|medium|low|info
  status VARCHAR(15),                          -- fail | pass | error
  detail TEXT, evidence TEXT, remediation TEXT, refs TEXT[],
  first_seen TIMESTAMPTZ DEFAULT now(), last_seen TIMESTAMPTZ DEFAULT now(),
  waived BOOLEAN DEFAULT false, waiver_note VARCHAR(400), waived_by VARCHAR(200),
  UNIQUE (tenant_id, database_id, check_id)   -- upsert; track first/last-seen + drift
);
```

Upsert on `(tenant_id, database_id, check_id)` gives **drift over time** (first_seen / last_seen /
resolved), and `waived` gives risk-acceptance without deleting the finding.

---

## 5. UI

- **New "Vulnerability Assessment" page** (main app): posture score per database, findings grouped
  by severity + benchmark section, remediation, "Run scan" button, per-finding **waive**, and trend.
  Gated on the existing `va-scanner` flag (finally wired to something real).
- **Replace `REPORTS.va`** — the placeholder becomes a real findings report (severity histogram,
  top failed checks, remediation) and can flow into the **signed Evidence Pack PDF**.
- Admin: per-tenant scan coverage in Tenant Health.

---

## 6. Compliance wiring (closes the honesty gap)

Today `iso.va` / `rbi.va` pass on *"a report is scheduled"* (`vaSched`) — which overstates VA
coverage. Rewire them to **real scan state**:

```
iso.va / rbi.va = meas( lastScanAge ≤ 90d  AND  openCriticalFindings == 0 )
```

with evidence like `"last VA scan 3d ago · 2 high, 0 critical open across 6 databases."` Now the
control reflects an assessment that actually ran, and findings become first-class compliance
evidence (each check already carries its PCI/CIS refs).

---

## 7. Phasing & rough effort

| Phase | Scope | Effort |
|---|---|---|
| **0 — Make it honest now** | Soften the "6000+ tests / GA" copy + the `va-scanner` flag; flip `iso.va`/`rbi.va` to attestation-backed (or gap) so nothing implies scanning that isn't happening. | ~0.5 day |
| **1 — MVP** | `va_scans`/`va_findings` schema + ingestion endpoints; agent `vaScanLoop` for **MySQL + PostgreSQL**; ~30 CIS-derived config/privilege/auth checks each; on-demand "Run scan" trigger; basic Findings UI; replace `REPORTS.va`; wire `iso.va`/`rbi.va` to real scan state. | ~1.5–2 wks |
| **2 — Breadth** | **SQL Server, Oracle, MongoDB** check libraries; scheduled scans + trend/drift; **version EOL/min-version** currency check (bundled dataset); waivers; remediation + findings in the signed Evidence Pack PDF; severity-weighted score + benchmark coverage %. | ~2–3 wks |
| **3 — Depth** | **CVE mapping** from engine version (bundled feed, refreshed periodically); per-framework benchmark profiles (PCI vs CIS vs HIPAA); per-check attestation/exception workflow; signed CSV/PDF export; scan-on-discovery. | ~2–3 wks |

Recommended first ship: **Phase 0 immediately** (honesty), then **Phase 1** as the credible MVP.

---

## 8. Key decisions to confirm

1. **Native check library vs. external engine** — recommend native (fits the agent, no license, air-gap-safe). CIS-CAT/OpenSCAP only if OS-level host scanning is also wanted (different product).
2. **Elevated read role** — accept a small extra grant beyond `dam_svc` for full coverage, or cap the MVP to checks the existing reader can see (fewer checks, zero new privilege).
3. **CVE currency** — bundled/periodic dataset (simple, offline) vs. a live feed (NVD/vendor; network + maintenance). Recommend bundled for v2, live for v3.
4. **Agent-executed vs. control-plane-executed** — recommend agent (already has reachability + creds, covers private/PaaS). Control-plane execution would require DAM to hold DB creds and reach every DB — a posture regression.

---

## 9. Integration points (existing code this touches)

- **Agent** (`dev/dam/agent`): `main.go` `loadConfig` (add `VA_SCAN` toggle), new `va_scan.go`
  modeled on `classifyLoop`/`scanTriggerLoop`; per-engine catalog queries.
- **Control plane** (`dev/dam/api/main.js`): `va_scans`/`va_findings` DDL; `POST /api/va/scan-results`,
  `GET /api/va/scan-pending`, `POST /api/va/scan` (trigger); `GET /api/va/findings`; wire
  `va-scanner` flag; rewrite `REPORTS.va`; update `complianceMetrics`/`buildFrameworks`
  (`iso.va`/`rbi.va`).
- **Frontend** (`dev/dam/frontend`): new VA page + nav; Compliance evidence links; Reports.
- **Marketing** (`Home.jsx`, feature-flag description): align claims with real coverage.
</content>
