# TooVix DAM — Super Admin Feature Specification

> Companion to [ADMIN-KB.md](ADMIN-KB.md). Expands every admin feature into **sub-features**, **use cases**, and **governance rules**.
>
> **Tags:** Phase: 🟢 must-have (v1) · 🟡 should-have (v2) · 🔵 future.
> **Audience:** Platform ops, engineering, support, finance, customer success, security.

---

## Category 1 — Tenant Lifecycle Management

### A1.1 Create Tenant 🟢
- **Sub-features:** sales-led wizard (v1); self-serve signup (v2); org name + workspace slug + plan tier + region + admin email + compliance frameworks + industry; provisioning pipeline (Postgres RLS record → ClickHouse DB → Kafka/Event Hub topics → KMS key generation → compliance pack loading → agent enrollment token → welcome email); estimated < 60s automated; retry on partial failure; provisioning audit trail.
- **Use case:** Sales closes Bharat National Bank. Ops enters details in the admin console; platform provisions a fully isolated tenant in IN-Mumbai within 45 seconds, sends the bank's CISO a welcome email with SSO setup instructions.
- **Governance:** every tenant creation logged to `platform_audit` with creator, plan, region, compliance scope. Tenant slug must be globally unique. Region cannot be changed post-provisioning without a formal migration.

### A1.2 Suspend Tenant 🟢
- **Sub-features:** manual suspension (ops-initiated); auto-suspension on non-payment (configurable grace: 7/14/30 days); abuse-triggered suspension; customer-requested pause; legal-hold suspension (blocks offboarding too); suspension effects (agents stop ingesting, UI read-only banner, API 403 on writes, data retained); unsuspend with approval workflow.
- **Use case:** TechStart Inc misses payment for 14 days. Auto-suspension fires: agents pause, the tenant admin sees "Account suspended — contact billing," but audit data is preserved. Finance applies credit, ops unsuspends, agents resume within 60 seconds.
- **Governance:** suspension reason mandatory. Auto-suspension requires configured grace period per plan. Unsuspend requires approval from billing or ops lead. All suspension/unsuspend events → `platform_audit`.

### A1.3 Offboard Tenant 🟢
- **Sub-features:** initiate offboarding (ops or auto on contract expiry); configurable grace period (default 30 days); countdown visible to tenant admin; data export available during grace (signed Parquet + config JSON); post-grace destruction (ClickHouse DB drop, Kafka topic delete, KMS key destruction schedule, Postgres soft-delete); legal-hold override (blocks destruction); offboarding checklist (integrations disconnected, API keys revoked, SSO deprovisioned, SIEM forwarding stopped).
- **Use case:** Royal Commerce UK decides not to renew. Ops initiates offboarding with 30-day grace. The tenant admin exports all audit data as a signed archive. After 30 days, all data is destroyed and a destruction certificate is generated.
- **Governance:** offboarding requires written confirmation (stored in admin). Legal hold blocks all destruction until released. Destruction certificate generated with hash proof. Grace period cannot be shortened below contract minimum.

### A1.4 Migrate Tenant 🟢
- **Sub-features:** intra-region migration (between ClickHouse clusters for capacity balancing); cross-region migration (regulatory change, customer request); migration steps (pause ingest → replicate data → switch routing → verify integrity → resume ingest → cleanup source); downtime estimate calculator; pre-migration validation (disk space, network bandwidth, compatibility); rollback if verification fails.
- **Use case:** IN-Mumbai cluster is at 87% capacity. Ops migrates GovData India to a new dedicated cluster within IN-Mumbai. Zero data loss, 4-minute ingest pause, hash-chain integrity verified post-migration.
- **Governance:** cross-region migration requires tenant admin written approval (data sovereignty implications). Migration audit trail with before/after cluster IDs. Integrity verification mandatory — auto-rollback if hash-chain mismatch.

### A1.5 Clone Tenant Configuration 🟡
- **Sub-features:** clone source tenant's policies, rules, classification rules, notification channels, integration configs to a new or existing tenant; selective clone (choose which config categories); diff preview before apply; does NOT clone data (audit events, alerts).
- **Use case:** Meridian Financial acquires a subsidiary. The subsidiary gets a new TooVix tenant with identical policy configuration cloned from the parent — 74 rules, 48 classifiers, 5 integrations — in one click instead of manual recreation.
- **Governance:** clone source must be a tenant the operator has access to. Clone logged with source/target/categories. Target tenant admin notified of configuration import.

