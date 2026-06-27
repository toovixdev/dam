# TooVix DAM — Super Admin Application Knowledge Base

> **Purpose:** Feature specification for the internal Super Admin console that manages the TooVix DAM platform — tenants, infrastructure, billing, content, security, and customer success.
> **Audience:** Platform operations, engineering, customer support, finance, customer success.
> **Companion:** [DAM-Knowledge-Base.md](../DAM-Knowledge-Base.md) — the core product KB.

---

## 1. Tenant Lifecycle Management

### 1.1 Create Tenant `[must-have]`
- **Sales-led for v1** — ops creates tenant on behalf of sales; self-serve later.
- **Inputs:** org name, workspace slug, plan tier, region, primary admin email, compliance frameworks, industry.
- **Provisioning pipeline:** control-plane record (Postgres + RLS) → ClickHouse database → Kafka/Event Hub topics → KMS keys → compliance pack loading → welcome email.
- **Estimated time:** < 60 seconds automated.

### 1.2 Suspend Tenant `[must-have]`
- **Triggers:** non-payment (auto after grace period), abuse detection, customer request, legal hold.
- **Effect:** agents stop ingesting, UI shows read-only banner, API returns 403 on writes, data retained per contract.
- **Reversible:** ops can unsuspend with approval workflow.

### 1.3 Offboard Tenant `[must-have]`
- **Grace period:** configurable (default 30 days) — tenant sees countdown, data export available.
- **Post-grace:** ClickHouse DB dropped, Kafka topics deleted, KMS keys scheduled for destruction, Postgres records soft-deleted.
- **Legal hold override:** blocks offboarding until hold is released.
- **Data export:** signed archive (Parquet + config JSON) available during grace period.

### 1.4 Migrate Tenant `[must-have]`
- **Between clusters:** move a tenant's ClickHouse data to a different cluster within the same region (capacity balancing).
- **Between regions:** move a tenant to a different data-plane region (regulatory change, customer request). Requires downtime window.
- **Steps:** pause ingest → replicate data → switch routing → verify → resume ingest → cleanup source.

### 1.5 Clone Tenant Configuration `[should-have]`
- Clone policies, rules, classification rules, integration configs from one tenant to another.
- Use case: enterprise customer with multiple business units wanting identical DAM config.

