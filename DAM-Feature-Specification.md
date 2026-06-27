# DAM Platform — Detailed Feature Specification

> Companion to [DAM-Knowledge-Base.md](DAM-Knowledge-Base.md). Expands every feature in the master catalogue into **sub-features**, **use cases**, and **rules** (detection rules use the engine-neutral `condition_jsonb` DSL from KB §10.3; governance features state the enforced rule).
>
> **Tags:** `[R]` RFP · `[C]` core architecture · `[G#]` competitive addition · Phase: 🟢 GA · 🟡 fast-follow · 🔵 post-GA · ⚪ watch.
> **Rule DSL note:** detection rules are structured JSON (never raw SQL); `action_type` uses the canonical vocabulary (READ/WRITE/DELETE/DDL/GRANT/LOGIN/ADMIN) so one rule fires across Oracle, SQL Server, MySQL/MariaDB, PostgreSQL, MongoDB, and Db2.

---

## Category 1 — Discovery & Asset Inventory

### F1.1 Database Auto-Discovery `[R][C]` 🟢
- **Sub-features:** network protocol fingerprinting (engine-specific ports); cloud API enumeration (Azure SQL, RDS, Cloud SQL, OCI, Atlas); manual registration; candidate dedupe & reconciliation; promote-to-monitored review queue; scheduled re-scan.
- **Use case:** A bank runs a discovery scan over `10.20.0.0/16`; the platform finds 3 unregistered MySQL instances and 1 rogue MongoDB, flags them as "unmonitored — sensitive ports open," and queues them for admin approval.
- **Rules:**
  - *Discovery rule:* `scan_cidr ∈ {ranges}` every N hours → fingerprint → if `engine detected AND db_instance_id NOT IN registry` → create candidate.
  - *Alert rule:* `{ "event":"unregistered_db_found", "severity":"high", "action":["alert","ticket"] }`.

### F1.2 Central Asset Registry `[C]` 🟢
- **Sub-features:** one record per DB across engines/clouds; engine + version + edition; `engine_metadata` JSONB (RAC nodes, AGs, replica sets); deployment type (managed/IaaS/on-prem); cloud + region + resource ID; topology (cluster/replica) via `parent_instance_id`; environment (prod/staging/dev/dr); owner/business-unit; monitoring status.
- **Use case:** Admin filters the inventory to "Oracle · prod · PCI-scope" and sees 42 instances with live coverage status.
- **Rule:** *Governance:* every monitored DB MUST have `owner_email`, `environment`, and `compliance_scope` set before `monitoring_status='active'`.

### F1.3 Database Grouping & Tagging `[C]` 🟢
- **Sub-features:** logical groups (Production, PCI-Scope, EU-PII); nested hierarchies; many-to-many membership; compliance-scope tags (pci/sox/hipaa/gdpr/dpdpa/rbi/itar); policy targeting by group.
- **Use case:** Tag all 120 cardholder DBs as `PCI-Scope`; one policy now applies to the whole group.
- **Rule:** *Policy scope:* `{ "scope_type":"compliance_tag", "scope_value":"pci" }`.

### F1.4 Coverage Monitoring `[C]` 🟢
- **Sub-features:** per-DB capture-mode tracking (network/host/puller/push); last-event timestamp; gap detection; agent heartbeat; parser-error rate; ingest-lag; recommendations.
- **Use case:** SQL Server X stops sending events; after 6h the platform raises "coverage gap — monitoring blind spot."
- **Rule:** `{ "metric":"last_event_age_minutes", "gte":360 } → { "severity":"high", "action":["alert","ticket"], "message":"No events from {db} in 6h" }`.

### F1.5 Agentless Cloud Data Discovery (DSPM) `[G5]` 🟡
- **Sub-features:** scan cloud accounts (AWS/Azure/GCP/SaaS) without agents; find shadow/orphan/legacy stores; map to compliance frameworks; risk-rank by sensitivity + exposure.
- **Use case:** Discovery finds an unmanaged S3 bucket + an orphaned RDS snapshot containing PII outside the monitored set.
- **Rule:** `{ "data_store":"discovered", "contains_sensitive":true, "monitored":false } → severity by sensitivity × public_exposure`.

### F1.6 Unstructured / File Discovery `[G18]` 🔵
- **Sub-features:** NAS, SharePoint, OneDrive, S3, file shares; file-type + content classification; entitlement on files; activity monitoring on file access.
- **Use case:** Find spreadsheets with Aadhaar numbers on a shared drive.
- **Rule:** `{ "file_content_match":"aadhaar", "share":"public" } → alert + recommend restrict`.

---

## Category 2 — Data Classification

### F2.1 Sensitive-Data Discovery `[R][C]` 🟢
- **Sub-features:** schema discovery; pattern/regex detection; content sampling; built-in detectors (email, name, DOB, address, CC, SSN); India PII (Aadhaar, PAN, GSTIN, IFSC); confidence scoring; row/document-count estimates.
- **Use case:** Classifier samples `CUSTOMERS.AADHAAR_NO`, matches the Verhoeff validator at 0.98 confidence, tags the column `aadhaar,pii`.
- **Rules:**
  - `{ "rule_name":"Aadhaar", "target":"sample_data", "pattern":"\\d{4}\\s?\\d{4}\\s?\\d{4}", "validator":"verhoeff_12", "threshold":0.7, "assigns_tags":["aadhaar","pii"] }`
  - `{ "rule_name":"PAN", "target":"column_name", "pattern":"[A-Z]{5}\\d{4}[A-Z]", "validator":"pan_format", "assigns_tags":["pan","pii"] }`

### F2.2 Content Scanning (Regex + Validators) `[R][C]` 🟢
- **Sub-features:** named validators (Luhn, Verhoeff, PAN, GSTIN, IFSC); per-engine scoping; priority ordering; enable/disable toggles; threshold % of samples.
- **Use case:** Credit-card columns validated by Luhn to cut false positives from random 16-digit IDs.
- **Rule:** `{ "rule_name":"CreditCard", "target":"sample_data", "pattern":"\\d{13,16}", "validator":"luhn", "threshold":0.8, "assigns_tags":["pci"] }`.