### A1.6 Tenant Feature Flags 🟢
- **Sub-features:** global feature list (LLM Monitoring, Inline Blocking, DSAR Module, VA Scanner, UEBA, Dynamic Masking, Static Masking, Deception Console, JIT Access, SQL Grammar Allowlist); per-tenant override (enabled/disabled/beta/default); plan-tier enforcement (Starter features ⊂ Business ⊂ Enterprise); staged rollout phases (alpha → beta → early-access → GA); percentage-based rollout; override audit trail.
- **Use case:** LLM Monitoring is in beta. Ops enables it for Meridian Financial (beta tester) and Bharat National Bank (early access), while keeping it off for all other tenants. When ready, ops rolls it to 25% → 50% → 100% over 2 weeks.
- **Governance:** feature flag changes → `platform_audit`. Plan-tier enforcement cannot be bypassed (Starter tenant cannot get Enterprise feature even with manual flag). Beta features show a "beta" badge in tenant UI.

### A1.7 Tenant Resource Quotas 🟢
- **Sub-features:** quota dimensions (events/day, databases, agents, storage GB, API calls/hour, export volume/month); default quotas per plan tier (Starter: 1M events/5 DBs/10GB; Business: 500M/unlimited/1TB; Enterprise: custom); per-tenant override; soft limit (warning notification at 80%) vs hard limit (reject at 100%); quota enforcement at ingest gateway + API gateway; usage dashboard with trend toward limit.
- **Use case:** TechStart Inc on Starter plan approaches 80% of their 1M events/day quota. Auto-notification: "You're at 80% of your daily event limit — upgrade to Business for unlimited." At 100%, new events are buffered for 1 hour then dropped with alert to ops.
- **Governance:** hard-limit drops logged with tenant + event count. Quota override requires justification. Quota changes → `platform_audit`.

### A1.8 Configuration Drift Detection 🟡
- **Sub-features:** baseline per plan tier (minimum retention days, MFA required, BYOK required for Enterprise, minimum capture modes per crown-jewel DB); continuous scan of tenant config vs baseline; drift alerts to ops (tenant disabled MFA, retention below compliance minimum, BYOK key expired); auto-remediation option (re-enable MFA, reset retention); drift report per tenant.
- **Use case:** Nordic Insurance Group's admin accidentally disables MFA enforcement. Drift detection fires within 5 minutes: "MFA disabled on Nordic Insurance — violates Business plan baseline." Ops contacts tenant or auto-remediates.
- **Governance:** drift detection runs every 5 minutes. Critical drifts (MFA, encryption) alert immediately. Non-critical drifts (retention, naming) batch daily.

---

## Category 2 — Customer Support

### A2.1 Tenant Impersonation 🟢
- **Sub-features:** impersonate into any tenant's console as if logged in as their admin; mandatory justification text (min 20 chars); time-limited (30m/1h/2h max, configurable); auto-revoke at expiry; full session recording (every click, page view, action); `impersonated_by` field on all audit records during session; post-session review by security team; revocable mid-session by security; visual indicator in tenant UI ("Support session active").
- **Use case:** Bharat National Bank reports "our Oracle alerts aren't firing." Support engineer impersonates into their tenant, sees the Oracle policy is scoped to `db_group: test` instead of `prod`, fixes it, and logs the resolution. Bank sees "TooVix support session was active 14:22–14:38 — 3 actions taken."
- **Governance:** impersonation requires: active support ticket reference, justification text, approval (auto for Tier 2+, manual for Tier 1). Max 2h per session. All impersonation sessions reviewed by security within 24h. Quarterly impersonation audit report.

### A2.2 Tenant Health Dashboard 🟡
- **Sub-features:** single-pane per-tenant view; 6 health dimensions (ingest, agent, alert, classification, compliance, integration); composite health score 0–100; trend (improving/stable/declining); recent issues list; auto-generated health summary ("3 agents offline, alert ack rate dropped 24%, GDPR compliance at 86%"); comparison to cohort (similar plan/size tenants).
- **Use case:** Before responding to Nordic Insurance's support ticket, the engineer opens Tenant Health → Nordic Insurance. Score: 76 (amber). Sees: "Alert ack rate dropped from 92% to 68% over 2 weeks. 4 of 9 SOC analysts haven't logged in this month." Provides context before the call.
- **Governance:** health data refreshed every 15 minutes. Score thresholds configurable (green ≥80, amber ≥60, red <60). Health score changes of ±10 auto-notify assigned CSM.

