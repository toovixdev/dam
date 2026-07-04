# DAM Main Application — Build Log

> Living knowledge base for the autonomous build pass started 2026-06-27.
> Scope per instruction: **main application only** (not the admin app).
> Source of truth: approved mockups in `/mockups`, architecture doc, existing codebase in `/dev/dam`.

## 1. Audit findings (what existed vs. what was missing)

The React frontend (`dev/dam/frontend`) was **broken at build time**: `src/App.jsx` and
`src/components/Sidebar.jsx` import/route to 9 page components that did not exist on disk.
Vite would fail to resolve these imports, so the SPA could not render.

### Existing, working pages (14)
Login, Dashboard, Databases, Agents, Alerts, Policies, Quarantine, Classification,
Compliance, Dsar, AuditTrail, Users, Integrations, Billing.

### Missing pages that broke the build (9) — all have approved mockups
| Page component        | Route             | Mockup                  |
|-----------------------|-------------------|-------------------------|
| ActiveDefense.jsx     | /active-defense   | active-defense.html     |
| Discovery.jsx         | /discovery        | discovery.html          |
| Masking.jsx           | /masking          | masking.html            |
| AccessGovernance.jsx  | /access           | access.html             |
| LlmMonitoring.jsx     | /llm              | llm.html                |
| Reports.jsx           | /reports          | reports.html            |
| Settings.jsx          | /settings         | settings.html           |
| Profile.jsx           | /profile          | profile.html            |
| Support.jsx           | /support          | support.html            |

## 2. Architecture / integration facts (verified)

- **Stack**: Vite + React 18 + react-router-dom 6 + recharts. Backend = Express + pg +
  ClickHouse (HTTP) + ws. Postgres control plane `dam_control` (11 tables). ClickHouse
  `dam_analytics` (events/sessions/baselines/alert_events).
- **Frontend hot reload**: `dam-react` container bind-mounts `./dam/frontend/src` and
  `index.html`. New page files are picked up by Vite HMR instantly — **no rebuild required**.
- **Backend**: `dam-api` is `build:`-only (no mount), runs `node main.js` (not `--watch`).
  Any API change requires `docker compose build dam-api && up -d dam-api`.
- **Routing**: vite dev proxies `/api`, `/auth`, `/ws` → `dam-api:3000`. Prod nginx mirrors this.
- **Auth**: JWT in localStorage (`dam_token`/`dam_user`). `useAuth()` context. 401 → `/login`.
- **3 client DBs** (PG-CRM-PROD, MYSQL-PAYMENTS-PROD, MONGO-PROFILES-UK) are seeded and
  must not be touched. No destructive DDL anywhere in this pass.

## 3. Component & theme conventions (reuse these — do not reinvent)

The React app re-themes the mockups with its **own class vocabulary** (NOT the mockup's
`.phead/.tbl/.kpi/.subnav`). New pages must use the React conventions:

- Shell: `<Layout>` (renders Sidebar + TopBar), `<PageHeader title meta>...</PageHeader>`.
- Cards: `.card > .card-header(.card-title/.card-sub) + .card-body(.no-pad)`.
- KPIs: `<section className="kpi-grid">` of `<KpiCard icon iconBg iconColor label value detail detailType>`.
- Tables: `<DataTable columns data>` (sortable) OR raw `.data-table` for custom cells.
- Tabs: `<TabNav tabs active onChange>`.
- Modals/forms: `<Modal>`, `.form-field`, `.form-row`, `.btn-primary`/`.btn-secondary`.
- Charts: **recharts** (existing chart components under `src/components`), not the mockup `pf.*`.
- Badges: `<SeverityBadge>`, `<StatusBadge>`, `.badge` + `.sev-critical/.sev-high/.status-green`.
- Data: `useApiData('/path')` → `{data,loading,error,refetch}`. Demo/static data inline is an
  accepted, established pattern (see existing `Compliance.jsx` DEMO_CONTROLS) for screens whose
  mockups are presentational.

## 4. Build decisions

1. **Priority 1 — unbreak the build**: create all 9 page components so Vite resolves and the
   whole SPA renders. This is the highest-value, lowest-risk change (HMR, no rebuild).
2. **Fidelity**: replicate each mockup's layout, KPIs, tabs, tables, and interactions using the
   React vocabulary above so the theme/CSS stays 100% consistent with the rest of the app.
3. **Data**: wire to real endpoints where one cleanly exists (Profile → `/api/auth/me`;
   counts from `/api/agents`, `/api/dashboard/*`). Otherwise use inline demo data faithful to the
   mockup, matching the existing Compliance/Classification pattern. No fake endpoints invented.
4. **Interactivity**: every button does something real (navigation, modal, toast-equivalent
   inline feedback, tab switch, toggle state) — no dead buttons, no `alert()` stubs left behind.
5. **Backend**: additive, optional GET endpoints only where they add working value; rebuild
   dam-api once at the end if touched. No destructive DDL, no changes to client DB configs.

## 5. Progress

- [x] Audit complete; plan recorded.
- [x] 9 pages created (Masking, AccessGovernance, LlmMonitoring, Reports, Settings,
      ActiveDefense, Profile, Support, Discovery).
- [x] Shared `Toast` component + `ToastHost` mounted in Layout; supporting CSS appended to App.css.
- [x] Change-password flow (Profile modal → real `POST /api/auth/change-password`).
- [x] Verified: every page module transforms (HTTP 200), App.jsx OK, Vite ready with no errors.

## 6. Root-cause fix during verification

The dev build initially still 500'd on every router-using module with
`Failed to resolve import "react-router-dom"`. Cause: `react-router-dom@^6.28.0` had been
**added to `package.json` after the `dam-react` image was last built**, so the running
container's `node_modules` lacked it (recharts was already present from the original manifest).
Fix: `docker compose up -d --build dam-react` — reinstalls deps from the current manifest.
This is the correct durable fix (vs. an ephemeral in-container `npm install`). No source change
was needed; the page code was correct.

## 7. End-to-end verification (all green)

- `GET /api/health` → healthy (postgres ok).
- `POST /api/auth/login` (seeded admin) → JWT issued.
- `GET /api/auth/me`, `/api/databases`, `/api/agents`, `/api/dashboard/kpis` → 200 with token.
- All 23 page modules + App.jsx transform without error; Vite reports ready, logs clean.

## 8. Decisions on backend scope

No new backend endpoints were invented. The 9 new screens are presentational/interactive in the
approved mockups (hardcoded demo data + client-side actions), so they were built self-contained
with inline demo data — consistent with the existing `Compliance.jsx`/`Classification.jsx`
pattern — and wired to **real** endpoints wherever one already exists (Profile → `/api/auth/me`
+ `/api/auth/change-password`). Adding consumer-less endpoints would be speculative and risk the
"don't break the 3 client DBs / additive-only" constraint, so it was deliberately skipped.
No destructive DDL, no client-DB/config changes, no `dam-api` source changes in this pass.

## 9b. Timezone feature (added on request)

- New `src/hooks/useTimezone.js`: app-wide tz preference persisted in `localStorage` (`nx-timezone`),
  synced across components via a `window` CustomEvent (no provider needed). Exports `TIMEZONES`,
  `getTimezone/setTimezone`, `tzShortName`, `formatInTz`, and the `useTimezone()` hook.
- `TopBar.jsx`: header now shows a live clock + zone abbreviation (🌐 HH:MM IST) that ticks every
  second, with a dropdown to switch among 11 common zones. Defaults to the browser zone.
- `Profile.jsx`: the Timezone row reflects the selected zone and has its own selector (kept in sync
  with the header instantly). No rebuild needed — all under the `dam-react` src bind mount.

## 9c. User invitation emails (added on request)

Goal: actually notify invited users by email (previously `POST /api/users` set `status='invited'`
but sent nothing — no token, no mail transport). Delivery mechanism chosen by user: **SMTP via
nodemailer** (provider-agnostic; dev-safe by default).

**Backend (`dev/dam/api/main.js`, + `nodemailer` dep):**
- Email transport `getMailer()`: real SMTP when `SMTP_HOST` is set; otherwise a no-network
  `jsonTransport` that logs the invite link (dev stays testable, no real mail leaks).
  `sendInviteEmail()` renders an HTML+text invite with an `/accept-invite?token=…` link.
- Additive migration in `runAuthMigration`: `users.invite_token`, `invite_expires_at`,
  `invited_by` (+ index) via `ADD COLUMN IF NOT EXISTS` — idempotent, no destructive DDL.
- `POST /api/users` (admin): on invite (no password) generates a 32-byte token + 7-day expiry,
  stores it, sends the email. Returns `emailSent` (true only when a real SMTP send succeeded) and,
  in dev (no SMTP), `inviteLink` so the admin can copy/test it.
- `GET /api/invites/:token` (public): validates token + expiry, returns email/role/tenant/inviter
  for the accept screen. 404 if used/missing, 410 if expired.
- `POST /api/invites/:token/accept` (public): sets password (≥8) + name, flips `status='active'`,
  clears the token (single-use).
- `POST /api/users/:id/resend-invite` (admin): regenerates token+expiry and re-sends.

**Frontend:** new public route `/accept-invite` ([pages/AcceptInvite.jsx]) mirroring the
`accept-invite.html` mockup on the Login two-panel layout (loads invite, sets name+password,
redirects to /login). Users page now toasts real feedback on invite, copies the dev link when SMTP
is off, and has a **Resend invite** action on pending rows.

**Config:** `SMTP_HOST/PORT/SECURE/USER/PASS/FROM` + `APP_BASE_URL` added to `.env.example` and
passed through to `dam-api` in `docker-compose.yml`. To enable real email: set those vars and
rebuild `dam-api`. (Optional local catch-all: add a Mailhog service and `SMTP_HOST=mailhog`,
`SMTP_PORT=1025`.)

**Verified end-to-end:** invite → `GET /api/invites/:token` → accept → token consumed (404) →
new user logs in with the chosen password; resend issues a fresh working token; resend on an
active user 404s; dev `emailSent=false` + link surfaced. Migration applied; API logs clean.
Test users created during verification were deleted afterward.

## 9d. Account type — Local vs Azure AD (added on request)

The Add/Invite User modal now has an **Account type** toggle; `auth_provider` flows to
`POST /api/users`:
- `local` (default): set-password invite token + `accept-invite` email (§9c).
- `azure_ad`: creates the user with `auth_provider='azure_ad'`, **no password, no token**,
  `status='invited'`. They authenticate via the existing Azure AD SSO callback (matched by email,
  activated on first sign-in). A separate `sendSsoInviteEmail()` notifies them and points at
  `/login` ("Continue with Azure AD") — no token link.

`resend-invite` is now provider-aware: SSO users get the access email re-sent with no token
regeneration; local users get a fresh token. Verified: AD user row has
`auth_provider=azure_ad, status=invited, token NULL, password NULL`; resend keeps token NULL and
logs the SSO link; test users deleted afterward.

> Note (pre-existing, unchanged): the invite modal's role dropdown still uses display names
> (Viewer/Admin/…) while RBAC keys are `viewer`/`tenant_admin`/`soc_analyst`/… — applies to both
> local and AD users. Flagged for a follow-up; not touched here.

## 9e. Databases screen — mockup alignment (drift fix)

The Databases page had drifted from `mockups/databases.html`: 4 KPIs + 7 plain columns, no engine
tabs/filter, no monitoring/coverage/sensitivity widgets, no register/detail modals or export.
Realigned both frontend and backend.

**Backend (`dev/dam/api/main.js`):**
- Additive columns on `databases` (idempotent `ADD COLUMN IF NOT EXISTS`): `environment`,
  `capture_modes TEXT[]`, `sensitivity_tags TEXT[]`. Enriched the 3 real DBs (capture modes +
  sensitivity) so they render fully.
- Seeded **16 demo databases** (demo tenant only, guarded by an existence check) spanning all 6
  engines / clouds / on-prem with varied risk, status, capture modes, and sensitivity — so the
  engine tabs and widgets are populated like the mockup. Client DBs untouched.
- Rewrote `GET /api/databases` via `shapeDatabase()` to return: `deployment` (friendly label) +
  `is_paas`, `environment`, `monitoring` (capture-mode labels), `coverage` {net,host,pull,push},
  `sensitivity`, `status` (active/degraded/unmonitored from `monitoring_status`), `risk_score`,
  `open_alerts`, and `last_event` (best-effort `max(timestamp)` per DB from ClickHouse).
- Fixed `POST /api/databases`: now `authRequired`, uses `req.user.tenantId` (was a missing
  `x-tenant-id` header → null tenant), accepts the new fields, returns the shaped row.

**Frontend (`pages/Databases.jsx`, full rewrite):** 5 KPIs (Monitored / Not monitored / Degraded /
High risk / Sensitive), engine tab filter (All + 6 engines) + text filter, 10-column table
(Database, Engine, Deployment, Env, Monitoring pills, Coverage squares, Sensitivity badges, Risk,
Status, Last event), row→**Detail modal** (capture modes, sensitivity, recent activity, links to
policies/alerts), **Register modal** with 3 modes (Cloud Discovery / Network Scan / Manual — all
wired to real `POST /api/databases`), and **CSV export**. New CSS for `.cov`, `.mon-pill`,
`.eng-tab`, `.modetab`, `.scanrow`, `.row2`, `.kpi-grid.c5`.

**Verified:** API returns the enriched shape; manual + discovery + scan register POST creates a DB
and refetches; page compiles clean; dashboard endpoints still 200.

**Correction (real data only):** the first pass seeded 16 *fictional* databases (Oracle/Db2/MSSQL
with fake hosts) to make the screen look full — but those aren't running containers. Per feedback,
removed them and made the screen reflect reality:
- Deleted the 16 synthetic rows; **only the 3 real, container-backed DBs remain**: `PG-CRM-PROD`
  (client-postgres), `MYSQL-PAYMENTS-PROD` (client-mysql), `MONGO-PROFILES-UK` (client-mongo).