### F2.3 Customer-Editable Rule Library `[C]` 🟢
- **Sub-features:** create/clone/version rules; `applies_to_engines`; test-against-sample; import/export rule packs.
- **Use case:** A telco adds a custom "SIM/IMSI" detector scoped to its billing DBs.
- **Rule:** *Governance:* new classification rules run in "shadow" (tag-with-marker) for 7 days before enforcing.

### F2.4 Object & Principal Classification `[C]` 🟢
- **Sub-features:** object tags (pii/pci/hipaa/phi/aadhaar/crown_jewel) + data categories; principal tags (human/app/service/dba/system, privileged, dormant); three-part object naming across engines; source-of-truth replicated to data plane.
- **Use case:** Classifying `CUSTOMERS` as PII enriches every future event touching it, across all engines, at ingest.
- **Rule:** *Sync:* any classification change → single transaction (`object_classifications` + `control_plane_audit` + `outbox_events`) → data plane in seconds.

### F2.5 ML Classifiers + Exact Data Match `[G30]` 🟡
- **Sub-features:** trainable ML classifiers; exact-match against known sensitive datasets; fewer false positives than regex; semantic detection.
- **Use case:** EDM matches against the actual customer master list so only real customer names tag as PII.
- **Rule:** `{ "classifier":"ml_pii", "confidence":{"gte":0.9} } OR { "edm_dataset":"customer_master", "match":true }`.

---

## Category 3 — Activity Monitoring & Capture

### F3.1 Full Activity Capture (App + Privileged) `[R][C]` 🟢
- **Sub-features:** every statement from application and privileged/DBA accounts; who/what/when/where/which-query; session correlation; canonical event schema.
- **Use case:** A DBA using `sqlplus` as `SYS` reads a payroll table at 2am — captured with full context despite being a privileged local session.
- **Rule:** *Capture policy:* `{ "policy_type":"capture", "scope":{"all":true} }` — capture 100% of privileged-account activity regardless of other filters.

### F3.2 Multi-Mode Capture `[C]` 🟢
- **Sub-features:** Network agent (libpcap, engine protocol decode); Host agent (eBPF/ETW for local/IPC); Audit-log puller; Audit-push consumer; combine modes per engine.
- **Use case:** Self-managed Oracle on a VM uses Network + Host agents; managed RDS MySQL uses Audit-Push + puller as backup.
- **Rule:** *Coverage rule:* a DB tagged `crown_jewel` MUST have ≥2 capture modes active or raise a coverage warning.

### F3.3 Full Audited-Event Detail `[R][C]` 🟢
- **Sub-features:** date/time, raw + normalized SQL, bind parameters, end-user, source IP/port, source program, OS user, destination instance, schema/objects, action type/subtype, rows affected, duration, return code, bytes returned, geo.
- **Use case:** An investigator pulls the exact `SELECT` text, bind values, and 50,000-row result size for a flagged exfil event.
- **Rule:** *Retention:* full `query_text` stored (truncated 16KB); events immutable once written (hash-chained).

### F3.4 Stored-Procedure Execution Tracking `[R]` 🟢
- **Sub-features:** who executed which procedure, when, with what params, which tables it touched.
- **Use case:** Track every execution of `sp_payout` including the operator and downstream tables.
- **Rule:** `{ "action_subtype":{"any_of":["EXECUTE","CALL"]}, "object_type":"procedure", "object_name":"sp_payout" } → log + tag`.

### F3.5 DDL / Change-Control Tracking `[R]` 🟢
- **Sub-features:** capture CREATE/ALTER/DROP; before/after schema; correlate to change tickets; unauthorized-change alerts.
- **Use case:** An unapproved `ALTER TABLE accounts DROP COLUMN audit_flag` outside a change window fires instantly.
- **Rule:** `{ "action_type":"DDL", "outside_change_window":true } → { "severity":"high", "action":["alert","ticket"] }`.

### F3.6 No-Reboot Agent Lifecycle `[R]` 🟢
- **Sub-features:** install/upgrade/remove without OS or DB restart; rolling upgrades; enrollment token → cert swap; versioned config + safe rollback.
- **Use case:** Roll agents from v2.3→v2.4 across 300 hosts with zero DB downtime.
- **Rule:** *Governance:* agent upgrade batches capped at X% of fleet; auto-pause rollout if post-upgrade error rate > threshold.

### F3.7 "No Native Audit" Toggle `[R][D13]` 🟢
- **Sub-features:** per-customer / per-DB switch to disable native-audit dependency; fall back to network+host capture; documented PaaS exception (managed DBs need native audit).
- **Use case:** A customer policy forbids native auditing on self-managed Oracle → platform uses only agents; for their Azure SQL it documents the native-audit exception.
- **Rule:** *Config rule:* `if capture_mode='no_native' AND deployment='managed' → warn "coverage limited; native audit required for PaaS"`.

### F3.8 eBPF / In-Memory Container Sensors `[G22][C]` 🟢
- **Sub-features:** capture inside K8s/OpenShift without breaking container purity; eBPF on Linux, ETW on Windows; captures shared-memory/Unix-socket local connections.
- **Use case:** Monitor a PostgreSQL pod's local socket traffic that never hits the network.
- **Rule:** *Deploy:* host-agent DaemonSet auto-attaches to nodes labelled `db-host=true`.

### F3.9 Agentless Managed-DBaaS Capture `[G21][C]` 🟢
- **Sub-features:** consume AWS Database Activity Streams, Azure SQL Audit→Event Hubs, Cloud SQL→Pub/Sub, Atlas webhooks; serverless push consumer; normalize to canonical schema.
- **Use case:** Monitor Aurora PostgreSQL where no host agent can run.
- **Rule:** *Routing:* push-consumer subscribes to the tenant's audit channel; events flow into the same per-tenant ingress topic.

### F3.10 Before/After Value Capture `[G15]` 🟢
- **Sub-features:** record old + new values on UPDATE/DELETE for sensitive objects; configurable per object/column; forensic diff view.
- **Use case:** Prove what a fraudulent `UPDATE accounts SET balance=…` changed the value from and to.
- **Rule:** `{ "action_type":"WRITE", "object_sensitivity_tags":{"any_of":["pci","crown_jewel"]} } → capture_before_after=true`.

