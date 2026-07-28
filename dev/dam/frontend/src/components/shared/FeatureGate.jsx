import Layout from '../Layout';
import useFeatures from '../../hooks/useFeatures';

// The upsell shown in place of an entitlement-gated feature. Also usable inline (section-level)
// by passing `inline` — then it renders a compact banner instead of a full-page panel.
export function UpsellPanel({ name = 'This feature', plan = 'Enterprise', inline = false }) {
  const body = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: inline ? 4 : 10 }}>
        <span style={{ fontSize: inline ? 18 : 30 }}>🔒</span>
        <b style={{ fontSize: inline ? 14 : 19, letterSpacing: '-.01em' }}>{name} is a {plan} feature</b>
      </div>
      <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.55, margin: 0, maxWidth: 520 }}>
        {name} isn’t included in your current plan. Upgrade to <b>{plan}</b> to enable it, or talk to us about
        adding it to your subscription.
      </p>
      {!inline && (
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <a className="btn-primary" href="/support">Contact us to upgrade</a>
          <a className="btn-secondary" href="/billing">View plans</a>
        </div>
      )}
    </>
  );
  if (inline) {
    return (
      <div style={{ border: '1px solid var(--line)', background: 'var(--surface-2, var(--surface))', borderRadius: 12, padding: '14px 16px' }}>
        {body}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 48 }}>
      <div style={{ maxWidth: 620, width: '100%', border: '1px solid var(--line)', borderRadius: 16, padding: '34px 32px', background: 'var(--surface)', boxShadow: 'var(--shadow, 0 8px 24px rgba(0,0,0,.06))' }}>
        {body}
      </div>
    </div>
  );
}

// Route-level gate: renders `children` (the real page) when the tenant is entitled to `feature`,
// otherwise an Enterprise upsell in the standard app chrome. Server-side enforcement still applies
// on the feature's API endpoints — this is the UX layer.
export default function FeatureGate({ feature, name, plan = 'Enterprise', children }) {
  const { features, loading } = useFeatures();
  if (loading) {
    return <Layout><div className="loading-screen"><div className="loading-spinner" /><p>Loading…</p></div></Layout>;
  }
  if (features[feature] === false) {
    return <Layout><UpsellPanel name={name} plan={plan} /></Layout>;
  }
  return children;
}
