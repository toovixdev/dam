// ─────────────────────────────────────────────────────────────────────────────
// Compliance control catalog — canonical controls with a cross-framework crosswalk.
//
// Each entry is ONE canonical control (a query over the ClickHouse events plane) that
// maps to one OR MORE regulatory citations via `mappings[]`. This is the "one control
// satisfies many regulations" model (IBM Guardium's crosswalk): a single sealed,
// attestable evidence run can count toward every framework the control is mapped to.
//
// Backward compatibility: `framework` / `control` / `controlName` are derived from the
// FIRST mapping (the primary citation) so existing consumers keep working. The pack +
// matrix endpoints resolve membership + citation via mappings (frameworksOf / controlFor).
//
// Every `where(...)` returns a ClickHouse boolean expression over the `events` columns
// (see dev/dam/clickhouse/init.sql): operation, principal, schema_name, table_name,
// row_count, tags[], anomaly_score, event_class, timestamp, client_ip, sql_text.
//
// kind:  'activity' — an evidence log the reviewer confirms was reviewed (PCI 10.6 style).
//        'exception' — rows are already the concerning subset; each is a finding to clear.
// ─────────────────────────────────────────────────────────────────────────────

// Sensitivity tags an object carries when classification marks it personal / regulated.
const SENSITIVE = ['pii', 'pci', 'phi', 'aadhaar', 'pan', 'gstin', 'ssn', 'dob'];
const PERSONAL = ['pii', 'aadhaar', 'pan', 'ssn', 'dob', 'email', 'name', 'address', 'phone'];
const PHI = ['phi'];                         // ePHI (HIPAA §164) / special-category health (GDPR Art.9)
const CARDHOLDER = ['pci', 'pan'];           // cardholder data (PCI-DSS)
const SHARED_ACCOUNTS = ['root', 'admin', 'sa', 'postgres', 'system', 'mysql'];

const chList = (arr) => '[' + arr.map((t) => `'${t}'`).join(',') + ']';
const sensAny = `hasAny(tags, ${chList(SENSITIVE)})`;
const personalAny = `hasAny(tags, ${chList(PERSONAL)})`;
const phiAny = `hasAny(tags, ${chList(PHI)})`;
const chdAny = `hasAny(tags, ${chList(CARDHOLDER)})`;
const sharedAcct = `lower(principal) IN (${SHARED_ACCOUNTS.map((a) => `'${a}'`).join(',')})`;

// m(framework, control, controlName) — one citation in a control's crosswalk.
const m = (framework, control, controlName) => ({ framework, control, controlName });