### F3.11 Mainframe DAM (Db2 z/OS, IMS) `[G20]` 🔵
- **Sub-features:** SMF-record ingestion; kernel-level capture; z/OS principal mapping.
- **Use case:** A large bank monitors core-banking Db2 on z/OS in the same console as its distributed DBs.
- **Rule:** Same canonical rules apply; capture via SMF collector instead of wire decode.

---

## Category 4 — Threat Detection & Behavioral Analytics (UEBA)

### F4.1 Continuous Learning `[R][C]` 🟢
- **Sub-features:** incremental baselines updated with every event (no batch retraining); per (query, principal, instance) statistics; exponential weighted profiles (α 0.1–0.3).
- **Use case:** A new ETL job's normal volume is learned automatically within a day; later spikes stand out.
- **Rule:** *Baseline:* only `return_code=0` events form baselines; drift > 50% week-over-week triggers review.

### F4.2 Outlier / Abnormal-Behavior Detection `[R][C]` 🟢
- **Sub-features (the 8 RFP patterns):** unauthorized table access; specific-data selection; off-hours access; first-time table access; never-before-selected data; exceptional error volume; unusual volume of normal activity; unusual time of normal activity.
- **Use case:** A teller account that never touches the `SALARIES` table suddenly reads 10k rows at midnight → multiple flags stack.
- **Rules:**
  - *Off-hours:* `{ "principal_user_type":"human", "unusual_access_time":true } → flag`.
  - *First-time object:* `{ "first_time_object_access":true, "object_sensitivity_tags":{"any_of":["pii","pci"]} } → flag`.
  - *Volume:* `{ "rows_z_score":{"gte":3} } → flag "volume_spike"`.

### F4.3 Per-Event Anomaly Scoring `[C]` 🟢
- **Sub-features:** z-score vs baseline (rows, duration); stacked anomaly flags; score 0–100; threshold→alert.
- **Use case:** Event scores 92/100 (extreme rows + sensitive + off-hours) → critical alert.
- **Rule:** `anomaly_score = f(z_rows, z_duration, sensitivity, time, peer_deviation)`; `score ≥ rule.threshold → anomaly_alert`.

### F4.4 Entity Behavioral Profiles + Risk Score `[C]` 🟢
- **Sub-features:** per-principal profile (volume, temporal, query, geo); rolling risk score; risk-event ledger (why score rose); dormancy detection.
- **Use case:** An analyst clicks a user's risk score and sees the exact events that drove it up.
- **Rule:** `{ "reason":"sensitive_access", "risk_delta":+8 }` appended to `entity_risk_events`; Redis holds live score.

### F4.5 Peer-Group Clustering `[C]` 🟢
- **Sub-features:** weekly unsupervised clustering (e.g., "etl_services", "dba_humans"); membership fit score; group-change-as-signal.
- **Use case:** A service account drifts out of the "etl_services" cluster → flagged as behavioral outlier.
- **Rule:** `{ "peer_group_changed":true } OR { "deviation_from_peers":{"gte":3} } → alert`.

### F4.6 Per-Database Risk Score `[R][C]` 🟢
- **Sub-features:** composite of alerts + VA findings + discovery + data sensitivity; trend over time; fleet ranking.
- **Use case:** Exec dashboard ranks the riskiest 10 databases this quarter.
- **Rule:** `db_risk = w1·open_alerts + w2·va_severity + w3·sensitive_objects + w4·anomaly_rate`.

### F4.7 Auto-Profiling / Noise Filtering `[R][C]` 🟢
- **Sub-features:** learn known-good app patterns; suppress routine traffic; allow-list normal query templates; reduce alert fatigue.
- **Use case:** A high-frequency health-check query is auto-profiled as benign and excluded from anomaly scoring.
- **Rule:** `{ "query_hash":"…", "occurrence_count":{"gte":N}, "all_benign":true } → suppress`.

### F4.8 Threat-Intel Enrichment `[G32][C]` 🟡
- **Sub-features:** inbound MISP/commercial/CERT feeds; enrich events with known-bad IPs/indicators; auto-raise severity on match.
- **Use case:** A login from an IP on a CERT-In advisory list is auto-escalated.
- **Rule:** `{ "client_ip":{"in_threat_feed":true} } → severity="critical"`.

---

## Category 5 — Alerting, Blocking & Response

### F5.1 Real-Time Alerting `[R][C]` 🟢
- **Sub-features:** sub-second alert generation; severity (low/med/high/critical); dedup + grouping; assignment to analyst; lifecycle states.
- **Use case:** Mass-PII read triggers a Slack + PagerDuty alert within ~1–3s of the query.
- **Rule:** `{ "object_sensitivity_tags":{"any_of":["pii","pci","aadhaar"]}, "action_type":"READ", "rows_affected":{"gte":10000}, "principal_user_type":"human" } → { "severity":"high", "action":["alert"] }`.

### F5.2 Monitoring Mode + Blocking Mode `[R]` 🟢
- **Sub-features:** passive monitor (alerts only); active block (proxy-enforced); per-policy mode; gradual rollout (monitor→block).
- **Use case:** A new block rule runs in monitor mode for a week, then is promoted to block once false positives are zero.
- **Rule:** `policy_type ∈ {capture, alert, block}`; promotion gated on review.

### F5.3 Inline DAM Proxy Gateway `[R][D3]` 🟢
- **Sub-features:** in-path proxy/listener; real-time block/allow/substitute; per-engine proxy; connection-string redirect; latency budget.
- **Use case:** A `DELETE` against `accounts` without a WHERE clause is blocked at the gateway before reaching the DB.
- **Rule:** `{ "action_type":"DELETE", "no_where_clause":true, "object":"accounts" } → action:"block"`.

### F5.4 Session Kill / Quarantine `[R][C]` 🟢
- **Sub-features:** terminate offending session; quarantine principal (auto-action with release workflow); blacklist/whitelist; keep full activity logged.
- **Use case:** A compromised app account exfiltrating data is auto-quarantined; its sessions are killed and queued for analyst release.
- **Rule:** `{ "anomaly_score":{"gte":90}, "action_type":"READ", "sensitive":true } → action:["kill_session","quarantine"]`.