- Removed the demo-seed block from `runAuthMigration` (so it won't re-add on restart) and the
  `capture_modes` write. Kept the additive `environment` + `sensitivity_tags` columns.
- **Monitoring / coverage / status are now derived live from the real `agents` table** (not a
  stored column): `GET /api/databases` LEFT JOINs agents, aggregates `agent_types` + online/total
  counts; status = unmonitored (0 agents) / degraded (some offline) / active (all online).
  `last_event` stays real (ClickHouse). `POST` no longer takes `capture_modes`; a newly registered
  DB shows `unmonitored` until an agent is deployed — which is correct.
- Result: 3 DBs, all `active`, monitoring `Host (eBPF)+Network` (their 2 real online agents each),
  real `last_event` (MYSQL/PG have events, Mongo = never). Engine tabs for Oracle/SQL Server/Db2 are
  legitimately empty — the dev stack only runs Postgres/MySQL/MongoDB. Dashboard now 3 DBs/3
  monitored. `capture_modes` column left in place (additive; unused).

## 9f. Agent capture modes — design + Deploy-monitoring screen

Settled the agent architecture (design discussion; Go agents not yet coded). Decision: **Option B** —
3 *installable* agents (**Network**, **Host/eBPF**, **Inline Proxy**) + agentless Audit-Pull/Cloud-Push.
Key points captured in KB [§7.2]: the proxy is the only in-path component (can block); network/host
are passive observers at the DB that catch proxy-bypass and local/IPC paths; **one Go image, one
mode per container**, so #containers = #(database × mode). Posture presets: Lightweight (Network),
Full visibility (Network+Host, recommended), Enforce (Proxy+Network), Crown jewel (all 3); PaaS →
agentless. Proxy/network are real in the dev stack; host eBPF is simulated on macOS.

**Built now (screen + API):**
- `pages/Agents.jsx`: the "+ Deploy Agent" stub became a real **Deploy monitoring** modal — database
  picker, 4 presets, 3 multi-select mode cards, a **live coverage preview** (networked/local
  visibility, attribution, block, reroute, container count), a **PaaS guardrail** (disables the 3,
  steers to agentless), and a proxy path-change warning. Deploy issues one `POST /api/agents` per
  selected mode. Agent-type labels prettified in the table.
- `POST /api/agents`: fixed to `authRequired` + `req.user.tenantId` (was using a missing
  `x-tenant-id` header → null tenant); sets `version` + `last_heartbeat`, validates input.
- `GET /api/databases`: `inline_proxy` now recognised — added to `CAPTURE_LABEL` and folded into the
  `net` coverage flag, so a deployed proxy shows as an "Inline Proxy" pill and lights coverage.

**Verified:** deploying an `inline_proxy` to PG-CRM-PROD created an online agent and the Databases row
immediately showed monitoring `['Host (eBPF)','Inline Proxy','Network']` with `net` coverage true;
Agents.jsx compiles; test agent removed afterward. Because Databases status/monitoring derive from
the live agents table, the Deploy screen and the Databases screen now stay in sync automatically.

## 9g. Capture Modes & Coverage reference page (learn → deploy)

New page `pages/CaptureModes.jsx` at **/capture-modes** (sidebar under Data Sources, after Agents;
allowed for tenant_admin/soc_analyst/db_owner). Purpose: explain the trade-offs *before* deploying.
Contents:
- primer cards for the 3 installed agents + agentless, and the gate-vs-cameras mental model;
- **"Who sees what — by connection path"** matrix (routed / direct / local × proxy/network/host);
- **"What each combination buys"** matrix (Network · Host · Proxy · Net+Host · Proxy+Net · All 3 ×
  networked/local visibility, attribution, block, reroute, install, container count);
- **"What's applicable by deployment type"** (On-prem/IaaS install agents; RDS/Azure SQL/Cloud SQL/
  Atlas/OCI → agentless; inline proxy marked ⚠ possible-in-your-VPC for network-reachable PaaS);
- **posture preset cards** (Lightweight / Full visibility ★ / Enforce / Crown jewel) each with a
  **"Deploy this →"** button.

**Hand-off:** "Deploy this" navigates to `/agents?deploy=1&modes=network,host[,proxy]`; `Agents.jsx`
reads the query (`useSearchParams`) to open the Deploy-monitoring modal **pre-selected** with those
modes, and clears the params on close. So the flow is: read the matrices → pick a posture → land in
the deploy panel already configured. All matrices are static reference content (no API). Verified:
CaptureModes/Agents/App/Sidebar all transform clean; dam-react logs clean.

## 9h. Instance-scoped coverage (agents cover the whole instance)

An agent attaches to a database **instance** (host:port / process), not to one schema — so a single
MySQL instance hosting N databases is covered by one set of agents, and databases added to that
instance later are auto-covered. Implemented:

- **Backend (`GET`/`POST /api/databases`)**: coverage/monitoring/status are no longer derived
  per-`database_id`. New `loadInstanceAgents()` aggregates agents by **instance key (`host|port`)**;
  `shapeDatabase()` reads that aggregate, so every database on the same `host:port` reflects the
  instance's agents. Status = unmonitored (0 agents) / degraded / active, evaluated at the instance
  level. Response now includes `instance` (`host:port`) and `instance_databases` (count on that
  instance).
- **Frontend**: Deploy-monitoring panel shows the selected DB's instance and "agents here cover all
  N databases on this instance"; Databases detail modal shows the **Instance** + a note when it
  hosts multiple databases.

**Verified:** added `MYSQL-INVENTORY-PROD` on `client-mysql:3306` (same instance as
MYSQL-PAYMENTS-PROD) with **no new agent** → it came back `status=active`, monitoring
`['Host (eBPF)','Network']`, coverage net+host, `instance_databases=2`. I.e. a database added to an
existing instance is auto-covered. Test row removed afterward.

> Modeling note: instance identity is `(host, port)`. Databases meant to share an instance must use
> the same host+port. A first-class `db_instances` entity (enrollment per instance, schemas as
> children) is the cleaner long-term model and the natural unit for the Go agent's `TARGET`.

## 9i. First-class instance model + decommission (Option A)

Promoted the **instance** to a real entity. A `databases` row was conflating "server" and "schema";
now an **instance** (a `host:port` server) owns **databases/schemas**, and **agents enroll on the
instance** — so all of an instance's databases share coverage and new ones are auto-covered.

**Schema (additive, idempotent):** new `db_instances` table; `databases.instance_id` and
`agents.instance_id` columns. **Backfill** groups existing databases by `(tenant, host, port,
engine)` into instances and links agents to their database's instance. The 3 client DBs became 3
single-database instances; the stray `10.10.10.1` test row became its own (unmonitored) instance.

**API:**
- Coverage/status now derived from agents on `instance_id` (`loadInstanceAgents` + shared
  `coverageFromInstance`). `GET /api/databases` joins the instance (COALESCE so dashboards keep
  working) and returns `instance`, `instance_id`, `instance_databases`.
- `GET /api/instances`, `POST /api/instances` (optional `initial_database`),
  `DELETE /api/instances/:id` (**cascade**: removes its agents, databases, alerts, then the
  instance).
- `POST /api/databases` now adds a **schema to an instance** (`name` + `instance_id`, inherits the
  instance's host/port/engine); `DELETE /api/databases/:id` removes a single schema.
- `POST /api/agents` enrolls per **instance_id** (accepts `database_id` for back-compat → resolves
  to its instance); `GET /api/agents` returns the agent's `instance` (host:port).

**Frontend:**
- Databases page reworked into **Instances** + **Databases** tabs. Instances tab = the rich
  monitoring/coverage table + per-row **＋ DB / Deploy / Delete**; Databases tab = schema list with
  **Delete**. New **Register instance** modal (manual + cloud discovery, optional first database),
  **Add database to instance** modal, and **confirm-delete** modals (instance delete spells out the
  cascade). KPIs now instance-aware.
- Agents **Deploy monitoring** modal targets **instances** (not databases); accepts
  `?deploy=1&instance=<id>&modes=…` handoff from the Instances tab / database detail / Capture-Modes
  presets. Agents table shows the agent's **Instance**.

**Verified end-to-end (API):** backfill → 4 instances; add database to `client-mysql:3306` →
auto-covered (active, Host+Network, instance_databases=2); register new instance + initial database
→ unmonitored; deploy network agent → active; delete database; **decommission instance cascades**
(db + agent removed) back to baseline (4 instances / 6 agents). Dashboard endpoints still 200;
frontend compiles clean.

> Note: `databases` keeps denormalized instance fields (host/port/engine/…) so legacy dashboard
> queries are untouched; `db_instances` is the source of truth via COALESCE.

**Fix — show instance display name, not the IP:** the UI was rendering `instance` (the raw
`host:port`) where a friendly `db_instances.name` exists. Now `GET /api/databases` also returns
`instance_name`; Instances/Databases tabs, the database detail (Instance + new Endpoint field), and
the Agents deploy dropdown + table all show the **name** with `host:port` as a muted secondary line.

**Fix — uniform naming:** auto-named instances were `host:port` while user-registered ones were just
a name, so they rendered inconsistently. Convention is now **name = host** (port lives only in the
`host:port` endpoint line): the backfill/`POST /api/instances` default is host-only, and a one-time
idempotent migration renames existing `host:port` names down to `host`. All instances now display
uniformly as **name + endpoint**.

## 9j. DAM Agent — Go image, increment 1 (inline proxy for MySQL)

Started building the real agents. **One Go image** (`dev/dam/agent`, pure stdlib → trivial build),
`MODE`-selectable (network | host | proxy). **Built locally by docker-compose — no registry needed
for dev**; production would push to a registry the customer env can pull (GHCR/ECR/Docker Hub/
private). Increment 1 implements **MODE=proxy for MySQL** end-to-end.

**Control plane (additive):**
- `POST /api/agents/enroll` — token-gated (`AGENT_ENROLL_TOKEN`, dev default shared via compose).
  The agent declares the instance it monitors (`host:port` + engine); the API **find-or-creates that
  `db_instances` row** and registers the agent on it (idempotent by instance + type + agent_host).
- `POST /api/agents/:id/heartbeat` — refreshes `last_heartbeat`/status.
- **Reaper** (30s tick) marks agents `offline` after 60s without a heartbeat → drives the Agents
  screen + instance status.

**Agent (`main.go`):** loads config from env, enrolls (retries until dam-api is up), heartbeats
every 15s, then runs the mode. **Proxy:** listens on `LISTEN_PORT`, accepts client connections,
dials `UPSTREAM` (the real DB), pipes both ways, and **decodes the MySQL wire protocol on the
client→server stream** — extracts the login **username** from the handshake response and the **SQL**
from `COM_QUERY` packets (handles MySQL 8 `CLIENT_QUERY_ATTRIBUTES` header), classifies the
operation, tags sensitivity, and inserts an event into ClickHouse `dam_analytics.events`
(`agent_type='inline_proxy'`). Stable agent identity (`dam-agent-<mode>-<host>-<port>`) so restarts
reuse the row.

**Compose:** `dam-agent-mysql-proxy` (`build: ./dam/agent`) on client-net + dam-net, listening
:3306 → `client-mysql:3306`. `AGENT_ENROLL_TOKEN` shared with dam-api.

**Verified end-to-end:** agent builds, enrolls (auto-created the `client-mysql:3306` instance),
heartbeats (online in Agents screen; instance shows **Inline Proxy** coverage, status active). Ran
queries through the proxy (TLS disabled — note below) → captured with **real attribution**
(`principal=app_payments`), correct operation (SELECT/UPDATE/DELETE), and sensitivity tags
(pii/ssn/pci) into ClickHouse; dashboard event counts include them.

> **Known limits (increment 1):** (a) **TLS** — MySQL 8 clients negotiate TLS by default, which
> encrypts the wire; the proxy then sees ciphertext (the "TLS content ✗" row in the capability
> matrix). Captured demo used `--ssl-mode=DISABLED`; real TLS visibility needs the proxy to terminate
> TLS (MITM cert) — a later increment. (b) Only **proxy/MySQL** is implemented; network/host modes
> and postgres/mongo decoders are next. (c) No blocking yet (proxy currently observes + forwards).
> (d) NATS publish not wired (ClickHouse only). (e) To see captures, clients must connect **through**
> the proxy (`dam-agent-mysql-proxy:3306`); `traffic-gen` still hits MySQL directly.

## 9k. MySQL agent — continuous capture + inline blocking (increment 2)

Completed the MySQL inline-proxy agent (focus on MySQL; postgres/mongo decoders later).

- **Continuous capture:** `traffic-gen`'s MySQL is now routed **through the proxy**
  (`MYSQL_HOST=dam-agent-mysql-proxy`), so live app traffic is captured end-to-end (real
  attribution `app_payments`, operation, pii/pci/ssn tags) into ClickHouse — no manual queries
  needed. (mysql2 uses plaintext `COM_QUERY`, so the proxy decodes it.)
- **Inline blocking:** the proxy is now **packet-framed** — it forwards each client→server packet,
  but a `COM_QUERY` matching a deny rule (`BLOCK_PATTERNS` env, default
  `DROP TABLE,DROP DATABASE,TRUNCATE,GRANT ALL`) is **dropped** and a protocol-correct MySQL **ERR
  packet** (1142) is returned to the client. The query never reaches the DB.
- **Alerts:** a blocked query fires `POST /api/agents/alert` (token-gated) → an `alerts` row
  (severity high, anomaly 90, attributed to the instance's database) + WS broadcast → shows on the
  Alerts screen.
- **MySQL-only focus:** `client-postgres`, `client-mongo`, and the old `dam-collector` are stopped;
  `traffic-gen` tolerates the missing PG/Mongo (guarded connects).

**Verified:** live traffic captured continuously; `DROP TABLE transactions` via the proxy → refused
with `ERROR 1142 … Query blocked by TooVix DAM policy`, the table **still exists**, and a
"Blocked by policy" alert appears in `/api/alerts`. Agent online; instance coverage = Inline Proxy.

> Still open (later): real TLS visibility (proxy TLS-termination), network/host modes, postgres/mongo
> decoders, richer policy (column/role-aware, not just substring), NATS publish.

## 9l. Network agent — real passive capture (increment 3)

`MODE=network` now does **real passive packet capture** (no longer a stub), still pure Go stdlib:
- Opens an **`AF_PACKET` raw socket** (`syscall`, no libpcap/CGO), bound to `CAPTURE_IFACE` (eth0),
  parses **Ethernet → IPv4 → TCP**, filters client→server segments to `TARGET_PORT`, reassembles
  per-connection (4-tuple) and decodes the MySQL wire protocol via the shared `frameAndDecode`
  (handshake username + COM_QUERY, query-attributes aware). Passive — observes, never blocks.
- Compose `dam-agent-mysql-network`: `network_mode: service:client-mysql` (shares the DB's net
  namespace — the only way to sniff another container on a switched Docker bridge), `cap_add:
  NET_RAW/NET_ADMIN`, `user: root`. Because a netns-shared container can't also join dam-net, it
  reaches the platform via **host-published ports** (`host.docker.internal:3000/:8123`).

**Verified:** the network agent enrolled on the **same instance** as the proxy (so the instance now
shows **Network + Inline Proxy** coverage), and captured live traffic-gen queries off client-mysql's
NIC with full attribution (`app_payments`), correct operation, and pii/pci tags — running **in
parallel** with the proxy. This concretely demonstrates the **redundant capture on the routed path**
(both saw the same proxy→mysql queries), which is expected: passive agents earn their keep on
proxy-bypass/local traffic, not on already-proxied traffic.

> Gotchas: (a) `extra_hosts` conflicts with `network_mode: service:` — removed; Docker Desktop
> resolves `host.docker.internal` automatically. (b) An agent started **mid-connection** misses the
> handshake → `principal=unknown` + query-attributes unknown (operation OTHER); restarting the
> client (fresh handshake) fixes it. (c) Reassembly is arrival-order (fine on a local bridge; a
> production agent would order by TCP seq). **Host (eBPF) mode** remains a stub here — to be run for
> real on a Linux VM (Intel MacBook) next.

## 9m. Cleanup — MySQL-only, real agents only

Removed everything without a real agent and consolidated MySQL:
- **Decommissioned the postgres + mongo instances** (their DBs are stopped and only had *seeded*
  `collector-*` agents). Deleted those instances + databases + fake agents + related alerts.
- **Consolidated MySQL.** There were two `client-mysql` instances: the user-registered one
  (host `127.0.0.1`, holding the `payments`/`invoices` databases, **no agents**) and the
  agent-enrolled one (host `client-mysql:3306`, holding the **2 real agents**, no databases) — the
  `127.0.0.1` host mismatch flagged earlier. Moved the databases onto the real `client-mysql:3306`
  instance (host corrected) and dropped the empty duplicate. Now one MySQL instance, 2 databases,
  both showing **active / Network + Inline Proxy** from the real agents.
- **Removed the fake agent seed** from `runAuthMigration` (agents self-enroll via
  `/api/agents/enroll` now), so fresh starts no longer create `collector-*` agents — databases stay
  unmonitored until a real agent is deployed.

Final: 1 instance, 2 databases, 2 real online agents (network + inline_proxy); verified it persists
across a dam-api rebuild (no re-seed). PG/Mongo client DBs remain stopped.

> A full volume reset (`down -v`) would re-run `init.sql`, which still seeds the PG/Mongo *databases*
> (now agentless/unmonitored). Strip those from `init.sql` if a permanently MySQL-only baseline is
> wanted; left in for when PG/Mongo testing resumes (e.g., the Linux VM for host mode).

## 9n. Dashboard "monitored" count fix

The dashboard showed **0 monitored DBs** while the Databases/Agents screens showed them monitored.
Cause: the dashboard was the last place still counting the stale `databases.monitoring_status`
column (which stays `not_monitored`), instead of deriving from the live agents table. Fixed the
three dashboard queries — `dashboard/kpis`, `computeFleetRisk`, and `dashboard/risky-databases` — to
count a database as monitored when **its instance has ≥1 agent** (`EXISTS … agents WHERE
instance_id = d.instance_id`). Verified: kpis `monitored: 2`, risky-databases both `monitored`. The
`monitoring_status` column is now fully vestigial (still written on insert, never read for status).

## 9o. Data-plane integrity — signed Merkle checkpoints + pluggable WORM archive

Per-row hash chaining works for the control plane (Postgres `audit_trail`, low volume) but is
impractical for ClickHouse `dam_analytics.events` (millions of append-only rows). Implemented the
**detection + prevention** pair the architecture doc called for:

**Detection — signed Merkle checkpoints** (`api/main.js`):
- `runCheckpoint()` runs every 180s (first run 25s after boot). It seals every event window
  `[prev.window_end, now-30s)` (the 30s settle margin avoids racing late inserts).
- `windowDigest()` computes a SHA-256 **Merkle root** over `arraySort(groupArray(event_id|timestamp|
  principal|operation|row_count))` — order-independent, so it only changes if events are added,
  removed, or altered.
- Each checkpoint is **chained** (`chain_hash = sha256(prev|seq|window|count|root)`) and
  **HMAC-signed** (`AUDIT_SIGNING_KEY`). Proof rows go to a new Postgres table `audit_checkpoints`
  (migration in `runMigrations`) — **separate from the data**, so deleting events in ClickHouse
  cannot erase the evidence.
- `GET /api/audit/checkpoints` (list) and `GET /api/audit/checkpoints/verify` (recompute every
  window vs. live ClickHouse → `{ok,total,broken:[{seq,reason}]}`). Verified: deleting 59 events
  inside window #1 → `event count changed (10504 → 10445)`.

**Prevention/recovery — pluggable immutable (WORM) archive** (`api/archive.js`, new):
- `createArchive(env)` factory returns a provider with a uniform contract
  `{ name, mode, lockDays, init(), put(key, body, contentType) }`, so the checkpoint engine is
  cloud-agnostic. Each sealed window's raw events are also shipped as NDJSON to the archive.
- Providers, selected by `ARCHIVE_PROVIDER`:
  - `s3` — AWS S3, MinIO, Ceph, Wasabi, any S3-compatible (uses the `minio` SDK; for AWS set
    `S3_ENDPOINT=s3.<region>.amazonaws.com S3_USE_SSL=true S3_PORT=443`). Bucket created with
    Object Lock; default retention set from `ARCHIVE_LOCK_MODE` (GOVERNANCE/COMPLIANCE) +
    `ARCHIVE_LOCK_DAYS`.
  - `azure` — Azure Blob Storage (`@azure/storage-blob`); per-blob immutability policy
    (`Locked`=COMPLIANCE / `Unlocked`=GOVERNANCE) when version-level immutability is enabled.
  - `none` — detection-only, no archive.
- Dev backend: new `dam-minio` compose service (S3 API on host `9100`, console `9090`; host 9000
  is taken by ClickHouse). All knobs are env-overridable in `docker-compose.yml` with AWS/Azure
  examples documented inline. `Dockerfile` now also copies `archive.js`.
- Verified WORM: `mc rm --version-id …` on the locked object → `WORM protected and cannot be
  overwritten`; deleting events from ClickHouse then **restoring them from the archive** brought
  `verify` back to `{ok:true}` (full detect → recover loop).

**UI** (`frontend/src/pages/AuditTrail.jsx`): new **Checkpoints** tab (seq, window, event count,
Merkle root, "HMAC ✓", "WORM stored"). The header **Verify** button is tab-aware — control-plane
chain on the Control Plane tab, data-plane checkpoints on the DB Activity / Checkpoints tabs.

## 9p. DSAR Manager — dynamic, with real subject discovery

The page rendered a flat list and its "New request" was broken (frontend sent `subject_email`,
backend required `subject_identifier` → insert failed, table stayed empty). Rebuilt against the
mockup (`mockups/dsar.html`) with **real data discovery**:

**Backend** (`api/main.js`, needs `mysql2`):
- `discoverSubject(identifier, name)` — loads classified personal-data columns
  (`classified_columns` ⋈ `databases` ⋈ `classified_objects`), groups by physical host, then for
  each MySQL client DB **connects and runs `SELECT COUNT(*) … WHERE <id/name cols> = ?`** to confirm
  the subject actually has rows there. Returns hits `[{database, schema, object, columns[], tags[],
  row_count}]` grounded in live customer data — not seed data.
- `persistDiscovery()` writes hits to new table `dsar_data_hits` and rolls
  `databases_found`/`columns_found`/`status` forward. `dsarSteps()` derives the workflow
  (received → discovery → compile/erase/rectify → close) from request type + status.
- Endpoints: `POST /api/dsar` (creates **and discovers** synchronously), `GET /api/dsar/:id`
  (request + hits + steps), `POST /api/dsar/:id/discover` (re-scan), `POST /api/dsar/:id/fulfill`.
  All `authRequired` and `writeAudit`-logged (`dsar.create/rescan/fulfill`). Erasure **does not**
  physically delete customer rows — fulfilment is recorded; deletion stays gated behind DBA approval.
- Compose: added `CLIENT_MYSQL_ROOT_PASSWORD` to `dam-api` env and put `dam-api` on `client-net`
  (the control plane needs read-only reach into client DBs for discovery). Added `mysql2` to
  `package.json`.

**Frontend** (`frontend/src/pages/Dsar.jsx`): KPIs (Open / Due soon / Fulfilled / Avg time),
table with **Found-in** column + deadline countdown, and the **fulfillment detail modal**
(subject/regulation/deadline cards, workflow step tracker, "Data locations found" per-object with
columns + tags + row counts, and type-aware actions: Execute erasure / Compile export / Apply
rectification, Re-scan, Export data locations). Fixed create to send `subject_identifier`.

Verified: erasure for `john@example.com` → found in `payments.customers` (6 personal cols, 1 row),
status `in_progress`; unknown subject → 0 hits, `discovering`; fulfill → all steps done,
`fulfilled_at` set.

## 9q. Billing & Usage — dynamic, metered from live platform state

The page was 100% hardcoded (`DEMO_USAGE`/`DEMO_INVOICES` arrays, no backend). Rebuilt against
`mockups/billing.html` with usage **metered from real platform data** and persisted invoices.

**Backend** (`api/main.js`): pricing model constants (`BILLING_PLAN`, `BILLING_RATES`) +
- `computeUsage()` — live metrics: monitored DBs (databases with agents), inline-blocking DBs
  (`agent_type='inline_proxy'`), DSARs this period, events/day (7-day avg vs. ClickHouse), **hot
  storage** (`system.parts` bytes for `dam_analytics`), and **cold storage = the WORM archive**
  (`archive.usage()` sums MinIO/S3/Azure object sizes — new method in `archive.js`).
- `buildLineItems()` — current invoice from usage × rates (base fee, per-DB, event/hot overage,
  cold per-GB, inline per-DB, per-DSAR). `ensureInvoices()` generates/refreshes the current month's
  invoice and backfills 5 prior months once so history isn't empty.
- New tables `billing_invoices`, `payment_methods` (seeds Stripe primary + Razorpay backup).
- Endpoints: `GET /api/billing` (plan, usage+limits, current invoice, balance, methods, history),
  `POST /api/billing/pay` (marks invoice paid, simulated gateway txn), `POST
  /api/billing/payment-methods` (connect gateway). All `authRequired` + `writeAudit`-logged
  (`billing.payment`, `billing.gateway_connect`).

**Frontend** (`frontend/src/pages/Billing.jsx`): KPIs, usage progress bars (with limits/%),
current-invoice breakdown table, payment-methods + account-balance cards, invoice history, a
currency switcher (client-side display conversion), a **Make-a-payment** modal (→ `/billing/pay`)
and **Connect-gateway** modal (→ `/billing/payment-methods`), and CSV export of invoices.

Verified live: Jun 2026 = $8,850 from real usage (4 DBs, 2 inline, 2 DSARs, 15-object WORM archive
as cold storage); pay → status `paid`, outstanding $0; reset to `open` for demo.

## 9r. Dashboard "Open alerts by severity" donut — fixed to real open counts

The donut was fed `recentAlerts` — the **latest-10 alerts of any status** (`/dashboard/recent-alerts`,
`ORDER BY created_at DESC LIMIT 10`). So it was both capped at 10 and polluted with
acknowledged/resolved/false-positive alerts — it never reflected the true open-alert breakdown
(actual: 97 critical / 142 high / 66 medium / 7 low = 312 open).

Fix: new endpoint `GET /api/dashboard/alerts-by-severity` (`GROUP BY severity WHERE status='open'`,
returns `{critical,high,medium,low,total}`), surfaced through `useDashboard` as `alertSeverity`.
`SeverityDonut` now accepts a `counts` prop (falls back to counting a list for other callers), and
the Dashboard passes `counts={alertSeverity}`. `recentAlerts` stays as-is for the AlertFeed (recent
activity is correctly status-agnostic). Verified the donut total matches the live open-alert count.

## 9s. Alert counts unified — Alerts page, sidebar badge, dashboard donut all agree

After 9r, the dashboard donut (correct, 320 open) disagreed with the Alerts screen. Root cause: both
the **Alerts page** and the **sidebar nav badge** loaded `GET /api/alerts` (which was `LIMIT 100`,
all statuses) and counted `status==='open'` client-side — so they undercounted (capped at ≤100,
status-mixed). Three different places were each deriving counts from a capped list.

Fix — one authoritative source:
- New `GET /api/alerts/summary` → `{ open:{critical,high,medium,low,total}, ack, closed, all }`
  (single `GROUP BY status,severity`).
- `GET /api/alerts` is now **filterable** (`?status=open|ack|closed|resolved&severity=&limit&offset`,
  default limit 500/max 1000) so the table fetches per active tab instead of one capped list.
- Alerts page: KPIs + tab badges + `ackAll` total come from `/alerts/summary`; the table fetches
  `/alerts?status=…&severity=…` reactively on tab change. Sidebar badge uses `summary.open.total`.
- Verified all agree with DB ground truth (320 open: 101/144/68/7); count rises live as the
  detection simulator fires.

## 9t. Alerts — search, group-by, indexes, and display-cap notice

- **Search**: `GET /api/alerts` gained a `q` param (ILIKE over principal, summary, rule, object_name,
  database name). Alerts page has a debounced (350ms) search box; results combine with the active tab.
- **Group by**: client-side toggle (none / Database / Principal / Rule / Severity) renders the visible
  rows as collapsible sections with per-group counts (count-desc).
- **Display cap notice**: the list is capped server-side at 500 rows (`LIST_CAP`). When a view hits
  the cap, an amber banner says "Showing the first 500 (display limit) of N — narrow with search or
  tabs." The card sub also shows "X of N showing" using the authoritative summary counts.
- **Indexes** (from the partitioning discussion): added `idx_alerts_status_created (status,
  created_at DESC)` and partial `idx_alerts_open_created … WHERE status='open'` to keep the triage
  path index-scanned as the table grows. Decision: defer partitioning (table is ~kB-scale); if volume
  warrants, range-partition by `created_at` (immutable key) rather than mutable `status`.

## 9u. Self-generating quarantine activity (generator → proxy block → held session)

End-to-end so blocked queries land on the Quarantine screen on their own:
- **Traffic generator** (`client/traffic-gen/generate.js`): every ~12 loops fires a policy-violating
  MySQL query (`TRUNCATE` / `GRANT ALL` / `DROP TABLE`, all against throwaway `zzz_scratch`/fake-user
  names so nothing real is harmed) through the inline proxy (`MYSQL_HOST: dam-agent-mysql-proxy`).
- **Inline proxy agent** (`dam/agent/main.go`): on a `BLOCK_PATTERNS` match it already rejected the
  query (MySQL err 1142) + raised an alert; now it **also** calls `POST /api/quarantine` via new
  `quarantineSession()` → a `held` session (critical, with principal/db/query-preview/client-IP).
- **Sidebar badge**: new `GET /api/quarantine/summary` (`{held,released,killed,total}`); the
  Quarantine nav badge is now driven by `summary.held` (live-polled), hardcoded `ct:'3'` removed.

Verified: generator fired `DROP TABLE …` → proxy logged `[BLOCKED]` → 2 `held` sessions created
(`database_name=MYSQL-PAYMENTS-PROD`), summary `{held:2}`. Note: restarting the proxy drops the
generator's single MySQL connection (no auto-reconnect) — restart `traffic-gen` after rebuilding the
proxy. Held sessions accumulate (~1 per 90s); reviewers release/kill them on the screen.

- **Quarantine row detail** (`Quarantine.jsx`): double-clicking a session opens a modal showing the
  full **attempted query** (`query_preview`), a plain-language "why this was blocked" derived from the
  SQL (destructive DDL / privilege escalation / policy match), principal/db/severity/status, hold
  timing, and Release/Kill actions. Surfaces what the app actually tried to run, beyond the one-line reason.

## 10. Admin console — Super-Admin app (new `dam/admin-frontend`)

Started the **Super-Admin console** as a second React/Vite app, separate from the product app,
mirroring its structure and reusing the **exact same design system** — `App.css` (all **11 themes**,
incl. the two beyond the mockups: `signature`, `enterprise`), `branding.js`, `useApiData`, `KpiCard`,
`PageHeader`, `Toast`. New shell components: admin `Sidebar` (super-admin nav from mockup `NAV_SUPER`),
self-contained `TopBar` (11-theme switcher, no auth/tz deps yet), `Layout`.

- **First screen built: Platform Dashboard** (`pages/PlatformDashboard.jsx`) — 8 KPI cards
  (active tenants, total DBs, agents online + health %, events today, platform alerts, regions, data
  integrity, platform version), an events-ingested area chart (`PlatformEventsChart`), a tenants-by-region
  donut (`RegionDonut`), and two tables (top tenants by volume, open platform alerts). Sidebar entries
  without a page yet route to a generic `Placeholder`.
- **Fully dynamic** via new backend endpoints (read-only aggregation; nothing mutates main-app data):
  - `GET /api/admin/platform/overview` — aggregates `tenants` / `databases` / `agents` / `audit_trail`
    (Postgres) + events-today & per-tenant volume (ClickHouse, best-effort) + the isolated admin tables.
  - `GET /api/admin/platform/events-timeline` — last-24h hourly event counts (ClickHouse).
- **DB: new ISOLATED admin-only tables** (additive `CREATE TABLE IF NOT EXISTS` in new
  `runAdminMigration()`, called after `runAuthMigration()`): `platform_alerts`, `platform_meta`
  (version/deploy date). No existing main-app table is altered or its data modified, so the main DAM
  app is unaffected. No demo tenants seeded — the dashboard reflects real data (currently 1 tenant).
- **docker-compose**: added `dam-admin-react` (build `./dam/admin-frontend`, port **5174**, src volume-
  mounted, proxies `/api` → dam-api). The static admin mockups stay available on `dam-admin-frontend`
  (nginx, :8092). Verified `npm run build` succeeds (662 modules).

### 10a. Admin screen 2 — Tenants (`pages/Tenants.jsx`)

Second admin screen, faithful to `admin-mockups/tenants.html`: 4 KPI cards (Active / Trial /
Suspended / Total DBs), a searchable tenants table (name+slug, plan, region, DBs, events/day,
agents online/total, status, **live-derived health**), a **Manage** detail modal (status bar, details,
config, usage, quick links to other admin routes, lifecycle action buttons), and a **3-step Create
Tenant wizard** (details → deployment → animated provisioning).

- **Read endpoints** (all live, read-only aggregation):
  - `GET /api/admin/tenants` — per-tenant rollup: DB count, agent online/total, monitored DBs, open
    alerts, events/day (ClickHouse), primary admin (LATERAL join to `users`), SSO from `auth_provider`,
    and a composite **health** score (`tenantHealth()` = 60·agent-uptime + 40·monitor-coverage − open-alert penalty).
  - `GET /api/admin/tenants/:id` — same shape for one tenant. `GET /api/admin/tenants/summary` — KPI counts.
- **Create = REAL** (per user decision): `POST /api/admin/tenants` does an additive `INSERT` into
  `tenants` (+ optional `tenant_admin` user invite via `ON CONFLICT (email) DO NOTHING`). Slug format +
  uniqueness validated (dup → 409). New rows only — no existing tenant is modified. The wizard's final
  step calls this for real behind the provisioning animation.
- **Status actions = PROTOTYPE** (per user decision): Suspend / Unsuspend / Offboard / Reset-pw /
  Force-logout / Export / Migrate are toast-only (no write), so the live Meridian tenant the product
  app logs into is never disrupted. A note in the modal states this.
- **Not schema-changed**: fields the mockup shows but the schema lacks (KMS, retention, compliance,
  contract date) are shown as derived/“Platform default” rather than altering the `tenants` table.
  If we want them editable later, store in an isolated `tenant_admin_meta` table (platform_meta pattern).
- Verified end-to-end: created `acme-test-co` (trial) → summary went 1→2 tenants / 0→1 trial, dup slug
  → 409, main app `/api/tenants` + dashboard KPIs unaffected, then **cleaned up the test row**. Admin
  build OK (664 modules); HMR live on :5174.

### 10b. Admin screen 3 — Feature Flags (`pages/FeatureFlags.jsx`)

Third admin screen, faithful to `admin-mockups/feature-flags.html`: 4 KPI cards (Features / GA / Beta /
Alpha), a **Global Feature List** (per-tier Starter/Business/Enterprise access ✓/✗, rollout-stage badge,
live Enabled X/total, Manage), an inline **Per-Tenant Overrides** panel, and a **Staged Rollout** card.

- **Two new ISOLATED admin tables** (additive, no main-app table touched):
  - `feature_flags` — 16-feature catalog (key, name, desc, stage ga/beta/alpha, tier_starter/business/
    enterprise, is_core, tier_gated, rollout_target/error, sort). Seeded in `runAdminMigration()`.
    Counts match the mockup exactly: 16 total / 12 GA / 3 Beta / 1 Alpha.
  - `feature_overrides` — per-tenant exceptions (`feature_key`+`tenant_id` unique, status). No FK to
    tenants (kept fully isolated so it can never interfere with tenant lifecycle).
- **Effective enablement is derived** (`featureEnabled()`): core = always on; explicit override wins;
  otherwise GA features are on for tier-eligible tenants while **beta/alpha are opt-in** (default off).
  Tier eligibility from `tenants.tier` (enterprise/business/else→starter).
- **Endpoints**: `GET /api/admin/features` (catalog + live enabled counts), `/features/summary`,
  `/features/:key/overrides` (per-tenant rows), and `POST /features/:key/overrides/:tenantId`
  `{status: enabled|disabled|reset}`.
- **Override toggles = REAL writes** — but only into the isolated `feature_overrides` table, so the
  main app is unaffected (no confirmation needed). Core/tier-gated features reject overrides → 409.
  Staged-rollout buttons (Expand/Pause/Rollback) are prototype toasts; the rollout % is live-derived.
- Verified: enabling UEBA for Meridian flipped its enabled count 0→1 and persisted; core override → 409;
  then **reset the test override** (table back to 0 rows); main app KPIs unaffected; `/feature-flags`
  + `/api/admin/features` serve 200 via :5174. Admin build OK (16 modules added → 666 total-ish).
- **Fix (Manage button)**: drove the UI with headless Chromium (Playwright). The Manage button worked
  logically (panel opened, overrides rendered, Enable persisted, no JS errors) but the overrides panel
  renders *below* the 16-row feature table, so on a normal viewport it opened off-screen and looked
  inert. Added `scrollIntoView` on open (a `panelRef` + `useEffect([selected])`) to match the mockup —
  panel now lands at viewport y≈431 right after the click. Tenants' Manage (centered modal) was fine.

### 10c. Admin screen 4 — Resource Quotas (`pages/Quotas.jsx`)

Fourth admin screen, faithful to `admin-mockups/tenant-quotas.html`: 4 KPI cards (Tenants at limit /
Soft warnings / Hard blocks / Avg utilization), a conditional quota-warning banner, the **Quota Usage
by Tenant** table (events/day + DBs + storage, limit vs actual, status), **Default Quotas by Plan Tier**,
an **Enforcement Behavior** reference, a **Quota Utilization** bar list, **Notification Channels**, and a
live **Current Quota Pressure** panel. Edit opens a per-tenant quota editor.

- **Two new ISOLATED admin tables**: `quota_plans` (tier defaults — seeded starter/business/enterprise;
  NULL = unlimited/custom) and `quota_overrides` (per-tenant custom limits + justification + operator).
- **Limits = override ?? plan default; actuals are REAL**: DB count from Postgres, events/day from
  ClickHouse (today), storage *estimated* from total ClickHouse rows × ~1 KB/event (honest: the dev
  tenant shows ~1 MB). pct/status/avg all derived; "Current Quota Pressure" is computed live from
  utilization (≥70%), no static seed.
- **Endpoints**: `GET /api/admin/quotas` (+ `/summary`, `/plans`, `/alerts`) and
  `POST /api/admin/quotas/:tenantId` (save override).
- **Edit = REAL write** into the isolated `quota_overrides` table (justification required → stored on
  the row). Deliberately does **NOT** write to the app-maintained `audit_trail` (its hash-chain is
  app-owned) — flagged in both the API comment and the modal copy. **Upgrade** (Business→Enterprise)
  stays a prototype toast (would change tenant tier).
- Verified end-to-end + in-browser (Playwright): plan defaults seeded; Meridian shows 250M ev-limit /
  142 actual / Unlimited DBs / 4 / 5 TB / ~1 MB → OK; save w/o justification → 400 and modal stays
  open; save with justification flipped the row to "custom" with new limits; **cleaned up the test
  override**; main app KPIs unaffected; `/quotas` + `/api/admin/quotas` serve 200 via :5174.

### 10d. Admin screen 5 — Tenant Health (`pages/TenantHealth.jsx`)

Fifth admin screen, faithful to `admin-mockups/tenant-health.html`: a tenant selector, 4 KPI cards
(Overall health / Databases / Events today / Open issues), six **Health Cards** (Ingest, Agent, Alert,
Classification, Compliance, Integration — each with a live Healthy/Warning/Degraded/Critical/No-data
badge), and a **Recent Issues** table.

- **Pure reads — NO new tables, NO writes, main app untouched.** Single endpoint
  `GET /api/admin/tenants/:id/health` aggregates real state:
  - Ingest from ClickHouse (eps over last 5m, lag from `max(timestamp)`, events today) per tenant_id.
  - Agent from `agents` (online/total, offline list, coverage from monitored DBs).
  - Alert from `alerts` (24h count, ack-rate from non-open, avg `resolved_at-created_at`, unack).
  - Classification from `classified_columns` (count, last scan, pending = confidence<0.85).
  - Compliance from global `compliance_scores` (frameworks, avg pass-rate, gaps).
  - Integration from `integrations` (empty in dev → honestly "Not configured").
  - **Issues derived live** from offline agents, coverage gaps, open alerts, ingest lag, stale scans.
  - Overall health reuses the shared `tenantHealth()` composite (consistent with the Tenants screen).
- Selector lists real tenants (1 in dev); the page is also the Tenant-screen Manage quick-link target.
- Verified end-to-end + in-browser (Playwright): Meridian → health 75, Ingest *Degraded* (last event
  2m), Agent *Healthy* 4/4 100%, Alert *Critical* (816/24h, 52 unack), Compliance *Critical* 84.1%,
  Integration *No data*, and **8 issues sourced from real open alerts** (brute-force, blocked DROP/
  TRUNCATE, GRANT DBA, bulk read). 4 KPIs + 6 cards + 8 issue rows render, no JS errors; main app
  unaffected; `/tenant-health` serves 200 via :5174.

### 10e. Fix — events were tagged `'dev-tenant'`, not the real tenant UUID

The Tenant Health (and Platform) per-tenant event counts read far too low (≈160/day vs ≈3.8k actual)
and Ingest showed *Degraded*. Root cause: the event writers **hard-coded `tenant_id = 'dev-tenant'`**
([collector.js:14], [agent/main.go:511]) while the real tenant is a UUID. The main app never noticed
because **it counts events without a tenant filter**; only the new admin screens read per-tenant.
Verified safe to change: UEBA baselines match by `principal` only (not tenant_id), so re-tagging can't
break detection.
- **Fix**: the `/api/agents/enroll` response now returns `tenant_id` (it already computed it); the Go
  agent threads it through `Config.TenantID` → `forwardEvent` (fallback `'dev-tenant'` if unresolved);
  the collector resolves it at startup via `GET /api/tenants`. Rebuilt dam-api + dam-collector + the 4
  agent containers; restarted traffic-gen (its proxy conn drops on rebuild).
- **Backfill**: re-tagging in place failed (`tenant_id` is in the ORDER BY key — can't `ALTER … UPDATE`
  a key col). Did it correctly with `INSERT … SELECT * REPLACE ('<uuid>' AS tenant_id) … WHERE
  tenant_id='dev-tenant'` then `ALTER TABLE … DELETE WHERE tenant_id='dev-tenant'`.
- **Result**: 0 `'dev-tenant'` rows remain; Tenant Health = 3,865 today / Ingest *Healthy* *Running*;
  Platform Dashboard top-tenant = 3,865; main app dashboard = 3,865 — **all three now agree**.

### 10f. Admin screens 6–9 — Infrastructure section

Built the four Infrastructure screens from `admin-mockups/` (infra-health, noisy-neighbor, canary-deploy,
capacity-planning). The mockups assume a fictional 5-region fleet; wired to **real dev-stack data** where
it exists, single "local (dev)" region otherwise.

- **Infrastructure Health** (`InfraHealth.jsx`, `GET /api/admin/infra/health`) — the most real screen:
  live probes of all 8 actual services (Postgres `SELECT 1`, ClickHouse, Redis TCP, NATS `/varz`, MinIO
  `/health/live`, API self, collector via recent events, agents from table) + real metrics (CH disk %/
  rows/queries-per-hr from `system.*`, Postgres size/conns, NATS msgs/mem). KPIs + region card +
  Live-Metrics panel + Component-Status table. Verified: 8/8 healthy, CH 10% disk, real numbers.
- **Noisy Neighbor** (`NoisyNeighbor.jsx`, `GET /api/admin/infra/noisy`) — per-tenant ClickHouse usage
  from **real event share** (events/hr per tenant_id); Event-Hub/K8s figures are estimates scaled from
  that share (labelled as such in the UI). Layer tabs (All/CH/EventHub/K8s), detail panel w/ scroll-into-
  view, prototype throttle sliders + auto-throttle toggle. Meridian shows 100% share (single tenant).
- **Canary Deployments** (`CanaryDeployments.jsx`) — **isolated `canary_rollouts` table** (seeded active
  v2.4.2 + 5 history rows). `GET /api/admin/canary`, `POST /api/admin/canary` (start), and
  `POST /api/admin/canary/:id/action` (promote/pause/resume/rollback) = **real writes** to the isolated
  table only. Phases stepper, real action buttons, canary metrics, real tenants as canary pool, history
  table, start-rollout modal. Verified promote (5%→25%) persists, then reset.
- **Capacity Planning** (`CapacityPlanning.jsx`, `GET /api/admin/infra/capacity`) — **real** ClickHouse
  disk used/total + `os.cpus()` cores; linear forecast (`days to 90%`) from today's event bytes/day;
  cost projection derived from fleet counts at an 8%/mo assumption; recommendations derived from
  utilization. Per-region table + recharts growth area + recs + cost columns.
- **New isolated table**: `canary_rollouts` only. Infra/noisy/capacity are pure reads. `net` added to
  requires for the Redis TCP probe. No main-app table touched; main app KPIs unchanged.
- Verified all 4 in-browser (Playwright): 4 KPIs each, marker sections present, **zero JS errors**;
  routes + endpoints all 200 on :5174 / :3000. Admin build OK.

### 10g. Admin screens 10–12 — Billing & Success section

Built Billing & Plans, Trial Conversion, Customer Success from `admin-mockups/`. **All pure reads,
no new tables, no writes** — every number is computed from real usage/tenant/health/feature data.

- **Billing & Plans** (`Billing.jsx`, `GET /api/admin/billing`) — invoices **computed live**: per tenant
  base+per-DB fee (pricing model in code) + event/storage **overages vs the quota limits** (reuses
  `quota_plans`/`quota_overrides`); MRR/avg/overage KPIs; revenue-by-region donut; tenant invoice table;
  recent billing events derived from the invoices. Static reference: Plan-Tiers + Pricing-Model tables.
  Verified: Meridian → 4 DBs × $100 = **$400/mo**, $0 overage, Paid; MRR $400.
- **Trial Conversion** (`TrialConversion.jsx`, `GET /api/admin/trials`) — active trials = tenants with
  `status='trial'`; trial table (day# from created_at, DBs, alerts fired) with derived next-milestone +
  health; conversion funnel derived from real pipeline (signed-up → connected-DB → first-alert →
  converted); CSM auto-trigger signals. Honest empty state (0 trials in dev).
- **Customer Success** (`CustomerSuccess.jsx`, `GET /api/admin/success`) — account-health table reusing
  the `tenantHealth()` composite + usage (coverage) + alert-ack % + ARR (invoice×12) + derived renewal
  date + risk-based signals; **feature-adoption** computed from `feature_flags`/`feature_overrides`
  (% tenants with each feature enabled); expansion signals; static TTV benchmarks. Verified: Meridian
  health 75 (at-risk, 300 open alerts), ARR $4,800, adoption 100% on enterprise-eligible features.
- Pricing model: base { business/professional $2,500 }, $150/DB (ent $100), event overage $0.12/1M,
  hot storage $0.08/GB — all in code (`PRICING`).
- Verified all 3 in-browser: 4 KPIs each, marker sections, **zero JS errors**; routes + endpoints 200;
  main app KPIs unaffected (4 DBs / 4 agents). Numbers are small (one dev tenant) but correctly computed.

### 10h. Fix — admin vs product billing disagreed; then made rates configurable

- **Disagreement**: admin billing showed $400, product `/api/billing` showed $8,875 for the same tenant
  because the first admin version invented its own rate card. Fixed by making admin `computeInvoices()`
  **reuse the product pricing engine** (`BILLING_PLAN` + `BILLING_RATES` + `buildLineItems`) with
  per-tenant usage (storage apportioned by event-row share). Now both = **$8,875** line-for-line. Also
  updated the admin Pricing-Model/Plan-Tiers tables to the real rate card and fixed the Overages KPI to
  count only metered overages.
- **Configurable rates** (`billing_rates` isolated singleton table): the previously hardcoded
  `BILLING_PLAN`/`BILLING_RATES` consts became `let`, seeded into `billing_rates` and **loaded into
  memory at startup** via `loadBillingRates()` (called after `runAdminMigration`).
  `GET/PUT /api/admin/billing/rates` read/edit the card; PUT validates (numbers ≥ 0 → 400 otherwise),
  persists, and **reloads in memory** so both admin and product billing recompute instantly — no rebuild.
  Product invoices stay in sync because `ensureInvoices` already refreshes the open invoice from live usage.
- **Admin Billing editor** (`Billing.jsx`): Pricing-Model table now renders from `/admin/billing/rates`
  with an **Edit rates** modal (7 rates + 3 plan limits) → `apiPut` (added to admin client). Footer shows
  last-updated by/when.
- Verified end-to-end: PUT base 8000→9000 / perDB 100→120 → admin **and** product both jump to **$9,955**
  (base $9,000 + 4×$120 + $475 add-ons); negative rate → 400; reset to defaults; editor modal renders
  10 inputs, zero JS errors. New isolated table only; no main-app table touched.

### 10i. Per-tenant negotiated contracts (discounts)

Real-world customers pay negotiated (discounted) rates, not the global card. Implemented this as
**per-tenant custom rate overrides with an optional valid-until** (the model the user picked).
- **Layering**: global `billing_rates` → per-tenant override → effective card. `buildLineItems(u, plan,
  rates)` was parameterised (defaults to the globals, so existing callers are unchanged); a new
  `effectiveBilling(tenantId)` merges the global card with any ACTIVE override (NULL column = keep global;
  past `valid_until` = ignored).
- **Both screens use it**: admin `computeInvoices` calls `effectiveBilling` per tenant; the product
  `/api/billing` + `ensureInvoices(tenantId, usage, plan, rates)` use the logged-in tenant's effective
  card — so the customer is billed at their contracted rates and the admin matches exactly.
- **Isolated table** `tenant_billing_overrides` (per-DB/base/etc. nullable + `valid_until` + `reason` +
  `updated_by`). New endpoints: `GET/PUT/DELETE /api/admin/tenants/:id/billing-override`. PUT validates
  (≥0, valid date), empty body clears the contract.
- **UI** (`Billing.jsx`): invoice table gains a **Contract** column (＋ Set / ✎ Edit) + a "Negotiated ·
  until <date>" badge on the tenant; a `ContractEditor` modal with per-rate inputs (blank = global,
  shown as placeholder), valid-until, reason, and **Remove contract**. Added `apiDelete` to the admin client.
- Verified end-to-end (admin **and** product): contract base 8000→6000 / perDB 100→80 → both **$8,875 →
  $6,795**, negotiated badge + valid-until shown; **valid_until in the past auto-reverts** both to $8,875;
  DELETE → global; editor modal placeholders show globals; zero JS errors; main app unaffected.

### 10j. Admin screens 13–17 — Security & Ops section

Built all five Security & Ops screens, dynamic against the backend. Four new **isolated** tables +
a shared **platform-audit logger** wired into the existing admin write-actions, so the audit log fills
with real operator activity. No main-app table touched.

- **New isolated tables**: `platform_audit` (operator action log), `admin_access_sessions`
  (impersonation + break-glass, keyed by `type`), `approval_requests` (multi-party chain in JSONB),
  `platform_operators` (12 vendor staff + role). All seeded.
- **`logPlatformAudit()` helper** is now called from tenant-create, billing-rates update, contract
  save/remove, quota-override, canary action, and the session/approval endpoints → the audit log shows
  genuine operator actions, not just seeds.
- **Platform Audit Log** (`PlatformAudit.jsx`, `GET /api/admin/audit`): KPIs (events today / actors /
  tenants / live impersonations), server-side filters (actor/action/tenant/search/date), client CSV export.
- **Impersonation** + **Break-Glass** (`Impersonation.jsx`/`BreakGlass.jsx`, `GET/POST
  /api/admin/sessions`, `POST /:id/end`): request form → **real session row** (auto-expiry via
  `make_interval`), active + history tables, End/Revoke. Break-glass adds scope/approver/incident +
  workflow viz. Every start/end logs to the audit.
- **Roles & Permissions** (`Roles.jsx`, `GET /api/admin/operators`): KPIs + live role-assignment table
  (12 operators, per-role user counts) + static permission matrix + SoD rules.
- **Approval Requests** (`Approvals.jsx`, `GET /api/admin/approvals`, `POST /:id/decision`): "Viewing
  as" role switcher, pending table with **live Approve/Reject** (enabled only for your role's pending
  chain step), SoD enforced server-side (all-approve → approved; any reject → rejected), history + chain
  reference. Decisions log to the audit.
- Fixed a Postgres param-type clash (`$11` used as both INT and in a string-interval) → `make_interval`.
- Verified end-to-end + in-browser (Playwright): all 5 pages render, zero JS errors; impersonation
  create→active→audit-logged→end works; approval approve advances the chain (Sales✓, stays pending until
  all three); CSV export; routes 200; main app unaffected. Test writes cleaned (audit back to 5 seeds).

### 10k. Fix — Security & Ops used fabricated data, not real backend data

User flagged the screens showed made-up operators/tenants. Rewired them to the **real backend**:
- **Platform Audit Log** now reads the **real hash-chained `audit_trail`** (29+ entries) UNION-ed with
  operator actions from `platform_audit` (via `AUDIT_CTE`, joining real `users` + `tenants`). Shows real
  `auth.login` / `dsar.create` / `billing.payment` / `alert.false_positive` events by real people (Vikram
  Sharma, Ananya Desai, Sarah Chen) on Meridian, with real resources/IPs/detail payloads.
- **Roles & Permissions** now reads the **real `users` table** (15 real accounts + their real product
  roles) with a product-RBAC capability matrix. `platform_operators` (fabricated) no longer used.
- **Sessions & Approvals**: a one-time, flag-guarded migration (`platform_meta.secops_realdata`) **purged
  all fabricated seeds** (GovData India, Royal Commerce UK, David Kim, …). They now populate from **real
  actions** only — impersonation/break-glass created via the UI against the real tenant, and a new
  `POST /api/admin/approvals` wired to the tenant **Request suspension / Request offboarding** actions
  (chain by type; logs to audit). The lone surviving approval references the real Meridian tenant.
- Verified: audit 31 real events; roles 15 real users; suspend → real `SUS-####` approval → audit-logged
  → approve as Lead → resolved; sessions empty until real use; zero JS errors; main app unaffected.

## 9v. Dashboard "Top risky databases" — made dynamic + fixed mockup links

Two bugs: the widget showed all DBs at risk 0, and "View all"/"Triage" jumped to the mockup site.
- **Mockup links → SPA routes**: Dashboard "⚠ Triage alerts", "View all →", "Triage →" and
  `CompliancePosture`'s "Open Compliance Center →" were hardcoded `http://localhost:8091/*.html`.
  Replaced with react-router `<Link to="/alerts|/databases|/compliance">`. (`Header.jsx` has the same
  pattern but is dead code — not imported anywhere.)
- **risk_score was never computed** (static 0 on every DB). Root cause of "not dynamic": the
  detection simulator attributed alerts to hardcoded display names (`MYSQL-PAYMENTS-PROD`…) that
  don't match the real `databases.name` (`payments`…), so 1206/1206 open alerts had `database_id=NULL`.
  Fixes:
  - Simulator now picks a **real** `databases` row (id+name) and links alerts to it.
  - New `recomputeDbRisk()` job (60s) writes a real `risk_score` from live signals — severity-weighted
    open-alert pressure (capped 55) + unmonitored (+20) + sensitivity tags (+15) + high/critical
    classified columns (+10) — so the Databases list and fleet risk benefit too.
  - `GET /api/dashboard/risky-databases` computes the same score **inline** (not the stored column) so
    the widget never lags its own open-alert counts.
  Verified live: payments 65/20 alerts, inventory 23/6, client-mysql-2 8/1, invoices 0/0 — scores move
  as alerts accumulate/are acked.

## 11. Quarantine release → execute → event → alert → audit (real "hold & release")

Previously the inline-proxy *blocked* a query (MySQL ERR 1142) and recorded a forensic quarantine row;
**Release was a status flip only** — the SQL never ran and nothing flowed downstream. Now release
**actually executes the approved statement** and pushes it through the normal pipeline:
- **Proxy** (`agent/main.go`): the quarantine POST now carries the **full SQL** + `engine` + `db_host` +
  `db_port` (not just a 200-char preview).
- **Schema**: `quarantine_sessions` gains `full_sql`, `engine`, `db_host`, `db_port`, `exec_result`
  (additive ALTERs).
- **Release** (`resolveQuarantine`): runs `executeReleasedSql()` against the real target DB (mysql2,
  root creds — same path DSAR uses), then `chInsertEvent()` (tagged `source_host='released-after-review'`,
  `tags=['released_after_review']`) → the released SQL appears in the **activity audit trail** and is
  re-evaluated by detection; raises an **alert** (`Released & executed/failed after review: <reason>`);
  stores `exec_result`; and writes an **audit_trail** entry with the outcome. `Kill` never executes.
- **Fix**: `writeAudit` inserts `resource_id` as **UUID**, but quarantine passed the string `session_id`
  → the insert silently failed (caught), so `quarantine.*` audit entries never persisted. Switched to the
  row's UUID `s.id` (session_id moved into `details`). Now `quarantine.released` writes correctly.
- **Frontend** (`Quarantine.jsx`): release toast surfaces the execution outcome.
- Verified end-to-end (API + UI): release of `DROP TABLE IF EXISTS …` → `executed · 0 rows`, event in
  ClickHouse (`inline_proxy` / `released-after-review`), new critical alert, audit_trail row; release of
  `GRANT ALL … dam_probe` → `execution error: not allowed to create a user with GRANT` captured the same
  way. UI toast shows "Released — executed · 0 row(s) affected"; zero JS errors.

## 12. Microsoft Teams alert integration (real, configurable)

The Integrations page was static (Teams = cosmetic "disconnected"). Built it for real:
- **Config** persisted in the existing `integrations` table (`type='msteams'`, `config={webhook_url,
  min_severity}`, `status`). Endpoints (all `authRequired`): `GET /api/integrations`,
  `PUT /api/integrations/msteams` (validates **https**, upserts, keeps stored URL if blank),
  `POST /api/integrations/msteams/test` (sends a test card). Webhook URL is masked in GET responses.
- **Dispatch**: `dispatchAlert()` loads the active Teams integration, filters by `min_severity`
  (`SEV_ORDER`), and POSTs an **Adaptive Card** (modern Teams Workflows format: `type:message` +
  `attachments[].contentType=application/vnd.microsoft.card.adaptive`) with severity/principal/database/
  time/SQL. Best-effort — wrapped in try/catch, never blocks alert creation; updates `last_sync_at` on success.
- **Hooked into all three real alert sources**: the agent alert endpoint, the policy detection simulator,
  and the quarantine release alert.
- **UI** (`Integrations.jsx`): the Microsoft Teams card now shows the real status and opens a **Configure
  modal** (webhook URL, minimum severity, enable/disable, **Send test card**, Save). Other connectors stay
  cosmetic.
- Verified with a local mock webhook: PUT rejects `http://` (400) / accepts `https://` (200); test card
  delivered; a **medium** alert was filtered (0 cards) while **high/critical** forwarded (release →
  critical card, detection/proxy → high cards). 4 Adaptive Cards captured with correct structure; modal
  renders with no JS errors. Left unconfigured (clean) — paste a real Teams webhook to go live.

## 13. Slack alert integration + disconnect/remove (generalized channels)

Built Slack the same way as Teams, and generalized the dispatch/endpoints so adding a channel is one line.
- **Generalized**: `ALERT_CHANNELS = { msteams: postTeamsCard, slack: postSlackMessage }` + `CHANNEL_NAME`.
  `dispatchAlert()` now **fans out to every active channel** that passes its own `min_severity` (each send
  isolated in try/catch). New `postSlackMessage()` posts a Slack **Block Kit** message (header + summary +
  Severity/Principal/Database/Time fields + SQL code block, colored by severity attachment).
- **Endpoints parameterised** by type: `PUT /api/integrations/:type`, `POST /api/integrations/:type/test`,
  and (per user request) **`DELETE /api/integrations/:type`** to disconnect/remove. `GET /api/integrations`
  masks the webhook for any `ALERT_CHANNELS` type. Backward-compatible with the existing `msteams` paths.
- **UI** (`Integrations.jsx`): `TeamsModal` → generic **`IntegrationModal`**; both Slack and Teams cards are
  now real (live status overlaid from `/api/integrations`). Modal has **Send test** + a **Disconnect**
  button (shown only when configured) → `apiDelete`. Per-channel placeholder/help copy.
- **Bug fixed**: the modal instance persists across opens, so `useState` kept stale `enabled`/`minSeverity`
  (a connected integration showed "Disabled" → Save would silently disable it). Added a `useEffect` that
  re-syncs the form from the current integration on open.
- Verified with a mock webhook: Slack PUT https-only (http→400/https→200); **fan-out** (1 critical alert →
  2 POSTs, correct Slack-Block-Kit + Teams-Adaptive shapes); min-severity (medium→0); **DELETE** removes
  the row; modal now shows correct Enabled/severity on reopen; no JS errors; main app unaffected. Slack is
  the easy one to test for real — Incoming Webhooks work on any free Slack workspace.

## 14. Azure AD / Entra ID integration card (real status, read-only)

Azure AD SSO was already fully wired (`/auth/azure`, `/auth/callback`, JIT user provisioning as
`auth_provider='azure_ad'`, env-configured) and is actively used (**13 real users**). Only the
Integrations card was cosmetic. Per the user's chosen scope ("real status + test, safe — no auth-flow
change"):
- **Backend**: `GET /api/integrations/sso/azure` reports the live connection state from the existing
  `AZURE_*` env constants (configured, secretConfigured, tenantId, clientId — public OAuth param,
  redirectUri, authority, signInUrl) + usage (`usersProvisioned` and `lastLogin` from
  `users WHERE auth_provider='azure_ad'`). No secret is ever returned; the auth flow is untouched.
- **Frontend** (`Integrations.jsx`): the Azure AD connector is now real (`kind:'sso'`) — the card shows
  **Connected** + "N users via SSO · tenant …", and a **View status** modal lists the real config
  (status, tenant/client IDs, secret ✓/missing, redirect URI, authority, users provisioned, last
  sign-in) with a **Test sign-in** button (opens `/auth/azure`). Read-only — env-managed, with a hint to
  set the `AZURE_*` vars when not configured.
- Verified: endpoint returns configured=true / 13 users / last sign-in today; card shows Connected; modal
  renders real values with an enabled Test sign-in; no JS errors; main app + auth flow unaffected.
- **Test sign-in clarity**: it was "redirecting to dashboard" because an existing Microsoft session let the
  OAuth round-trip complete silently (i.e. SSO *worked* and signed the user in). Added an optional,
  whitelisted `prompt` param to `/auth/azure` (`select_account`/`login`/`consent`); the Test button now
  uses `?prompt=select_account` so Microsoft always shows the account picker (visible proof), then lands
  signed-in on the dashboard. The normal "Continue with Azure AD" login is unchanged (no prompt); bad
  values are ignored.

## 15. Email (SMTP) integration (UI-configurable + send test)

The platform mailer (`getMailer`, nodemailer) was **env-only** (`SMTP_*`) and unconfigured in this
environment, so invitations fell back to a no-network JSON transport + logged links. Per the user's
chosen scope ("Configure SMTP + send test"), SMTP is now **UI-configurable, DB-first with env fallback**:
- **Transport layer** (`api/main.js`): `loadSmtpConfig()` reads the active `integrations` row
  (`type='email'`) at boot and after every save/delete, caching it in `smtpDbConfig` and invalidating the
  `_mailer`. `activeSmtp()` resolves the effective config — **DB wins, else env (`SMTP_HOST/…`), else
  null** (→ JSON transport). `buildTransport(cfg)` builds a nodemailer transport from any config (shared
  by `getMailer` and the test route). Invite/SSO send paths now use `activeFrom()` / `smtpConfigured()`
  instead of the old `SMTP_HOST` const, so configuring SMTP from the UI makes real email start sending
  **without a rebuild**.
- **Endpoints** (registered **before** the generic `/api/integrations/:type` alert-channel routes so the
  literal `smtp` segment wins the match):
  - `GET /api/integrations/smtp` — status: `configured`, `source` (database|env|null), masked `saved`
    config (`hasPassword` flag — the **password is never returned**), effective `from`, `envHost`.
  - `PUT /api/integrations/smtp` — upsert host/port/secure/user/pass/from/enabled into `integrations`
    (type='email'). Blank password **keeps the stored secret** (same pattern as the webhook URL). Builds
    the From header from explicit `from`, else `Name <user>`, else the env default. Audited.
  - `POST /api/integrations/smtp/test` — `transport.verify()` then sends a styled test email. Can test an
    **unsaved** config (full SMTP in the body) or the saved/active one; recipient defaults to the caller's
    account email. Returns 502 with the real SMTP/DNS error on failure.
  - `DELETE /api/integrations/smtp` — removes the row, reverts the mailer to env/JSON. Audited.
- **Frontend** (`Integrations.jsx`): the Email (SMTP) connector is now real (`kind:'smtp'`) — the card
  shows **Connected** + host/source + From, with a **Configure Email (SMTP)** modal (host, port,
  STARTTLS-587/SSL-465 selector that auto-sets the port, username, masked password with leave-blank-to-keep,
  From address, test-recipient, enable/disable; **Send test**, **Disconnect**, **Save**). New setups
  default to Enabled.
- Verified: status reports unconfigured→configured→unconfigured; save persists + masks the password +
  source flips to `database`; blank re-save retains the secret; test against an unreachable host returns
  the real DNS error (proves it actually connects); the generic `:type` alert routes (slack/msteams) still
  resolve correctly after the reorder; modal renders with no JS errors; main app unaffected. Left clean
  (no SMTP row) after testing.

## 16. All integration cards made real (schema-driven connector framework)

The remaining cosmetic cards (Splunk, Sentinel, ServiceNow, PagerDuty, Okta, Jira, Datadog, Custom
Webhook) were wired up for real. Rather than 8 one-offs, the alert-forwarding layer was generalized into
a **schema-driven connector registry** (one source of truth on the backend, rendered by the UI).
- **Backend** (`api/main.js`): replaced the `ALERT_CHANNELS` map with `const CONNECTORS = { … }` where each
  entry declares `{ name, kind:'alert', help, fields:[…], send(config, alert) }`. `fields` describe the
  config inputs (`key/label/type/required/secret/placeholder/options/default`); `secret:true` fields are
  masked in responses and kept-on-blank when re-saved. New real senders: **Splunk** (HEC), **PagerDuty**
  (Events API v2), **Datadog** (Events API), **Custom Webhook** (JSON POST + optional auth header),
  **ServiceNow** (Table API incident, basic auth), **Jira** (REST v3 issue, email+API-token, ADF body),
  **Microsoft Sentinel** (Log Analytics Data Collector API, HMAC-SHA256 signed). A normalized `alertEvent()`
  / `alertText()` keep payloads consistent; severity is mapped per vendor.
- **Generalized endpoints** (all schema-driven, replacing the webhook-specific versions):
  `GET /api/integrations` (generic masking via `maskConnectorConfig`), **`GET /api/integrations/catalog`**
  (returns each connector's schema — no secrets — so the UI renders modals dynamically),
  `PUT /api/integrations/:type` (`buildConnectorConfig` merges form fields over stored, keeps blank
  secrets, validates required + URL fields, stores `min_severity`), `POST /api/integrations/:type/test`
  (sends `sampleAlert()` through the connector), `DELETE /api/integrations/:type`. `dispatchAlert()` now
  fans an alert out to every active `kind:'alert'` connector that passes its `min_severity` — Slack/Teams
  unchanged, just moved into the registry.
- **Okta SSO**: `GET /api/integrations/sso/okta` — read-only env-configured status mirroring the Azure card
  (`OKTA_DOMAIN/CLIENT_ID/CLIENT_SECRET/REDIRECT_URI` + `users WHERE auth_provider='okta'`). A real
  sign-in flow would need an `/auth/okta` handler; scope here is the status card.
- **Frontend** (`Integrations.jsx`): all 12 cards are now `real`. A single **schema-driven
  `IntegrationModal`** fetches `/integrations/catalog` and renders the right fields (text/password/select)
  for any connector, with secret "stored — leave blank to keep" hints, min-severity + enable/disable,
  Send-test / Disconnect / Save. The Azure modal was generalized into `SsoModal` serving both Azure AD and
  Okta. Old hardcoded `CHANNEL_META` / webhook-only modal removed.
- Verified end-to-end: catalog lists all 9 alert connectors; Custom Webhook save → masked GET (secret
  shown as set+preview, non-secret in full) → blank re-save keeps the stored secret → real HTTP delivery to
  a local sink with the auth header; a **fired critical alert dispatched** to the connector while a **low
  alert was filtered** by min-severity; every connector modal renders its fields with no JS errors; Okta
  status card works; main app + Slack/Teams/SMTP/Azure unaffected. Adding a new connector = one `CONNECTORS`
  entry. Note: ITSM/Sentinel senders are built to each vendor's spec but only fully verifiable against a
  live instance (no creds in this env).
- **Visual polish to match the mockup** (`mockups/integrations.html`): each card now uses a brand-coloured
  logo tile (white monogram on the vendor colour, e.g. Splunk #65a637 "S", Slack #4a154b "#", Datadog
  #632ca6 "DD") instead of the generic soft-purple glyph; the bulky full-width button was replaced by a
  compact footer — a dot status badge (Connected/Available) on the left + a small Configure/Connect/View
  status button on the right, pinned to the card bottom. The config modal gained a status bar (logo +
  Connected/Not-connected + category + active/inactive) above the fields. Tighter grid (min 300px).

## 17. Live payment gateways — Razorpay + PayU (test mode)

The Billing page's "Make a payment" was a **simulated** stub (`POST /api/billing/pay` just marked the
invoice paid + minted a fake txn). Added **real** Razorpay + PayU checkout, configurable via env, secrets
server-side only.
- **Config** (`api/main.js`): `RAZORPAY_KEY_ID/SECRET`, `PAYU_MERCHANT_KEY/SALT`, `PAYU_MODE` (test→
  test.payu.in / live→secure.payu.in), `USD_TO_INR` (invoices are USD, gateways charge INR), `API_PUBLIC_URL`
  (PayU callback). `razorpayConfigured()` / `payuConfigured()` gate everything; unconfigured → the page
  falls back to the simulated pay. Added `express.urlencoded()` (PayU posts its callback form-encoded).
- **Razorpay** (in-page modal widget): `POST /api/billing/razorpay/order` creates an Order via the Orders
  API (Basic auth, amount in paise INR); frontend loads `checkout.js` and opens the widget with the
  order_id; on success `POST /api/billing/razorpay/verify` checks the HMAC-SHA256 signature
  (`order_id|payment_id`, constant-time compare) before marking the invoice paid + auditing.
- **PayU** (hosted checkout — Bolt is deprecated/domain-gated, won't load on localhost): `POST
  /api/billing/payu/initiate` builds the v1 **SHA-512 request hash** + params; the browser auto-submits a
  form to `${PAYU_BASE}/_payment`. PayU posts back to `POST /api/billing/payu/callback` (public), which
  **verifies the reverse hash**, marks paid on `status=success`, audits, and 302-redirects to
  `/billing?payu=success|failed|invalid`. The Billing page reads that param on mount and toasts. Hash
  strings are byte-exact to PayU's canonical PHP (`||||||` padding) — verified by reconstruction.
- **Frontend** (`Billing.jsx`): fetches `/billing/payment-config`; the pay modal shows branded **Pay with
  Razorpay / Pay with PayU** buttons when configured (with the ≈INR amount), plus the simulated fallback
  for other/unconfigured methods. Added PayU to the connect-gateway list.
- **Security**: only the Razorpay public `key_id` reaches the browser; secrets + salt never leave the
  server; both verify paths reject tampered signatures/hashes (tested); callback authenticity rests on the
  reverse hash. **To go live**: set the keys in `.env` (Razorpay test keys or PayU's public sandbox
  `gtKFFx`/`eCwWELxi`) and restart `dam-api`. Verified end-to-end with injected test keys: config flips to
  configured (key_id only), PayU initiate hash matches an independent recompute, Razorpay order reaches the
  live API, and valid/forged signatures are accepted/rejected correctly. Left **unconfigured** (clean).

### 17a. UI-configurable gateways + Razorpay demo UI
Follow-up: (1) the Razorpay button should open the real Razorpay UI even before keys are added, and (2)
gateways should be configurable in-app.
- **DB-first config** (`gateway_config` table, one row per provider; additive). `loadGatewayConfig()` at
  boot + after save; `activeRazorpay()` / `activePayU()` resolve **DB → env → (Razorpay) demo**. Replaces
  the env-only consts. Secrets never returned (masked `hasSecret`/`hasSalt` + tail).
- **Razorpay demo mode**: with no own key, `activeRazorpay()` falls back to a public demo key
  (`rzp_test_1DP5mmOlF5G5ag`, overridable via `RAZORPAY_DEMO_KEY`). `razorpay/order` returns the key +
  amount with `orderId:null`; the frontend opens the **real Razorpay checkout widget** (no-order) and on a
  test-card success calls `razorpay/demo-confirm` (no signature to verify in demo). With an own key
  ("live"), the full order + HMAC-verify path runs. Verified: the actual Razorpay iframe opens in-browser
  ("Test Mode", "Secured by Razorpay"). Note: the public demo account has no payment methods enabled, so a
  test payment can't *complete* on it — that needs the user's own test key (the UI proves the integration).
- **Settings → Payments tab** (`Settings.jsx` `PaymentsTab` + `GatewayCard`): per-gateway forms (Razorpay
  key_id/secret; PayU merchant_key/salt/mode) backed by `GET/PUT/DELETE /api/billing/gateways[/:provider]`.
  Blank secret keeps the stored value; status badge shows Live·saved / Live·env / Demo / Not configured;
  Disconnect reverts. The Billing modal now always shows **Pay with Razorpay** (with a "test mode" hint +
  test-card number when on the demo key). Verified end-to-end: demo→live→keep-secret→delete all work, the
  Settings tab renders both cards, and the Razorpay widget opens with no JS errors. Left in demo/clean.
- **Fix**: the pay modal's "simulated" radio list still showed the DB-seeded *Razorpay* method, so picking
  it + the simulate button faked a (Stripe-default) payment instead of opening the Razorpay UI. Razorpay &
  PayU are now filtered out of the simulated list (`simMethods`) — the only way to pay with them is the
  real-UI "Pay with Razorpay/PayU" buttons; the fallback button reads "Simulate via <gateway>" (Stripe/
  PayPal only) and is hidden when no simulated methods remain.
- **Testable bill amount**: Razorpay sandbox caps large amounts, so added an opt-in `BILLING_TEST_TOTAL_USD`
  env (wired through compose + `.env`). When set, `ensureInvoices()` forces the *current* invoice to that
  USD total with a single "Test charge" line (history/backfill keep real numbers, so it survives the
  per-load recompute). Set to `5` for testing → invoice $5 → Razorpay order ₹417.50; the real checkout UI
  opens with Cards/Netbanking enabled and completes with test card 4111 1111 1111 1111. Unset (or blank) →
  the real computed bill returns.
- **UPI**: added a Razorpay Checkout `config.display.blocks` that surfaces a prioritised "Pay using UPI"
  block (`show_default_blocks: true` keeps cards/netbanking). UPI only renders if it's **enabled on the
  Razorpay account** (Dashboard → Test Mode → Account & Settings → Configuration → Payment Methods → UPI);
  the checkout can't show a method the account hasn't activated. Test VPAs: success@razorpay /
  failure@razorpay.
- **Downloadable invoice PDF**: the per-row "PDF" button (was a no-op toast) now downloads a real PDF.
  `GET /api/billing/invoices/:reference/pdf` streams `application/pdf` (Content-Disposition attachment) from
  a **self-contained PDF writer** (`buildInvoicePdf`, standard-14 fonts, no embedding, **no new dependency**)
  — header, billed-to + meta, line-item table (Helvetica labels + Courier right-aligned numbers so
  alignment needs no glyph metrics), Total Due, footer. Empty line_items (backfilled months) get a synthetic
  "Monthly subscription" row. Frontend (`Billing.jsx`) `downloadInvoice()` fetches with the Bearer token and
  saves the blob as `<ref>.pdf`. Verified: valid PDF v1.4 (file/qlmanage render), correct headers, and the
  in-browser button triggers the download with no JS errors.
- **Currency-aware**: the PDF now follows the Billing page's currency selector. `downloadInvoice()` passes
  `?currency=<code>&rate=<RATES[code]>`; the endpoint applies a PDF-safe symbol map (USD `$`, INR `Rs `,
  EUR `EUR `, GBP `GBP `, CAD/SGD `C$`/`S$`, JPY `JPY `) and `buildInvoicePdf` converts every money value
  (line amounts, numeric rates, Total Due) by the rate — mirroring the frontend `money()`. Added a
  "Currency" meta row. Verified INR (Rs 417.50 across rate/amount/total) and EUR render correctly; selecting
  INR in the dropdown drives `currency=INR&rate=83.5` on the download.

## 18. Masking page made dynamic (was fully static)

The Masking page was cosmetic — hardcoded `INITIAL_RULES`/`STATIC_JOBS`, a fabricated **95% coverage**,
and a toggle that only flipped local state — while the backend already had real data. Reality was the
opposite: **0% coverage, 5 high/critical sensitive columns** in `payments.customers` (card_number, sin,
card_expiry, email, full_name) all unmasked.
- **Backend**: extended `GET /api/compliance/masking` to also return `columns[]` — every high/critical
  classified column with `{id, db, obj, col, tag, sensitivity, masked}` (was only returning the unmasked
  subset). The existing `POST /api/classification/columns/:id/mask` toggles `is_masked` for real.
- **Frontend** (`Masking.jsx`): now `useApiData('/compliance/masking')`. Real KPIs (sensitive / masked /
  coverage % / unmasked gaps); the **Dynamic rules** table lists the real classified columns with a working
  per-row masking **toggle** (POST + refetch) and a **"Mask all gaps (N)"** bulk action. Mask-method column
  is a labelled policy hint per data class (enforcement is the stored masked flag). The **Static jobs** and
  **Preview** tabs have no backend, so they're kept but clearly banner-labelled **"Illustrative"** (avoids
  passing mock data off as real client data).
- Verified end-to-end: KPIs show the true 5/0/0%/5; toggling a column live-updates to 1 masked / 20% /
  4 gaps with an audit-backed POST; no JS errors. Restored to as-found (all unmasked) after testing.

## 19. Real inline-proxy data masking (MySQL result-set redaction)

Made dynamic masking actually enforce (previously `is_masked` was only a policy flag; the proxy was
capture-only). The Go agent now **rewrites masked columns in the MySQL result stream** based on the
connecting principal — the database data is never altered (true dynamic/query-time masking).
- **Agent** (`agent/main.go`): replaced the server→client `io.Copy` with `maskedPipe` — it frames MySQL
  packets, runs the text-protocol result-set state machine (column-count → ColumnDefinition41 → rows),
  matches each column's `schema/org_table/org_name` to the policy, and for non-bypass principals rewrites
  flagged field values per row (length-encoded re-encode + corrected packet header). Methods: `last-4`
  (keep last 4), `redact` (alnum→X, delimiters kept), `email` (mask local part, keep domain); NULLs
  preserved. `CLIENT_DEPRECATE_EOF` handled; `recover()` falls back to raw copy on any parse/TLS stream
  (fail-open). Principal + caps captured at handshake (mutex-shared with the masking goroutine).
- **API**: `GET /api/agents/masking-policy?token=…` returns the masked columns (`is_masked=true`, method
  derived from data class) + `bypassUsers` (env `MASK_BYPASS_USERS`, default `root`). Agent fetches at
  connect + refreshes every 20s so UI toggles apply.
- **Verified end-to-end through `dam-agent-mysql-proxy`**: same `SELECT customers` query —
  `app_payments` (non-bypass) sees `XXXXXXXXXXXX4242` / `XXX-XXX-XXX` / `j***@example.com` / `XXXX XXXXX`
  while `card_expiry` (toggled off) stays clear; `root` (bypass) sees all real values. Capture + DROP-TABLE
  blocking still work; no panics. Same untouched rows in the DB.
- **Limits** (honest): text protocol (`COM_QUERY`) only — prepared-statement binary result sets pass
  through unmasked; requires a non-TLS connection (`--ssl-mode=DISABLED`, same as the existing capture);
  bypass is by DB username; fail-open on parse error.

### 19a. Per-database, configurable bypass (no root default)
Security fix: the bypass default was `root`, which is wrong — the app/web tier must connect with a
least-privilege account, never root/DBA, and each database has its own privileged accounts. So bypass is
now **configured per database** in the control plane, **defaulting to none** (mask everyone, including the
app account, until a principal is explicitly granted).
- **Schema**: additive isolated table `masking_bypass (database_id, principal, note, created_by)` — no
  main-app table touched.
- **API**: `GET/POST /api/compliance/masking/bypass` + `DELETE /…/:id` (per-database principals, audited).
  `GET /api/agents/masking-policy` now returns `bypassByDb { dbName: [principals] }` (+ an optional empty
  `bypassGlobal` from `MASK_BYPASS_USERS`). Removed the `root` default.
- **Agent**: `maskPolicy.isBypassed(db, principal)` checks the per-db set (then global); `parseColDef`
  reads the column's schema and applies the bypass for *that* database. Fresh policy per connection.
- **UI**: new **Masking → Bypass** tab — a card per database (lists **all** monitored DBs, each with its
  masked-column count + its own bypass list, add/remove), plus guidance ("nothing bypasses by default;
  never add root/admin/DBA; add only least-privilege accounts that need raw values, e.g. a settlement
  service or audited break-glass"). Databases with no masked columns show a note that bypass has no effect
  there until columns are masked, but can still be pre-configured. Verified each DB takes an independent
  list (payments←settlement_svc, invoices←ap_recon_svc → `bypassByDb` keyed per db).
- **Verified**: with no bypass, `root` through the proxy is now MASKED; adding `root` to the `payments`
  bypass makes only `root` see real values (`app_payments` still masked); removing it re-masks. Per-db,
  effective on the next connection, audited. Demo bypass cleaned up (state: no bypass).

## 20. Quarantine KPI / count fixes

Two linked bugs: the page's "Held Now" widget showed **200** while the sidebar showed the real count
(e.g. 528), and **Released/Killed never updated**. Cause: the page derived all KPIs from the
`/api/quarantine` **list, which is `LIMIT 200`, held-first** — so Held capped at 200, and resolved
sessions fell below the cap (counts stuck near 0, invisible in the table) even though the DB had plenty
(33 released / 108 killed at the time).
- **Backend**: `/api/quarantine/summary` now returns authoritative `held/released/killed/total` **+
  `avgHoldSecs`** in one aggregate query. `/api/quarantine` gained a `status` filter (+ `limit`) and orders
  by `COALESCE(resolved_at, held_at)` so resolved sessions are reachable.
- **Frontend** (`Quarantine.jsx`): all four KPIs now read from `/quarantine/summary` (same source as the
  sidebar badge → they match). Added **Held / Released / Killed / All** tabs that filter the table via the
  endpoint (so resolved sessions are viewable). Release/kill now `refetch()` **both** list + summary.
- **Verified**: page Held = sidebar (526 = 526); Released/Killed show real counts and are filterable;
  killing a session live-updates Held −1 / Killed +1 with no JS errors.

## 21. Feature flag now gates Dynamic Masking enforcement

The `dynamic-masking` feature flag existed but `featureEnabled()` was only consulted by the **admin
console's reporting** (enabled-count / adoption / billing) — nothing in the runtime honored it. Confirmed
empirically: disabling it via the Admin override endpoint left masking fully active through the proxy.
- **Fix**: `GET /api/agents/masking-policy` now computes effective `dynamic-masking` enablement per tenant
  (`featureEnabled(flag, tier, override)`) and **only serves masked columns for tenants where it's enabled**
  (query now selects `d.tenant_id` and filters). Disable → 0 columns → agent masks nothing; enable → columns
  return → masking resumes. Picked up on the next DB connection (agent refetches per connection + every 20s).
- **Admin path**: Feature Flags → *Dynamic Masking* → **Manage** → set a tenant Disabled/Enabled/Reset
  (`POST /admin/features/dynamic-masking/overrides/:tenantId`, per-tenant, isolated `feature_overrides`).
- **Verified**: flag disabled → proxy returns real `4242…/123-456-789`; reset to GA default (enabled) →
  proxy returns `XXXX…4242 / XXX-XXX-XXX`. Left enabled (default). Note: gating is the enforcement path;
  the product Masking page still shows toggles even when the flag is off (a "disabled by admin" banner
  would be a nice follow-up).

### 21a. Product Masking page reflects the flag
Closed the UX gap: `GET /api/features` (authRequired) returns effective per-tenant enablement for every
feature (`featureEnabled(flag, tier, override)`). The Masking page reads `dynamic-masking`; when disabled
it shows an amber banner ("Dynamic Masking is disabled for your organization … not enforced … contact your
administrator") and disables the per-column toggles + "Mask all gaps". Verified: enabled → no banner /
controls active; disabled (via Admin override) → banner shown / toggles + mask-all disabled; no JS errors.

## 22. JIT Access — built for real (was a mock)

The Access Governance page's "JIT requests" tab was a hardcoded `INITIAL_JIT` array with local-state
Approve/Revoke + toasts. Now it's a real, audited, time-boxed access workflow.
- **Schema**: additive isolated `jit_grants` table (requester, database, scope, reason, duration, status,
  requested/approved/expires/revoked timestamps + actors). No main-app table touched.
- **API**: `GET /api/access/jit` (grants + status summary), `POST /api/access/jit` (request → pending),
  `POST /api/access/jit/:id/approve` (→ active, sets `expires_at = now + duration` via `make_interval`),
  `POST /api/access/jit/:id/revoke` (active→revoked, pending→denied). Every step audited. A **30s reaper**
  auto-expires active grants past their window (the "auto-expiring" promise).
- **Frontend** (`AccessGovernance.jsx`): JIT tab now from `/access/jit`; a **＋ JIT request** modal
  (requester prefilled with the current user, database dropdown from `/databases`, scope, duration,
  reason); Approve/Deny on pending, Revoke on active; relative "expires in Xh Ym"; the **JIT active** KPI +
  tab pending-count are real. Entitlements + Service-account-identity tabs left as illustrative mocks.
- **Verified end-to-end**: request→pending→approve(active, expiry set)→revoke; the reaper moved a
  past-expiry grant active→expired; UI modal/approve/revoke work, KPI live, no JS errors. Test data cleared.
- **Light by design** — it's the governance/workflow + audit layer; the grant is recorded, not yet issued
  as a real DB `GRANT`. Real privilege execution can layer on via the mysql2 path used by quarantine release.

## 23. Quarantine release — de-rooted + multi-engine

Fixed the least-privilege anti-pattern (release re-ran held SQL as `root` via
`CLIENT_MYSQL_ROOT_PASSWORD`) and made it engine-agnostic.
- **No hardcoded root**: `resolveExecCred(session)` resolves a least-privilege credential — a per-instance
  override (new isolated `exec_credentials` table, `host+port → user/pass`) wins, else per-engine env
  (`EXEC_MYSQL_USER/PASS`, `EXEC_PG_USER/PASS`, defaulted to the app accounts `app_payments` / `app_crm`,
  **not** root). The customer configures an appropriately-scoped account per database.
- **Multi-engine**: `executeReleasedSql` dispatches by `ENGINE_FAMILY` — MySQL/MariaDB via mysql2,
  PostgreSQL via a `pg.Client`, connecting to the session's `database_name`. Unsupported engines (mongodb,
  …) degrade gracefully ("not supported in this build"); missing creds return a clear "configure a
  least-privilege account" note.
- **Robustness fix** (real bug): `resolveQuarantine` had no try/catch, so a malformed id / query error
  became an **unhandled rejection that crashed the whole API**. Now it validates the UUID (→ 400) and wraps
  the flow (→ 500 on error); the process stays up.
- **Verified**: MySQL release `executed · 2 rows` (as app_payments), Postgres `executed · 1 row` (as
  app_crm), mongodb gracefully unsupported; a malformed id returns 400 with the API still serving; and a
  release of `SELECT … FROM mysql.user` was **DENIED to app_payments** — proving it runs least-privilege,
  not root. Note: a separate DSAR-discovery lookup still uses root (`main.js` ~4750) — out of scope here.

## 24. Real detection engine (Phase 1) — replaces the alert simulator

Before: alerting was a *simulator* that picked a rule and **fabricated a matching event + the alert** — the
real captured traffic was never evaluated against the `policies` rules. Now there's a real engine.
- **Split generation from detection**: the old sim is repurposed into a pure **traffic generator** — it
  emits realistic *enriched* events (tags, row_count, schema.table) into `dam_analytics.events` and **no
  longer creates alerts**. Biased toward the fully-evaluable rules so alerts keep flowing.
- **Detection engine** (`runDetectionEngine`, every 7s): a **watermark-incremental micro-batch** — cursor on
  event `timestamp` with a 5s safety lag; for each **enabled** policy it compiles the DSL via the existing
  `policyToClickhouse()` and **pushes the predicate down to ClickHouse** over the new slice; each matching
  row → an alert (dispatched + WS broadcast). ClickHouse does the scanning; Node just orchestrates.
- **Correct gating (no over-firing)**: a rule is evaluated only if every predicate is supported or a harmless
  scope refinement (`principal_user_type`). Rules whose *defining* predicate is behavioral/windowed
  (first-time, off-hours, N-in-window, cross-schema) are **skipped → Phase 2** — otherwise they'd fire on
  their weak remainder. Extended the translator with `grants_role` (via `positionCaseInsensitive(sql_text…)`)
  so **GRANT of DBA/SYSDBA** is fully evaluable too.
- **Suppressions/exceptions honored** (the same `alert_suppressions` the upcoming allow-list writes).
- **Verified deterministically**: injected a 12k-row PII read → alert fired; a 200-row read → no alert
  (threshold); after adding an exception on that object → no alert (suppressed); and on live traffic the
  engine raises **Bulk read** + **GRANT DBA** with **no behavioral over-firing**.
- **Design note**: chose micro-batch push-down over a ClickHouse MV because rules are dynamic/user-editable
  (an MV bakes a fixed query and can't join Postgres rules) and windowed/behavioral rules need aggregation.
  MVs remain the Phase-2 optimization (AggregatingMergeTree rollups for first-time / windowed rules).
- **Honest limits**: only text/threshold/tag/grant rules evaluate today; behavioral + windowed rules are
  Phase 2 (need the rollup MVs); captured *agent* events still carry `row_count:0`, so threshold rules match
  the enriched traffic-gen events (and any real event that carries the fields) — real-capture row-count
  enrichment is a follow-up.

## 25. Governed exceptions / allow-list (Policies → Exceptions)

Turned exceptions from the reactive-only "mark false positive" click into a proactive, governed control that
the real detection engine honors — the "broad rule + narrow exception" model.
- **Schema**: `alert_suppressions` gained `database_name` + `expires_at` (additive; the false-positive flow
  still works, db=any / never-expire).
- **API**: `GET /api/policies/exceptions` (list, with an `expired` flag), `POST` (create — requires at least an
  object or principal so it can't be rule-wide; optional `expiresInDays` via `make_interval`), `DELETE /:id`
  (revoke). Create/revoke are audited (`policy.exception_grant` / `_revoke`).
- **Engine**: the detection engine's suppression check now filters expired rows (`expires_at IS NULL OR >
  now()`) and matches on **database + object + principal** — so an exception is scoped, not table-wide.
- **UI**: new **Exceptions** tab on Policies & Rules — a governed list (rule, database, object, principal,
  reason, added-by, expiry, Revoke) + an **Add exception** modal (rule dropdown, database dropdown, object,
  optional principal, reason, expiry) with guidance that capture/audit is unaffected.
- **Verified**: created a scoped exception (Bulk-read on `inventory.stock` for `reporting_svc`, 7-day) → that
  principal's matching read was **suppressed**, while the **same read by a different principal still fired**
  (exception is narrow, not wholesale). List/expiry/revoke work; no JS errors. Test data cleaned.

## 26. Exception trail retention (soft-delete)

Exceptions are a deliberate weakening of a control, so their full lifecycle must survive revocation.
- **Schema**: `alert_suppressions` gained `status` (default `active`), `revoked_by`, `revoked_at` (additive;
  existing rows backfilled to `active`).
- **Revoke is now soft-delete**: `DELETE /api/policies/exceptions/:id` sets `status='revoked'` +
  `revoked_by`/`revoked_at` (keeps the row) instead of removing it. The engine only honors
  `status='active'` (and non-expired), so behavior is unchanged.
- **List**: `GET /api/policies/exceptions` defaults to active; `?include=all` returns revoked/expired too,
  with a derived `expired` flag.
- **UI**: Exceptions tab gets an **Active / All** toggle; each row shows **Granted (by · when)**, expiry, and
  a **Status** badge (active / expired / revoked) with **revoked-by · when** for revoked ones. Revoke only
  on active rows.
- Grant + revoke remain in the **hash-chained audit_trail** (tamper-proof backstop). Verified:
  create→revoke retains the record (granted_by + revoked_by + revoked_at) in the All view, hidden from
  Active, engine ignores it; no JS errors.

## 27. JIT Access — real provisioning via Vault + Approval Signer (Model B, hardened)

Replaced the record-only JIT workflow (§22) with real, least-privilege provisioning. A grant now
mints a **short-lived, scoped DB user** — and DAM stores **no database password anywhere**.

**Architecture (new services in `docker-compose.yml`):**
- **`dam-vault`** — HashiCorp Vault (dev mode). Holds the privileged *broker* credential and, via the
  **Database secrets engine**, mints ephemeral scoped users on demand.
- **`dam-vault-init`** — one-shot bootstrap (`dam/vault/bootstrap.sh`): provisions the least-privilege
  broker account (`dam_jit_payments` — `CREATE USER` + `SELECT ON payments.* WITH GRANT OPTION`, **not
  root**), configures the DB secrets engine + scoped role `jit-payments-customers-read`, and creates an
  **AppRole** for DAM. `role_id` + `secret_id` are delivered on a shared tmpfs (`dam-vault-bootstrap`) —
  never in `.env` or the DB.
- **`dam-approval-signer`** (`dam/approval-signer/`) — a **separate trust domain** with an Ed25519 key
  DAM never holds (in `dam-signer-keys`, which DAM does not mount). Signs a canonical grant descriptor
  after an independent approver authenticates with their own credential (`SIGNER_APPROVER_TOKEN`).

**Data model (additive):** `jit_brokers` (engine/host/port, `vault_role`, `allowed_scopes` JSONB = the
ceiling, `rate_limit_per_hour`, `status`, health detail — **no password column**). `jit_grants` gained
`broker_id, privilege, schema_name, object_name, approval_sig, provisioned_user, provisioned_at,
vault_lease_id`.

**API (`main.js`):** Vault AppRole client (fails **closed** if Vault down — never a stored-password
fallback); `GET/POST/DELETE /api/access/jit/brokers`, `/brokers/:id/health` (mints a probe user, connects,
runs an **out-of-scope check** — no `SUPER`/global/`mysql.user`, then revokes); `GET /api/access/jit/databases`
(**broker-gated** — healthy brokers only); request endpoint now takes `brokerId`+`scopeId` (ceiling-checked);
**`POST /api/access/jit/:id/provision`** enforces, in order: **signed-approval gate** (Ed25519 verify —
a compromised DAM can't forge it), **approver ≠ requester**, **ceiling**, **per-DB circuit breaker**
(429 + critical alert), then Vault mints the user and returns creds **once** (password never persisted).
Revoke + the reaper revoke the Vault **lease** → the minted user is `DROP`ed.

**Runbook:** `dam/docs/JIT-BROKER-SETUP.md` — per-engine (MySQL/Postgres) least-privilege broker SQL,
Vault role config, `rotate-root`, and the security model + honest dev-mode caveats.

**Frontend (`AccessGovernance.jsx`):** new **Brokers** tab (status pill, scope/ceiling, health-check, add
modal), broker-gated + scope-constrained request modal, **Approve** modal that routes through the signer
(collects the approver credential client-side, so DAM never sees it) and shows issued creds **once**.

**Verified end-to-end:** health check green (Vault mint+connect+scope); dropdown gated; **provision without
a signature → refused**; **forged signature → 403**; **self-approve (requester) → SoD refusal at signer**;
**wrong approver credential → 401**; valid admin approval → user minted; **issued creds read
`payments.customers` (8 rows), out-of-scope + `mysql.user` DENIED**; **revoke → Vault drops the user →
creds now "Access denied"**; **rate cap → 429 + critical alert**. No main-app tables altered; core
endpoints and the React build regression-clean.

## 28. JIT separation-of-duties made real (identity-bound, DB-owner-scoped)

The earlier SoD was comparing two free-text fields (requester default = name, approver default =
email), so a user could approve their own request. Rebuilt on **verified identities**:
- **Requester = the authenticated caller.** `POST /api/access/jit` ignores any client `requester` and
  sets it from `req.user` (+ `requester_user_id`). The request form shows it read-only.
- **Approver = the authenticated caller too.** `POST …/provision` no longer trusts a body `approver`;
  it uses `req.user.email`. SoD is enforced on verified identity (email **and** user id): the requester
  cannot approve — no matter what's typed.
- **DB-owner scoping.** `jit_brokers` gained an `owners` JSONB (list of emails). Only an owner of *that*
  broker may approve; a `tenant_admin` may act as an **audited break-glass** approver
  (`jit.provision.breakglass`, `break_glass:true`). A db_owner of a *different* DB is refused.
- **Wizard** gained a "Data owners (approvers)" field; the **Approve modal** shows the approver as your
  read-only login with live status (you're an owner / not an owner / break-glass / you're the requester)
  and blocks accordingly; the request modal shows requester read-only.

Verified with minted JWTs for real role users: requester self-approve → 403 SoD; viewer non-owner → 403;
db_owner of another DB → 403; **listed owner → provisions**; **admin non-owner → break-glass provision +
audit**. No main-app tables touched.

## 29. Quarantine realigned to real DB-firewall semantics (no resume/replay)

Real DB firewalls don't "resume" a killed session or replay a blocked statement — quarantine is
*containment*. Rebuilt to match, and made the enforcement **actually real** (agent-enforced), not a record state.
- **Agent enforcement (`agent/main.go`):** new `startQuarantinePoller` fetches `GET /api/agents/quarantine-list`
  every 8s; in `processPackets`, a COM_QUERY from a quarantined principal is refused (`writeMySQLError`) and
  the live session is **dropped** (`client.Close()`). This is the real block — proven via the agent log
  `[QUARANTINED] <principal> session dropped`.
- **Release = lift the account quarantine** (`resolveQuarantine`): dropped the SQL-replay entirely (no
  `executeReleasedSql`, no synthetic event/alert). Release just resolves + audits; the principal reconnects
  and retries themselves. Allowed from held OR terminated.
- **Terminate (kill)** = drop the live session + keep the account blocked (terminal).
- **New:** `POST /api/quarantine/account` — manually quarantine a principal (real containment); `GET
  /api/agents/quarantine-list` — the agent's block list = `DISTINCT principal WHERE status IN ('held','killed')`.
- **Frontend (`Quarantine.jsx`):** relabeled Release→"Release (lift quarantine)", Kill→"Terminate", KPIs
  ("quarantine lifted" / "sessions killed, kept blocked"), honest detail copy, and a **Quarantine account** modal.
- **Migration note:** the 630 pre-existing *simulated* held/killed rows were retired to `status='expired'`
  (preserved as history, non-enforcing) so turning on real enforcement wouldn't retroactively block live
  accounts (`app_payments`, `app_crm`). Held now genuinely means "blocked inline."
- **Verified E2E:** qtest reads via the proxy → quarantine account → agent drops its session → release →
  reconnect reads again. No replay anywhere.

## 30. Auto-quarantine is now a policy choice (default: block-only)

A blocked statement no longer auto-locks the whole account by default. New singleton
`quarantine_policy` table (`auto_quarantine` bool, `categories` jsonb) with `GET/PUT
/api/quarantine/policy` (PUT is admin-only, audited). The agent's block ingest
(`POST /api/quarantine`) consults it via `blockCategory(reason)`:
- **Block-only (default):** returns `{quarantined:false, mode:'block_only'}` — the statement was
  already blocked inline + alerted, but **no account-quarantine record is created** (account stays active).
- **Auto-quarantine (opt-in):** creates a `held` record (→ agent block-list → account locked) — for all
  blocked queries, or only the selected categories (`privilege_escalation`, `destructive_ddl`,
  `schema_change`, `mass_delete`).
The cosmetic "Quarantine policy" modal (`Quarantine.jsx`) was rebuilt: the auto-quarantine control is now
**real and persisted** (loads/saves via the endpoints); the old trigger-rules list is marked *illustrative*.
Verified: block-only → 0 held records on a blocked DROP; auto on → held record created.

## 31. Active Defense — real live-ops view (was fully static)

The page was 100% hardcoded (a `SAMPLE[]` timer feed, constant KPIs, fixed charts). Rewired the
top half to real data; the rest is honestly labelled illustrative.
- **New endpoint `GET /api/active-defense`** aggregates real data: threat level derived from the
  high/critical alert mix in the last hour; **Blocked/hr** from `"Blocked by policy%"` alerts;
  **Accounts held** from `quarantine_sessions`; **Critical (24h)** count; a **live stream** merging
  recent alerts + quarantine holds (newest 14); and a **24h threat-volume timeline** (8×3h buckets,
  zero-filled via `generate_series`).
- **`ActiveDefense.jsx`** is **WebSocket-driven**: `useLiveEvents(['alert','quarantine'])` prepends every
  new alert (agent block OR detection) the instant it's broadcast; a 20s poll is a fallback that also
  refreshes KPIs/timeline (debounced 4s refetch on WS events). Pause freezes the stream. KPIs, live
  stream, and the 24h volume chart are **real**.
- **Egress** and **Behavioral topology** are now **real too** — the endpoint adds a per-DB `sum(row_count)`
  over 24h (ranked High/Med/Low by relative volume) and the top `principal→database` edges by
  `max(anomaly_score)`/volume, both from ClickHouse `events`. Only the **Deception console** stays tagged
  **illustrative** (the decoy/honeypot engine isn't built; "Deploy decoy" says so).
- Verified: endpoint returns live values (threat=Critical, blocked/hr=7, crit24h=217, 14 stream items,
  real timeline).

## 32. Deception console — real decoys / honeypots (was the last illustrative widget)

Built the decoy feature for real, so the Active Defense page is now genuine end-to-end.
- **Schema:** `decoys` (schema/table, state armed|hit, table_created, hit_principal/ip/at, last_scan_at).
- **Endpoints:** `GET /api/deception` (list + summary); `POST` (admin) deploys a decoy — **creates a real
  honeypot table** in the client DB (best-effort via root at deploy time; falls back to name-only, since
  detection works on the captured query regardless) and arms it; `DELETE` removes + drops the table.
- **Detection scan** (`runDecoyScan`, every 8s): matches each armed decoy's table name in captured
  `sql_text` in ClickHouse `events` (excluding `information_schema`, watermarked by `last_scan_at`) → on a
  hit, marks the decoy `hit` + records principal/IP + raises a **critical alert** ("Decoy probed — …") and
  broadcasts it over the WS.
- **Frontend (`ActiveDefense.jsx`):** the Deception card is real (list armed/hit decoys, hit principal +
  time, remove) with a **Deploy decoy** modal. Illustrative tag gone — the whole page is now real.
- **Verified E2E:** deployed `payments.card_vault_bak` (honeypot table created) → probed it through the
  proxy as `probe_user` → within one scan the decoy flipped to **hit** (probe_user, client IP) and a
  **critical "Decoy probed" alert** fired + logged. Test user/decoy reset afterward.

## 33. Email as a real alert channel

SMTP was configurable for sending (invites/notifications) but email was **not** an alert-delivery
channel — `dispatchAlert()` only fanned out to Teams/Slack/etc (`CONNECTORS`). Added an **`email_alerts`**
connector: `postEmailAlert(cfg, a)` emails alerts (severity/principal/db/query) to a recipient list via
the configured SMTP (`getMailer`), gated by `min_severity` like every other channel; returns an honest
`SMTP not configured` status if SMTP isn't set up. Registered in `CONNECTORS` (so the generic
PUT `/api/integrations/:type` + `/test` + catalog all work) and added an **Email alerts** card in
`Integrations.jsx` (distinct from the existing Email-SMTP *connection* card). Verified: configure
recipients+min-severity → active; test reports SMTP-not-configured until SMTP is set up.

## 34. Self-serve signup (the `/signup` mockup, made real)

`signup.html` existed only as a static mockup; the real app had `/login` + `/accept-invite` but no
signup. Built it:
- **`POST /api/auth/signup`** (public): validates company/name/email/password (8+), rejects duplicate
  email, derives a **unique slug** from the company name, creates the **tenant** (professional tier,
  active) + the first **tenant_admin** (local auth, active, bcrypt password), and returns a JWT (same
  shape as login) so they're auto-logged-in. Audited + platform-audited.
- **`Signup.jsx`** at route `/signup` (mirrors the Login split-panel), plus a "Create a workspace" link on
  Login and "Sign in" back-link on Signup.
- Verified E2E: signup → empty tenant (0 databases, 1 admin) + token → that admin logs in (200). Test
  tenant cleaned up.

## 35. Tenant isolation on read endpoints (was single-tenant under the hood)

Signup exposed that most read endpoints ignored the caller's tenant (built for the single Meridian demo)
— a new tenant saw Meridian's data. Fixed: **every user-facing read endpoint now requires auth and
filters by `req.user.tenantId`** (shared DB + `tenant_id` column; not per-tenant DBs). Scoped:
dashboard/* (+ `computeFleetRisk(pgPool, T)`), databases/instances/agents, alerts(+summary),
quarantine(+summary), access/jit(+brokers/databases), active-defense, deception, discovery
candidates/jobs, policies(+versions), policies/exceptions, classification objects/columns,
compliance/masking + sensitive-access, dsar(+:id), report-schedules, users, audit — plus ClickHouse
`events` queries filtered by `tenant_id = '<T>'`. Agent/token endpoints (`/api/agents/*`,
`/api/quarantine` ingest, `/api/discovery/candidates` POST) deliberately left token-authed (no user
context — the agents are Meridian's). **Verified:** a fresh signup tenant returns 0 everywhere
(audit=1 = its own signup entry) while Meridian is unchanged; agent endpoints still 200.
- **Follow-up (noted):** the aggregate generators behind `compliance/frameworks` and `reports/:type`
  (and `complianceMetrics()`) are auth-gated but still compute over global data — they need deeper
  per-tenant scoping. `quarantine_policy` is still a singleton (should become per-tenant).

## 36. Signup email verification

Signup no longer auto-logs-in. `POST /api/auth/signup` now creates the first admin as **`unverified`**
(reusing `invite_token` + `invite_expires_at`, 24h) and emails a verification link
(`sendVerifyEmail` → `${APP_BASE_URL}/verify-email?token=…`); returns `{pending, email}` (no token). Login
blocks unverified users with a clear "verify your email first" message. `POST /api/auth/verify-email`
validates the token, flips the user to `active`, clears the token, and returns a JWT (auto-login). Frontend:
Signup shows a "check your email" state; new `VerifyEmail.jsx` at `/verify-email` verifies + auto-logs-in.
If the email send fails (or no SMTP), the verify link is logged to the API console so dev is never stuck.
Verified E2E: signup→pending; login blocked; verify→token+login 200; token reuse rejected. (Zoho returned
`550 Unusual sending activity` during the test — provider throttling on the new account, not a code issue.)

## 37. Platform mailer — GUI-configured, separate from tenant SMTP

System email (signup verification, invites) is PLATFORM-level (no tenant context) but was wrongly using
the global/tenant SMTP. Split it out:
- **New singleton `platform_smtp`** (host/port/secure/username/password/from_addr) + a platform mailer
  (`activePlatformSmtp` → DB-first, `SMTP_*` env fallback; `getPlatformMailer`/`platformFrom`/
  `platformConfigured`, loaded at boot). `sendVerifyEmail` + `sendInviteEmail` now use it (not the tenant
  mailer). Tenant *alert* email (`postEmailAlert`) still uses the tenant/global mailer.
- **Admin (Super-Admin console) endpoints** `GET/PUT/POST /api/admin/platform/smtp[/test]` (password
  write-only, kept-on-blank, `send test` can test unsaved values) — **operator configures it in a GUI, no
  `.env`/hardcode**.
- **Admin app:** new `PlatformEmail.jsx` page + route `/platform-email` + sidebar nav. Fields: host/port/
  SSL/username/password-token/from + Send-test.
- Verified: save→masked read (`configured:database`); signup routes through the platform mailer (proved by
  a 535 from the platform config, with the verify link logged as the dev fallback). Left unconfigured/clean.

## 38. Tier-based data-plane isolation (Option A) — dedicated ClickHouse DB per paid tenant

Trial/starter tenants **share** `dam_analytics`; paid tenants (professional/enterprise/business) get a
**dedicated** ClickHouse database once provisioned. Existing Meridian stays shared until explicitly migrated.
- **Schema/helpers** (`main.js`): `tenants.data_plane VARCHAR` (NULL = shared); `DEDICATED_TIERS`;
  `chDbName(id)` = `tenant_<id-without-dashes>`; `eventsDbFor(tenantId)` (reads `data_plane`, cached in
  `_tenantDbCache`, defaults `dam_analytics`); `ensureTenantEventsDb` (idempotent `CREATE DATABASE` + an
  `events` table cloned from the `dam_analytics.events` schema — verified 18-col parity); `chExecRaw`;
  `provisionDataPlaneIfPaid(tenantId, tier)` called from **signup** (professional) and **admin
  tenant-create** (by tier).
- **Writes** route via `chInsertEvent` → `INSERT INTO ${eventsDbFor(ev.tenant_id)}.events`.
- **Reads** routed through `eventsDbFor(req.user.tenantId)` on every tenant-facing CH endpoint:
  dashboard/kpis, events-timeline, events-by-database, sensitive-access, sensitive-daily, databases
  lastEvents, active-defense egress+topology, compliance/sensitive-access, tenant-status ingest metrics,
  billing eventsPerDay, decoy scan (per decoy's tenant), and `policies/test` backtest.
- **Also fixed a cross-tenant leak**: `GET /api/audit/activity` had *no* auth and *no* tenant filter (it
  returned every tenant's captured queries). Now `authRequired` + a mandatory `tenant_id` predicate +
  routed to `eventsDbFor`.
- **Verified E2E**: professional signup → `tenant_<id>` DB created (visible in `SHOW DATABASES`) with the
  events table; Meridian (enterprise, pre-existing) stays `(shared)` and keeps ingesting into
  `dam_analytics` live (67 ev/5m during test); a probe write into the dedicated DB stayed there and did not
  reach `dam_analytics`. Verification tenant + its DB cleaned up after.
- **Deferred (still on shared `dam_analytics`)**: cross-tenant platform aggregates (compliance metrics/
  frameworks, `REPORTS[type]` generators) and the background jobs (detection-sim, baseline builder, shadow
  eval). For a dedicated-plane paid tenant to get detection/baselines, the agent/collector target DB and
  those jobs must become per-tenant-DB aware — larger follow-up.

## 39. Signup plan selector (Trial / Business / Enterprise)

Signup previously hardcoded `tier='professional'` (not even a real quota tier — it fell through to
starter-level feature gating). Added a real plan chooser:
- **Frontend** ([Signup.jsx](../frontend/src/pages/Signup.jsx)): a 3-card `plan-picker` — **Trial**
  (free, 14-day, shared infra), **Business** (dedicated data plane), **Enterprise** (contact sales). Trial
  is the default. Selecting Enterprise swaps the form for a **Contact-sales** panel (prefilled `mailto:` to
  `sales@toovix.com`, no instant provisioning) with a "start a free trial instead" escape. Submit button +
  helper copy adapt to the chosen plan. CSS `.plan-picker/.plan-card` added to `App.css`.
- **Backend** ([/api/auth/signup](../api/main.js#L1259)): accepts `plan`; `SELF_SERVE_PLANS` maps
  `trial→{tier:starter,status:trial}` (shared plane) and `business→{tier:business,status:active}`
  (dedicated plane via `provisionDataPlaneIfPaid`). `plan=enterprise` is rejected with a contact-sales
  message. Tier/status now recorded in the signup audit detail.
- **Verified**: trial → `starter`/`trial`/(shared); business → `business`/`active`/`tenant_<id>` dedicated
  DB created; enterprise → 400 "contact sales". Test tenants + DB cleaned up.

## 40. Generic (tenant-agnostic) login

The login page was cosmetically + functionally tied to Meridian. Made it generic:
- **Password login was already generic** — [`/api/auth/login`](../api/main.js#L1188) looks the user up by
  email (`users JOIN tenants`) and issues a JWT scoped to *their* tenant. Any tenant's user signs in with
  their work email; the workspace is resolved automatically.
- **UI** ([Login.jsx](../frontend/src/pages/Login.jsx)): replaced the hardcoded
  `🏛 Meridian Financial · tenant meridian` chip with a generic "we'll take you to *your* workspace —
  detected from your email" hint.
- **Azure SSO** ([`/auth/azure` callback](../api/main.js#L1450)): existing SSO users already routed to
  their own tenant by email. The `else` branch used to **auto-provision unknown identities into
  `tenants LIMIT 1` (Meridian)** — both a Meridian hardcoding and a security hole (any Azure account could
  land in Meridian as a viewer). Now unknown SSO identities are **rejected** with
  `?error=No TooVix workspace is linked to <email>…` — they must be invited by an admin or self-serve sign
  up. (Deferred: first-time SSO org onboarding keyed on Azure `tid`/email-domain.)
- Verified: Meridian admin password login → resolves to Meridian tenant; unknown email → generic 401.

## 41. Workspace-first login + per-tenant SSO (Phase 1)

Replaced the global, Meridian-tied SSO with the **workspace-first** pattern (Okta/Slack style): SSO is
configured per tenant by its admin, and login resolves the tenant *before* offering SSO.
- **Login is now two-step** ([Login.jsx](../frontend/src/pages/Login.jsx)): step 1 asks for the workspace
  **slug** (`your-workspace.toovix.app`); step 2 shows that tenant's enabled SSO buttons **+** email/
  password. Last workspace is remembered in localStorage; an SSO rejection deep-links back with the
  workspace prefilled. `GET /api/auth/workspace?slug=` returns `{ tenantName, slug, sso[] }`.
- **Per-tenant SSO enablement** stored in `integrations` as `type='sso_<provider>'` (`status` active/
  inactive). `ssoProvidersFor(tenantId)` returns a provider only if the tenant enabled it **and** the
  platform-level app for it is configured. Admin endpoints: `GET /api/integrations/sso`,
  `PUT /api/integrations/sso/:provider` (adminOnly). `SSO_PROVIDERS` registry (Phase-1: `azure`).
- **Admin UI**: the Azure card's [SsoModal](../frontend/src/pages/Integrations.jsx) now has an admin-only
  **Enable/Disable on this workspace's login** toggle; the connector card's "connected" state reflects
  per-tenant enablement (not just the platform app). Test-sign-in is scoped with `?tenant=<slug>`.
- **SSO redirect carries the tenant** — `/auth/azure?tenant=<slug>` verifies the tenant has Azure enabled
  and embeds the slug in OAuth `state`. The **callback resolves the tenant from `state`** and matches the
  returning user **within that tenant** (`WHERE email=$1 AND tenant_id=$2`) — no more `tenants LIMIT 1`,
  no cross-tenant acceptance. Unknown identity → rejected with "not a member of <workspace>."
- **Verified**: lookup empty→`sso:[]`; admin enable→lookup shows Azure; `/auth/azure?tenant=meridian-fg`
  302s to Microsoft with `state={slug:'meridian-fg'}`; disable→error-redirect; unauth PUT→401. Meridian
  left with Azure SSO enabled.
- **Slug delivery** (needed now that login is workspace-first): signup returns `{ slug, tenantName }`
  and the **"check your email" screen shows the Workspace ID**; the **verification email** carries it in a
  highlighted block ("you'll enter this to sign in"). `verify-email` returns the slug and
  [VerifyEmail.jsx](../frontend/src/pages/VerifyEmail.jsx) stashes it in `localStorage.dam_workspace`, so the
  device pre-fills the workspace next time. Verified: signup → `slug:'northwind-traders'`, lookup + verify
  both return it.
- **Deferred to Phase 2**: per-tenant IdP *credentials* (each tenant's own Azure/Okta app, encrypted) —
  Phase 1 reuses the shared platform Azure app.

## 42. Welcome email on workspace activation

Added `sendWelcomeEmail({to,fullName,tenantName,slug,tier,loginUrl})` — sent to the new admin **once the
workspace goes live**, i.e. at self-serve **email-verification** success (in addition to the verify email).
It recaps the workspace ID (slug), plan, an "Open your console" button, and a numbered first-run checklist
(connect a database → deploy an agent → invite team → optional SSO). Fired best-effort
(`.catch`) so it never blocks activation; routed through the platform mailer. Verified: signup → verify →
`[Welcome] Sent welcome email … for workspace welcome-test-co`.
### Admin-console tenant creation → invite → welcome (added)

`POST /api/admin/tenants` previously created the first admin as `invited` and sent **no email**. Now it
invites them and the welcome follows on activation:
- **Local admin** (`sso:'none'`): a tokened `accept-invite` link is generated (7-day expiry) and
  `sendInviteEmail` is sent. On `POST /api/invites/:token/accept`, once the user is activated, a **welcome
  email fires if their role is `tenant_admin`** (team-member accepts stay on the plain "you can sign in"
  message). Fully verified: create → `[Invite] Sent invitation email`; accept → `[Welcome] Sent welcome
  email … workspace contoso`.
- **SSO admin** (`sso:'azure-ad'`, the console default): created `auth_provider='azure_ad'` with no token;
  `sendSsoInviteEmail` points them at SSO sign-in. On their **first SSO login** the Azure callback flips
  them `invited→active` and sends the welcome once (gated on `tenant_admin` + was-inactive). Verified the
  create/invite half; the welcome-on-first-SSO-login is wired in the callback (needs a live Azure round-
  trip to observe).

## 43. Public marketing homepage wired into the React app

Ported `mockups/index.html` into the product app as a real route. Previously `/` was the protected
Dashboard and the marketing page only existed as a static mockup (served by the nginx `dam-frontend` on
:8091 from `../mockups`). Now:
- **[Home.jsx](../frontend/src/pages/Home.jsx)** — full landing page (nav, hero + animated SOC SVG, stats,
  capabilities, engines, compliance, data-residency, testimonials, pricing, CTA, footer). Repeating cards
  are data-driven arrays; the large animated hero SVG is injected verbatim via `dangerouslySetInnerHTML`
  (kept its SVG attributes as-is rather than hand-converting to camelCase). **CTAs wired to real routes**:
  Sign in → `/login`, Start free trial / pricing / "Create workspace" → `/signup`, Live demo → `/login`;
  section links (#capabilities, #engines, #compliance, #pricing) scroll in-page.
- **[Home.css](../frontend/src/pages/Home.css)** — the mockup's styles, every selector scoped under
  `.hp-page` and carrying its own light-theme CSS variables, so it renders identically regardless of the
  app's active theme and never leaks into the authenticated app chrome.
- **[App.jsx](../frontend/src/App.jsx)**: `/` → `<Home/>` (public). Authenticated users are redirected to
  `/dashboard` (preserving old behaviour); `/dashboard` stays protected.
- Runs on the **React app (dam-react, :5173)** — the static mockups on :8091 are unchanged/separate.
- Verified: Vite transforms Home.jsx + Home.css cleanly; App.jsx route HMR'd; no compile errors.

## 44. Default policy pack seeded on tenant creation

New tenants were starting with an empty Policies page. Added `DEFAULT_POLICIES` (the same 11-rule baseline
the Meridian reference tenant ships with — block DELETE-without-WHERE, bulk sensitive read, credential
brute force, DDL change control, cross-schema joins, first-time object access, DBA GRANT, LLM exfil,
off-hours privileged access, service-account new-IP, ODBC/JDBC bulk export) and `seedDefaultPolicies(tenantId)`
(idempotent — skips if the tenant already has any policy). Rules are copied verbatim incl. `rule_definition`
jsonb, `rule_type`, `category`, `scope`, `actions[]`, `severity`, and `status` (enabled / monitor /
disabled exactly as Meridian).
- **Wired into both creation paths**: `POST /api/auth/signup` and `POST /api/admin/tenants` call it right
  after `provisionDataPlaneIfPaid`.
- Verified: a fresh signup produced exactly 11 policies matching Meridian (names/severities/statuses), with
  `rule_definition` + `actions[]` byte-identical; `[Policies] Seeded 11 default policies …` logged.
- Rules are engine-neutral and simply lie in wait until the tenant onboards its own databases. Existing
  pre-change tenants keep 0 policies unless backfilled (seed fn can be run against them on request).

## 45. Mandatory TOTP MFA for password logins

Password (local) logins now require TOTP two-factor. SSO logins are exempt (IdP handles MFA).
- **DB**: `users.mfa_secret` (base32), `mfa_enrolled_at`, `mfa_backup_codes` (jsonb array of bcrypt
  hashes); `mfa_enabled` default flipped to **true** (it was silently `false`). Signup + admin-create now
  set `mfa_enabled=true` explicitly (invite path already did). `mfa_enabled=false` is the **escape hatch**
  for lockout recovery (`UPDATE users SET mfa_enabled=false WHERE email=…`).
- **TOTP** (`main.js`): RFC-6238 (HMAC-SHA1, 30s, 6 digits, ±1 window) implemented on Node `crypto` — no
  TOTP dependency. `qrcode` added only to render the enrolment QR. Base32 encode/decode, secret gen,
  `otpauth://` URI, `verifyTotp`, 8× single-use backup codes (bcrypt-hashed, consumed on use).
- **Login flow** (`/api/auth/login`): after the password check, the session is **not** issued. If the user
  is MFA-enabled: enrolled → `{ mfaRequired, mfaToken }`; not-yet-enrolled → `{ mfaSetupRequired, setupToken }`.
  The `mfaToken`/`setupToken` are short-lived pending JWTs (`mfaPending` claim) that `authRequired` now
  **rejects** — they only work on the MFA endpoints.
- **Endpoints**: `POST /api/auth/mfa/setup` (secret + QR data-URL), `/mfa/enroll` (confirm first code →
  activate + return backup codes + session), `/mfa/verify` (TOTP **or** a one-time backup code → session).
- **Frontend** ([Login.jsx](../frontend/src/pages/Login.jsx)): three new stages inside the workspace-first
  sign-in — **setup** (QR + manual key + confirm code), **backup** (show the 8 codes once), **verify**
  (6-digit or backup code). MFA CSS in App.css.
- **Verified E2E** (scripted TOTP): first login → setup-required → QR → enroll (8 codes) → next login →
  code required → TOTP ok · bad code rejected · backup code works once · reused backup code rejected.
- **Heads-up**: every existing local user (incl. the seeded admin + 15 Meridian users, all `mfa_enabled=t`)
  is prompted to enrol on their next password login.

## 46. Detection engine made tenant-scoped (fixes cross-tenant alert→policy links)

Found during MFA testing: `runDetectionEngine` (1) hardcoded `tenants LIMIT 1` as the tenant for **every**
alert, (2) iterated **all** tenants' enabled policies, and (3) read `dam_analytics.events` with **no**
tenant filter — so alerts got Meridian's `tenant_id` but a `policy_id` from whichever (identically-named,
now-seeded-everywhere) policy matched. `alerts a JOIN policies p WHERE a.tenant_id<>p.tenant_id` was 57.
- **Fix**: the engine now loops tenants and, per tenant, evaluates **only that tenant's** enabled policies
  against **only that tenant's** events (routed via `eventsDbFor(tenantId)` + `WHERE tenant_id=…`), with
  tenant-scoped `databases` + `alert_suppressions`. The alert's `tenant_id` and `policy_id` are therefore
  always the same tenant. Single shared time watermark advances after all tenants are processed.
- Same global-scope bug fixed in the **shadow-eval** loop (monitor rules' `shadow_hits` now count only the
  policy's own tenant's events).
- **Data cleanup**: re-pointed the existing mismatched alerts to the same-named policy in their own tenant
  (73 rows; NULL fallback unused). Verified **0** mismatches remain after several live passes; Meridian
  keeps firing (11 alerts / 2 min); 3,692 alerts all same-tenant-linked.

## 47. Okta OIDC SSO login (mirrors Azure, env-based)

Built the real Okta sign-in flow (previously Okta was a read-only status card only).
- **Config** (`main.js`): `OKTA_DOMAIN`, `OKTA_CLIENT_ID`, `OKTA_CLIENT_SECRET`, `OKTA_REDIRECT_URI`
  (default `http://localhost:5173/auth/okta/callback`), `OKTA_ISSUER` (default
  `https://{domain}/oauth2/default` — the org's pre-provisioned default auth server). Added to
  `docker-compose` + `dev/.env` (domain + client ID filled for `integrator-3025962.okta.com`; secret left
  blank to paste).
- **Registry**: `okta` added to `SSO_PROVIDERS` (`type='sso_okta'`, `platformReady` = domain+id+secret set),
  so the per-tenant enable endpoints, `ssoProvidersFor`, and workspace-first login all pick it up for free.
- **Routes**: `/auth/okta?tenant=<slug>` (verifies the tenant has Okta enabled, carries slug in `state`,
  redirects to `${issuer}/v1/authorize`) and `/auth/okta/callback` (code→token exchange with the secret,
  decode id_token, resolve tenant from `state`, match user **within that tenant** — no auto-provision, no
  cross-tenant — set `auth_provider='okta'`, first-time admin welcome, issue DAM session). Same security
  model as Azure.
- **Integrations** ([Integrations.jsx](../frontend/src/pages/Integrations.jsx)): the Okta card's SsoModal
  now has the admin **Enable/Disable on this workspace's login** toggle and a tenant-scoped **Test sign-in**
  (`/auth/okta?tenant=<slug>&prompt=login`); the connector card reflects per-tenant enablement. Okta status
  endpoint extended with `enabledForTenant` + `slug` and scoped `usersProvisioned` to the tenant.
- **Login** ([Login.jsx](../frontend/src/pages/Login.jsx)): Okta logo + generic `handleSSO` → `/auth/<provider>?tenant=`.
- Verified routes live (guards fire correctly). The Okta user's email must match an existing user in the
  workspace (SSO never auto-creates accounts).

### 47a. Okta made GUI-configurable (per-tenant credentials)
Per user request, Okta creds are no longer env-only — they're configured **per tenant in the GUI**
(Integrations → Okta), stored in the `integrations` row's `config` jsonb. `SSO_PROVIDERS` grew a
`ready(config)` fn (Azure = env check; Okta = per-tenant `oktaEffective(config)`, which merges the stored
config over the env fallback). `oktaConfigFor(tenantId)` feeds `/auth/okta` + callback. New endpoint
`PUT /api/integrations/sso/okta/config` (adminOnly) saves domain/client_id/client_secret/redirect_uri —
**secret is write-only** (blank keeps stored). `GET /sso/okta` returns the config (domain/clientId prefill,
`secretConfigured` flag, `configured`, `enabledForTenant`) — never the secret. The generic
`PUT /sso/:provider` enable toggle now checks per-tenant `ready` (Okta: "add credentials first"). Frontend
SsoModal shows an editable **Okta credentials** form (domain / client ID / secret + read-only redirect URI)
→ Save → Enable → Test. `.env` OKTA_* kept only as optional prefill/fallback. Verified end-to-end via a
minted admin token: save config → `configured:true` → enable → workspace lookup returns `['azure','okta']`;
test config cleared afterward so the real secret is entered fresh in the GUI.

## 48. Google Sign-In (OIDC) — third SSO provider, GUI-configurable

Added Google as a third SSO provider, same per-tenant GUI-config model as Okta (§47a).
- **Config** (`main.js`): `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` (env = optional fallback), fixed endpoints
  (`accounts.google.com/o/oauth2/v2/auth`, `oauth2.googleapis.com/token`). No per-org domain (single
  issuer). `googleEffective(cfg)` + `googleConfigFor(tenantId)`; `google` added to `SSO_PROVIDERS`
  (`type='sso_google'`, `tenantConfigurable`).
- **Routes**: `/auth/google?tenant=<slug>` + `/auth/google/callback` — identical security model to Okta
  (tenant in `state`, per-tenant creds for the code exchange, match user within tenant, no auto-provision /
  no cross-tenant, first-time admin welcome, `auth_provider='google'`).
- **Endpoints**: `PUT /api/integrations/sso/google/config` (adminOnly, secret write-only) +
  `GET /api/integrations/sso/google` (masked). Enable via the generic `PUT /sso/:provider`.
- **Frontend**: Google connector card (red 'G'), `SSO_META.google`, `SsoModal` generalized to Okta+Google
  (shared credentials form; **domain field only for Okta**; Google = client ID + secret), `handleSSO` +
  `SSO_LOGO` + login button generalized to any provider, third refetch wired.
- Verified E2E via minted admin token: save config → `configured:true` → enable → workspace lookup returns
  `['azure','okta','google']`; guards fire; test config cleared. Redirect URI: `…/auth/google/callback`.

## 49. Invite-user: Okta + Google account types (+ tenant-scoping fix)

The Invite-user modal only offered **Local** and **Azure AD** — and the backend only understood those two.
- **Frontend** ([Users.jsx](../frontend/src/pages/Users.jsx)): account-type options now **Local / Azure AD /
  Okta / Google** (2×2 grid). All Azure-specific copy (email label, SSO note, submit button, success toast)
  generalized via `SSO_LABELS`.
- **Backend** ([POST /api/users](../api/main.js)): generalized `isAdUser` → `isSso` over
  `SSO_INVITE_PROVIDERS` ({azure_ad, okta, google}). SSO invites now store the **actual** provider (was
  coerced to `'local'` for anything non-Azure), `status='invited'`, **`mfa_enabled=false`** (IdP handles
  MFA; local users keep TOTP), and send a **provider-branded** SSO email (`sendSsoInviteEmail` gained a
  `providerName` param → right label + button colour). `resend-invite` generalized the same way.
- **Bug fixed along the way**: the invite INSERT used `(SELECT id FROM tenants LIMIT 1)` — so **every
  invited user landed in the first tenant (Meridian), not the inviter's**. Now uses `req.user.tenantId`.
- Verified: inviting Google/Okta users → correct `auth_provider`, `invited`, `mfa_enabled=false`, and
  created **in the inviter's tenant**.

## 50. Email is now unique PER TENANT (a person can be in multiple workspaces)

`users.email` was globally unique (`users_email_key`), so the same person couldn't belong to two
workspaces (adding them anywhere else → "user already exists"). Switched to true multi-tenant identity.
- **Migration**: drop `users_email_key`, add `UNIQUE (tenant_id, email)` (`users_tenant_email_key`),
  idempotent via a `DO $$…$$` guard.
- **Password login** ([/api/auth/login](../api/main.js#L1302)): email lookup is now scoped by the chosen
  **workspace slug** (the workspace-first login already resolves it; frontend passes `workspace` in the
  body). No slug + email in >1 workspace → 409 "enter your workspace name first"; unique email still works
  without a slug (back-compat).
- **Signup**: dropped the global "email already exists" block — the same person may create/own multiple
  workspaces (per-tenant unique index still guards within the new tenant).
- **Invite** ([POST /api/users](../api/main.js)): existence check scoped to `AND tenant_id = $1`;
  **admin-create** `ON CONFLICT (email)` → `ON CONFLICT (tenant_id, email)`.
- **SSO** callbacks already matched by `email AND tenant_id` — unchanged.
- Verified: same email added to a 2nd workspace (previously rejected); login without workspace → 409;
  login with `workspace=meridian-fg` → scoped to the right account.

## 9. App entry points

- Dev SPA (HMR): http://localhost:5173  · API: http://localhost:3000
- **Admin console (HMR): http://localhost:5174**
- Seeded admin login: `vikramsharma3107@gmail.com` / `Admin@123`
- MinIO console (dev WORM archive): http://localhost:9090 (`dam_minio` / `dam_minio_secret`)