const RAW = [
  // ── Cardholder data (PCI-DSS v4.0 — pci/pan-scoped) ─────────────────────────
  {
    id: 'pci-chd-access', kind: 'activity',
    name: 'Access to cardholder data',
    description: 'Every read of a cardholder-data (pci/pan) object — individual user access to CHD, object-scoped to cardholder data specifically.',
    where: () => `operation = 'SELECT' AND ${chdAny}`,
    mappings: [m('PCI-DSS', 'PCI 10.2.1.1', 'Individual access to cardholder data')],
  },
  {
    id: 'pci-chd-modification', kind: 'activity',
    name: 'Modification of cardholder data',
    description: 'INSERT/UPDATE/DELETE against cardholder-data objects — the change record for CHD integrity review.',
    where: () => `operation IN ('INSERT','UPDATE','DELETE') AND ${chdAny}`,
    mappings: [m('PCI-DSS', 'PCI 10.2.2', 'Modification of cardholder data')],
  },
  {
    id: 'pci-credential-changes', kind: 'activity',
    name: 'Credential & privilege changes',
    description: 'GRANT/REVOKE and identity statements (ALTER USER, SET PASSWORD, IDENTIFIED BY) — changes to identification and authentication credentials.',
    where: () => `operation IN ('GRANT') OR sql_text ILIKE '%alter user%' OR sql_text ILIKE '%identified by%' OR sql_text ILIKE '%set password%'`,
    mappings: [m('PCI-DSS', 'PCI 10.2.1.5', 'Changes to authentication credentials')],
  },

  // ── ePHI / special-category (HIPAA §164 — phi-scoped; also GDPR Art.9) ───────
  {
    id: 'hipaa-ephi-access', kind: 'activity',
    name: 'Access to ePHI / special-category data',
    description: 'Every read of a PHI-classified object — HIPAA audit-controls evidence (§164.312(b)) and, for GDPR, access to special-category (health) data warranting heightened protection (Art.9).',
    where: () => `operation = 'SELECT' AND ${phiAny}`,
    mappings: [m('HIPAA', 'HIPAA §164.312(b)', 'Audit controls — access to ePHI'), m('GDPR', 'GDPR Art.9', 'Special-category data access')],
  },
  {
    id: 'hipaa-ephi-modification', kind: 'activity',
    name: 'Modifications to ePHI (HIPAA integrity)',
    description: 'INSERT/UPDATE/DELETE against PHI-classified objects — integrity evidence that ePHI was not improperly altered or destroyed.',
    where: () => `operation IN ('INSERT','UPDATE','DELETE') AND ${phiAny}`,
    mappings: [m('HIPAA', 'HIPAA §164.312(c)(1)', 'Integrity — alteration / destruction of ePHI')],
  },
  {
    id: 'hipaa-ephi-bulk-export', kind: 'exception',
    name: 'Bulk ePHI extraction',
    description: 'Reads of PHI objects returning 10,000+ rows — the mass-export signature reviewed against the minimum-necessary standard.',
    where: () => `operation = 'SELECT' AND ${phiAny} AND row_count >= 10000`,
    mappings: [m('HIPAA', 'HIPAA §164.308(a)(1)(ii)(D)', 'Bulk ePHI extraction (minimum necessary)')],
  },
  {
    id: 'hipaa-ephi-after-hours', kind: 'exception',
    name: 'After-hours access to ePHI',
    description: 'Access to PHI objects outside 07:00–20:00 UTC — surfaced for the information-system-activity review.',
    where: () => `${phiAny} AND (toHour(timestamp) < 7 OR toHour(timestamp) >= 20)`,
    mappings: [m('HIPAA', 'HIPAA §164.308(a)(1)(ii)(D)', 'Off-hours access to ePHI')],
  },
  {
    id: 'hipaa-ephi-high-risk', kind: 'exception',
    name: 'High-risk activity touching ePHI',
    description: 'Statements scored anomaly ≥ 70 that touched PHI-classified objects — the ePHI high-risk review queue.',
    where: () => `anomaly_score >= 70 AND ${phiAny}`,
    mappings: [m('HIPAA', 'HIPAA §164.308(a)(1)(ii)(D)', 'Anomalous ePHI activity review')],
  },
  {
    id: 'hipaa-access-management', kind: 'activity',
    name: 'Access authorization changes on ePHI (DDL / GRANT)',
    description: 'Schema and privilege changes (DDL, GRANT/REVOKE) against ePHI-classified objects — access to ePHI is granted, modified, and reviewed under authorization. Object-scoped: a GRANT on a non-PHI object is not a HIPAA event.',
    where: () => `operation IN ('DDL','GRANT') AND ${phiAny}`,
    mappings: [m('HIPAA', 'HIPAA §164.308(a)(4)', 'Access authorization & management')],
  },

  // ── Personal data (GDPR — personalAny-scoped) ───────────────────────────────
  {
    id: 'personal-data-access', kind: 'activity',
    name: 'Access to personal data (GDPR)',
    description: 'Reads of objects tagged as personal data — the processing record for GDPR Article 30 accountability.',
    where: () => `operation = 'SELECT' AND ${personalAny}`,
    mappings: [m('GDPR', 'GDPR Art.30', 'Records of processing (personal data)'), m('ISO 27001', 'ISO A.18.1.4', 'Privacy and protection of PII')],
  },
  {
    id: 'gdpr-personal-modification', kind: 'activity',
    name: 'Modifications to personal data (GDPR)',
    description: 'INSERT/UPDATE/DELETE against personal-data objects — accuracy (Art.5(1)(d)) and records-of-processing (Art.30) evidence for changes to personal data.',
    where: () => `operation IN ('INSERT','UPDATE','DELETE') AND ${personalAny}`,
    mappings: [m('GDPR', 'GDPR Art.5(1)(d) / Art.30', 'Modification of personal data')],
  },
  {
    id: 'gdpr-bulk-personal-export', kind: 'exception',
    name: 'Bulk personal-data extraction (GDPR)',
    description: 'Reads of personal-data objects returning 10,000+ rows — the data-minimisation (Art.5(1)(c)) exception and a personal-data-breach (Art.33) indicator.',
    where: () => `operation = 'SELECT' AND ${personalAny} AND row_count >= 10000`,
    mappings: [m('GDPR', 'GDPR Art.33 / Art.5(1)(c)', 'Bulk personal-data extraction')],
  },
  {
    id: 'gdpr-after-hours-personal', kind: 'exception',
    name: 'After-hours access to personal data (GDPR)',
    description: 'Access to personal-data objects outside 07:00–20:00 UTC — reviewed under the security-of-processing (Art.32) obligation for anomalous access.',
    where: () => `${personalAny} AND (toHour(timestamp) < 7 OR toHour(timestamp) >= 20)`,
    mappings: [m('GDPR', 'GDPR Art.32', 'Off-hours access to personal data')],
  },

  // ── Broad sensitive-data controls (all SENSITIVE tags) ──────────────────────
  {
    id: 'sensitive-object-access', kind: 'activity',
    name: 'Access to sensitive objects',
    description: 'All reads of objects classified PII/PCI/PHI — establishes who touched regulated data and when.',
    where: () => `operation = 'SELECT' AND ${sensAny}`,
    mappings: [m('PCI-DSS', 'PCI 10.2.1', 'Access to cardholder / sensitive data'), m('ISO 27001', 'ISO A.12.4.1', 'Event logging')],
  },
  {
    id: 'mass-sensitive-read', kind: 'exception',
    name: 'Mass sensitive-data extraction',
    description: 'Reads of sensitive objects returning 10,000+ rows — the signature of bulk export / mass data access.',
    where: () => `operation = 'SELECT' AND ${sensAny} AND row_count >= 10000`,
    mappings: [m('PCI-DSS', 'PCI 10.2.1', 'Bulk sensitive-data extraction')],
  },
  {
    id: 'after-hours-sensitive', kind: 'exception',
    name: 'After-hours access to sensitive data',
    description: 'Access to regulated objects outside 07:00–20:00 UTC — reviewed for unauthorized or anomalous activity.',
    where: () => `${sensAny} AND (toHour(timestamp) < 7 OR toHour(timestamp) >= 20)`,
    mappings: [m('PCI-DSS', 'PCI 10.2.4', 'Off-hours access to sensitive data')],
  },
  {
    id: 'sensitive-data-modification', kind: 'activity',
    name: 'Modifications to sensitive data',
    description: 'INSERT/UPDATE/DELETE against classified objects — integrity evidence for financially-relevant / regulated data.',
    where: () => `operation IN ('INSERT','UPDATE','DELETE') AND ${sensAny}`,
    mappings: [m('SOX', 'SOX 802 / PCI 10.2.2', 'Modification of sensitive data')],
  },

  // ── Cross-framework subject / operation controls (one control → many regs) ──
  {
    id: 'shared-account-activity', kind: 'exception',
    name: 'Shared / generic-account activity',
    description: 'Activity from shared or generic accounts (root/admin/sa/postgres/system/mysql) — a unique-user-identification violation and the record of actions by individuals with administrative access. One control satisfying PCI, HIPAA and SOX access requirements.',
    where: () => `${sharedAcct}`,
    mappings: [
      m('PCI-DSS', 'PCI 10.2.1.2 / 8.2.1', 'Administrative actions & unique-ID enforcement'),
      m('HIPAA', 'HIPAA §164.312(a)(2)(i)', 'Unique user identification'),
      m('SOX', 'SOX 404 / ITGC Access', 'Privileged / administrative activity'),
      m('ISO 27001', 'ISO A.9.2.3', 'Management of privileged access rights'),
    ],
  },
  {
    id: 'authentication-activity', kind: 'activity',
    name: 'Authentication & session activity',
    description: 'LOGIN/LOGOUT and auth-class events — the account-usage record for authentication review across PCI and HIPAA.',
    where: () => `(operation IN ('LOGIN','LOGOUT') OR event_class = 'auth')`,
    mappings: [
      m('PCI-DSS', 'PCI 10.2.5', 'Authentication & session activity'),
      m('HIPAA', 'HIPAA §164.312(d)', 'Person or entity authentication'),
      m('ISO 27001', 'ISO A.12.4.1', 'Event logging (authentication)'),
    ],
  },
  {
    id: 'auth-anomaly', kind: 'exception',
    name: 'Invalid / anomalous authentication',
    description: 'Authentication events scored anomalous (≥ 50) — the invalid-access-attempt / log-in-monitoring queue (no explicit auth-failure flag is captured yet, so anomaly score is the signal). Satisfies PCI invalid-access and HIPAA log-in monitoring.',
    where: () => `(operation IN ('LOGIN','LOGOUT') OR event_class = 'auth') AND anomaly_score >= 50`,
    mappings: [
      m('PCI-DSS', 'PCI 10.2.1.4', 'Invalid logical access attempts'),
      m('HIPAA', 'HIPAA §164.308(a)(5)(ii)(C)', 'Log-in monitoring'),
      m('ISO 27001', 'ISO A.9.4.2', 'Secure log-on procedures'),
    ],
  },
  {
    id: 'ddl-changes', kind: 'activity',
    name: 'System-level object changes (DDL)',
    description: 'All DDL (CREATE/ALTER/DROP) — creation and deletion of system-level objects (PCI 10.2.1.7) and the ITGC change-management record auditors reconcile against approved tickets (SOX §404).',
    where: () => `operation = 'DDL'`,
    mappings: [
      m('PCI-DSS', 'PCI 10.2.1.7', 'Creation / deletion of system objects'),
      m('SOX', 'SOX 404 / ITGC Change Mgmt', 'Change management — schema changes'),
    ],
  },
  {
    id: 'privilege-grants', kind: 'activity',
    name: 'Privilege grants & revocations',
    description: 'GRANT/REVOKE of database privileges — the access-provisioning record for least-privilege (PCI Req 7) and segregation-of-duties review (SOX §404).',
    where: () => `operation IN ('GRANT')`,
    mappings: [
      m('PCI-DSS', 'PCI 7.2', 'Least-privilege / access provisioning'),
      m('SOX', 'SOX 404 / ITGC Access', 'Access provisioning changes'),
      m('ISO 27001', 'ISO A.9.2.5', 'Review of user access rights'),
    ],
  },
  {
    id: 'ddl-privilege-changes', kind: 'activity',
    name: 'Schema & privilege changes (DDL / GRANT)',
    description: 'Every DDL and GRANT/REVOKE captured — the combined change record auditors reconcile against approved change tickets.',
    where: () => `operation IN ('DDL','GRANT')`,
    mappings: [
      m('SOX', 'SOX 404 / ITGC', 'Schema & privilege changes'),
      m('PCI-DSS', 'PCI 10.2.7', 'Schema & privilege changes'),
    ],
  },
  {
    id: 'data-deletion', kind: 'activity',
    name: 'Data deletion events',
    description: 'All DELETE operations — GDPR erasure (right-to-be-forgotten) evidence (Art.17) and SOX destructive-change review.',
    where: () => `operation = 'DELETE'`,
    mappings: [
      m('GDPR', 'GDPR Art.17', 'Data deletion / right to erasure'),
      m('SOX', 'SOX 404 / ITGC', 'Destructive data changes'),
    ],
  },
  {
    id: 'high-risk-activity', kind: 'exception',
    name: 'High-risk (anomalous) activity',
    description: 'Statements scored anomaly ≥ 70 by the detection engine — the daily high-risk review queue.',
    where: () => `anomaly_score >= 70`,
    mappings: [m('PCI-DSS', 'PCI 10.6', 'Review of high-risk activity'), m('ISO 27001', 'ISO A.16.1.4', 'Assessment of information security events')],
  },

  // ── SOX segregation of duties & change-window controls ──────────────────────
  {
    id: 'sox-direct-data-change', kind: 'exception',
    name: 'Direct data changes by privileged accounts (SOX SoD)',
    description: 'INSERT/UPDATE/DELETE performed by administrative/generic accounts — back-end changes that bypass the application, the classic unapproved-direct-change red flag for SOX segregation of duties.',
    where: () => `operation IN ('INSERT','UPDATE','DELETE') AND ${sharedAcct}`,
    mappings: [m('SOX', 'SOX 404 / SoD', 'Direct back-end data changes')],
  },
  {
    id: 'sox-off-hours-change', kind: 'exception',
    name: 'After-hours changes (DML / DDL / GRANT)',
    description: 'Data or schema changes outside 07:00–20:00 UTC — anomalous change activity reviewed under SOX §404 change-management controls.',
    where: () => `operation IN ('INSERT','UPDATE','DELETE','DDL','GRANT') AND (toHour(timestamp) < 7 OR toHour(timestamp) >= 20)`,
    mappings: [m('SOX', 'SOX 404 / ITGC', 'Off-hours change activity')],
  },
];