### F5.5 Fail-Open / Fail-Closed `[D14]` 🟢
- **Sub-features:** default fail-open (monitor) on proxy outage; per-policy fail-closed for crown-jewel DBs; health-driven switchover.
- **Use case:** Proxy node dies → normal DBs keep serving (fail-open); the cardholder DB blocks new sessions (fail-closed).
- **Rule:** `if proxy_unavailable: db.fail_mode=='closed' ? deny_new_sessions : pass_through`.

### F5.6 Virtual Patching `[R]` 🟢
- **Sub-features:** block known-exploit query patterns; shield unpatched/legacy DBs; content-updated signature packs; covers SQLi/buffer-overflow patterns until a real patch lands.
- **Use case:** A CVE in Oracle 19c is virtually patched by blocking its exploit signature within hours, before the quarterly patch window.
- **Rule:** `{ "matches_exploit_signature":"CVE-2025-XXXX" } → action:"block"`.

### F5.7 Alert Lifecycle & Triage `[C]` 🟢
- **Sub-features:** open/acknowledged/resolved/suppressed/false_positive; assignment; resolution notes; SLA timers; link to triggering event + rule.
- **Use case:** SOC analyst acknowledges, investigates the linked session, marks false-positive with a note → feeds tuning.
- **Rule:** *SLA:* critical alerts must be acknowledged within X min or auto-escalate.

### F5.8 Multi-Channel Dispatch `[C]` 🟢
- **Sub-features:** Slack, Teams, email, SMS, PagerDuty, ServiceNow, Splunk HEC, generic webhooks; per-channel formatting; rate limit; circuit breaker; suppression; dead-letter.
- **Use case:** Criticals → PagerDuty + Slack; weekly digest → email to execs.
- **Rule:** `{ "severity":"critical" } → channels:["pagerduty","slack"]; { "severity":"low" } → channels:["digest"]`.

### F5.9 SQL-Grammar Allowlist / Trusted Path `[G23]` 🟡
- **Sub-features:** train approved SQL templates; approved connection paths (IP/user/app); block deviations (positive security model); anomaly on unknown grammar.
- **Use case:** Only the app server IP + the app account may run the payment procedure; anything else is blocked.
- **Rule:** `{ "query_hash":{"not_in":"approved_set"} } OR { "client_ip":{"not_in":"trusted_path"} } → action:"block"`.

---

## Category 6 — Vulnerability Assessment & Posture

### F6.1 VA Test Library (6000+) `[R][C]` 🟢
- **Sub-features:** CIS benchmarks, DISA-STIG, PCI-DSS checks, weak/default passwords, missing patches, excessive privileges, vulnerable configs; per-engine drivers; scheduled scans (CronJob/serverless/timer).
- **Use case:** Weekly scan of all Oracle DBs flags 3 with default `DBSNMP` passwords and 5 missing the latest CPU.
- **Rule:** *Scan schedule:* `{ "scope":"engine:oracle", "tests":"cis+pci", "cron":"weekly" }`; finding severity maps to CVSS.

### F6.2 Known-Vulnerability Attack Detection `[R]` 🟢
- **Sub-features:** detect exploit attempts against known CVEs; correlate with VA findings; link to virtual-patch rules.
- **Use case:** An exploit attempt matches a CVE the DB is unpatched for → high-severity alert + auto virtual-patch suggestion.
- **Rule:** `{ "exploit_signature_match":true, "target_db_vulnerable":true } → severity:"critical"`.

### F6.3 Continuous Posture Scorecards `[G7]` 🟢
- **Sub-features:** ongoing config-posture grading (CIS/STIG/cloud); per-DB + fleet score; drift detection; remediation guidance; trend.
- **Use case:** A DB's hardening score drops from A to C after someone enables `xp_cmdshell` → posture alert.
- **Rule:** `{ "config_drift":"xp_cmdshell_enabled" } → posture_downgrade + alert`.

### F6.4 Findings Lifecycle & Compliance Mapping `[C]` 🟢
- **Sub-features:** finding states (open/accepted/remediated/false-positive); map findings to PCI/HIPAA/DPDPA controls; exception with expiry; remediation evidence.
- **Use case:** A finding is accepted with a documented compensating control and 90-day expiry for the auditor.
- **Rule:** *Governance:* accepted-risk exceptions auto-reopen at expiry.

---

## Category 7 — Data Protection (Masking / Tokenization / Encryption)

### F7.1 Dynamic Data Masking `[R][D12]` 🟢
- **Sub-features:** query-time masking by user/role/app; format-preserving options; partial/full/redact/hash; bypass for privileged-with-reason; enforced at proxy.
- **Use case:** A support agent sees `XXXX-XXXX-XXXX-1234`; the settlement service sees the full PAN.
- **Rule:** `{ "object_sensitivity_tags":{"any_of":["pci"]}, "principal_role":{"not_in":["settlement"]} } → mask("pan","last4")`.

### F7.2 Static Masking (Non-Prod) `[R][D12]` 🟢
- **Sub-features:** de-identify clones for dev/test; preserve referential integrity; deterministic masking; masking job audit.
- **Use case:** Prod→UAT refresh masks all PII while keeping joins valid across tables.
- **Rule:** `mask_dataset(prod→uat): pii→synthetic, preserve_fk=true`.

### F7.3 Encryption (At-Rest / In-Transit) + Per-Tenant KMS `[C]` 🟢
- **Sub-features:** TLS in transit; encryption at rest; per-tenant KMS keys; mTLS service-to-service.
- **Use case:** Each tenant's audit store is encrypted with its own key.
- **Rule:** *Policy:* no tenant data written unencrypted; key reference via `encryption_key_uri`.

### F7.4 BYOK across all KMS `[G16][D8]` 🟢
- **Sub-features:** Azure Key Vault, AWS KMS, GCP KMS, OCI Vault, HashiCorp Vault; key rotation; customer-held keys; provider-neutral URI.
- **Use case:** A BFSI customer holds its own keys in HashiCorp Vault; the platform never sees raw key material.
- **Rule:** *Governance:* signing/encryption operations call the customer KMS; raw keys never persisted in the platform.

