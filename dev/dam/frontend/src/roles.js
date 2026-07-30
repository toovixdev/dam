// Canonical role → allowed-screens map. Shared by the Sidebar (what to show) and the
// route guard (what to allow). Values match the internal roles stored on users.
export const ROLE_ALLOW = {
  tenant_admin: '*',
  soc_analyst:  ['dashboard', 'active-defense', 'databases', 'discovery', 'agents', 'capture-modes', 'alerts', 'behavior', 'policies', 'quarantine', 'classification', 'vulnerability', 'llm', 'support'],
  db_owner:     ['dashboard', 'databases', 'agents', 'capture-modes', 'alerts', 'behavior', 'classification', 'vulnerability', 'access', 'reports', 'change-log', 'attestations', 'support'],
  compliance:   ['dashboard', 'databases', 'classification', 'vulnerability', 'masking', 'access', 'compliance', 'dsar', 'audit', 'change-log', 'attestations', 'reports', 'behavior', 'llm', 'support'],
  auditor:      ['dashboard', 'compliance', 'audit', 'change-log', 'attestations', 'reports', 'support'],
  viewer:       ['dashboard', 'access', 'reports'],
};

// Screens every signed-in user may reach (personal / help / copilot).
const UNIVERSAL = ['dashboard', 'profile', 'support', 'copilot'];

// SAFE DEFAULT: an unknown/blank role gets the minimum, NOT everything. (The old code
// fell back to '*', which let mislabeled roles see all screens.)
const DEFAULT_ALLOW = ['dashboard'];

export function canSee(role, screen) {
  if (UNIVERSAL.includes(screen)) return true;
  const allow = ROLE_ALLOW[role] || DEFAULT_ALLOW;
  return allow === '*' || allow.includes(screen);
}