### A2.3 Job Management & Re-run 🟢
- **Sub-features:** view all async jobs across tenants (classification scan, VA scan, provisioning, policy deploy, data export, migration, hash-chain verification); job states (queued/running/completed/failed/cancelled); failed job detail (error message, stack trace, retry count); manual re-run with parameter override; bulk re-run (all failed jobs for a tenant); job duration metrics.
- **Use case:** GovData India's nightly classification scan failed due to a temporary ClickHouse timeout. Ops sees the failure in the job dashboard, clicks "Re-run," and the scan completes successfully. The tenant's classification coverage returns to 100%.
- **Governance:** re-runs logged with operator + reason. Max 3 auto-retries before requiring manual intervention. Failed jobs older than 72h without re-run → alert to ops.

### A2.4 Account Management 🟢
- **Sub-features:** reset tenant admin password (generates secure temp password + forces MFA re-enrollment); unlock locked accounts (after N failed login attempts); force session termination (all sessions for a user or all users in a tenant); disable/enable specific user accounts; view tenant's user list + last login + MFA status; force SCIM re-sync.
- **Use case:** Meridian Financial's admin (Sarah Chen) locked out after a password manager issue. Support resets her password, she logs in with the temp password, re-enrolls MFA, and is back in 3 minutes. The reset is logged with the support ticket reference.
- **Governance:** password resets require support ticket. Temp passwords expire in 1 hour. Reset → forced MFA re-enrollment (no bypass). All account actions → `platform_audit` + tenant's `control_plane_audit`.

### A2.5 Runbook Automation 🟡
- **Sub-features:** pre-built runbooks (12 initial: agent offline recovery, ClickHouse partition cleanup, Kafka consumer lag fix, outbox stuck recovery, ingest pipeline restart, certificate renewal, tenant provisioning retry, classification scan re-run, VA scan re-run, hash-chain repair, data plane re-sync, alert dispatcher restart); parameter input (target region/tenant/component); execution log with timing; success/failure tracking; custom runbook builder (v2).
- **Use case:** Kafka consumer lag spikes on EU-West partition 4. Ops opens Runbooks → "Kafka consumer lag fix" → selects EU-West → Execute. The runbook resets the consumer offset, restarts the consumer group, and verifies lag returns to normal in 2.4 minutes.
- **Governance:** runbook execution logged with operator + parameters + duration + outcome. Critical runbooks (hash-chain repair, data plane re-sync) require approval from engineering lead. Runbook failure → auto-escalate to on-call.

### A2.6 Tenant Data Export 🟢
- **Sub-features:** export all tenant data (audit events, configs, policies, classification rules, alert history); signed Parquet archive with hash-chain verification; configurable date range; export during offboarding grace period (mandatory availability); legal hold export (full tenant dump for litigation); export progress tracking; download link with 72h expiry.
- **Use case:** Pacific Health Partners receives a legal discovery request. Ops initiates a full data export for the tenant — 18 months of audit data exported as signed Parquet with integrity proof. The legal team downloads the archive and provides it to counsel.
- **Governance:** data export logged with requester + reason + date range + size. Legal hold exports require legal team approval. Export links expire after 72h. Exports include integrity verification metadata (hash-chain proof, signing certificate).

### A2.7 Customer Communication Log 🟡
- **Sub-features:** per-tenant log of all support interactions, escalations, RCA documents; link to ITSM tickets (ServiceNow/Jira); internal notes (not visible to tenant); interaction categories (support, QBR, escalation, incident, onboarding); searchable by tenant + date + category.
- **Use case:** Before a QBR with Bharat National Bank, the CSM reviews the communication log: 2 support tickets this quarter (both resolved quickly), 1 RCA from an ingest delay incident, and notes from the last QBR about expanding to their insurance subsidiary.
- **Governance:** communication logs retained for the life of the tenant + 2 years post-offboarding. Internal notes never shared with tenant. ITSM links validated weekly.

---

## Category 3 — Platform Operations

### A3.1 Infrastructure Health Monitoring 🟢
- **Sub-features:** per-region health dashboard (control plane status, data plane status, ingest lag, events/s, disk usage, Kafka consumer lag); component-level status (each microservice: version, replicas, CPU, memory, health endpoint result); alerting on threshold breaches (disk >85%, lag >5s, error rate >1%); cross-region comparison; historical uptime tracking.
- **Use case:** IN-Mumbai ClickHouse cluster hits 87% disk. Infra Health shows amber alert: "ch-in-01: disk 87%, projected full in 18 days." Ops schedules expansion before it becomes critical.
- **Governance:** health checks every 30 seconds. Alerts auto-escalate: warning (30m) → high (15m) → critical (immediate page). Uptime tracked for SLA reporting.