### F7.5 Tokenization / Format-Preserving Encryption `[G14]` 🔵
- **Sub-features:** vaulted/vaultless tokenization; FPE; PCI scope reduction; reversible by authorized service.
- **Use case:** PANs replaced with tokens in analytics stores, de-tokenized only by the settlement service.
- **Rule:** `{ "object":"pan" } → tokenize(fpe); detokenize requires role:"settlement"`.

### F7.6 Proxy-Enforced Row/Column Security (ABAC) `[G12]` 🔵
- **Sub-features:** row-level + column-level policies applied inline; decoupled from native DB; attribute-based (role/region/clearance).
- **Use case:** EU analysts see only EU-region rows; column `salary` hidden from non-HR.
- **Rule:** `{ "object":"employees", "row_filter":"region = user.region", "column_hide":["salary"] if role≠HR }`.

---

## Category 8 — Access Governance & Identity

### F8.1 Privileged-User Discovery `[R][C]` 🟢
- **Sub-features:** auto-find privileged accounts/roles per DB; flag privileged + dormant; expected programs/IPs; owner mapping to human user.
- **Use case:** Discover 14 accounts with `DBA` role, 3 of them dormant for 90+ days.
- **Rule:** `{ "is_privileged":true, "is_dormant":true } → review + recommend disable`.

### F8.2 Entitlement Review / Recertification `[G11]` 🟢
- **Sub-features:** scheduled access-recertification campaigns; reviewer sign-off; excess/stale/dormant flags; revoke workflow; evidence trail.
- **Use case:** Quarterly campaign asks each DB owner to confirm or revoke their users' access.
- **Rule:** *Governance:* access not recertified within the window is auto-flagged for revocation.

### F8.3 Separation of Duties `[G13]` 🟢
- **Sub-features:** admins/DBAs cannot read or alter the audit stream; auditor role isolated; SoD policy checks; admin actions self-audited.
- **Use case:** A DBA cannot delete or edit audit records of their own activity.
- **Rule:** *Policy:* `role:dba ⇒ deny(audit.read, audit.write)`; conflicting role grants blocked.

### F8.4 Service-Account / Pooled-Connection Identity Resolution `[G9]` 🟡
- **Sub-features:** resolve the real end-user behind shared app/pool/BI service accounts; preserve connection pooling; identity enrichment on events.
- **Use case:** Activity via the shared `app_user` account is attributed to the actual logged-in employee.
- **Rule:** `{ "principal":"app_user", "resolve_via":"app_context|session_var|sso_token" } → event.real_user = resolved_identity`.

### F8.5 Just-in-Time Access + Approvals `[G10]` 🔵
- **Sub-features:** self-service access request; approval via portal or Slack; auto-expiring temp credentials; duration-scoped grants; revoke kills live session; fully logged.
- **Use case:** A dev requests 2h read access to prod; manager approves in Slack; access auto-expires.
- **Rule:** `grant(scope, ttl); on expiry → revoke + terminate_sessions; all steps → control_plane_audit`.

---

## Category 9 — Policy & Rules Engine

### F9.1 Custom Security Rules (Positive + Negative) `[R][C]` 🟢
- **Sub-features:** positive model (allow-list known-good) + negative model (block known-bad); JSON DSL (never raw SQL); severity; rule types (threshold/anomaly/pattern/first_time/privileged); actions (alert/email/webhook/block).
- **Use case:** Build a rule "only the payroll app from its server may read SALARIES; everything else alerts."
- **Rule:** `{ "object":"salaries", "allow":{"principal":"payroll_app","client_ip":"10.0.5.0/24"}, "else":"alert" }`.

### F9.2 Correlation Rules `[R]` 🟢
- **Sub-features:** multi-condition / multi-event correlation; sequence detection; time-window joins; combine signals into one incident.
- **Use case:** Failed logins + a successful login + bulk read from one IP within 10 min → one "credential compromise" incident.
- **Rule:** `sequence([failed_login×5, successful_login, bulk_read], same_ip, window:"10m") → incident`.

### F9.3 Granular Rule Targeting `[R][C]` 🟢
- **Sub-features:** scope by all/engine/db_group/db_instance/compliance_tag; object/principal/IP/program filters; rule priority; enable/disable.
- **Use case:** Apply a MongoDB-only auth rule just to Atlas clusters tagged `pii`.
- **Rule:** `{ "applies_to_engines":["mongodb"], "scope":{"compliance_tag":"pii"} }`.

### F9.4 Engine-Neutral Canonical Rules `[C]` 🟢
- **Sub-features:** one rule fires across all 6 engines via canonical actions; `action_subtype` preserved for forensics.
- **Use case:** "Bulk READ of PII" fires for an Oracle SELECT, a Mongo find(), or a Db2 SELECT identically.
- **Rule:** `{ "action_type":"READ", "object_sensitivity_tags":{"any_of":["pii"]}, "rows_affected":{"gte":10000} }`.

### F9.5 Rule Exceptions `[C]` 🟢
- **Sub-features:** carve-outs by principal/IP/program/sql_hash/db_instance; mandatory reason; optional expiry; auto-expire.
- **Use case:** Suppress a known nightly batch from the "bulk read" rule for 30 days.
- **Rule:** `{ "exception_type":"principal", "value":"etl_nightly", "reason":"approved batch", "expires_at":"…" }`.

### F9.6 Policy Versioning `[C]` 🟢
- **Sub-features:** immutable snapshot on every change; version number; change reason; who/when; point-in-time reconstruction.
- **Use case:** Auditor asks "what did the PCI policy look like on 3 April?" → exact snapshot returned.
- **Rule:** *Governance:* every policy write creates a `policy_versions` row in the same transaction.

### F9.7 Custom Log Messages w/ Placeholders `[R]` 🟢
- **Sub-features:** templated alert/log text; system-variable placeholders (`{username}`, `{db}`, `{rows}`, `{ip}`); per-rule formatting.
- **Use case:** "User {username} read {rows} PII rows from {db} at {time}" rendered into the alert.
- **Rule:** `template: "User {username} on {db} ran {action_subtype} affecting {rows} rows"`.

