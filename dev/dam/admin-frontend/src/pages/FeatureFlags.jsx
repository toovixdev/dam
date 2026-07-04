import { useState, useCallback, useRef, useEffect } from 'react';
import Layout from '../components/Layout';
import KpiCard from '../components/KpiCard';
import PageHeader from '../components/shared/PageHeader';
import { toast } from '../components/shared/Toast';
import useApiData from '../hooks/useApiData';
import { apiFetch, apiPost } from '../api/client';

const STAGE_META = {
  ga:    { cls: 'status-green', label: 'GA' },
  beta:  { cls: 'sev-high',     label: 'Beta' },
  alpha: { cls: 'sev-medium',   label: 'Alpha' },
};
const TIER_LABEL = { enterprise: 'Enterprise', business: 'Business', professional: 'Professional', starter: 'Starter' };

function StageBadge({ stage }) {
  const m = STAGE_META[stage] || { cls: 'status-gray', label: stage };
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}
function TierCheck({ on }) {
  return on
    ? <span style={{ color: 'var(--green)', fontWeight: 700 }}>✓</span>
    : <span style={{ color: 'var(--subtle)' }}>✗</span>;
}

export default function FeatureFlags() {
  const { data: features, loading, lastRefresh, refetch } = useApiData('/admin/features', { poll: 30000 });
  const { data: summary, refetch: refetchSummary } = useApiData('/admin/features/summary', { poll: 30000 });

  const [selected, setSelected] = useState(null);   // feature key whose overrides panel is open
  const [overrides, setOverrides] = useState(null); // { feature, tenants }
  const [ovLoading, setOvLoading] = useState(false);
  const panelRef = useRef(null);

  const refreshAll = () => { refetch(); refetchSummary(); };

  // The overrides panel renders below a long feature table, so bring it into
  // view when it opens (matches the mockup) — otherwise "Manage" looks inert.
  useEffect(() => {
    if (selected && panelRef.current) {
      panelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [selected]);

  const openOverrides = useCallback(async (key) => {
    setSelected(key);
    setOvLoading(true);
    setOverrides(null);
    try {
      const data = await apiFetch(`/admin/features/${key}/overrides`);
      setOverrides(data);
    } catch {
      toast('Failed to load overrides', 'err');
    } finally {
      setOvLoading(false);
    }
  }, []);

  async function setOverride(tenantId, status) {
    const res = await apiPost(`/admin/features/${selected}/overrides/${tenantId}`, { status });
    if (res.ok) {
      toast(`${overrides.feature.name} — ${status === 'reset' ? 'reset to default' : status}`, 'ok');
      openOverrides(selected);   // refresh panel
      refetch();                  // refresh enabled counts
    } else {
      toast(res.data?.error || 'Failed to update override', 'err');
    }
  }

  if (loading && !features) {
    return <div className="loading-screen"><div className="loading-spinner" /><p>Loading feature flags...</p></div>;
  }

  const rolloutFeature = (features || []).find(f => f.stage === 'beta' && f.rolloutTarget);

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refreshAll}>
      <PageHeader title="Feature Flags" meta={['per-tenant feature toggles', 'staged rollout']} />

      <section className="kpi-grid">
        <KpiCard icon="▶" iconBg="var(--green-soft)" iconColor="var(--green)"
          label="Features" value={summary?.total ?? 0} detail="across 3 plan tiers" />
        <KpiCard icon="▮" iconBg="var(--primary-soft)" iconColor="var(--primary)"
          label="GA" value={summary?.ga ?? 0} detail="generally available" detailType="up" />
        <KpiCard icon="◔" iconBg="var(--amber-soft)" iconColor="var(--amber)"
          label="Beta" value={summary?.beta ?? 0} detail="staged rollout" />
        <KpiCard icon="≈" iconBg="var(--info-soft)" iconColor="var(--info)"
          label="Alpha" value={summary?.alpha ?? 0} detail="internal / early access" />
      </section>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header">
          <span className="card-title">Global Feature List</span>
          <span className="card-sub">{features?.length ?? 0} features</span>
        </div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead>
              <tr>
                <th>Feature</th>
                <th style={{ textAlign: 'center' }}>Starter</th>
                <th style={{ textAlign: 'center' }}>Business</th>
                <th style={{ textAlign: 'center' }}>Enterprise</th>
                <th>Rollout</th>
                <th className="num">Enabled</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(features || []).map(f => (
                <tr key={f.key} className={selected === f.key ? 'row-selected' : ''}>
                  <td><b>{f.name}</b><br /><small className="muted">{f.description}</small></td>
                  <td style={{ textAlign: 'center' }}><TierCheck on={f.tiers.starter} /></td>
                  <td style={{ textAlign: 'center' }}><TierCheck on={f.tiers.business} /></td>
                  <td style={{ textAlign: 'center' }}><TierCheck on={f.tiers.enterprise} /></td>
                  <td><StageBadge stage={f.stage} /></td>
                  <td className="num">{f.enabledCount} / {f.tenantTotal}</td>
                  <td>
                    {f.isCore ? <span className="muted" style={{ fontSize: 12 }}>Core — always on</span>
                      : f.tierGated ? <span className="muted" style={{ fontSize: 12 }}>Tier-gated</span>
                      : <button className="btn-secondary" style={{ padding: '5px 12px' }} onClick={() => openOverrides(f.key)}>Manage</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <div className="card" style={{ marginBottom: 14 }} ref={panelRef}>
          <div className="card-header">
            <span className="card-title">Per-Tenant Overrides — {overrides?.feature?.name || ''}</span>
            <button className="btn-secondary" style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: 12 }}
              onClick={() => { setSelected(null); setOverrides(null); }}>Close</button>
          </div>
          <div className="card-body no-pad">
            {ovLoading && <div className="muted" style={{ padding: 18, textAlign: 'center' }}>Loading…</div>}
            {!ovLoading && overrides && (
              <table className="data-table">
                <thead>
                  <tr><th>Tenant</th><th>Plan</th><th>Tier eligible</th><th>Current status</th><th></th></tr>
                </thead>
                <tbody>
                  {overrides.tenants.map(t => (
                    <OverrideRow key={t.tenantId} t={t} onSet={setOverride} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {rolloutFeature && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-header">
            <span className="card-title">Staged Rollout — {rolloutFeature.name}</span>
            <span className="card-sub">beta phase</span>
          </div>
          <div className="card-body">
            <StagedRollout f={rolloutFeature} />
          </div>
        </div>
      )}
    </Layout>
  );
}

function OverrideRow({ t, onSet }) {
  let badge;
  if (t.override === 'enabled') badge = <span className="badge status-green">Enabled (override)</span>;
  else if (t.override === 'disabled') badge = <span className="badge sev-critical">Disabled (override)</span>;
  else if (t.override === 'beta') badge = <span className="badge sev-high">Beta</span>;
  else if (t.override === 'alpha') badge = <span className="badge sev-medium">Alpha</span>;
  else if (t.eligible && t.enabled) badge = <span className="badge status-gray">Default (tier-included)</span>;
  else if (t.eligible) badge = <span className="badge status-gray">Default off (opt-in)</span>;
  else badge = <span className="badge" style={{ color: 'var(--subtle)' }}>Not available (plan)</span>;

  const canManage = t.eligible || t.override;

  return (
    <tr>
      <td><b>{t.name}</b><br /><small className="muted">{t.slug}</small></td>
      <td><span className="badge engine">{TIER_LABEL[t.tier] || t.tier}</span></td>
      <td>{t.eligible
        ? <span style={{ color: 'var(--green)', fontWeight: 700 }}>✓ Yes</span>
        : <span style={{ color: 'var(--subtle)' }}>✗ No</span>}</td>
      <td>{badge}</td>
      <td>
        {canManage ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn-secondary" style={{ padding: '3px 9px', fontSize: 11 }} onClick={() => onSet(t.tenantId, 'enabled')}>Enable</button>
            <button className="btn-secondary" style={{ padding: '3px 9px', fontSize: 11 }} onClick={() => onSet(t.tenantId, 'disabled')}>Disable</button>
            <button className="btn-secondary" style={{ padding: '3px 9px', fontSize: 11 }} onClick={() => onSet(t.tenantId, 'reset')}>Reset</button>
          </div>
        ) : <span className="muted" style={{ fontSize: 11.5 }}>Plan upgrade required</span>}
      </td>
    </tr>
  );
}

function StagedRollout({ f }) {
  const pct = f.tenantTotal > 0 ? Math.round((f.enabledCount / f.tenantTotal) * 100) : 0;
  const proto = (msg, type = 'ok') => toast(msg, type);
  return (
    <>
      <div style={{ display: 'flex', gap: 24, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <div><small className="muted">Current phase</small><br /><StageBadge stage={f.stage} /></div>
        <div><small className="muted">Tenants enabled</small><br /><b>{f.enabledCount} / {f.tenantTotal}</b> <span className="muted">({pct}%)</span></div>
        <div><small className="muted">Target</small><br /><b>{f.rolloutTarget}</b></div>
        <div><small className="muted">Error rate</small><br /><b style={{ color: 'var(--green)' }}>{f.rolloutError || '—'}</b></div>
      </div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
          <span className="muted">Rollout progress</span><b>{pct}%</b>
        </div>
        <div style={{ height: 8, borderRadius: 6, background: 'var(--surface-2)', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: 'var(--amber)' }} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn-primary" onClick={() => proto('Expanding to next batch of tenants')}>Expand to next batch</button>
        <button className="btn-secondary" onClick={() => proto('Rollout paused')}>Pause rollout</button>
        <button className="btn-secondary" style={{ color: 'var(--danger)' }} onClick={() => proto('Rollback would revert all beta tenants', 'err')}>Rollback</button>
      </div>
      <p className="muted" style={{ fontSize: 11, marginTop: 10 }}>
        Rollout controls are prototype-only; the enabled count above is live from real per-tenant overrides.
      </p>
    </>
  );
}
