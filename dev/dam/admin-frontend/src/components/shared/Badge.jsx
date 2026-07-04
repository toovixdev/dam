const SEVERITY_CLS = { critical: 'sev-critical', high: 'sev-high', medium: 'sev-medium', low: '', red: 'sev-critical', amber: 'sev-high' };
const STATUS_CLS = { active: 'status-green', online: 'status-green', monitored: 'status-green', enabled: 'status-green', fulfilled: 'status-green', open: 'sev-high', invited: 'status-gray', offline: 'sev-critical', disabled: 'status-gray', pending: 'status-gray' };

export function SeverityBadge({ severity }) {
  return <span className={`badge ${SEVERITY_CLS[severity] || ''}`}>{severity}</span>;
}

export function StatusBadge({ status }) {
  return <span className={`badge ${STATUS_CLS[status] || ''}`}>{status}</span>;
}

export function TagBadge({ tag, color }) {
  const cls = { ssn: 'sev-critical', aadhaar: 'sev-critical', phi: 'sev-critical', gdpr: 'sev-critical', pci: 'sev-high', pii: 'badge-ind', sin: 'badge-ind' };
  return <span className={`badge ${cls[tag] || color || ''}`}>{tag}</span>;
}