### F9.8 Auto-Updates (Rules / Content) `[R]` 🟢
- **Sub-features:** signed rule/VA/threat-intel content packs; scheduled auto-update; staged rollout; rollback.
- **Use case:** New VA tests and virtual-patch signatures download weekly without manual import.
- **Rule:** *Governance:* content packs signature-verified before apply; offline import for air-gapped sites.

---

## Category 10 — Compliance & Reporting

### F10.1 Pre-Built Compliance Packs `[R][C]` 🟢
- **Sub-features:** PCI-DSS, HIPAA, SOX, GDPR, **CERT-In**; control mappings; evidence collection; pass/fail status; scheduled generation.
- **Use case:** One-click PCI-DSS report shows who accessed cardholder data this quarter with control status.
- **Rule:** *Mapping:* `sensitive_access_mv(pci) → PCI-DSS Req 10`; gaps flagged as control failures.

### F10.2 India DPDPA + RBI Packs `[G29]` 🟢
- **Sub-features:** DPDPA control mappings (consent, data-principal rights, retention, breach reporting); RBI cyber-security framework; data-localization evidence; India PII coverage.
- **Use case:** A bank produces an RBI-aligned report proving Aadhaar access is monitored and localized in-country.
- **Rule:** *Mapping:* `dpdpa.retention ≤ configured; data_residency='india'` validated continuously; violation → finding.

### F10.3 Scheduled + On-Demand Reports `[R][C]` 🟢
- **Sub-features:** schedule (daily/weekly/monthly); on-demand; export (PDF/CSV/JSON); email distribution; parameterized scope; async export for large sets.
- **Use case:** Monthly compliance report auto-emailed to the compliance officer.
- **Rule:** `{ "report":"pci_access", "cron":"monthly", "deliver":["email:compliance@…"] }`.

### F10.4 DSAR Manager `[D10]` 🟢
- **Sub-features:** data-subject request intake (access/erasure/rectification/restrict); locate subject data via classification; fulfillment workflow; evidence + audit; SLA timers.
- **Use case:** A customer requests erasure under DPDPA; the platform locates their PII across DBs and tracks fulfillment.
- **Rule:** *Workflow:* `dsar(type, subject) → discover(subject_data) → approve → execute → evidence`; SLA per regulation.

### F10.5 Framework Scorecards (ISO/SOC2/NIST/FedRAMP) `[G31]` 🟡
- **Sub-features:** posture against multiple frameworks; control coverage %; gap list; one-click export.
- **Use case:** Security lead checks ISO 27001 control coverage before a certification audit.
- **Rule:** `score(framework) = covered_controls / total_controls`; gaps → remediation tasks.

### F10.6 Audit-Volume Insights / Selective Auditing `[G28]` 🟡
- **Sub-features:** analyze audit volume by DB/user/schema; identify noisy sources; tune capture to control cost; anomalous-audit-volume flag.
- **Use case:** One chatty app generates 60% of events; selective auditing trims it without losing security signal.
- **Rule:** `{ "audit_volume_share":{"gte":0.5}, "low_risk":true } → recommend filter`.

---

## Category 11 — AI / GenAI Data Security

### F11.1 LLM Activity Monitoring `[G1]` 🟡
- **Sub-features:** monitor prompts/responses to ChatGPT/Bedrock/Azure OpenAI/Claude; map which prompts trigger which DB queries; LLM as a monitored "engine"; immutable AI audit log.
- **Use case:** See that an internal copilot pulled 5k customer records to answer a prompt — and who asked.
- **Rule:** `{ "engine":"llm", "downstream_query.sensitivity":{"any_of":["pii"]} } → log + score`.

### F11.2 AI Firewall / Prompt Protection `[G2]` 🔵
- **Sub-features:** mask/redact PII in prompts before they reach the LLM; detect prompt injection / jailbreak; block sensitive-data egress to AI; policy per AI app.
- **Use case:** An employee pastes a customer list into ChatGPT; the gateway redacts the PII inline.
- **Rule:** `{ "destination":"external_llm", "prompt_contains_sensitive":true } → mask | block`.

### F11.3 Vector-DB & RAG Monitoring `[G3]` 🔵
- **Sub-features:** monitor vector stores (Qdrant/Milvus/pgvector); RAG-pipeline visibility; sensitive-data-in-embeddings detection.
- **Use case:** Detect that a RAG index ingested an un-redacted PII table.
- **Rule:** `{ "vector_store_ingest":true, "source_sensitivity":{"any_of":["pii"]} } → alert`.

### F11.4 Shadow-AI / AI-Asset Discovery `[G4]` ⚪
- **Sub-features:** inventory AI models/endpoints/agents in use; flag unauthorized AI tools touching data.
- **Use case:** Find an unsanctioned AI plugin querying production data.
- **Rule:** `{ "ai_endpoint":"unknown", "accesses_db":true } → flag`.

---

## Category 12 — Audit Trail & Tamper Evidence

### F12.1 Tamper-Proof Log Storage `[R][C]` 🟢
- **Sub-features:** append-only audit store; optional forward to 3rd-party; immutable archive; per-tenant isolation; all activity retained even when blocking.
- **Use case:** Even a successful attacker cannot alter the record of what they did.
- **Rule:** *Policy:* `audit_events` immutable post-write; deletes only via TTL/archival, never user-initiated.

### F12.2 Hash-Chain + Signed Checkpoints `[C]` 🟢
- **Sub-features:** BLAKE3 per-event chain (`prev_event_hash`→`event_hash`); monotonic `chain_sequence` per DB; hourly Merkle checkpoints signed by tenant KMS → immutable blob; range verification.
- **Use case:** An investigator proves a 30-day window is intact by verifying 720 signed checkpoints, not billions of rows.
- **Rule:** *Verification:* `verify(window) = recompute Merkle roots vs signed checkpoints`; mismatch → tamper alarm.

