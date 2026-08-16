// ─────────────────────────────────────────────────────────────────────────────
// Compliance report catalog — control-mapped evidence definitions.
//
// This is the missing "reporting depth" leg versus incumbents (IBM Guardium's
// Compliance Accelerators): a library of named reports, each mapped to a specific
// regulatory control requirement, each expressed as a query over the ClickHouse
// events plane. A run of any catalog entry produces a sealed, attestable evidence
// record (see the /api/compliance/catalog + /evidence endpoints in main.js).
//
// Every `where(...)` returns a ClickHouse boolean expression over the `events`
// columns (see dev/dam/clickhouse/init.sql). The runner adds the tenant_id and
// timestamp window, then snapshots the rows. Keep expressions to columns that
// actually exist: operation, principal, schema_name, table_name, row_count,
// tags[], anomaly_score, event_class, timestamp, client_ip, sql_text.
// ─────────────────────────────────────────────────────────────────────────────

// Sensitivity tags an object carries when classification marks it personal /
// regulated. Matches the tag vocabulary written by the classifier + policy engine.
const SENSITIVE = ['pii', 'pci', 'phi', 'aadhaar', 'pan', 'gstin', 'ssn', 'dob'];
const PERSONAL = ['pii', 'aadhaar', 'pan', 'ssn', 'dob', 'email', 'name', 'address', 'phone'];

// ePHI — electronic protected health information. HIPAA controls scope to the
// `phi` classification tag specifically (not all SENSITIVE), which is the correct
// mapping for the Security Rule's ePHI requirements.
const PHI = ['phi'];

// Generic / shared accounts — a unique-user-identification violation (HIPAA
// §164.312(a)(2)(i), PCI Req 8.2.1). Kept in sync with the posture model's sharedAcctEvents metric.
const SHARED_ACCOUNTS = ['root', 'admin', 'sa', 'postgres', 'system', 'mysql'];

// Cardholder data (CHD) — PCI-DSS controls scope to the cardholder-data tags specifically,
// not all sensitive data, so a PII/PHI read isn't miscounted as CHD access.
const CARDHOLDER = ['pci', 'pan'];

const chList = (arr) => '[' + arr.map((t) => `'${t}'`).join(',') + ']';
const sensAny = `hasAny(tags, ${chList(SENSITIVE)})`;
const personalAny = `hasAny(tags, ${chList(PERSONAL)})`;
const phiAny = `hasAny(tags, ${chList(PHI)})`;
const chdAny = `hasAny(tags, ${chList(CARDHOLDER)})`;
const sharedAcct = `lower(principal) IN (${SHARED_ACCOUNTS.map((a) => `'${a}'`).join(',')})`;

