# DAM Platform — Knowledge Base

> **Purpose:** Single source of truth for building a new **Database Activity Monitoring (DAM)** product that ships as **multi-tenant SaaS** *and* as a **single-tenant / on-premises (air-gapped capable)** deployment.
> **Sources consolidated:** `Complete Architecture and Design.docx`, `DAM TS.xlsx` (customer RFP / minimum technical specifications), and `/screen` UI walkthrough captures.
> **Companion docs:** [DAM-Feature-Specification.md](DAM-Feature-Specification.md) — every feature expanded into sub-features + use cases + rules (16 categories, F1.1–F16.5). Mockup design system captured in [mockups/assets/app.css](mockups/assets/app.css) (9 themes, dual dark/light per D16).
> **Status:** Living document. Open questions for the solution architect are collected in [§14](#14-open-questions--architect-decisions).

---

## Decisions Log (locked 2026-06-21)

| # | Decision | Implication |
|---|---|---|
| **D1** | **ITSM = phased.** Build DAM core first; satisfy ITSM via **bi-directional integration** (ServiceNow/Jira) + a lightweight case/SLA layer. Native ITIL-4 ITSM/CMDB suite is a **later phase**. | Keeps v1 focused on DAM. RFP ITSM clauses (#90–#130) addressed via integration at GA; native module deferred. |
| **D2** | **The `/screen` product is a competitor to displace** — not our UI. Build a **better** UX; use it only as feature/IA reference. | Fresh design system; we can improve on its IA (Active Defense, Quarantine, DSAR, Compliance Center concepts are validated market features worth beating). |
| **D3** | **Both capture postures at GA:** passive out-of-band monitoring **and** inline **DAM Proxy Gateway** blocking/quarantine. | Satisfies RFP #50/#51 (Monitoring + Blocking modes) at launch. Inline path needs its own latency budget + HA design. |
| **D4** | **GA engine set:** Oracle, SQL Server, MySQL/MariaDB, PostgreSQL, MongoDB, **IBM Db2**. Further engines per architect recommendation (see [§7.1](#71-engine-roadmap-recommendation)). | Six engines at GA. Each = Parser + capture + VA library + privilege profiles. |
| **D5** | **Multi-cloud from day 1.** Launch on 2+ clouds; build the provider-abstraction layer up front (messaging, secrets, blob, KMS). | Highest flexibility; abstraction interfaces are now a GA requirement, not a later refactor. Aligns with D7. |
| **D6** | **India in-country data plane at GA.** Stand up an India data-plane region at launch. | Required for BFSI/Gov tenders + RBI/DPDPA. Multi-region routing (via `tenants.data_plane_region`) is GA-critical. |
| **D7** | **Single abstraction-layer codebase** for SaaS + on-prem parity (one codebase, provider interfaces; no fork). | Avoids drift; on-prem swaps Event Hubs→Kafka, Key Vault→Vault, Blob→MinIO behind the same interfaces. |
| **D8** | **BYOK at GA across all major KMS:** Azure Key Vault, AWS KMS, GCP KMS, OCI Vault, HashiCorp Vault. | `encryption_key_uri` stays provider-neutral; all five KMS integrations are GA scope. |
| **D9** | **Deception Console = post-GA** premium differentiator (not table-stakes). | Keeps GA focused on core DAM. |
| **D10** | **DSAR in scope at GA as a thin workflow** over classification data (DPDPA/GDPR access + erasure). | Strong India compliance story, bounded build. |
| **D11** | **Mobile app = fast-follow** after GA (web-first). | Critical alerts + approvals + exec dashboards ship shortly after web GA. |
| **D12** | **Data masking: dynamic + static at GA.** Dynamic for non-privileged users; static for non-prod. | Fully meets RFP #9/#30. Adds masking engine + proxy integration to GA. |
| **D13** | **#57 native-audit handling = per-customer toggle.** Configurable per deployment whether native audit is used. | Flexible coverage incl. PaaS; needs clear config + test matrix + documented coverage trade-offs per mode. |
| **D14** | **Inline proxy fail mode = fail-open by default, per-policy fail-closed** (for crown-jewel DBs). | Balances availability vs enforcement; per-policy override drives proxy HA design. |
| **D15** | **GA integrations:** SIEM = **Splunk + Sentinel**; ITSM = **ServiceNow**; Notify = **Slack + Teams + Email**; Identity = **Azure AD + Okta + LDAP/AD/Kerberos** (+ RADIUS per #79). | Others (QRadar, Chronicle, Jira, PagerDuty, SMS) fast-follow. |
| **D16** | **UI = dual theme (dark + light), user-selectable.** Modern, ops-focused, competitor-displacing. | Dark for SOC/analysts, light for compliance/exec buyers. More design/build effort budgeted. |

---

## Implementation Status (updated 2026-06-27)

> Snapshot of what is actually built in the working codebase under `dev/`. Detailed,
> append-only engineering log lives in **[dev/dam/BUILD-LOG.md](dev/dam/BUILD-LOG.md)** — keep
> that file updated as development proceeds; this section is the high-level mirror.

**Running stack** (`dev/docker-compose.yml`, 13 containers): React SPA `dam-react` (Vite, :5173),
Express API `dam-api` (:3000), Postgres control plane (`dam_control`, 11 tables), ClickHouse
analytics, Redis, NATS, plus 3 seeded **client DBs** (PG-CRM-PROD, MYSQL-PAYMENTS-PROD,
MONGO-PROFILES-UK) — preserved, never reset. Seeded admin: `vikramsharma3107@gmail.com` / `Admin@123`.

**Main app — frontend (`dev/dam/frontend`)**: all 23 routed screens now build and render. The
9 screens that were imported but missing (and broke the Vite build) were implemented 2026-06-27 to
mockup fidelity using the app's React component vocabulary (Layout/PageHeader/KpiCard/DataTable/
TabNav/Modal/Badge + `useApiData`): **Active Defense, Discovery, Masking, Access Governance, LLM
Monitoring, Reports, Settings, Profile, Support**. Added a shared `Toast` and an app-wide
**timezone** preference (header clock + picker, synced to Profile; `src/hooks/useTimezone.js`).
Real wiring where endpoints exist (auth/me, change-password, databases, agents, dashboard);
presentational screens use inline demo data (same pattern as `Compliance`/`Classification`).

**Backend (`dev/dam/api/main.js`)**: auth (JWT + Azure AD SSO), RBAC middleware, dashboard
aggregations + fleet-risk score, CRUD for databases/agents/alerts/policies/classification/DSAR/
users, audit trail, WebSocket live feed. No destructive DDL; client DBs/configs untouched.

**Databases screen aligned to mockup (2026-06-27)**: `databases` got additive columns
`environment`, `sensitivity_tags[]` (also `capture_modes[]`, now unused). `GET /api/databases`
returns a shaped row (deployment label + PaaS flag, monitoring pills, coverage {net,host,pull,push},
sensitivity, status, last_event from ClickHouse) where **monitoring/coverage/status are derived live
from the real `agents` table**, not stored. `POST /api/databases` is auth-scoped to the caller's
tenant. Frontend rebuilt to 5 KPIs + engine/text filters + 10-col table + detail & 3-mode register
modals + CSV export. **Reflects real data only**: the screen shows just the 3 actually-running,
container-backed client DBs (PG-CRM-PROD/MySQL-PAYMENTS-PROD/MONGO-PROFILES-UK); an earlier pass had
seeded 16 fictional DBs and they were removed. Details: BUILD-LOG §9e.

**User invitations (email)**: `POST /api/users` (admin) now generates a single-use, 7-day invite
token and emails the invitee an `/accept-invite?token=…` link via **nodemailer SMTP**
(provider-agnostic; dev with no `SMTP_HOST` logs the link instead of sending). Public
`GET /api/invites/:token` + `POST /api/invites/:token/accept` back a new `/accept-invite` page;
`POST /api/users/:id/resend-invite` re-sends. Additive `users` columns (`invite_token`,
`invite_expires_at`, `invited_by`). Configure `SMTP_*` + `APP_BASE_URL` (see `dev/.env.example`)
and rebuild `dam-api` for real delivery. Details: BUILD-LOG §9c. The Add User modal also offers an
**Account type** toggle — *Local* (password invite) or *Azure AD (SSO)*: AD users are created with
`auth_provider='azure_ad'`, no password/token, and authenticate via the existing Azure AD SSO
callback; they get an SSO access email pointing at `/login` instead of a token link. BUILD-LOG §9d.

**Agent deployment (Deploy-monitoring screen)**: the Agents & Coverage page now has a real
**Deploy monitoring** panel — pick a database, choose 1/2/3 capture modes (Network / Host / Inline
Proxy) via presets (Lightweight / Full visibility / Enforce / Crown jewel) or multi-select, with a
**live coverage preview** (networked vs local/IPC visibility, attribution, blocking, path-change,
container count) and a PaaS guardrail that steers managed DBs to agentless. Deploy creates real
`agents` rows (`POST /api/agents`, now auth-scoped; `inline_proxy` recognised), which immediately
flow into the Databases monitoring/coverage/status (all derived from the live agents table). Full
design rationale in [§7.2](#72-agent-capture-modes--deployment-model--posture-guidance).

**Go agent — increment 1 built** (BUILD-LOG §9j): one Go image (`dev/dam/agent`, pure stdlib),
`MODE`-selectable, built locally by compose (**no registry needed for dev**; prod pushes to a
registry the customer env pulls from). **MODE=proxy for MySQL** works end-to-end: the agent
**self-enrolls** (`POST /api/agents/enroll`, token-gated, find-or-creates the `db_instances` row) +
**heartbeats** (`/heartbeat`; a 60s reaper marks stale agents offline), and the inline proxy decodes
the MySQL wire protocol — extracting the **real login user** + **SQL** (handles MySQL 8 query
attributes) → events to ClickHouse with `agent_type='inline_proxy'`, attribution, operation, and
sensitivity tags. **Increment 2 (BUILD-LOG §9k):** the MySQL agent now does **continuous capture**
(live `traffic-gen` routed through the proxy) and **inline blocking** — a `COM_QUERY` matching a
deny rule (`BLOCK_PATTERNS`) is dropped, a MySQL ERR is returned to the client, and a "Blocked by
policy" alert is raised (`POST /api/agents/alert`). PG/Mongo + the old collector are stopped for a
MySQL-only focus. Verified: `DROP TABLE` blocked (table survives) + alert on the Alerts screen.
Limits: TLS content needs proxy TLS-termination (demo used `--ssl-mode=DISABLED`); postgres/mongo
decoders, column/role-aware policy, and NATS publish are later increments. **Increment 3
(BUILD-LOG §9l):** `MODE=network` now does **real passive capture** — a pure-Go `AF_PACKET` raw
socket sniffs the DB's NIC (container shares `client-mysql`'s net namespace), decodes the MySQL wire
protocol, and captures with attribution + tags, running in parallel with the proxy (instance shows
**Network + Inline Proxy** coverage). **Host (eBPF) mode** stays a stub on macOS — to be validated
for real on a Linux VM (no eBPF on Docker Desktop). So 2 of the 3 installable modes are real in dev.

**First-class instance model** (BUILD-LOG §9h→§9i) — **now realizes the canonical
[§10.2](#102-asset-inventory--classification-7-tables) `db_instances` design** (the central asset
registry was always the intended model; the build was conflating server + schema and is now
corrected). An **instance** (`host:port` server) owns **databases/schemas**, and **agents enroll on
the instance**, so all its databases share coverage and new ones are auto-covered. Schema is
additive (`db_instances` + `instance_id` on databases/agents, with backfill grouping existing rows
by `(host,port,engine)`). API: `GET/POST/DELETE /api/instances` (instance delete **cascades** to its
databases + agents), `POST /api/databases` adds a schema to an instance, `DELETE /api/databases/:id`
removes a schema, agents enroll per `instance_id`. UI: Databases page has **Instances + Databases**
tabs with register-instance, add-database, decommission (instance cascade / database) flows; the
Agents deploy modal targets instances. Display convention: **instance name = host**, with `host:port`
shown as the endpoint (uniform across engines). This `(host:port)` instance is the natural `TARGET`
unit for the Go agents.

> Simplifications vs the full §10.2 design (future work): clusters (`topology_type` /
> `parent_instance_id` for RAC/AG/replica-set), `engine_metadata JSONB`, `db_groups`, and
> object-level inventory via `object_classifications` are not yet implemented — the build uses a flat
> `databases` table for schemas under an instance.

**Capture Modes & Coverage page** (`/capture-modes`, BUILD-LOG §9g): a learn-then-deploy reference —
the "who sees what by path" matrix, the "what each combination buys" matrix, and an "applicable by
deployment type" table (IaaS/on-prem install agents; PaaS → agentless). Posture preset cards
("Deploy this →") hand off to the Agents deploy panel pre-selected via `/agents?deploy=1&modes=…`.

**Not yet built / deferred**: admin app (separate, out of current scope); persistence for the
demo-only screens (masking rules, access entitlements, support tickets, discovery approvals);
timezone applied to in-table timestamps (currently header/Profile only); other notification
channels (Slack/Teams/webhook) — only transactional invite email exists so far. See BUILD-LOG §8/§9b/§9c.

**Gotcha for contributors**: `dam-react` bind-mounts only `src/` + `index.html` (source hot-
reloads; **`node_modules` does not**) — rebuild after any `package.json` change with
`docker compose -f dev/docker-compose.yml up -d --build dam-react`. `dam-api` has no source mount
and runs plain `node main.js`, so backend edits also require a rebuild/restart.

---

## Table of Contents
1. [Product Vision & Business Outcomes](#1-product-vision--business-outcomes)
2. [Users & Personas](#2-users--personas)
3. [Channels & Access](#3-channels--access)
4. [Core Capabilities](#4-core-capabilities)
5. [High-Level Architecture (3 Zones)](#5-high-level-architecture-3-zones)
6. [Application Components](#6-application-components)
7. [Supported Database Engines & Capture](#7-supported-database-engines--capture)
8. [Technology Stack](#8-technology-stack)
9. [Hosting / Deployment Models](#9-hosting--deployment-models)
10. [Control Plane Data Model (PostgreSQL)](#10-control-plane-data-model-postgresql)
11. [Data Plane Data Model (ClickHouse)](#11-data-plane-data-model-clickhouse)
12. [UI / Screen Inventory](#12-ui--screen-inventory)
13. [RFP / Tender Compliance Requirements](#13-rfp--tender-compliance-requirements)
13A. [Competitive Feature Gaps — Beyond the RFP](#13a-competitive-feature-gaps--beyond-the-rfp)
14. [Open Questions / Architect Decisions](#14-open-questions--architect-decisions)
15. [Glossary](#15-glossary)

---

## 1. Product Vision & Business Outcomes

A multi-tenant SaaS platform (also deployable on customer cloud / on-prem) that **continuously monitors database activity, classifies sensitive data, assesses vulnerabilities, and learns user & application behaviour** to detect anomalies across enterprise database fleets — engine-neutral and cloud-neutral.

**Four business outcomes the product sells on:**

| Outcome | What it delivers |
|---|---|
| **Risk Reduction** | Discovers unknown databases, detects misconfigurations, surfaces over-privileged accounts, flags anomalous behaviour — early visibility into insider threats, credential abuse, external attacks. |
| **Compliance** | Demonstrable automated compliance with PCI-DSS, HIPAA, SOX, GDPR, DPDPA. Pre-built reports, sensitive-data classification, immutable audit trails, continuous control validation. |
| **Breach Prevention** | Real-time monitoring of every DB access; behavioural baselines catch compromised accounts; anomaly detection catches mass exfiltration; rule-based alerts cut attacker dwell time from months to minutes. |
| **Audit Readiness** | Continuously up-to-date, tamper-evident record of every DB action. Cryptographic hash chains + signed checkpoints guarantee audit-trail integrity for regulators and forensics. |

**Three architectural principles** (non-negotiable design DNA):
1. **Cloud & engine neutrality** — capture/assessment components are pluggable across DB engines and clouds.
2. **Plane separation** — Control plane (config, identity, policy) isolated from Data plane (ingest, processing, query) for independent scaling and blast-radius containment.
3. **Tenant isolation** — per-tenant transport channels, dedicated data-plane DB storage, scoped config.

---

## 2. Users & Personas

| Persona | Primary needs |
|---|---|
| **Exec (CISO / Security Director / IT Leadership)** | Glance-level posture; executive dashboards; email digests; drills down only on major incidents. |
| **SOC Analyst** | Real-time alert triage; acknowledge / investigate / escalate; needs speed + context (user, query, sensitivity, anomaly score). |
| **Security Analyst (Threat Hunter)** | Proactive search of historical audit data; builds/tunes detection rules; uses peer comparisons & entity risk scores; writes custom queries / exports. |
| **Incident Response Engineer** | Reconstructs attack timelines; identifies scope; pulls forensic evidence; depends on tamper-evident trails & session reconstruction (often for legal use). |
| **Compliance Officer** | Periodic compliance reports; reviews classification accuracy; validates controls; pre-built dashboards; long-term retention; read-only. |
| **Tenant Admin** | Platform setup; onboard databases; configure SSO & notifications; manage users/roles; tune rule library; bulk ops; admin audit logs. |
| **Auditor (external — QSA / SOC2 / regulator)** | Temporary scoped read-only access; pulls reports; verifies trail integrity; exports signed evidence; their own access is logged (chain-of-custody). |

---

## 3. Channels & Access

- **Web UI** — browser console for daily operations, configuration, investigation (React).
- **Mobile App** — on-the-go critical alerts + approval workflows for execs/on-call.
- **REST API** — programmatic automation, integration, custom tooling.
- **Email Digests** — scheduled summaries for non-daily users.
- **Webhooks** — real-time outbound notifications to customer systems.

---

## 4. Core Capabilities

1. **Discovery & Classification** — discover all DBs (on-prem/cloud/hybrid); classify sensitive data (PII, PCI, HIPAA…); maintain asset inventory.
2. **Activity Monitoring** — real-time monitoring of all DB activity; who/what/when/where/which query; privileged-user monitoring.
3. **Auditing & Logging** — tamper-proof audit trails; centralized log management; retention policies.
4. **Policy Management** — access-control policies & rules; allow/block-listing of queries/users/IPs; time- & context-based rules.
5. **Alerting & Threat Detection** — real-time alerts (SQLi, privilege escalation, unusual access); behavioural-baseline anomaly detection; SIEM integration.
6. **Vulnerability Assessment (VA)** — scan for misconfigurations & CVEs; default creds, excessive privileges, unpatched versions; **6000+ tests** (CIS, PCI-DSS, weak passwords, vulnerable configs).
7. **Compliance Reporting** — pre-built reports (GDPR, PCI-DSS, HIPAA, SOX); scheduled & on-demand dashboards.
8. **Data Masking & Redaction** — dynamic masking for non-privileged users; static masking for non-prod.
9. **User & Entitlement Management** — review/manage privileges; detect over-privileged & dormant accounts; IAM/PAM integration.
10. **Integration & Connectors** — DB connectors (Oracle, SQL Server, MySQL, PostgreSQL, MongoDB); cloud DBs (RDS, Azure SQL, Cloud SQL, OCI); SIEM, ServiceNow, IAM.

---

## 5. High-Level Architecture (3 Zones)

```
┌────────────────────────────────────────────────────────────┐
│  ZONE 1: CUSTOMER ENVIRONMENT (any cloud / on-prem)         │
│  Databases · Capture Agents · Scanners                      │
└───────────────────────────┬────────────────────────────────┘
                            │ TLS / mTLS  (per-tenant ingress topic)
                            ↓
┌────────────────────────────────────────────────────────────┐
│  ZONE 2: DAM SAAS PLATFORM                                  │
│  Data Plane · Control Plane · Platform Services             │
└───────────────────────────┬────────────────────────────────┘
                            │ Outbound integrations
                            ↓
┌────────────────────────────────────────────────────────────┐
│  ZONE 3: EXTERNAL INTEGRATIONS                              │
│  SIEM · Notifications · ITSM · Identity                     │
└────────────────────────────────────────────────────────────┘
```

**Where each component runs is the key architectural constraint** (more than microservice-vs-monolith):
- **Customer environment** — anything that touches the database directly (agents, scanners).
- **SaaS data plane** — anything that processes audit events in flight or at rest.
- **SaaS control plane** — anything that manages tenants, policies, agents, identity.

### Zone 1 — Customer Environment
- **Databases** across 3 deployment classes: **Managed/PaaS** (no OS access — RDS, Azure SQL, Cloud SQL, OCI Autonomous, Atlas), **Self-Managed/IaaS** (VMs in any cloud), **On-Premises** (bare metal / VMware / Nutanix).
- **Capture Agents** (engine-aware) + **Scanners** (VA + Discovery) — see [§7](#7-supported-database-engines--capture).
- **Transport:** captured events ship to per-tenant ingress topics over TLS, authenticated by SAS keys / workload identity federation / mTLS.

### Zone 2 — DAM SaaS Platform
- **Ingress Transport:** one per-tenant message channel (Event Hubs in Azure SaaS; portable to Kafka / Kinesis / Pub/Sub).
- **Data Plane Services** (Go, stateless, KEDA-autoscaled, own K8s namespace).
- **Data Plane Storage:** multi-tenant ClickHouse, **one DB per tenant** in a shared cluster.
- **Control Plane Services** (CRUD-oriented, own K8s namespace).
- **Control Plane Storage:** PostgreSQL, **shared multi-tenant**, isolation via `tenant_id` FKs + Row-Level Security.
- **Control→Data sync:** per-tenant **config** Event Hubs (separate from audit-event channels) via transactional outbox.
- **Platform Services (cross-cutting):** Prometheus/Grafana, OpenTelemetry, Cert-Manager, KEDA, Secrets Manager (Key Vault / Vault), Blob Storage (Blob / MinIO).

### Zone 3 — External Integrations
- **Identity Providers** — Azure AD, Okta, Ping, ADFS, Keycloak (SAML/OIDC, group→role mapping).
- **SIEM** — Splunk, QRadar, Microsoft Sentinel, Chronicle, Elastic Security (bidirectional).
- **Notification/Collab** — Slack, Teams, email, SMS.
- **Incident Mgmt** — PagerDuty, Opsgenie, VictorOps.
- **ITSM** — ServiceNow, Jira Service Management, BMC Remedy.
- **Automation** — generic webhooks, Terraform provider, REST API.
- **Threat Intel** — MISP, commercial feeds, CERT advisories (inbound enrichment).

---

## 6. Application Components

### 6.1 Data Plane Services (Go, stateless, horizontally scaled)
| Service | Responsibility |
|---|---|
| **Ingest Service** | Consumes ingress topics; runs pipeline → **Parser** (engine-aware decode to canonical schema) → **Enrichment** (classification tags, geo-IP, query-template hash, session context) → **Scoring** (per-event anomaly score vs baselines). Highest-throughput component. |
| **Persistence Service** | Batched writes to ClickHouse (`audit_events`, `anomaly_alerts`, template upserts); assembles tamper-evident hash chain; idempotent reprocessing. Often co-deployed with Ingest in v1. |
| **Behavioral Analytics Worker** | Builds per-entity profiles; rolling risk scores; weekly peer-group clustering (the "continuous learning" capability). |
| **Alert Dispatcher** | Fans alerts out to channels via adapters (Slack, Teams, PagerDuty, ServiceNow, Splunk HEC, webhooks, email); rate limiting, circuit breakers, suppression, dead-letter. |
| **Checkpoint Worker** | Hourly Merkle hash checkpoints per DB instance; signs with tenant KMS key; writes to immutable blob for tamper-evidence verification. |
| **Coverage Monitor** | Tracks per-DB event-flow health (heartbeats, parser errors, ingest lag); detects gaps ("no events for 6h"); updates `coverage_status`. |
| **Query API** | Read-only HTTPS fronting ClickHouse for UI/mobile/integrations; constrained query DSL; per-tenant routing; resource-bounded; async export (Node.js). |

### 6.2 Control Plane Services (CRUD-oriented)
| Service | Responsibility |
|---|---|
| **Tenant Service** | Tenant lifecycle; provisioning workflow (creates per-tenant ClickHouse DB, Event Hubs, KMS keys); plan tiers; suspension/offboarding. |
| **Identity Service** | AuthN/AuthZ; SSO (SAML/OIDC); local accounts + MFA; invitations; API-key lifecycle; RBAC; SCIM provisioning. |
| **Policy Service** | CRUD audit policies & rules (JSON DSL); policy version snapshots; rule exceptions; compiles policies into runtime evaluators for Ingest. |
| **Classification Service** | Source-of-truth for principal/object classifications; schema discovery + pattern + content-sampling classifiers; built-in India-specific PII validators; customer-editable rule library. |
| **Agent Service** | Agent enrollment tokens; certificate issuance; config distribution; rolling version upgrades; health monitoring. |
| **Discovery Service** | DB discovery via cloud API + network scanning + manual registration; dedupe + reconcile candidates for review before promotion. |
| **VA Service** | Vulnerability scan orchestration; multi-engine test library; findings lifecycle; compliance mapping. |
| **Outbox Service** | Transactional outbox (Postgres LISTEN/NOTIFY + polling safety net) → reliable control→data plane sync via per-tenant config Event Hubs. |
| **Audit Service** | Captures every control-plane action (the DAM's own "DAM-lite") into `control_plane_audit`. |
| **Billing Service** | Usage metering (events, DBs, storage, alerts, scans); plan enforcement; customer usage dashboards; overage notifications. |
| **Control Plane APIs** | REST surface for all admin ops (separate from data-plane Query API — different workload/scaling/data source). |

### 6.3 Client-Side Components
- **Agents** — customer-deployed software near the DB: network agent (libpcap), host agent (eBPF/ETW), audit-log puller, audit-push consumer, VA scanner, discovery scanner. Ship as native packages (RPM/DEB/MSI), container images, and cloud VM extensions.

### 6.4 User Interfaces
- **Web UI (React)** — all personas; calls both Control Plane APIs and Data Plane Query API.
- **Mobile App** — alerts, acknowledgment, exec dashboards, approvals.

---

## 7. Supported Database Engines & Capture

**GA engines (per [D4](#decisions-log-locked-2026-06-21)):** Oracle (Enterprise/Standard/RAC/Exadata), Microsoft SQL Server (Standard/Enterprise/Azure SQL/Managed Instance), MySQL/MariaDB (Community/Enterprise/Aurora/Cloud SQL), PostgreSQL (Community/Aurora/Azure DB/Cloud SQL), MongoDB (Community/Enterprise/Atlas), **IBM Db2** (LUW + z/OS).

**Capture is engine-specific; everything downstream of the Parser is engine-neutral.** Customers typically combine modes per engine.

| Engine | Network Capture | Host Capture | Audit Trail Pull | Audit Push |
|---|---|---|---|---|
| **Oracle** | TNS protocol decode | eBPF for BEQUEATH/IPC | `UNIFIED_AUDIT_TRAIL` via JDBC | Oracle@Azure native export |
| **SQL Server** | TDS protocol decode | ETW (Win) / eBPF (Linux) | Extended Events / SQL Audit | Azure SQL Audit → Event Hubs |
| **MySQL/MariaDB** | MySQL protocol decode | eBPF for sockets | Enterprise / Percona / MariaDB Audit Plugin | RDS / Cloud SQL audit logs |
| **PostgreSQL** | PostgreSQL FE/BE protocol | eBPF for sockets | pgaudit / log_statement | RDS / Cloud SQL / Aurora audit |
| **MongoDB** | Wire protocol (OP_MSG/OP_QUERY) | eBPF for sockets | MongoDB Audit Log JSON | Atlas Auditing webhooks |
| **IBM Db2** | **DRDA** protocol decode | eBPF for sockets/IPC | **`db2audit`** facility / AUDIT policy logs | (none native — pull only) |

> **Db2 notes:** add `db2` to the `engine` enum, `drda` to `query_language`, and Db2-specific keys to `engine_metadata` (`platform`: `luw`/`zos`, `instance`, `db_partition`/DPF, `hadr_role`, `pureScale_member`). Principal concept = authorization ID; objects = table/view/procedure/function/package/alias. Canonical actions map cleanly (SELECT→READ, INSERT/UPDATE/MERGE→WRITE, etc.). **z/OS Db2** capture often requires SMF-record ingestion rather than wire decode — treat as a sub-variant.

### 7.1 Engine roadmap recommendation

Beyond the six GA engines, recommended additions in priority tiers (driven by Indian BFSI/Gov + large-enterprise demand). The canonical schema and outbox model absorb each new engine with **only a Parser + capture driver + VA test pack + privilege profile** — no core schema change.

| Tier | Engines | Why / who asks for it |
|---|---|---|
| **GA** | Oracle, SQL Server, MySQL/MariaDB, PostgreSQL, MongoDB, **Db2** | Covers the bulk of enterprise OLTP + the RFP. |
| **Fast-follow (T2)** | **SAP HANA**, **SAP ASE (Sybase)**, **Teradata** | SAP HANA ubiquitous in large enterprises; Sybase ASE entrenched in Indian BFSI/legacy banking; Teradata in DW-heavy shops. |
| **T3 — NoSQL/cache** | **Cassandra / ScyllaDB**, **Redis** | Redis is *already* hinted in the schema (`query_language` enum has `redis_cmd`); Cassandra common in telco/fintech. |
| **T4 — Cloud DW** | **Snowflake**, **Amazon Redshift**, **Google BigQuery**, **Azure Synapse** | Sensitive data increasingly lands in cloud warehouses; captured via native audit/query-history APIs (Audit-Push style), not wire decode. |

**My recommendation:** commit GA to the six. Prioritise **SAP ASE (Sybase)** and **SAP HANA** as the very next two for the Indian BFSI/Gov tender market, then Teradata. Treat cloud-DW engines as an **Audit-Push-only** class (no agent on the box) to keep that effort bounded.

**Four capture modes:**
- **Network Capture Agent** — passive libpcap, engine-native protocol decode (Go binary; systemd or K8s DaemonSet).
- **Host Agent** — local connections bypassing the network stack (shared memory, BEQUEATH, Unix sockets) via eBPF (Linux) / ETW (Windows).
- **Audit Trail Puller** — polls native audit logs via engine's standard interface; works for any reachable DB incl. PaaS.
- **Audit Push Consumer** — serverless function subscribing to customer-controlled channels where managed DBs push audit logs.

**Scanners:**
- **VA Scanner** — scheduled; 6000+ tests (CIS, PCI-DSS, weak passwords, missing patches, privilege analysis). K8s CronJob / serverless / systemd timer.
- **Discovery Scanner** — network protocol fingerprinting + cloud API enumeration + manual-registration reconciliation.

> **Note (RFP-driven):** Requirement #57 states the solution **should not use native DB audit functionality** — this favours network + host agent capture over audit-trail pull for that customer. Reconcile per deployment (see [§14](#14-open-questions--architect-decisions)).

### 7.2 Agent capture modes — deployment model & posture guidance

The four capture modes split into **3 installed agents** + **1 agentless** consumer:

| Mode | Installed? | In the data path? | Can block? |
|---|---|---|---|
| **Network agent** | yes (sidecar/tap) | no — passive observer at the DB NIC | no |
| **Host agent** (eBPF/ETW) | yes (on the DB host) | no — passive observer at the kernel | local/IPC only |
| **Inline proxy / gateway** | yes (gateway in the path) | **yes** — clients connect *through* it | **yes** (block/quarantine) |
| Audit pull / Cloud push | no (agentless) | no | no |

**Mental model:** the **proxy is a gate** the traffic passes through (so it can stop it); the **network and host agents are cameras** pointed at the database (they see traffic arrive but can't stop it). Critically, each sees a path the others can't:

| Connection path | Inline Proxy | Network agent | Host agent |
|---|:--:|:--:|:--:|
| App **routed through the proxy** | ✓ (+ real client IP) | ✓ (source = proxy) | ✓ |
| **Direct** TCP (bypasses proxy) | ✗ | ✓ | ✓ |
| **Local / IPC** (Unix socket, BEQUEATH, shared mem) | ✗ | ✗ | ✓ (only one) |

So passive agents deployed *alongside* a proxy exist to catch **proxy-bypass and local connections**, and to provide the deep visibility the proxy lacks; the proxy provides **enforcement + real end-user attribution** for routed traffic (passive agents see pooled/proxied connections as coming from the proxy — the attribution problem the Access-Governance identity-resolution feature solves).

**Packaging (decision):** **one** Go agent image; behaviour selected at container start by `MODE={network|host|proxy}` + `DB_ENGINE`. The image bundles all mode implementations + a shared `protocol/` decoder library (TNS/TDS/PG/MySQL/Mongo/DRDA). A **running container runs exactly one mode against one target DB** — the three modes have incompatible deployment shapes (network/host share the DB net namespace; host also needs `pid:` + `privileged`; the proxy needs its own networks to listen + forward). Therefore **#containers = #(database × mode) coverage points**: one DB monitored by Host+Network+Proxy = **3 containers**.

**Posture guidance (drives the Deploy-monitoring screen presets):**
- **Lightweight** = `Network` — cheapest passive monitoring; blind to local/IPC, can't block.
- **Full visibility** (recommended for self-managed) = `Network + Host` — complete passive capture (wire + local), no blocking, no path change.
- **Enforce** = `Proxy + Network` — block routed traffic + catch bypass; blind to local/IPC.
- **Crown jewel** = `Network + Host + Proxy` — everything + bypass + local; highest overhead, redundant capture on the routed path (needs dedup), inline availability risk. Reserve for the few highest-value DBs.
- **PaaS/managed DBs** can't install any of the three → use **agentless** (Audit Pull / Cloud Push).

Decision rule: *PaaS? → agentless. Need to block? → Proxy + Network (+ Host if local conns). Else local/IPC conns? → Network + Host, else Network.*

> Dev-environment note: the **inline proxy** and **network agent** are genuinely real in the Docker dev stack (the proxy listens + forwards; the network agent shares the DB's net namespace for real libpcap and ships events to the host-published NATS/ClickHouse ports). The **host eBPF agent runs in simulation on macOS/Docker-Desktop** (no real eBPF there); it is real on native Linux with `privileged`.

### 7.3 Data classification (agent capability — orthogonal to capture)

Classification — discovering which columns hold **PII/PCI** — is **independent of the capture mode**. It doesn't inspect traffic: the agent opens an **outbound** connection to the database as a **least-privilege reader** (`dam_svc` with `SELECT`/`PROCESS`), reads `information_schema`, matches column names against the PII/PCI pattern library (Aadhaar, SSN, card number/CVV/expiry, email, name, DOB, passport/tax-id, phone, address…), rolls sensitivity up to the object, and POSTs the result to `/api/classification/scan-results`. Results populate the **Classification** page and feed the Compliance scores.

- **Any installed agent can classify**, regardless of its `MODE` (network / host / proxy) — the *same* container already on the DB host does the scan when given DB read credentials. No separate agent is required.
- Enabled per-agent with `CLASSIFY=true` + `DB_USER` / `DB_PASSWORD`; re-scans every `CLASSIFY_INTERVAL_MIN` minutes (default 30). Same outbound-only path as capture — the control plane never dials into the DB network.
- The **standalone collector** runs the identical scan for **agentless / PaaS** sources that have no installed agent.
- `scan-results` resolves the tenant from the per-tenant enroll token and **find-or-creates** the `db_instances` + `databases` rows (tenant-scoped) from the reported `host`/`port`/`engine`, so a discovered schema appears on the Classification page automatically.
- Engine support: **MySQL** in the current build; other engines are observe-only until their `information_schema` reader lands. Verified live on GCP `db-vm-a` (network agent, `orders` DB → `orders.ship_address` classified as address/medium).

### Deployment targets by cloud
| Cloud | Always-On Agents | Scheduled Scanners | Serverless Pull/Push |
|---|---|---|---|
| Azure | AKS DaemonSet, Azure VM | Container Apps Job | Azure Function |
| AWS | EKS DaemonSet, EC2 | Fargate scheduled task | Lambda + EventBridge |
| GCP | GKE DaemonSet, GCE | Cloud Run Job | Cloud Function + Scheduler |
| OCI | OKE DaemonSet, Compute | Container Instance + scheduler | OCI Functions |
| On-Prem | K8s DaemonSet, systemd | K8s CronJob, systemd timer | K8s Deployment |

---

## 8. Technology Stack

| Layer | Choice | Rationale |
|---|---|---|
| **Backend / agents** | **Go** | Concurrency, low memory, single-binary, strong Azure/Kafka/ClickHouse/Postgres SDKs. |
| **Web tooling / SSR** | **Node.js** | Frontend infra, build tooling, Query API. |
| **Frontend** | **React** | Dense, data-heavy DAM interfaces. |
| **OLAP store (data plane)** | **ClickHouse** | Billions of rows, sub-second analytics; incremental materialized views. |
| **OLTP store (control plane)** | **PostgreSQL** | ACID, mature tooling, row-level security for multi-tenancy. |
| **Cache / low-latency state** | **Redis** | Rate limiting, suppression, rolling risk scores, session revocation, tenant routing cache. |
| **Object storage** | **Blob Storage** | Tamper-evident archives, checkpoints, exports, backups (Azure Blob SaaS; MinIO/S3 on-prem). |
| **Messaging** | **Kafka / Event Hubs** | Durable ordered transport for audit events + config sync (Event Hubs SaaS; Kafka on-prem). |
| **Orchestration** | **Kubernetes** | All stateless services; scaling, rolling deploys, standard runtime across hosting models. |
| **Secrets / keys** | **Key Vault / HashiCorp Vault** | Tenant encryption keys, DB creds, certs, KMS signing. |
| **Autoscaling** | **KEDA** | Event-driven scaling for ingest/dispatch. |
| **Observability** | **Prometheus, Grafana, OpenTelemetry** | Metrics, dashboards, distributed tracing. |
| **CI/CD** | **Argo CD (GitOps)** | Deployments; multi-region (future); DR via PG backups + ClickHouse replication. |

---

## 9. Hosting / Deployment Models

Same application architecture, three hosting models (supporting all three is a **product differentiator**):

| Model | Description | Best fit |
|---|---|---|
| **SaaS (multi-tenant)** | Fully managed in vendor cloud; customer deploys only Zone-1 agents; operational within hours. | Customers wanting fastest time-to-value, no on-prem mandate. |
| **Customer Cloud (single-tenant)** | Zone 2 deployed in customer's own Azure/AWS/GCP/private cloud account; customer retains data sovereignty & network isolation. | Regulated enterprises that allow cloud but require dedicated infra. |
| **On-Premises** | Zone 2 on customer-managed K8s (OpenShift, Tanzu, vanilla K8s, bundled k3s); Azure services substituted with Kafka / Vault / MinIO; **air-gapped supported with offline licensing**. | Banking, government, defence, strict data-residency. |

**Multi-cloud patterns:** single-cloud, multi-cloud (agents in each cloud converge on the same per-tenant ingress topic), hybrid, and on-prem-only — customer always sees **one unified DAM**.

> **RFP note:** Requirement #2 requires deployable as **physical or virtual appliance** with **HA / no single point of failure**, and #10/#11 require **scale-out by adding licenses** + load balancing across gateways. On-prem packaging must satisfy appliance form factor + HA.

---

## 10. Control Plane Data Model (PostgreSQL)

**Design:** transactional, low-volume, strict consistency. **One shared multi-tenant Postgres**; isolation via `tenant_id` FK + **Row-Level Security** (not separate DBs). Engine-specific concerns isolated to `engine`, `engine_version`, `engine_metadata JSONB`. Changes propagate to data plane via **change log + outbox pattern**.

**Six domains → ~28 tables:**

### 10.1 Tenant & Identity (7 tables)
`tenants` · `users` · `roles` · `permissions` · `role_permissions` · `user_roles` · `api_keys`
- `tenants` holds routing keys (`data_plane_region`, `data_plane_cluster`, `audit_db_name`) + `encryption_key_uri` (provider-neutral KMS: Azure KV / AWS KMS / GCP KMS / Vault → enables **BYOK**).
- `user_roles` supports **scoped assignments** (`scope_type`/`scope_id`) — e.g. "admin on prod DBs, viewer on dev" — avoiding role explosion.
- `api_keys` stores only **bcrypt hash**; plaintext shown once; `key_prefix` for UI display.

### 10.2 Asset Inventory & Classification (7 tables)
`db_groups` · `db_instances` · `db_instance_groups` · `db_credentials` · `principal_classifications` · `object_classifications` · `classification_rules`
- `db_instances` = central asset registry (one row per monitored DB across all engines/clouds); engine-specific attrs in `engine_metadata JSONB`; clusters (RAC/AG/replica-set) via `topology_type` + `parent_instance_id`.
  - ✅ **Implemented (dev)**: `db_instances` + `databases` (schemas, `instance_id` FK) + `agents.instance_id`; coverage/status derived per instance; instances CRUD with cascade decommission. `engine_metadata`, clusters, and `db_groups` not yet built. See Implementation Status above + BUILD-LOG §9i.
- `db_credentials` stores only a `secret_uri` reference (KMS/Vault) — **credentials never live in Postgres** (non-negotiable for a security product). Scoped by `purpose` (audit_reader / vuln_scanner / classifier / discovery).
- `principal_classifications` tags DB principals (human/app/service/dba/system), flags privileged/dormant, records expected programs/IPs.
- `object_classifications` is the **source of truth** replicated to the data plane (sensitivity tags: pii, pci, hipaa, aadhaar, pan…). Three-part name `object_database`/`object_schema`/`object_name`.
- `classification_rules` = customer-editable regex + validator (`luhn`, `verhoeff_12` for Aadhaar, `pan_format`, `gstin`, `ifsc`) + tags + threshold; `applies_to_engines` scoping.

### 10.3 Policy & Rules (6 tables)
`audit_policies` · `policy_scopes` · `rules` · `rule_exceptions` · `notification_channels` · `policy_versions`
- `audit_policies.policy_type` ∈ `capture` / `alert` / `block`.
- `policy_scopes.scope_type` ∈ `all` / `engine` / `db_group` / `db_instance` / `compliance_tag` (OR-combined).
- `rules` store predicate as **`condition_jsonb`** (structured JSON, **never SQL** — avoids code-execution surface); `rule_type` ∈ threshold/anomaly/pattern/first_time/privileged; thresholds, windows, suppression, actions.
- `rule_exceptions` — carve-outs by principal/IP/program/sql_hash with reason + expiry (critical for false-positive management).
- `policy_versions` — full immutable snapshot at every change (auditor question: "what did this policy look like on April 3rd?").

**Engine-neutral canonical action vocabulary** — Parser normalizes engine ops to: `READ`, `WRITE`, `DELETE`, `DDL`, `GRANT`, `LOGIN`, `ADMIN`. A single rule ("alert on bulk READ of PII") fires identically for an Oracle `SELECT`, SQL Server `SELECT`, or MongoDB `find()`.

### 10.4 Agents & Deployment (4 tables)
`collector_agents` · `agent_config` · `agent_health_metrics` · `coverage_status`
- `collector_agents.agent_type` ∈ network_agent / host_agent / audit_log_puller / audit_push_consumer / va_scanner / discovery_scanner (engine-neutral naming); `enrollment_token_hash` bootstraps then swaps for a long-lived cert.
- `agent_health_metrics` is high-write (events/sec, buffer %, CPU, dropped) → partition monthly or offload to a TSDB.
- `coverage_status` is derived (which capture modes deployed, last event time, detected gaps) — gap detection is itself a feature.

### 10.5 Operational (4 tables)
`control_plane_audit` · `outbox_events` · `usage_metering` · `jobs`
- `control_plane_audit` — append-only; actor/action/resource + before/after JSONB + request_id; extensible with hash-chain for tamper evidence.
- `outbox_events` — transactional outbox; per-tenant `sequence_number` for gap detection; status pending/dispatching/delivered/failed.
- `usage_metering` — daily pre-aggregated metrics (don't bill from raw events).
- `jobs` — Postgres-backed queue with lease-locking (`locked_by`/`lock_expires_at`, `SELECT FOR UPDATE SKIP LOCKED`) + resumable state machines (`current_stage`, `stage_state_jsonb`) for tenant provisioning, classification runs, VA scans, policy deploys.

### 10.6 Cross-cutting
- **Row-Level Security** on every tenant-scoped table (`tenant_id = current_setting('app.current_tenant_id')`).
- **Soft delete** (`deleted_at`) preferred; hard delete only on offboarding (with grace period).
- **Indexing**: every `tenant_id`; `(tenant_id, created_at DESC)`; FKs; `(tenant_id, engine)`.
- **Multi-region**: control plane single-region + read replicas; data planes regional; routing at API edge via `tenants.data_plane_region`.

---

## 11. Data Plane Data Model (ClickHouse)

**Design:** append-mostly, very high write volume (billions of events), heavy analytical reads. **One ClickHouse DB per tenant** in a shared cluster → cross-tenant queries are *physically impossible*. Engine-neutral canonical schema; tamper-evidence hash chain; **continuous learning** via incremental materialized views (no batch retraining).

### 11.1 Core Ingestion (7 entities)
| Entity | Role |
|---|---|
| `db_instance_registry` | Replicated DB catalog (dictionary) for engine-aware enrichment. `ReplacingMergeTree`. |
| **`audit_events`** | **Central fact table.** Canonical schema for all 5 engines; canonical action vocab; hash-chain fields (`prev_event_hash`, `event_hash`, `chain_sequence`); scoring fields; denormalized enrichment. `MergeTree`, partition by month, ORDER BY `(db_instance_id, event_time, event_id)`, 90-day TTL + cold archive. Projections by principal / object / session / alerts. |
| `query_templates` | Normalized query/command templates keyed by `query_hash` (xxhash64). |
| `principal_classification` | Replicated principal dictionary (user_type, privileged, dormant, expected programs/IPs). |
| `object_classification` | Replicated object dictionary (sensitivity tags, data categories). |
| `hash_chain_checkpoint` | Hourly Merkle root per DB instance, KMS-signed → immutable blob. |
| `anomaly_alerts` | Alerts when score > threshold or pattern match; lifecycle open/ack/resolved/suppressed/false_positive; links event_id ↔ control-plane rule_id. |

**Hash chain:** BLAKE3 (faster than SHA-256), `chain_sequence` monotonic per `db_instance_id` for gap detection. Verification covers ranges via checkpoints (verify 720 hourly checkpoints for a 30-day window instead of walking all events).

### 11.2 Materialized Views (7 — `AggregatingMergeTree`, incremental)
| View | Purpose | TTL |
|---|---|---|
| `query_principal_baseline_mv` | Primary detection baseline (avg/p99/stddev rows & duration per query×principal×instance/day) → z-scores. | 180d |
| `principal_time_baseline_mv` | Hour-of-day / day-of-week baseline → off-hours detection. | 180d |
| `principal_object_access_mv` | Which objects a principal touches → cross-schema / never-before access. | 180d |
| `principal_daily_activity_mv` | Daily volume per principal → "unusual volume today". | 365d |
| `failed_logins_mv` | Failed logins per 1-min window → brute force / credential stuffing / spray. | 30d |
| `sensitive_access_mv` | Access to PII/PCI/PHI/Aadhaar per tag×principal → compliance dashboards. | **7 years** |
| `sessions_mv` | Per-session aggregates → session reconstruction for IR. | 90d |

### 11.3 Behavioral Analytics / UEBA (4 tables)
`entity_profiles` (daily, exponential weighted avg α≈0.1–0.3) · `entity_risk_events` (ledger of risk deltas + reasons) · `peer_groups` (weekly clustering) · `peer_group_membership` (fit score; group change = signal).
- Rolling risk score updated near-real-time via Redis (mirrored to ClickHouse).
- **Anti-poisoning safeguards**: drift detection when a baseline mean shifts >50% week-over-week; bounded α prevents single-event baseline shifts.

### 11.4 Cross-cutting (data plane)
- TTL strategy varies (audit_events 90d hot; sensitive_access 7y; checkpoints indefinite/immutable).
- Cold export to compressed Parquet in blob; on-demand restore.
- Codecs: `ZSTD(3)` on query text, `DoubleDelta+LZ4` on time columns, `LowCardinality` on enums.
- Read replicas via `ReplicatedMergeTree`; reads to replicas, writes to primary.
- Schema migrations via `ALTER TABLE ADD COLUMN` (no rewrite); MV changes via dual-write cutover.

### 11.5 End-to-end example (engine-agnostic)
A MongoDB `find()` returning 50k customer records → Capture (OP_MSG decode) → Parser (extract op/collection/filter/rows) → Enrichment (principal=service acct, object=`customers.profiles` tagged `pii`) → Scoring (z-score ~25 vs p99 of 800 → flags `rows_z_score_extreme`,`sensitive_access`) → Persistence (BLAKE3 hash, `action_type=READ`,`action_subtype=find`,`engine=mongodb`) → Alert (→ Event Hub → Dispatcher → Slack/PagerDuty/SIEM). **End-to-end ~1–3s.** Same flow for Oracle/SQL Server/MySQL/PostgreSQL — only the Parser stage differs.

---

## 12. UI / Screen Inventory

> Captured from the `/screen` product walkthrough. The UI uses distinctive feature branding (mapped to architecture concepts below). It is a dark-themed React console with a left navigation rail.

| Screen / Module | What it shows | Maps to |
|---|---|---|
| **Dashboard** | KPI tiles (total DBs, agents, alerts, risk score ~100), world map of DB access, recent alerts feed, activity trend charts. | Exec/SOC landing; Query API + control plane. |
| **Database Management** | Inventory grid of registered databases with status, risk, protection state. | `db_instances`, `coverage_status`. |
| **Register Database** (3 modes) | (a) **Autonomous Discovery**, (b) **Network Scan** (CIDR → discovered hosts list), (c) **Manual Configuration** (host:port, engine, credentials). | Discovery Service, Agent enrollment. |
| **Active Defense** | "Threat Neural Net", "Behavioral Topology", "Breach/Egress Safety" panels; real-time threat stream. | Scoring + UEBA (`entity_profiles`, anomaly_alerts). |
| **Behavioral Topology / Egress Safety / Deception Console** | Forensic behavioral insight; egress simulation/enforcement; decoy/deception monitoring. | Behavioral Analytics Worker; data-exfil detection. |
| **Quarantine Management** | Quarantined sessions/queries with policy violation, severity, auto-action, release controls. | Blocking mode; `rules` with `block` action; session kill. |
| **Classification Rules / Classification Engine** | Baseline compliance words (Email, Phone, SSN, Full Name, DOB, Home Address) toggles + active custom logic; coverage %. | `classification_rules`, Classification Service. |
| **DAM Proxy Gateway** | Proxy/listener config (port e.g. 7001), connection strings, inline enforcement note. | Inline/blocking deployment, gateway mode. |
| **Protection Setup** (per-DB, e.g. MariaDB) | Per-database protection level (Low/Med/High), monitoring vs blocking mode, recent queries. | `audit_policies`, `policy_scopes`. |
| **DSAR Manager** | Data Subject Access Request workflow (request type: access / right-to-erasure / rectification / restrict processing). | GDPR/DPDPA compliance feature. |
| **Compliance Center / Audit Manifests** | PCI-facing response masking coverage, % classified sensitive columns, masked/exposed status, control statuses. | `sensitive_access_mv`, masking, compliance reporting. |
| **System Settings / API Infrastructure** | Provision access tokens, master key, automation config. | `api_keys`, Identity Service. |

**Left-nav modules observed** (approx.): Dashboard · Databases · Security · Quarantine · Classification · Compliance · Reports · Intelligence/Behavioral · Agents · DSAR Manager · Settings.

> ⚠️ The screenshots are frames from a recorded demo (Teams window visible). Treat feature *names* as candidate UI branding; the underlying capabilities are defined in [§4](#4-core-capabilities) and the data models.

---

## 13. RFP / Tender Compliance Requirements

> From `DAM TS.xlsx` — a customer **"Minimum Technical Specifications"** compliance sheet (columns: spec text · Amendment-I · Compliance Yes/No). The tender bundles **DAM** *and* an **ITSM / Service Management** module. Key DAM-relevant clauses below (use as a build checklist).

### 13.1 Deployment & Scale
- **#2** Deployable as **physical or virtual appliance**; **HA with no single point of failure**.
- **#10/#11** **Scale-out by adding licenses** as DB count grows; **load balancing** across boxes/gateways/management servers.
- **#6** Meet regulatory compliance incl. **CERT-In**.

### 13.2 Detection & Behavior
- **#17** Continuously **learn user & application** behavior.
- **#18** Provide **risk score per database** (combining alerts, discovery, VA, data sensitivity).
- **#20** Detect **abnormal server/user behavior via outliers**: unauthorized table access; specific-data selection; off-hours access; first-time table access; never-before-selected data; exceptional error volume; unusual *volume* of otherwise-normal activity; unusual *time* of otherwise-normal activity.
- **#38** Detect attacks exploiting **known vulnerabilities**.
- **#67** **Auto-profile** activity to filter noise / known-good.

### 13.3 Discovery, Classification & Masking
- **#9** Support **6000+ VA tests** (weak passwords, missing patches, CIS benchmark, PCI-DSS) + sensitive-data discovery + **masking**.
- **#26** **Content scanning** for regular expressions.
- **#30** Auto-discover sensitive data (**credit card, Aadhaar, any PII**) with customization.
- **#31** Auto-discover **privileged users**.

### 13.4 Blocking, Control & Sessions
- **#13** **Tamper-proof log storage** *or* forward logs to 3rd party; **kill sessions** on sensitive-data access / policy violation; keep all activity logged.
- **#33** **Change control** — track DDL execution.
- **#36** Capture & analyze **all DB activity** (application + privileged accounts).
- **#41** **Virtual patching** — auto-mitigate known vulnerabilities / block on known query patterns until patched.
- **#42** Track **stored-procedure execution** (who/what/when/tables accessed).
- **#50** **Block access in real time**; block execution.
- **#51** Support **Monitoring Mode** (alerts) and **Blocking Mode** (proactively block queries).
- **#45** Full audited-event detail: date/time, raw SQL, parameters, end-user, source IP, source app, destination DB instance, schema/objects affected, command details, results, values affected.

### 13.5 Agents & Coverage
- **#52/#54** Agent install/update **without OS or DB reboot**.
- **#57** **Must NOT use native database audit functionality** (favours network/host-agent capture).
- **#58/#71** Support/monitor **all database types**; integrate **all owner databases with no limit** on DB count.

### 13.6 Rules, Reporting & Access
- **#24** Automatic updates.
- **#25** **Custom security rules** — positive & negative security model; correlation rules.
- **#73** Rule creation at very granular level.
- **#46/#88** **Scheduled reports**.
- **#78** **RBAC**.
- **#79** AuthN: built-in / **Kerberos / LDAP / AD / RADIUS**.
- **#83** **Custom log messages** with system-variable placeholders (e.g. Username).

### 13.7 Integration
- **#90/#91** **Low-code/no-code** REST/Web API integration (GUI config, no coding); **2-way** integration with 3rd-party; multiple inbuilt auth methods; exchange data at any lifecycle stage.
- **#121** **Bi-directional SIEM/SOAR** integration (auto ticket create, enrich, status sync, auto close).

### 13.8 ITSM Module (bundled in tender — scope decision needed)
The tender also mandates a full **ITIL®-4 Service Management** suite: Service Catalog, Service Request, Incident, Change Enablement, Problem, Knowledge, Event/Monitoring, Release, **CMDB**; plus RPA/low-code workflow designer, email-to-incident, SLA tracking (#128/#130 built-in ITSM/case management + SLA timelines for alert ack/investigation/resolution).
> **Decision:** Is ITSM **in-scope** for this product, or satisfied via integration with an existing ITSM (ServiceNow/Jira)? See [§14](#14-open-questions--architect-decisions).

---

## 13A. Competitive Feature Gaps — Beyond the RFP

> **Study basis:** feature inventory of 9 leading DAM / data-security products (2026) — **IBM Guardium**, **Imperva Data Security Fabric** (Thales), **Oracle AVDF + Data Safe**, **Microsoft Defender for SQL + Purview**, **AWS native (DAS/Macie/GuardDuty)**, **DataSunrise**, **Trustwave DbProtect (LevelBlue)**, **Cyral (now Varonis)**, **Satori**, **Trellix (McAfee) DB Security**.
>
> **What your Excel RFP already covers well:** activity monitoring, 6000+ VA tests, sensitive-data discovery, dynamic/static masking, blocking + monitoring modes, virtual patching, behavioral outlier detection, continuous learning, per-DB risk score, DDL/change control, stored-proc tracking, RBAC + LDAP/AD/Kerberos/RADIUS, SIEM/SOAR + ITSM/ITIL integration, scheduled reports, custom & correlation rules.
>
> **The gaps below are capabilities competitors ship that your RFP does NOT ask for.** Each has my scope verdict (the user delegated these decisions). **Verdict legend:** 🟢 GA · 🟡 Fast-follow · 🔵 Post-GA · ⚪ Watch/optional.

### A. AI / GenAI Data Security *(biggest market shift; RFP is silent on it)*
| # | Feature | What it is | Who has it | Verdict |
|---|---|---|---|---|
| G1 | **LLM activity monitoring** | Monitor what users send to / receive from LLMs (ChatGPT, Bedrock, Azure OpenAI, Claude); audit which prompts trigger which DB queries. | DataSunrise, Satori, MS Purview, Guardium | 🟡 |
| G2 | **Prompt-time data protection / AI firewall** | Mask/redact PII in prompts *before* they reach the LLM; detect prompt injection, jailbreak, data exfiltration. | DataSunrise, Imperva/Thales, Guardium | 🔵 |
| G3 | **Vector-DB & RAG monitoring** | Treat vector stores (Qdrant, Milvus, pgvector) + RAG pipelines as first-class monitored sources. | DataSunrise, Guardium | 🔵 |
| G4 | **Shadow-AI / AI asset discovery** | Inventory AI models, datasets, endpoints, agents in use (incl. unauthorized). | Guardium AI Security, MS Purview | ⚪ |

> **Call:** Our `audit_events` schema already carries `query_language` with room for AI sources; treating an **LLM/AI gateway as just another "engine"** (Parser + canonical actions) lets us add G1 cheaply. This is the single strongest differentiator vs. the RFP's 2020-era scope.

### B. Data Security Posture Management (DSPM) & Cloud Posture
| # | Feature | What it is | Who has it | Verdict |
|---|---|---|---|---|
| G5 | **Agentless cloud data discovery (DSPM)** | Scan cloud accounts (AWS/Azure/GCP/SaaS) for sensitive data without agents; find **shadow / orphan / legacy** data stores. | Guardium DSPM, MS Purview, Cyera | 🟡 |
| G6 | **Attack-path / data-breach-path analysis** | Graph the exploitable path an attacker takes to reach sensitive data; prioritize by blast radius. | MS Defender for Cloud, DSPM tools | 🔵 |
| G7 | **Security posture scorecards (CIS/STIG/cloud)** | Continuous config-posture grading across the DB fleet (beyond point-in-time VA). | Oracle DSPM, Guardium, DataSunrise | 🟢 |
| G8 | **Data lineage** | Track how sensitive data flows/propagates across stores. | Guardium, DataSunrise | ⚪ |

### C. Identity & Access Governance *(RFP only asks "discover privileged users")*
| # | Feature | What it is | Who has it | Verdict |
|---|---|---|---|---|
| G9 | **Service-account / connection-pool identity resolution** | Attribute activity behind shared app / pooled / BI service accounts back to the **real end user**. *The #1 gap legacy DAM leaves open.* | **Cyral** (signature feature) | 🟡 |
| G10 | **Just-in-Time (JIT) access + approval workflows** | Self-service temporary DB access with auto-expiring credentials; approve/deny via portal or **Slack**; revoke kills the live session. | Cyral, Satori, DataSunrise | 🔵 |
| G11 | **Entitlement review / rights management** | Periodic access-recertification campaigns; flag excessive, stale, dormant privileges (beyond just *finding* privileged users). | Guardium, Imperva URM, DbProtect, Varonis | 🟢 |
| G12 | **Row-/column-level security enforced at the proxy** | ABAC authorization (row/column/object) applied inline, decoupled from each native DB. | Cyral, Satori | 🔵 |
| G13 | **Separation of duties (auditor cannot tamper)** | DBAs/admins cannot read or alter the audit stream; auditor role is isolated. | Oracle AVDF, AWS DAS, Guardium | 🟢 |

### D. Data Protection (beyond masking)
| # | Feature | What it is | Who has it | Verdict |
|---|---|---|---|---|
| G14 | **Tokenization / format-preserving encryption (FPE)** | Vaulted/vaultless tokenization + FPE to shrink PCI scope (RFP has masking but not tokenization). | Imperva/Thales CipherTrust, IBM GDE | 🔵 |
| G15 | **Before/after value capture** | Record old + new values on data changes (not just that a DML/DDL happened). | Oracle AVDF, Trellix | 🟢 |
| G16 | **BYOK / external KMS + key rotation** | Already locked as **D8** (all major KMS). | Most enterprise vendors | 🟢 *(D8)* |
| G17 | **Post-quantum / crypto posture** | Discover crypto in use; plan migration to NIST PQC. | Guardium Quantum Safe | ⚪ |

### E. Coverage Expansion (capture surface the RFP lumps as "all databases")
| # | Feature | What it is | Who has it | Verdict |
|---|---|---|---|---|
| G18 | **Unstructured / file data discovery** | Discover & monitor sensitive data in files, NAS, SharePoint, OneDrive, S3 — not just databases. | Guardium for Files, Imperva, MS Purview | 🔵 |
| G19 | **NoSQL / warehouse / vector coverage made explicit** | Snowflake, BigQuery, Redshift, Synapse, Cassandra, Elasticsearch, Redis, Couchbase — name them, don't hide behind "all DBs". | Guardium, Imperva, DataSunrise | 🟡 *(roadmap §7.1)* |
| G20 | **Mainframe DAM (Db2 z/OS, IMS)** | Kernel-level capture on z/OS — critical for large Indian banks. | Guardium (deep), Oracle | 🔵 |
| G21 | **Agentless managed-DBaaS capture** | Consume cloud-native audit streams (AWS Database Activity Streams, Azure SQL Audit→Event Hubs, Atlas webhooks) where agents can't run. | Guardium External S-TAP, Imperva Sonar, AVDF | 🟢 *(already in arch — Audit Push Consumer)* |
| G22 | **eBPF / in-memory container sensors** | Capture inside Kubernetes/OpenShift without breaking container purity. | Imperva (eBPF/UProbes), Trellix (memory sensor) | 🟢 *(already in arch — Host Agent)* |
| G23 | **SQL-grammar allowlist / Trusted Path firewall** | Train approved SQL patterns + approved connection paths (IP/user/app); block deviations (positive security model). | Oracle DB Firewall, Imperva | 🟡 |

### F. Operations & Economics
| # | Feature | What it is | Who has it | Verdict |
|---|---|---|---|---|
| G24 | **SIEM ingestion-cost optimization** | Forward only a filtered/scored subset to the SIEM (Imperva claims 5–30% of volume) to cut Splunk/Sentinel bills. | Imperva | 🟡 |
| G25 | **Immutable audit archive w/ dedup + compression** | Long-term, searchable, tamper-evident archive (10x compression). RFP wants tamper-proof logs but not the economics. | Imperva, Oracle ILM | 🟢 *(blob + Parquet already designed)* |
| G26 | **Infrastructure-as-Code deployment (Terraform provider, GitOps)** | Customer-managed deploy/upgrade as code (vital for on-prem + multi-cloud per D5/D7). | Cyral, Imperva eDSF Kit | 🟢 |
| G27 | **Managed service / MDR option** | Vendor-operated monitoring & scanning for customers without a SOC. | Trustwave/LevelBlue | ⚪ |
| G28 | **Audit-volume insights / selective auditing** | Analyze audit volume by DB/user/schema; tune what's captured to control cost & noise. | Oracle Data Safe Audit Insights | 🟡 |

### G. Compliance Depth (India-specific & frameworks)
| # | Feature | What it is | Who has it | Verdict |
|---|---|---|---|---|
| G29 | **Named DPDPA + RBI compliance packs** | Dedicated India **DPDPA** & **RBI** report templates + control mappings (DataSunrise is the *only* studied vendor with an explicit DPDPA pack — a clear opening for us in the Indian market). | DataSunrise (DPDPA) | 🟢 |
| G30 | **ML trainable classifiers + Exact Data Match (EDM)** | Go beyond regex content scanning — ML classifiers + exact-match against known sensitive datasets, fewer false positives. | MS Purview, Imperva, Guardium IGDC | 🟡 |
| G31 | **Pre-built framework scorecards (ISO 27001, SOC 2, NIST, FedRAMP)** | One-click posture against multiple frameworks beyond PCI/CERT-In. | Most enterprise vendors | 🟡 |
| G32 | **Threat-intelligence feed enrichment** | Enrich alerts with known-bad IPs/indicators (MISP, commercial, CERT). | Guardium, MS Defender | 🟢 *(already in arch — Zone 3)* |

### Scope summary — what I'm folding in
- **🟢 GA additions** (commit now): posture scorecards (G7), entitlement review/recertification (G11), separation-of-duties hardening (G13), before/after value capture (G15), agentless DBaaS capture (G21, already designed), eBPF container sensors (G22, already designed), immutable archive economics (G25), IaC/GitOps deploy (G26), **DPDPA + RBI packs (G29)**, threat-intel enrichment (G32) — plus the already-locked BYOK (G16/D8).
- **🟡 Fast-follow** (next after GA): LLM activity monitoring (G1), DSPM agentless discovery (G5), service-account identity resolution (G9), SQL-grammar allowlist firewall (G23), SIEM cost optimization (G24), audit-volume insights (G28), ML/EDM classifiers (G30), framework scorecards (G31), explicit NoSQL/warehouse coverage (G19).
- **🔵 Post-GA** (differentiators): AI firewall/prompt protection (G2), vector-DB/RAG (G3), attack-path analysis (G6), JIT access workflows (G10), proxy-enforced RLS/CLS (G12), tokenization/FPE (G14), unstructured/file discovery (G18), mainframe z/OS (G20).
- **⚪ Watch**: shadow-AI discovery (G4), data lineage (G8), post-quantum (G17), managed/MDR (G27).

> **Headline strategic gaps the RFP completely misses:** (1) **AI/LLM data security** — the fastest-moving area in 2026; (2) **service-account identity resolution** — the deepest unsolved problem in legacy DAM; (3) **DSPM / agentless cloud discovery**; (4) **JIT access governance**; (5) **explicit India DPDPA/RBI compliance packs** — our wedge into the Indian BFSI/Gov market.

---

## 14. Open Questions / Architect Decisions

> Items I (as solution architect) flag as needing your input or an explicit decision before/while building. Grouped by theme. **Resolved items show their answer; ✅ = locked in the [Decisions Log](#decisions-log-locked-2026-06-21).**

### A. Scope & Product
1. ✅ **ITSM scope** — *Resolved (D1): phased.* DAM core + ServiceNow/Jira integration + lightweight case/SLA layer at GA; native ITIL-4 suite later. → Still need: which ITSM is the **primary integration target** at GA (ServiceNow vs Jira vs both)?
2. ✅ **Demo screenshots** — *Resolved (D2): competitor to displace.* Build a better UX; screenshots are reference only. → Still need: a design direction / brand for the new UI.
3. **Deception/Honeypot ("Deception Console")** — present in the competitor UI but absent from our architecture doc. **Is decoy/honeypot capability in scope?** It implies extra data-plane + agent work. (Recommend: defer to post-GA; it's a differentiator, not table-stakes.)
4. **DSAR / Right-to-erasure** — competitor has a DSAR Manager (GDPR/DPDPA). **Confirm in scope?** Adds data-subject workflow + erasure orchestration beyond monitoring. (Recommend: in scope for India DPDPA story, but as a thin workflow over classification data.)

### B. Capture & Enforcement
5. **#57 "no native DB audit"** conflicts with the Audit-Trail-Puller / Audit-Push modes (which *rely* on native audit). For that customer we lean on network + host agents — but PaaS/managed DBs (RDS, Azure SQL, Atlas, BigQuery) often **cannot** be captured without native audit. **Decision needed:** scope #57 to self-managed engines and document a PaaS exception? (Recommended.)
6. ✅ **Blocking/Inline mode** — *Resolved (D3): both at GA.* Passive out-of-band **and** inline DAM Proxy Gateway. → Still need: **inline scope** — which engines get the proxy at GA (recommend Oracle/SQL Server/MySQL/PostgreSQL where wire-proxy is mature; Db2 DRDA + MongoDB proxy as fast-follow), and the **fail-open vs fail-closed** policy when the proxy is unavailable (HA + latency budget).

### C. Multi-Cloud / Branding
7. **Primary cloud** — Architecture is written Azure-first (Event Hubs, Key Vault, Blob). Is **Azure the launch cloud**, with AWS/GCP/OCI as fast-follow? Affects what we abstract first.
8. **"Anthropic's cloud"** appears in the SaaS hosting text — placeholder. Confirm the **operating entity / brand / cloud account** for the managed SaaS.

### D. Data & Compliance
9. **Retention defaults** — doc uses 90-day hot / 7-year cold (2555d). Confirm defaults and whether per-tenant/per-plan configurable; align with CERT-In + Indian BFSI mandates.
10. **Data residency** — for India BFSI/Gov (RBI, DPDPA), do we need **in-country data plane** from day one? Drives region rollout + on-prem priority.
11. **BYOK** — confirm BYOK is a launch requirement (it's modeled via `encryption_key_uri`) and which KMS providers must be supported at GA.

### E. Engineering / Ops
12. **v1 engine coverage** — All 5 engines at GA, or phase (e.g., Oracle + SQL Server first)? Each engine = Parser + capture + VA test library + privilege profiles.
13. **On-prem messaging/storage parity** — On-prem swaps Event Hubs→Kafka, Key Vault→Vault, Blob→MinIO. Do we maintain a **single abstraction layer** or separate builds? Recommend abstraction interfaces from day one to avoid drift.
14. **Mobile app** — is it GA scope or fast-follow? (Alerts + approvals only per the doc.)
15. **Agent health metrics at scale** — doc notes `agent_health_metrics` should move off Postgres to a TSDB. Decide threshold/trigger for that migration.
16. **Tamper-evidence on control plane** — extend `control_plane_audit` with the same hash-chain as the data plane? (Recommended for a security product; small cost.)

---

## 15. Glossary

| Term | Meaning |
|---|---|
| **Control Plane** | Config/identity/policy services + PostgreSQL (shared multi-tenant, RLS). |
| **Data Plane** | Ingest/processing/query services + ClickHouse (one DB per tenant). |
| **Canonical action vocabulary** | Engine-neutral verbs: READ/WRITE/DELETE/DDL/GRANT/LOGIN/ADMIN. |
| **Capture modes** | Network agent · Host agent · Audit-log puller · Audit-push consumer. |
| **Outbox pattern** | Transactional change log → reliable control→data plane sync. |
| **UEBA** | User & Entity Behavior Analytics (entity_profiles, risk events, peer groups). |
| **Hash chain / checkpoint** | BLAKE3 per-event chain + hourly KMS-signed Merkle roots for tamper evidence. |
| **MV** | ClickHouse `AggregatingMergeTree` materialized view (incremental baselines). |
| **BYOK** | Bring Your Own Key — customer-controlled KMS encryption key. |
| **DSAR** | Data Subject Access Request (GDPR/DPDPA). |
| **VA** | Vulnerability Assessment (6000+ tests). |
| **PaaS/IaaS DB** | Managed (no OS access) vs self-managed-on-VM database deployment. |

---

*Generated from the provided architecture document, RFP technical-specification sheet, and UI walkthrough captures. Update [§14](#14-open-questions--architect-decisions) as decisions are made.*