### F12.3 Immutable Archive (Dedup + Compression) `[G25][C]` 🟢
- **Sub-features:** long-term searchable archive; Parquet cold export; ZSTD compression; on-demand restore; WORM/immutable blob.
- **Use case:** Query 5-year-old access records for a legal hold within minutes via on-demand restore.
- **Rule:** *TTL:* hot 90d → cold Parquet; `sensitive_access` retained 7y; checkpoints indefinite.

### F12.4 Long-Term Retention `[C]` 🟢
- **Sub-features:** configurable hot/cold retention per tenant/plan; compliance-driven (7y default for sensitive access); legal hold.
- **Use case:** A regulated customer sets 7-year retention; another sets 1-year to control cost.
- **Rule:** `retention_hot_days`, `retention_cold_days` per tenant; legal-hold overrides TTL.

### F12.5 Control-Plane Self-Audit (DAM-lite) `[C]` 🟢
- **Sub-features:** capture every config action (policy change, role grant, alert ack, classification approval); actor + before/after; append-only; optional hash-chain.
- **Use case:** Prove who changed the PCI policy and when, for the auditor.
- **Rule:** *Governance:* every control-plane write appends to `control_plane_audit` in the same transaction.

---

## Category 13 — Integrations

### F13.1 SIEM (Bidirectional) `[R][D15]` 🟢
- **Sub-features:** Splunk + Microsoft Sentinel at GA (QRadar/Chronicle/Elastic fast-follow); CEF/syslog + HEC; bidirectional event flow; field mapping.
- **Use case:** DAM alerts correlate with endpoint telemetry in Sentinel; Sentinel enriches DAM context.
- **Rule:** `{ "severity":{"gte":"high"} } → forward(siem)`; ingestion-filtered (see F13.6).

### F13.2 SOAR `[R]` 🟢
- **Sub-features:** bi-directional ticket create/enrich/status-sync/auto-close; playbooks (lock user, block IP, open ticket); chained actions.
- **Use case:** A critical alert auto-opens a SOAR case, runs a "disable DB user" playbook, and closes on resolution.
- **Rule:** `{ "severity":"critical" } → soar.create_case + playbook("disable_user")`.

### F13.3 ITSM (ServiceNow first) `[R][D15]` 🟢
- **Sub-features:** ServiceNow at GA (Jira fast-follow); auto incident creation; bi-directional status sync; CMDB reconciliation; phased native ITSM later (D1).
- **Use case:** Coverage-gap alert opens a ServiceNow incident assigned to the DB owner.
- **Rule:** `{ "event":"coverage_gap" } → servicenow.incident(assignee=db.owner)`.

### F13.4 Identity / SSO `[R][D15]` 🟢
- **Sub-features:** Azure AD, Okta, LDAP/AD, Kerberos, RADIUS; SAML/OIDC; SCIM provisioning; group→role mapping; MFA.
- **Use case:** Enterprise users SSO via Azure AD; group `db-admins` maps to the `admin` role automatically.
- **Rule:** `{ "idp_group":"db-admins" } → assign_role("admin")`.

### F13.5 Low-Code / No-Code API Integration `[R]` 🟢
- **Sub-features:** REST/Web API; GUI-configured connectors (no coding); 2-way data exchange; multiple inbuilt auth methods; webhook in/out; lifecycle-stage hooks.
- **Use case:** An ops engineer wires a webhook to a CMDB via the GUI in minutes, no code.
- **Rule:** *Config:* connector defined declaratively; auth via stored secret reference.

### F13.6 SIEM Ingestion-Cost Optimization `[G24]` 🟡
- **Sub-features:** forward only filtered/scored subset (e.g., 5–30% of volume); per-severity routing; aggregate low-value events.
- **Use case:** Only scored/anomalous events go to Splunk, cutting ingest cost ~80%.
- **Rule:** `{ "anomaly_score":{"gte":50} OR "severity":{"gte":"medium"} } → siem; else → cheap_archive`.

---

## Category 14 — Platform, Deployment & Operations

### F14.1 Multi-Hosting (SaaS / Customer-Cloud / On-Prem) `[R][C]` 🟢
- **Sub-features:** multi-tenant SaaS; single-tenant customer cloud; on-prem K8s (OpenShift/Tanzu/k3s); air-gapped + offline licensing.
- **Use case:** A bank runs fully on-prem air-gapped; a startup uses SaaS — same product.
- **Rule:** *Build:* one codebase, provider interfaces select Event Hubs/Kafka, Key Vault/Vault, Blob/MinIO (D7).

### F14.2 Appliance + HA `[R]` 🟢
- **Sub-features:** physical or virtual appliance form factor; HA with no single point of failure; clustered gateways; auto-failover.
- **Use case:** A gateway node fails; traffic continues on its HA peer with no data loss.
- **Rule:** *Governance:* every production tier deployed N+1; health-check driven failover.

### F14.3 Multi-Cloud + India Region (Day 1) `[D5][D6]` 🟢
- **Sub-features:** launch on 2+ clouds; in-country India data plane; per-tenant region routing (`data_plane_region`); data residency enforcement.
- **Use case:** An Indian customer's data never leaves India; a global customer routes to its nearest region.
- **Rule:** `route(tenant) → tenant.data_plane_region`; residency='india' blocks cross-region replication.

### F14.4 Scale-Out by Licensing + Load Balancing `[R]` 🟢
- **Sub-features:** add capacity by adding licenses as DB count grows; load-balance across gateways/collectors; KEDA autoscaling; per-tenant rate limits.
- **Use case:** Onboarding 500 new DBs = add licenses; ingest auto-scales with volume.
- **Rule:** *Scaling:* KEDA scales ingest on topic lag; license check gates new DB registration.

### F14.5 Control / Data Plane Separation `[C]` 🟢
- **Sub-features:** control plane (PostgreSQL, shared + RLS); data plane (ClickHouse, one DB per tenant); independent scaling; blast-radius containment.
- **Use case:** An ingest spike on one tenant never affects another's config or query latency.
- **Rule:** *Isolation:* cross-tenant query physically impossible (per-tenant DB) + RLS on control plane.