### 1.6 Tenant Feature Flags `[must-have]`
- Enable/disable features per tenant: LLM monitoring, inline blocking, DSAR module, VA scanner.
- Staged rollout: beta → early-access → GA per tenant.
- Integrates with plan tier (Business plan doesn't get Enterprise features).

### 1.7 Tenant Configuration Drift Detection `[should-have]`
- Alert when a tenant's config deviates from expected baseline (MFA disabled, retention below compliance minimum, BYOK key expired).
- Configurable baseline per plan tier.

### 1.8 Tenant Resource Quotas `[must-have]`
- Per-tenant limits: max events/day, max databases, max agents, max storage, max API calls.
- Enforced at ingest gateway + API gateway.
- Soft limit (warning) vs hard limit (reject).

---

## 2. Customer Support

### 2.1 Tenant Impersonation `[must-have]`
- **Purpose:** troubleshoot customer-reported issues by seeing their console as they see it.
- **Controls:** mandatory justification text, time-limited (max 2 hours), auto-revoke, full session recording, post-access review by security team.
- **Audit:** every action taken during impersonation logged with `impersonated_by` field.
- **RBAC:** only designated support engineers with break-glass approval.

### 2.2 Tenant Health Dashboard `[should-have]`
- Single-pane per-tenant view: ingest lag, agent uptime, alert delivery rate, parser error rate, coverage gaps, last event per DB.
- "Is this tenant healthy?" — green/amber/red score.
- Used by support before responding to a ticket.

### 2.3 Job Re-run `[must-have]`
- Manually re-trigger failed async jobs: classification scan, VA scan, tenant provisioning, policy deployment, data export.
- Shows job history with logs, error details, duration.

### 2.4 Account Management `[must-have]`
- Reset customer admin password (generates temp password + MFA reset).
- Unlock locked accounts (after failed login attempts).
- Force session termination for a tenant's users.
- Disable/enable specific user accounts within a tenant.

### 2.5 Runbook Automation `[should-have]`
- Pre-built runbooks for common incidents: agent offline, ClickHouse partition full, outbox stuck, ingest lag spike.
- One-click execute with parameter input.
- Execution log with audit trail.

### 2.6 Customer Communication Log `[should-have]`
- Track support interactions, escalations, RCA documents per tenant.
- Links to ITSM tickets (ServiceNow/Jira).

### 2.7 Tenant Data Export `[must-have]`
- Export all tenant data on request or legal hold: audit events, configs, policies, classification rules.
- Signed Parquet archive with hash-chain verification.
- Available during offboarding grace period.

---

## 3. Platform Operations

### 3.1 Infrastructure Health `[must-have]`
- Per-region dashboard: control plane status, data plane status, ingest lag, events/s, disk usage, Kafka consumer lag.
- Component-level status: each microservice with version, replicas, CPU, memory, health.
- Alerting on threshold breaches.

### 3.2 Noisy Neighbor Detection `[must-have]`
- Real-time view: which tenants are consuming disproportionate CPU, memory, disk I/O, Kafka throughput.
- Auto-throttle option: temporarily rate-limit a noisy tenant to protect others.
- Historical trends: "Tenant X's resource consumption grew 300% this week."

### 3.3 Canary Deployments `[should-have]`
- Roll new platform version to 5-10% of tenants first.
- Monitor error rates, latency, parser failures for the canary cohort.
- Progressive rollout: canary → 25% → 50% → 100%.
- Automated rollback if p99 latency exceeds threshold or error rate spikes.

### 3.4 Capacity Planning `[should-have]`
- Forecast ClickHouse disk, Kafka partitions, compute needs based on tenant growth trends.
- "At current growth, IN-Mumbai cluster needs expansion by August."
- Alerts when utilization crosses planning thresholds (70%, 85%, 95%).

### 3.5 Maintenance Window Scheduler `[should-have]`
- Schedule region-level or cluster-level maintenance.
- Customer notification templates (email + in-app banner).
- Track customer acknowledgments.

### 3.6 Incident Management `[should-have]`
- Platform-level incident tracker: declare → assign owner → timeline → RCA → close.
- Severity levels: P1 (platform down), P2 (region degraded), P3 (single tenant affected), P4 (cosmetic).
- Feeds into platform audit log and SOC 2 evidence.

### 3.7 Disaster Recovery `[must-have]`
- Initiate DR procedures per region: failover to DR cluster, switch DNS, verify data integrity.
- DR test scheduler: run DR drills quarterly with results tracking.
- Recovery time objective (RTO) and recovery point objective (RPO) tracking.

---

## 4. Commercial / Billing

### 4.1 Billing & Plans `[must-have]`
- **Plan tiers:** Starter (free trial, 14 days, 5 DBs), Business (per-DB/month, unlimited, SSO), Enterprise (custom, BYOK, on-prem, SLA).
- **Usage metering:** events processed, databases monitored, storage consumed, agents deployed, API calls, scans run.
- **Invoice generation:** monthly, auto-generated from metering data.
- **Overages:** soft notification at 80% → hard cap or overage billing at 100%.

### 4.2 Credits & Adjustments `[must-have]`
- Apply credits for outages, goodwill, promotional discounts.
- Manual billing overrides with mandatory justification.
- Adjustment audit trail.

### 4.3 Trial Conversion Tracking `[should-have]`
- Pipeline: trial started → first DB connected → first alert fired → compliance report generated → converted / churned.
- Conversion funnel with drop-off points.
- Auto-trigger: if trial tenant hasn't connected a DB by day 3, notify CSM.

### 4.4 Contract Management `[should-have]`
- Store signed MSAs, DPAs, SLA agreements, BAAs (HIPAA) per tenant.
- Track contract expiry, renewal dates, auto-renewal terms.
- Link compliance obligations to tenant config requirements.

### 4.5 Revenue by Region `[must-have]`
- MRR/ARR breakdown by region, plan tier, industry.
- Growth trends, churn rate, expansion revenue.

---

## 5. Product Configuration

### 5.1 Content Pack Management `[must-have]`
- **Classifier library:** manage global PII detectors (SSN, Aadhaar, PAN, NHS, SIN, credit card, etc.). Version, enable/disable, set regional defaults.
- **VA test library:** manage 6000+ vulnerability assessment tests (CIS, DISA-STIG, PCI-DSS, weak passwords). Version, map to compliance frameworks.
- **Default policy library:** rules that ship to every new tenant. Version, test before deployment.
- **Threat intelligence feeds:** MISP, commercial feeds, CERT advisories. Manage sources, refresh intervals, IOC types.

### 5.2 Content Pack Versioning & Rollback `[must-have]`
- Every content update = a signed, versioned pack.
- Rollback to previous version if new pack causes false positives.
- Air-gapped tenants receive packs as offline bundles.

### 5.3 Per-Region Content Overrides `[must-have]`
- India-region tenants auto-get Aadhaar/PAN/GSTIN/IFSC classifiers enabled.
- EU-region tenants auto-get GDPR-specific rules enabled.
- US tenants auto-get SSN/HIPAA detectors.
- Admin can override per tenant.

### 5.4 Agent Version Management `[must-have]`
- Track which agent versions are deployed across the fleet.
- Compatibility matrix: agent version × DB engine version × OS.
- Schedule global rollout: v2.3 → v2.4 across all tenants with canary.
- Block incompatible upgrades automatically.

### 5.5 A/B Testing for Detection Rules `[should-have]`
- Test new rule version against old on same traffic stream.
- Compare: false positive rate, alert volume, detection coverage.
- Promote winner to production.

---

## 6. Compliance & Security (Vendor's Own Posture)

### 6.1 Platform Audit Log `[must-have]`
- Every vendor-side action logged: tenant access, config changes, impersonation sessions, billing adjustments.
- Immutable, hash-chained (same standard as the product itself).
- Searchable by actor, action, tenant, time range.

### 6.2 Break-Glass Access `[must-have]`
- Emergency access to production tenant data.
- **Controls:** mandatory justification, manager approval, time-limited (max 2 hours), auto-revoke, full session recording.
- Post-access review by security team within 24 hours.

### 6.3 Vendor Employee Access Reviews `[must-have]`
- Quarterly recertification: "Does this ops engineer still need production access?"
- Auto-revoke if not recertified within window.
- Segregation of duties: support can't approve their own break-glass.

### 6.4 SOC 2 Evidence Collection `[should-have]`
- Auto-generate evidence for TooVix's own SOC 2 / ISO 27001 audits.
- Access logs, change logs, incident response records, vendor access reviews.
- Evidence export as PDF/CSV bundle for auditors.

### 6.5 Data Sovereignty Enforcement `[should-have]`
- Hard rules: "Tenant X's data MUST stay in IN-Mumbai."
- Alert if any cross-region replication, backup, or data movement is attempted.
- Audit trail for proof of compliance.
- Per-tenant data residency report.

### 6.6 Security Event Monitoring `[must-have]`
- Who logged into the admin console, from where, when.
- Failed login attempts, unusual access patterns.
- Alerts on: new device, new IP, off-hours access, multiple tenant access in short window.

---

## 7. Customer Success

### 7.1 Account Health Scoring `[should-have]`
- Composite score per tenant: usage trends, alert acknowledgment rate, coverage %, support ticket volume, time since last login.
- **Green:** healthy, engaged. **Amber:** declining usage or gaps. **Red:** churn risk.
- Auto-notify CSM on score changes.

### 7.2 Renewal Pipeline `[should-have]`
- Track upcoming renewals: 90/60/30 day alerts.
- Renewal likelihood based on health score + usage trends.
- Link to contract terms and pricing history.

### 7.3 Feature Adoption Tracking `[should-have]`
- Which features each tenant uses: alert rules, VA scans, compliance reports, LLM monitoring, DSAR, masking, blocking mode.
- Heatmap across all tenants: "80% use alert rules, only 12% use LLM monitoring."
- Drives product prioritization and CSM conversations.

### 7.4 Time-to-Value Tracking `[should-have]`
- Per tenant: days from signup to first DB, first alert, first compliance report, first policy customized.
- Benchmark against cohort averages.
- Identify bottlenecks in onboarding.

### 7.5 Expansion Signals `[should-have]`
- "Nordic Insurance added 12 databases this quarter but is on Business plan with 100 DB limit."
- "GovData India has 156 DBs but no LLM monitoring — upsell opportunity."
- Auto-trigger notifications to account manager.

---

## Screen Inventory

### Must-Have Screens (v1)
| Screen | Status | Description |
|---|---|---|
| Platform Dashboard | built | KPIs, events chart, top tenants, platform alerts |
| Tenants | built | Tenant list, create/suspend/offboard actions |
| Billing & Plans | built | MRR, plan tiers, revenue, billing events |
| Infrastructure Health | built | Region health, component status |
| Tenant Impersonation | **to build** | Impersonate into tenant with audit controls |
| Platform Audit Log | **to build** | All vendor-side actions, searchable |
| Break-Glass Access | **to build** | Emergency access with approval workflow |
| Content Pack Management | **to build** | Classifiers, VA tests, policies, threat intel |
| Feature Flags | **to build** | Per-tenant feature toggles |
| Noisy Neighbor Detection | **to build** | Resource consumption per tenant |
| Agent Version Management | **to build** | Fleet versions, compatibility, rollout |
| Tenant Resource Quotas | **to build** | Per-tenant limits, enforcement |

### Should-Have Screens (v2)
| Screen | Status | Description |
|---|---|---|
| Tenant Health Dashboard | **to build** | Single-pane support view per tenant |
| Canary Deployments | **to build** | Progressive rollout management |
| Capacity Planning | **to build** | Growth forecasting, expansion alerts |
| Runbook Automation | **to build** | Pre-built incident runbooks |
| Trial Conversion | **to build** | Funnel tracking, conversion pipeline |
| Data Sovereignty | **to build** | Region enforcement, compliance proof |
| Account Health & Success | **to build** | Health scores, renewal, adoption |
| Tenant Overview (advanced) | built | Usage vs limits, config summary |
| SSO & SCIM Config | built | SSO connections, group mapping |
| KMS & BYOK | built | Key management, rotation, BYOK |

---

*Living document. Update as features are built and new requirements emerge.*
