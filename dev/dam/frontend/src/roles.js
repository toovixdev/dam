// Canonical role → allowed-screens map. Shared by the Sidebar (what to show) and the
// route guard (what to allow). Values match the internal roles stored on users.
export const ROLE_ALLOW = {
  tenant_admin: '*',
  soc_analyst:  ['dashboard', 'active-defense', 'databases', 'discovery', 'agents', 'capture-modes', 'alerts', 'policies', 'quarantine', 'classification', 'llm', 'support'],
  db_owner:     ['dashboard', 'databases', 'agents', 'capture-modes', 'alerts', 'classification', 'access', 'reports', 'support'],
  compliance:   ['dashboard', 'databases', 'classification', 'masking', 'access', 'compliance', 'dsar', 'audit', 'reports', 'llm', 'support'],
  auditor:      ['dashboard', 'compliance', 'audit', 'reports', 'support'],
  viewer:       ['dashboard', 'access', 'reports'],
};

// Screens every signed-in user may reach (personal / help / copilot).
const UNIVERSAL = ['dashboard', 'profile', 'support', 'copilot', 'assistant'];

// SAFE DEFAULT: an unknown/blank role gets the minimum, NOT everything. (The old code
// fell back to '*', which let mislabeled roles see all screens.)
const DEFAULT_ALLOW = ['dashboard'];

export function canSee(role, screen) {
  if (UNIVERSAL.includes(screen)) return true;
  const allow = ROLE_ALLOW[role] || DEFAULT_ALLOW;
  return allow === '*' || allow.includes(screen);
}