### F14.6 IaC / GitOps Deployment `[G26][C]` 🟢
- **Sub-features:** Terraform provider/modules; Argo CD GitOps; versioned config; reproducible on-prem + multi-cloud installs.
- **Use case:** A customer deploys the whole on-prem stack from a Terraform plan.
- **Rule:** *Governance:* all infra changes via PR→GitOps; no manual drift.

### F14.7 Observability `[C]` 🟢
- **Sub-features:** Prometheus metrics; Grafana dashboards; OpenTelemetry traces; structured logs; customer-facing health dashboards.
- **Use case:** Ops sees ingest lag, parser errors, and agent health on one dashboard.
- **Rule:** *Alerting:* `ingest_lag > threshold OR parser_error_rate > x → ops page`.

### F14.8 Managed Service / MDR Option `[G27]` ⚪
- **Sub-features:** vendor-operated monitoring + scanning for customers without a SOC; managed tuning; co-managed alerts.
- **Use case:** A mid-market customer outsources DAM operations to the vendor.
- **Rule:** *Service:* tiered managed offering layered on the same platform.

---

## Category 15 — UI / UX & Channels

### F15.1 Web UI — Dual Theme `[D16][C]` 🟢
- **Sub-features:** dark + light (and additional themes) user-selectable; modern ops-focused IA; responsive; all personas; reuses the captured design system (Inter, token-based theming).
- **Use case:** SOC analysts use dark; compliance officers use light — same app.
- **Rule:** *Theme:* `html[data-theme]` token switch; persisted per user.

### F15.2 Core Screens `[C]` 🟢
- **Sub-features:** Dashboard; Database Inventory + Registration; Alert Triage / Active Defense; Quarantine; Classification; Policy/Rules; Compliance Center (+DPDPA/DSAR); Agents/Coverage; Reports; Settings.
- **Use case:** An analyst moves from dashboard → alert → linked session → quarantine in a few clicks.
- **Rule:** *RBAC:* each screen gated by permission (e.g., `policy.write`, `audit.events.read`).

### F15.3 API + Email Digests + Webhooks `[C]` 🟢
- **Sub-features:** REST API (automation); scheduled email digests (execs); outbound webhooks (real-time events).
- **Use case:** Exec gets a weekly email digest without logging in; automation pulls alerts via API.
- **Rule:** `{ "digest":"weekly", "audience":"exec" } → email summary`.

### F15.4 Mobile App `[D11][C]` 🟡
- **Sub-features:** critical alerts; alert acknowledgment; exec dashboards; approval workflows (incl. JIT/DSAR approvals).
- **Use case:** An on-call analyst acknowledges a critical alert from their phone at night.
- **Rule:** *Scope:* mobile limited to alerts/approvals/dashboards; deep config stays on web.

---

## Category 16 — Administration & Multi-Tenancy

### F16.1 RBAC + Scoped Roles `[R][C]` 🟢
- **Sub-features:** system + custom roles; permission catalog; scoped assignments (admin on prod, viewer on dev) without role explosion; grant expiry.
- **Use case:** A contractor is admin over one instance, read-only on the rest, expiring in 30 days.
- **Rule:** `{ "role":"admin", "scope_type":"db_instance", "scope_id":"…", "expires_at":"…" }`.

### F16.2 SSO / MFA / SCIM / API Keys `[C]` 🟢
- **Sub-features:** SAML/OIDC SSO; enforced MFA; SCIM auto-provision/deprovision; API keys (bcrypt-hashed, prefix display, scoped, expiring).
- **Use case:** A leaver is auto-deprovisioned via SCIM; their API keys revoke.
- **Rule:** `{ "scim_event":"deprovision" } → disable_user + revoke_keys`.

### F16.3 Tenant Isolation `[C]` 🟢
- **Sub-features:** per-tenant ClickHouse DB (data plane); RLS on shared PostgreSQL (control plane); per-tenant transport channels + KMS keys.
- **Use case:** Tenant A can never query Tenant B's events — physically impossible.
- **Rule:** *Policy:* `tenant_id = current_setting('app.current_tenant_id')` enforced on every control-plane table.

### F16.4 Usage Metering & Billing `[C]` 🟢
- **Sub-features:** daily pre-aggregated metrics (events, DBs, storage, alerts, scans); plan tiers; overage notifications; customer usage dashboards.
- **Use case:** A tenant sees it's at 80% of its plan's event quota.
- **Rule:** `{ "usage":{"gte":0.8×plan_limit} } → notify; { "gte":1.0 } → overage`.

### F16.5 Bulk Operations + Admin Audit `[R][C]` 🟢
- **Sub-features:** bulk DB onboarding; bulk policy/classification apply; delegated administration; full admin-action audit log.
- **Use case:** Onboard 200 databases from a CSV and apply the PCI policy group in one action.
- **Rule:** *Governance:* every bulk action recorded in `control_plane_audit` with item-level results.

---

## Appendix — Rule DSL Quick Reference

Detection rules (`condition_jsonb`) compose these primitives (compiled to safe streaming evaluation — never raw SQL):

| Field | Example | Meaning |
|---|---|---|
| `action_type` | `"READ"` | canonical verb (READ/WRITE/DELETE/DDL/GRANT/LOGIN/ADMIN) |
| `object_sensitivity_tags` | `{"any_of":["pii","pci"]}` | sensitivity match |
| `rows_affected` | `{"gte":10000}` | volume threshold |
| `rows_z_score` | `{"gte":3}` | deviation from baseline |
| `principal_user_type` | `"human"` | app/human/service/system/dba |
| `unusual_access_time` | `true` | off-hours vs time baseline |
| `first_time_object_access` | `true` | never-before access |
| `client_ip` | `{"not_in":"trusted_path"}` | network context |
| `window_minutes` / `sequence` | `"10m"` | correlation window |
| `exclude` | `{"principal_user_type":"service"}` | carve-out |
| `actions` | `["alert","block","kill_session","quarantine","webhook","email"]` | response |

**Cross-engine guarantee:** because the Parser normalizes every engine to this vocabulary, a single rule definition fires identically on Oracle, SQL Server, MySQL/MariaDB, PostgreSQL, MongoDB, and Db2 — authored once, enforced everywhere.