### A3.2 Noisy Neighbor Detection 🟢
- **Sub-features:** real-time per-tenant resource consumption (CPU share %, memory share %, disk I/O %, Kafka throughput, ClickHouse query load); sorted by highest consumer; auto-throttle option (temporarily rate-limit a tenant's ingest to protect cluster); manual throttle with duration + reason; historical consumption trends; tenant isolation score (how well-isolated is this tenant from neighbors); alert on disproportionate consumption (>30% of shared cluster).
- **Use case:** Bharat National Bank's nightly ETL batch causes a spike to 34% of IN-Mumbai cluster CPU. Noisy Neighbor dashboard highlights this. Ops sees it's recurring (every night 02:00–04:00 IST), recommends the bank either stagger their ETL or move to a dedicated cluster.
- **Governance:** auto-throttle requires justification. Throttle events → `platform_audit` + notification to affected tenant. Tenants consuming >30% of shared cluster for >1 hour trigger a migration recommendation.

### A3.3 Canary Deployments 🟡
- **Sub-features:** progressive rollout phases (canary 5% → 25% → 50% → 100%); canary tenant selection (random or specific); canary metrics (error rate, p99 latency, parser failures, alert delivery rate); automated rollback triggers (error rate >0.5%, latency >3× baseline); manual promote/pause/rollback controls; deployment types (platform version, agent version, content pack); rollout history with outcome (success/rolled-back).
- **Use case:** Platform v2.4.2 is ready. Ops starts a canary rollout to 5% of tenants (TechStart Inc + Royal Commerce UK). After 30 minutes, error rate is 0.02% (normal). Ops promotes to 25%, monitors for 1 hour, then 50%, then 100%. Total rollout time: 4 hours with zero incidents.
- **Governance:** canary rollout mandatory for all production deployments. Auto-rollback if error rate >0.5% or p99 latency >3× baseline. Rollout log with operator + versions + phases + metrics at each promotion.

### A3.4 Capacity Planning 🟡
- **Sub-features:** per-region capacity dashboard (ClickHouse nodes, disk used/total, Kafka partitions, compute cores, utilization %); growth trend charts (monthly); forecast model (linear projection based on last 6 months); "projected full" date per resource; expansion recommendations with cost estimate; cost projection (current vs projected at growth rate); alerting at planning thresholds (70%, 85%, 95%).
- **Use case:** Capacity Planning shows IN-Mumbai at 87% disk utilization with 8% monthly growth. Forecast: "Full by August 2026." Recommendation: "Add 2 ClickHouse nodes ($4,200/month)." Ops approves and schedules the expansion.
- **Governance:** capacity alerts at 70% (plan), 85% (act), 95% (emergency). Expansion requests require engineering approval + cost sign-off. Monthly capacity review meeting driven by this dashboard.

### A3.5 Maintenance Window Scheduler 🟡
- **Sub-features:** schedule region-level or cluster-level maintenance; maintenance types (planned upgrade, hardware replacement, network change, DR drill); customer notification templates (email + in-app banner); notification lead time (48h/72h/1 week); customer acknowledgment tracking; maintenance impact estimation (expected downtime, affected tenants); post-maintenance verification checklist.
- **Use case:** Ops schedules a ClickHouse upgrade for EU-West on Saturday 02:00–04:00 CET. The system auto-notifies all 9 EU-West tenants 72 hours in advance. 7 of 9 acknowledge. Ops proceeds; post-maintenance verification confirms all tenants healthy.
- **Governance:** minimum 48h notice for planned maintenance. Emergency maintenance requires P1 incident declaration. Maintenance windows logged with actual duration vs planned.

### A3.6 Incident Management 🟡
- **Sub-features:** platform-level incident tracker; severity levels (P1: platform down, P2: region degraded, P3: single tenant affected, P4: cosmetic/minor); incident lifecycle (declare → assign owner → investigate → mitigate → resolve → RCA → close); timeline recording (every action timestamped); affected tenant tracking; customer communication status; RCA template; post-incident review scheduler; feeds into SOC 2 evidence.
- **Use case:** Kafka consumer lag on EU-West spikes to 45 seconds. Ops declares a P2 incident. Timeline: lag detected → engineer assigned → root cause identified (partition rebalance during deployment) → consumer group restarted → lag returns to normal → RCA written → incident closed. Total duration: 22 minutes.
- **Governance:** P1/P2 incidents require RCA within 48 hours. P1 incidents require post-incident review meeting. All incidents logged for SOC 2 evidence. Customer-facing status page updated for P1/P2.

### A3.7 Disaster Recovery 🟢
- **Sub-features:** per-region DR procedures (failover to DR cluster, DNS switch, data integrity verification); DR test scheduler (quarterly mandatory); DR test results tracking (RTO achieved, RPO achieved, issues found); one-click failover initiation (with confirmation); failback procedure; DR status dashboard (last test date, last failover, DR cluster health).
- **Use case:** Quarterly DR drill for IN-Mumbai: ops initiates controlled failover to DR cluster in IN-Pune. All 10 India tenants switch over in 3.2 minutes (RTO target: 5 min). Data verified — 0 events lost (RPO: 0). Failback completed. DR test report generated automatically.
- **Governance:** DR tests mandatory quarterly. DR test failure = P2 incident. RTO and RPO tracked vs SLA commitments per tenant plan. DR procedures reviewed and updated after every real failover.

---

## Category 4 — Commercial / Billing

### A4.1 Billing & Plans Management 🟢
- **Sub-features:** plan tiers (Starter: free 14-day trial, 5 DBs, 30d retention; Business: per-DB/month, unlimited, 1yr retention, SSO; Enterprise: custom pricing, BYOK, on-prem, air-gap, SLA); usage metering (events processed, databases monitored, storage consumed, agents deployed, API calls, scans run); invoice generation (monthly, auto from metering); overage handling (soft notify at 80%, hard cap or overage billing at 100%); plan upgrade/downgrade workflow.
- **Use case:** Pacific Health Partners on Business plan adds their 95th database (approaching plan limit). Auto-notification at 80%: "Consider Enterprise for unlimited databases + BYOK." At 100 DBs: conversation with sales required to proceed or upgrade.
- **Governance:** metering data retained for 24 months. Invoice generation logged. Plan changes require tenant admin confirmation + ops approval for downgrades.

### A4.2 Credits & Adjustments 🟢
- **Sub-features:** apply credits (outage compensation, goodwill, promotional discount, trial extension); manual billing overrides with mandatory justification; credit types (one-time, recurring, percentage); adjustment audit trail; credit expiry (configurable); balance tracking per tenant.
- **Use case:** EU-West had a 22-minute P2 incident affecting Nordic Insurance. Ops applies a $500 SLA credit with justification "P2 incident INC-2026-047, 22min downtime, SLA breach." Credit appears on the next invoice.
- **Governance:** credits >$1,000 require finance approval. All credits → `platform_audit` with amount + reason + approver. Credit reports generated monthly for finance team.

### A4.3 Trial Conversion Tracking 🟡
- **Sub-features:** trial pipeline visualization (signed up → verified email → connected 1st DB → first alert fired → first compliance report → converted / churned / active trial); per-trial tenant progress tracking; milestone timestamps; auto-triggers (no DB by day 3 → notify CSM; no alert by day 7 → send help email); conversion rate trends (monthly); cohort analysis (conversion rate by industry, region, referral source).
- **Use case:** Trial funnel shows 12 signups this month, but only 8 connected a database. 3 of those never fired an alert. Ops sees: "50% of trials that don't connect a DB by day 3 churn — trigger earlier onboarding outreach."
- **Governance:** trial data retained 12 months post-churn for analysis. Auto-triggers configurable per plan. Conversion reports generated weekly for sales leadership.

### A4.4 Contract Management 🟡
- **Sub-features:** store signed documents per tenant (MSA, DPA, SLA, BAA for HIPAA, custom addenda); track contract dates (start, end, renewal, auto-renewal); renewal alerts (90/60/30 day); contract terms linked to tenant config (SLA tier → DR RTO, retention minimum → config enforcement); document version history.
- **Use case:** Bharat National Bank's enterprise contract specifies: 99.95% uptime SLA, 7-year retention, in-country data residency, quarterly DR tests. These terms are stored in the admin console and linked to the tenant's configuration — drift detection alerts if retention is changed below 7 years.
- **Governance:** contracts require legal team upload. Contract changes require both parties' signature. Contract terms → enforced via configuration drift detection.

### A4.5 Revenue Analytics 🟢
- **Sub-features:** MRR/ARR breakdown by region, plan tier, industry; growth trends (month-over-month, quarter-over-quarter); churn rate (logo churn, revenue churn); net revenue retention (NRR); expansion revenue (upsells, cross-sells); average revenue per tenant; revenue concentration risk (top 5 tenants as % of total).
- **Use case:** Revenue dashboard shows: MRR $284K, NRR 118%, India region growing fastest at 14% QoQ. Top 2 tenants (Bharat National Bank + Meridian Financial) represent 42% of revenue — concentration risk flagged.
- **Governance:** revenue data reconciled monthly with finance system. Revenue reports available to C-level and finance only (RBAC restricted).

---

## Category 5 — Product Configuration

### A5.1 Content Pack Management 🟢
- **Sub-features:** manage global classifier library (48 rules: SSN, Aadhaar, PAN, NHS, SIN, credit card, email, GSTIN, IFSC, phone, DOB, address, etc.); manage VA test library (6,247 tests: CIS, DISA-STIG, PCI-DSS, HIPAA, RBI-CSF, SOX/ITGC); manage default policy library (18 rules shipped to new tenants); manage threat intelligence feeds (MISP, CERT-In, commercial feeds); per-item: version, enable/disable, regional scope, framework mapping.
- **Use case:** India's DPDPA regulation adds a new data category. Product team adds a "DPDPA consent ID" classifier to the library, tests it on 3 tenants, then pushes it globally. All India-region tenants auto-receive it; others get it disabled by default.
- **Governance:** content changes require product team approval. Pushes are versioned and signed. Air-gapped tenants receive offline bundles. Rollback available within 72h.

### A5.2 Content Versioning & Rollback 🟢
- **Sub-features:** every content update = a signed, versioned pack; version history with changelog; rollback to any previous version; differential updates (only changed items); signature verification before apply; air-gapped offline bundles (downloadable .tar.gz with signature); push status tracking (X of Y tenants updated).
- **Use case:** VA test pack v2.14 introduces a new CIS check that causes false positives on Db2 databases. Ops rolls back to v2.13 for Db2 tenants within 10 minutes while the product team fixes the test. Non-Db2 tenants keep v2.14.
- **Governance:** rollback window: 72h for automatic, unlimited for manual. Rollbacks logged with reason. Content packs cryptographically signed — reject unsigned or tampered packs.

### A5.3 Per-Region Content Defaults 🟢
- **Sub-features:** region → default classifier/policy mapping (India: Aadhaar+PAN+GSTIN+IFSC+DPDPA rules; EU: GDPR rules+EU PII; US: SSN+HIPAA+SOX; UK: NHS+GDPR post-Brexit); auto-apply on tenant creation based on region; tenant can override (add more, not remove compliance-mandated ones); regional content report (which classifiers active per region).
- **Use case:** A new tenant is created in IN-Mumbai. The provisioning pipeline auto-enables: Aadhaar, PAN, GSTIN, IFSC classifiers + DPDPA compliance pack + RBI CSF rules. The tenant admin can add more classifiers but cannot disable Aadhaar (regulatory mandate).
- **Governance:** compliance-mandated classifiers (Aadhaar for India, SSN for US healthcare) cannot be disabled by tenant admin — only by platform ops with documented exception.

### A5.4 Agent Version Management 🟢
- **Sub-features:** global agent fleet version tracking; compatibility matrix (agent version × DB engine version × OS); schedule global rollout (canary → batched → full); block incompatible upgrades automatically; per-tenant version pin (enterprise customers can hold a version); agent changelog; download links for all supported platforms (RPM/DEB/MSI/container).
- **Use case:** Agent v2.4.1 adds support for Oracle 23ai. Ops starts a fleet-wide rollout: 10% batch size, 30-minute soak between batches. Batch 3 shows elevated parser errors on Db2 12 — rollout auto-pauses. Ops investigates, pushes a hotfix (v2.4.2), resumes rollout.
- **Governance:** agent rollouts follow canary process. Enterprise tenants can pin versions (with documented exception). Unsupported agent versions (>2 major behind) generate compliance warning.

### A5.5 A/B Testing for Detection Rules 🟡
- **Sub-features:** run new rule version alongside old on same event stream; compare metrics (alert volume, false positive rate, detection coverage, mean time to detect); statistical significance calculator; promote winner; per-tenant or global A/B test; test duration (1 day to 30 days).
- **Use case:** Product team rewrites the "Bulk PII read" rule to use peer-group deviation instead of fixed threshold. A/B test on 5 tenants for 2 weeks: new rule catches 12% more true positives with 40% fewer false positives. Promoted globally.
- **Governance:** A/B tests require product team approval. Test results archived for 12 months. Neither variant can be less strict than compliance minimum.

---

## Category 6 — Compliance & Security (Vendor's Own Posture)

### A6.1 Platform Audit Log 🟢
- **Sub-features:** every vendor-side action logged (tenant access, config changes, impersonation sessions, billing adjustments, content pack pushes, break-glass access, deployments, cert rotations); immutable, hash-chained (same BLAKE3 standard as the product); searchable by actor + action type + tenant + time range; export as signed evidence pack (PDF/CSV); retention: indefinite for compliance.
- **Use case:** During TooVix's annual SOC 2 audit, the auditor requests evidence of all production tenant access for Q1 2026. Ops exports the platform audit log filtered to tenant access events — 347 events, all with justification, operator identity, and duration. Hash-chain integrity verified.
- **Governance:** platform audit log is append-only, never deletable. Hash-chain verification runs hourly. Log access restricted to security team + auditors. Quarterly log review mandatory.

### A6.2 Break-Glass Access 🟢
- **Sub-features:** emergency production access to tenant data; request form (tenant, justification, scope: read-only/read-write, duration: 30m/1h/2h, incident reference); approval workflow (requester → manager approval → security review → active → auto-expired); full session recording; post-access review within 24h; revocable mid-session by security; break-glass access restricted to designated senior engineers.
- **Use case:** At 3am, a critical hash-chain verification failure is detected on Meridian Financial's audit trail. The on-call engineer requests break-glass access (read-write, 1h, P1 incident). Manager approves via mobile. Engineer repairs the chain, verifies integrity, and exits. Security reviews the session next morning — all actions appropriate.
- **Governance:** break-glass access is the exception, never the norm. Maximum 2h per session. Post-review mandatory within 24h. Quarterly break-glass audit report. More than 3 break-glass sessions per month triggers a process review.

### A6.3 Vendor Employee Access Reviews 🟢
- **Sub-features:** quarterly recertification of all vendor employees with production access; reviewer: each employee's manager; recertification window: 14 days; auto-revoke if not recertified; segregation of duties (support cannot approve their own access; billing cannot access production data); access levels (platform admin, support impersonation, billing read, security audit); new-hire access request with approval workflow; leaver access revocation (auto via HR feed or manual).
- **Use case:** Quarterly review shows 12 employees with production access. 10 recertified by their managers. 2 not recertified within 14 days (one on leave, one role-changed). Access auto-revoked for both. The one on leave's access is re-granted when they return and manager recertifies.
- **Governance:** access reviews are SOC 2 evidence. Review completion tracked (% on time). Overdue reviews escalate to CISO. Access review reports retained indefinitely.

### A6.4 SOC 2 Evidence Collection 🟡
- **Sub-features:** auto-generate evidence for TooVix's own SOC 2 Type II / ISO 27001 audits; evidence categories (access logs, change management, incident response, vendor access reviews, encryption status, backup verification, DR test results); evidence export as PDF/CSV bundle; evidence collection schedule (quarterly for SOC 2, annual for ISO); gap identification (which evidence is missing or incomplete).
- **Use case:** TooVix's SOC 2 auditor requests evidence for 8 control objectives. The admin console generates a bundle: platform audit log (control 1), access review reports (control 2), incident reports with RCA (control 3), DR test results (control 4), encryption verification (control 5), change management log (control 6), vendor access log (control 7), backup verification (control 8). All cryptographically signed.
- **Governance:** evidence auto-collected on schedule. Gaps flagged 30 days before audit. Evidence bundles signed and tamper-evident.

### A6.5 Data Sovereignty Enforcement 🟡
- **Sub-features:** per-tenant data residency rules (tenant X's data MUST stay in region Y); enforcement at all data layers (ClickHouse, Kafka, blob storage, backups, exports); cross-region transfer blocking (alert + block if data movement violates residency); sovereignty audit trail (every data access with region logged); per-tenant data residency report (for regulators); bulk sovereignty compliance report (all tenants).
- **Use case:** RBI mandates that Indian banking customers' data must reside in India. The admin console enforces: all 10 India-region tenants' data stays in IN-Mumbai. An engineer accidentally configures a cross-region backup to EU-West — the system blocks it and alerts ops: "Sovereignty violation: GovData India backup to EU-West blocked."
- **Governance:** sovereignty rules immutable by non-security personnel. Cross-region transfer blocks are hard-fails (not warnings). Sovereignty reports generated quarterly and available for regulator audit. Rule changes require CISO approval.

### A6.6 Security Event Monitoring 🟢
- **Sub-features:** admin console login tracking (who, when, from where, device); failed login detection + alerting; unusual access patterns (new device, new IP, off-hours, multiple tenant access in short window); session tracking (active sessions, duration, last activity); anomaly detection (login from unusual geo, concurrent sessions from different locations); integration with corporate SIEM for vendor-side security.
- **Use case:** An admin account logs in from an IP in an unusual country at 3am. Security event monitoring flags: "Unusual login: ops_engineer_2 from 203.x.x.x (previously only seen from US/India). Off-hours access." Auto-MFA challenge triggered. Alert to security team.
- **Governance:** all admin logins → platform audit. Failed login threshold: 5 → account locked. Unusual access → immediate alert to security. Security events forwarded to vendor's own SIEM.

---

## Category 7 — Customer Success

### A7.1 Account Health Scoring 🟡
- **Sub-features:** composite score per tenant (0–100); scoring dimensions (usage trends: 25%, alert acknowledgment rate: 20%, coverage completeness: 20%, support ticket volume: 15%, login frequency: 10%, feature adoption: 10%); thresholds (green ≥80, amber ≥60, red <60); trend detection (improving/stable/declining); auto-notification to CSM on score drop ≥10 points; cohort comparison (vs similar-sized tenants on same plan).
- **Use case:** Royal Commerce UK's health score drops from 72 to 58 over 3 weeks: usage down 35%, no admin login in 14 days, alert ack rate at 31%. Auto-notification to CSM: "Churn risk — schedule executive outreach." CSM contacts the customer and discovers they've had an internal reorg.
- **Governance:** health scores updated every 6 hours. Score changes of ≥10 notify CSM immediately. Monthly health score reports to customer success leadership. Scoring weights reviewed quarterly.

### A7.2 Renewal Pipeline 🟡
- **Sub-features:** upcoming renewals (90/60/30 day views); renewal likelihood based on health score + usage trends + support history; contract value at stake; renewal owner assignment; renewal outcome tracking (renewed, expanded, downgraded, churned); win/loss analysis; renewal forecast (expected MRR next quarter based on likelihood).
- **Use case:** Renewal pipeline shows 8 contracts up for renewal in 90 days, totaling $142K ARR. 5 are green (auto-renew likely), 2 are amber (need attention), 1 is red (Royal Commerce UK — churn risk). CSM prioritizes the red and amber accounts.
- **Governance:** renewal alerts auto-generated at 90/60/30 days. Renewals >$50K require VP-level engagement plan. Churn post-mortem required for all lost renewals.

### A7.3 Feature Adoption Tracking 🟡
- **Sub-features:** per-tenant feature usage matrix (which features active, frequency, depth); global adoption heatmap across all tenants; adoption by plan tier; adoption trends (growing/flat/declining per feature); low-adoption alerts (feature available but unused for 30+ days); adoption correlation with health score and renewal likelihood.
- **Use case:** Feature adoption heatmap shows LLM monitoring at only 12% adoption despite being available to all Business and Enterprise tenants. Product team uses this to: (1) improve the feature's discoverability, (2) create enablement content, (3) have CSMs demo it in QBRs.
- **Governance:** adoption data anonymized for product analytics. Per-tenant adoption shared with CSM only. Adoption reports drive quarterly product roadmap prioritization.

### A7.4 Time-to-Value Tracking 🟡
- **Sub-features:** per-tenant milestones (signup → first DB connected → first alert fired → first compliance report → first custom policy → SSO configured → SIEM integrated); median time per milestone across all tenants; benchmark against cohort; bottleneck identification (which milestone takes longest); onboarding velocity trend (improving/declining); comparison by region, plan, industry.
- **Use case:** Time-to-value report shows: median first-DB-connected is 0.8 days (good), but median first-compliance-report is 3.4 days (slow). Investigation reveals: the compliance wizard has a confusing framework selection step. Product team simplifies it; next cohort's median drops to 1.8 days.
- **Governance:** milestone timestamps auto-captured. Benchmarks updated monthly. Tenants exceeding 2× median on any milestone → auto-trigger onboarding assistance.

### A7.5 Expansion Signals 🟡
- **Sub-features:** auto-detected expansion opportunities (approaching plan limits, adding databases rapidly, requesting features not in current plan, high engagement with premium features in trial); signal types (upsell: plan upgrade; cross-sell: new module; expansion: more DBs/users); signal → assigned account manager notification; signal tracking (acted on / resulted in expansion / declined).
- **Use case:** "Pacific Health Partners added 12 databases this quarter, now at 95 of 100 Business plan limit. They've been demoing inline blocking (Enterprise feature) in sandbox. Signal: upsell to Enterprise." Auto-notification to account manager with context.
- **Governance:** signals auto-generated, never fabricated. Account managers must act on signals within 7 days (or dismiss with reason). Signal-to-expansion conversion rate tracked as a team KPI.

---

## Appendix — Admin RBAC Matrix

| Role | Tenants | Billing | Infra | Security | Content | Support |
|---|---|---|---|---|---|---|
| **Platform Ops** | create, suspend, migrate | view | full | view audit | push updates | impersonate |
| **Engineering** | view | — | full, deploy | break-glass | full | view |
| **Support Tier 1** | view | — | view | — | — | view health |
| **Support Tier 2** | view config | — | view | — | — | impersonate |
| **Finance/Billing** | view | full | — | — | — | — |
| **Security** | view | view | view | full | — | review impersonation |
| **Customer Success** | view health | view usage | — | — | — | view health, comms |
| **Product** | view | — | — | — | full | — |

---

*Living document. Update as features are built and requirements evolve.*