// Derive the backward-compatible primary fields from the first mapping.
const CATALOG = RAW.map((c) => ({
  ...c,
  framework: c.mappings[0].framework,
  control: c.mappings[0].control,
  controlName: c.mappings[0].controlName,
}));

const catalogById = (id) => CATALOG.find((c) => c.id === id) || null;
const frameworksOf = (c) => [...new Set((c.mappings || [{ framework: c.framework }]).map((x) => x.framework))];
const mappingFor = (c, framework) => (c.mappings || []).find((x) => x.framework === framework) || { framework, control: c.control, controlName: c.controlName };
const controlFor = (c, framework) => mappingFor(c, framework).control;
const controlNameFor = (c, framework) => mappingFor(c, framework).controlName;
// Resolve a loose key ('pci', 'pci-dss', 'iso27001') to the catalog framework name a control maps to.
// Punctuation/space-insensitive so 'iso27001' matches 'ISO 27001' and 'pci' matches 'PCI-DSS'.
const _fwNorm = (s) => String(s).replace(/[^a-z0-9]/gi, '').toUpperCase();
const frameworkForKey = (c, key) => frameworksOf(c).find((f) => _fwNorm(f).startsWith(_fwNorm(key))) || null;

module.exports = { CATALOG, catalogById, SENSITIVE, PERSONAL, frameworksOf, controlFor, controlNameFor, frameworkForKey };