// kind:
//   'activity'  — an evidence log the reviewer confirms was reviewed (PCI 10.6 style).
//   'exception' — rows are already the concerning subset; each is a finding to clear.
const CATALOG = [
  {
    id: 'ddl-privilege-changes',
    framework: 'SOX',
    control: 'PCI 10.2.7 / SOX ITGC',
    controlName: 'Schema & privilege changes',
    name: 'Schema & privilege changes (DDL / GRANT)',
    description: 'Every DDL and GRANT/REVOKE captured — the change record auditors reconcile against approved change tickets.',
    kind: 'activity',
    where: () => `operation IN ('DDL','GRANT')`,
  },
  {
    id: 'sensitive-object-access',
    framework: 'PCI-DSS',
    control: 'PCI 10.2.1',
    controlName: 'Access to cardholder / sensitive data',
    name: 'Access to sensitive objects',
    description: 'All reads of objects classified PII/PCI/PHI — establishes who touched regulated data and when.',
    kind: 'activity',
    where: () => `operation = 'SELECT' AND ${sensAny}`,
  },
  {
    id: 'mass-sensitive-read',
    framework: 'PCI-DSS',
    control: 'PCI 10.2.1',
    controlName: 'Bulk sensitive-data extraction',
    name: 'Mass sensitive-data extraction',
    description: 'Reads of sensitive objects returning 10,000+ rows — the signature of bulk export / mass data access.',
    kind: 'exception',
    where: () => `operation = 'SELECT' AND ${sensAny} AND row_count >= 10000`,
  },
  {
    id: 'after-hours-sensitive',
    framework: 'PCI-DSS',
    control: 'PCI 10.2.4',
    controlName: 'Off-hours access to sensitive data',
    name: 'After-hours access to sensitive data',
    description: 'Access to regulated objects outside 07:00–20:00 UTC — reviewed for unauthorized or anomalous activity.',
    kind: 'exception',
    where: () => `${sensAny} AND (toHour(timestamp) < 7 OR toHour(timestamp) >= 20)`,
  },
  {
    id: 'sensitive-data-modification',
    framework: 'SOX',
    control: 'PCI 10.2.2 / SOX',
    controlName: 'Modification of sensitive data',
    name: 'Modifications to sensitive data',
    description: 'INSERT/UPDATE/DELETE against classified objects — integrity evidence for financially-relevant data.',
    kind: 'activity',
    where: () => `operation IN ('INSERT','UPDATE','DELETE') AND ${sensAny}`,
  },
  {
    id: 'authentication-activity',
    framework: 'PCI-DSS',
    control: 'PCI 10.2.5',
    controlName: 'Authentication & session activity',
    name: 'Database authentication activity',
    description: 'LOGIN/LOGOUT and auth-class events — the access record for account-usage review.',
    kind: 'activity',
    where: () => `(operation IN ('LOGIN','LOGOUT') OR event_class = 'auth')`,
  },
  {
    id: 'high-risk-activity',
    framework: 'PCI-DSS',
    control: 'PCI 10.6',
    controlName: 'Review of high-risk activity',
    name: 'High-risk (anomalous) activity',
    description: 'Statements scored anomaly ≥ 70 by the detection engine — the daily high-risk review queue.',
    kind: 'exception',
    where: () => `anomaly_score >= 70`,
  },
  {
    id: 'data-deletion',
    framework: 'GDPR',
    control: 'GDPR Art.17 / SOX',
    controlName: 'Data deletion / right to erasure',
    name: 'Data deletion events',
    description: 'All DELETE operations — supports erasure (right-to-be-forgotten) evidence and destructive-change review.',
    kind: 'activity',
    where: () => `operation = 'DELETE'`,
  },
  {
    id: 'personal-data-access',
    framework: 'GDPR',
    control: 'GDPR Art.30',
    controlName: 'Records of processing (personal data)',
    name: 'Access to personal data (GDPR)',
    description: 'Reads of objects tagged as personal data — the processing record for GDPR Article 30 accountability.',
    kind: 'activity',
    where: () => `operation = 'SELECT' AND ${personalAny}`,
  },

  // ── HIPAA Security Rule — ePHI activity evidence ────────────────────────────
  // Runnable evidence reports backing the HIPAA posture controls already surfaced
  // by complianceFrameworks() in main.js: audit controls §164.312(b), integrity
  // §164.312(c)(1), and information-system-activity review §164.308(a)(1)(ii)(D).
  // All ePHI-scoped via the `phi` tag so a health-data tenant gets HIPAA-specific
  // evidence, not the generic sensitive-data reports.
  {
    id: 'hipaa-ephi-access',
    framework: 'HIPAA',
    control: 'HIPAA §164.312(b)',
    controlName: 'Audit controls — access to ePHI',
    name: 'Access to ePHI (HIPAA audit controls)',
    description: 'Every read of an object classified PHI — the §164.312(b) audit-controls record of who accessed electronic protected health information and when.',
    kind: 'activity',
    where: () => `operation = 'SELECT' AND ${phiAny}`,
  },
  {
    id: 'hipaa-ephi-modification',
    framework: 'HIPAA',
    control: 'HIPAA §164.312(c)(1)',
    controlName: 'Integrity — alteration / destruction of ePHI',
    name: 'Modifications to ePHI (HIPAA integrity)',
    description: 'INSERT/UPDATE/DELETE against PHI-classified objects — integrity evidence that ePHI was not improperly altered or destroyed.',
    kind: 'activity',
    where: () => `operation IN ('INSERT','UPDATE','DELETE') AND ${phiAny}`,
  },
  {
    id: 'hipaa-ephi-bulk-export',
    framework: 'HIPAA',
    control: 'HIPAA §164.308(a)(1)(ii)(D)',
    controlName: 'Bulk ePHI extraction (minimum necessary)',
    name: 'Bulk ePHI extraction',
    description: 'Reads of PHI objects returning 10,000+ rows — the mass-export signature reviewed against the minimum-necessary standard.',
    kind: 'exception',
    where: () => `operation = 'SELECT' AND ${phiAny} AND row_count >= 10000`,
  },
  {
    id: 'hipaa-ephi-after-hours',
    framework: 'HIPAA',
    control: 'HIPAA §164.308(a)(1)(ii)(D)',
    controlName: 'Off-hours access to ePHI',
    name: 'After-hours access to ePHI',
    description: 'Access to PHI objects outside 07:00–20:00 UTC — surfaced for the information-system-activity review.',
    kind: 'exception',
    where: () => `${phiAny} AND (toHour(timestamp) < 7 OR toHour(timestamp) >= 20)`,
  },
  {
    id: 'hipaa-ephi-high-risk',
    framework: 'HIPAA',
    control: 'HIPAA §164.308(a)(1)(ii)(D)',
    controlName: 'Anomalous ePHI activity review',
    name: 'High-risk activity touching ePHI',
    description: 'Statements scored anomaly ≥ 70 that touched PHI-classified objects — the ePHI high-risk review queue.',
    kind: 'exception',
    where: () => `anomaly_score >= 70 AND ${phiAny}`,
  },
  {
    id: 'hipaa-auth-activity',
    framework: 'HIPAA',
    control: 'HIPAA §164.312(d)',
    controlName: 'Person or entity authentication',
    name: 'Authentication & session activity (HIPAA)',
    description: 'LOGIN/LOGOUT and auth-class events on systems holding ePHI — the account-usage record for §164.312(d) authentication review.',
    kind: 'activity',
    where: () => `(operation IN ('LOGIN','LOGOUT') OR event_class = 'auth')`,
  },
  {
    id: 'hipaa-access-management',
    framework: 'HIPAA',
    control: 'HIPAA §164.308(a)(4)',
    controlName: 'Access authorization & management',
    name: 'Access authorization changes on ePHI (DDL / GRANT)',
    description: 'Schema and privilege changes (DDL, GRANT/REVOKE) against ePHI-classified objects — the §164.308(a)(4) record that access to ePHI specifically is granted, modified, and reviewed under authorization. (Object-scoped: a GRANT on a non-PHI object is not a HIPAA event.)',
    kind: 'activity',
    where: () => `operation IN ('DDL','GRANT') AND ${phiAny}`,
  },
  {
    id: 'hipaa-login-monitoring',
    framework: 'HIPAA',
    control: 'HIPAA §164.308(a)(5)(ii)(C)',
    controlName: 'Log-in monitoring',
    name: 'Anomalous authentication activity',
    description: 'Authentication events scored anomalous (≥ 50) — the §164.308(a)(5)(ii)(C) log-in-monitoring queue for discrepancy review (no explicit auth-failure flag is captured, so anomaly score is the signal).',
    kind: 'exception',
    where: () => `(operation IN ('LOGIN','LOGOUT') OR event_class = 'auth') AND anomaly_score >= 50`,
  },
  {
    id: 'hipaa-shared-account',
    framework: 'HIPAA',
    control: 'HIPAA §164.312(a)(2)(i)',
    controlName: 'Unique user identification',
    name: 'Shared / generic-account activity',
    description: 'Activity from shared or generic accounts (root/admin/sa/postgres/system/mysql) — each row is a unique-user-identification violation to resolve under §164.312(a)(2)(i).',
    kind: 'exception',
    where: () => `${sharedAcct}`,
  },

  // ── PCI-DSS v4.0 — cardholder-data controls + the Req 10.2.1.x access breakdown ──────
  // CHD reads/writes scope to the `pci`/`pan` tags (not all sensitive data); the Req 8/10
  // access controls are subject/session-level. Deepens PCI from legacy 3.2.1 coverage to the
  // v4.0 sub-requirement granularity auditors expect.
  {
    id: 'pci-chd-access',
    framework: 'PCI-DSS',
    control: 'PCI 10.2.1.1',
    controlName: 'Individual access to cardholder data',
    name: 'Access to cardholder data (PCI)',
    description: 'Every read of a cardholder-data (pci/pan) object — the §10.2.1.1 record of individual user access to CHD. Object-scoped to cardholder data specifically.',
    kind: 'activity',
    where: () => `operation = 'SELECT' AND ${chdAny}`,
  },
  {
    id: 'pci-chd-modification',
    framework: 'PCI-DSS',
    control: 'PCI 10.2.2',
    controlName: 'Modification of cardholder data',
    name: 'Modifications to cardholder data (PCI)',
    description: 'INSERT/UPDATE/DELETE against cardholder-data objects — the change record for CHD integrity review.',
    kind: 'activity',
    where: () => `operation IN ('INSERT','UPDATE','DELETE') AND ${chdAny}`,
  },
  {
    id: 'pci-admin-actions',
    framework: 'PCI-DSS',
    control: 'PCI 10.2.1.2',
    controlName: 'Administrative / root actions',
    name: 'Administrative & root-account actions',
    description: 'Activity by administrative/generic accounts (root/admin/sa/postgres/system/mysql) — the §10.2.1.2 record of all actions taken by individuals with administrative access.',
    kind: 'activity',
    where: () => `${sharedAcct}`,
  },
  {
    id: 'pci-invalid-access',
    framework: 'PCI-DSS',
    control: 'PCI 10.2.1.4',
    controlName: 'Invalid logical access attempts',
    name: 'Invalid / anomalous access attempts',
    description: 'Authentication events scored anomalous (≥ 50) — the §10.2.1.4 invalid-access-attempt queue (no explicit auth-failure flag is captured, so anomaly score is the signal).',
    kind: 'exception',
    where: () => `(operation IN ('LOGIN','LOGOUT') OR event_class = 'auth') AND anomaly_score >= 50`,
  },
  {
    id: 'pci-credential-changes',
    framework: 'PCI-DSS',
    control: 'PCI 10.2.1.5',
    controlName: 'Changes to authentication credentials',
    name: 'Credential & privilege changes',
    description: 'GRANT/REVOKE and identity statements (ALTER USER, SET PASSWORD, IDENTIFIED BY) — the §10.2.1.5 record of changes to identification and authentication credentials.',
    kind: 'activity',
    where: () => `operation IN ('GRANT') OR sql_text ILIKE '%alter user%' OR sql_text ILIKE '%identified by%' OR sql_text ILIKE '%set password%'`,
  },
  {
    id: 'pci-system-object-changes',
    framework: 'PCI-DSS',
    control: 'PCI 10.2.1.7',
    controlName: 'Creation / deletion of system objects',
    name: 'System-level object changes (DDL)',
    description: 'All DDL (CREATE/ALTER/DROP) — the §10.2.1.7 record of creation and deletion of system-level objects.',
    kind: 'activity',
    where: () => `operation = 'DDL'`,
  },
];

const catalogById = (id) => CATALOG.find((c) => c.id === id) || null;

module.exports = { CATALOG, catalogById, SENSITIVE, PERSONAL };
