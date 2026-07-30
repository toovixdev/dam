import useApiData from './useApiData';

// Per-tenant ENTITLEMENT map { featureKey: boolean } — whether the tenant's plan (tier + overrides)
// includes each feature, independent of GA-rollout stage (GET /api/entitlements). This is the right
// signal for gating the UI: an enterprise-only feature still in alpha (e.g. jit-access) is
// entitled=true for enterprise but false for business, whereas /api/features would report it off
// for everyone because it isn't GA. `loading` is true until it arrives.
export default function useFeatures() {
  const { data } = useApiData('/entitlements', { poll: 60000 });
  return { features: data || {}, loading: data == null };
}

// Which screen (nav id / route) maps to which gating feature. Only enterprise-restricted screens
// need listing here; a screen absent from this map is always available (subject to RBAC).
export const SCREEN_FEATURE = {
  access: 'jit-access',
  llm: 'llm-monitoring',
  dsar: 'dsar',
  masking: 'dynamic-masking', // business+ (starter sees it locked)
  behavior: 'ueba',           // business+ (starter sees it locked)
  vulnerability: 'va-scanner',
};
