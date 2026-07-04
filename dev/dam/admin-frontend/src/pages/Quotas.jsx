import { useState } from 'react';
import Layout from '../components/Layout';
import KpiCard from '../components/KpiCard';
import PageHeader from '../components/shared/PageHeader';
import Modal from '../components/shared/Modal';
import { toast } from '../components/shared/Toast';
import useApiData from '../hooks/useApiData';
import { apiPost } from '../api/client';

const TIER_BADGE = { enterprise: 'engine', business: 'sev-medium', starter: 'sev-high', professional: 'status-gray' };
const TIER_LABEL = { enterprise: 'Enterprise', business: 'Business', starter: 'Starter', professional: 'Professional' };
const STATUS_META = {
  ok:        { cls: 'status-green', label: 'OK' },
  warning:   { cls: 'sev-high',     label: 'Warning' },
  'at-limit':{ cls: 'sev-critical', label: 'At limit' },
};

function fmtEvents(n) {
  if (n == null) return 'Unlimited';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}
function fmtDbs(n) { return n == null ? 'Unlimited' : String(n); }
function fmtStorageLimit(gb) {
  if (gb == null) return 'Unlimited';
  return gb >= 1024 ? (gb / 1024).toFixed(gb % 1024 ? 1 : 0) + ' TB' : gb + ' GB';
}
function fmtStorageActual(gb) {
  if (gb == null) return '—';
  if (gb >= 1024) return (gb / 1024).toFixed(1) + ' TB';
  if (gb >= 1) return gb.toFixed(1) + ' GB';
  return (gb * 1024).toFixed(0) + ' MB';
}
function pctColor(pct) { return pct >= 80 ? 'var(--danger)' : pct >= 70 ? 'var(--amber)' : 'var(--green)'; }

function StatusBadge({ status }) {
  const m = STATUS_META[status] || { cls: 'status-gray', label: status };
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}
function Actual({ value, pct }) {
  return pct >= 80 ? <b style={{ color: pctColor(pct) }}>{value}</b> : <span>{value}</span>;
}

export default function Quotas() {
  const { data: quotas, loading, lastRefresh, refetch } = useApiData('/admin/quotas', { poll: 30000 });
  const { data: summary, refetch: refetchSummary } = useApiData('/admin/quotas/summary', { poll: 30000 });
  const { data: plans } = useApiData('/admin/quotas/plans', { poll: 0 });
  const { data: alerts, refetch: refetchAlerts } = useApiData('/admin/quotas/alerts', { poll: 30000 });
  const [edit, setEdit] = useState(null);

  const refreshAll = () => { refetch(); refetchSummary(); refetchAlerts(); };

  if (loading && !quotas) {
    return <div className="loading-screen"><div className="loading-spinner" /><p>Loading resource quotas...</p></div>;
  }

  const rows = quotas || [];
  const worst = (alerts || []).find(a => a.severity === 'critical' || a.severity === 'high');
  const bars = [...rows].sort((a, b) => b.maxPct - a.maxPct);

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refreshAll}>
      <PageHeader title="Tenant Resource Quotas" meta={['per-tenant limits', 'noisy-neighbor prevention']} />

      <section className="kpi-grid">
        <KpiCard icon="⚠" iconBg="var(--danger-soft)" iconColor="var(--danger)"
          label="Tenants at limit" value={summary?.atLimit ?? 0} detail="approaching or at quota" detailType={summary?.atLimit ? 'down' : 'up'} />
        <KpiCard icon="▲" iconBg="var(--amber-soft)" iconColor="var(--amber)"
          label="Soft warnings" value={summary?.warnings ?? 0} detail="above 70% utilization" detailType={summary?.warnings ? 'down' : ''} />
        <KpiCard icon="●" iconBg="var(--green-soft)" iconColor="var(--green)"
          label="Hard blocks" value={summary?.hardBlocks ?? 0} detail={summary?.hardBlocks ? 'tenants throttled' : 'no tenants blocked'} detailType={summary?.hardBlocks ? 'down' : 'up'} />
        <KpiCard icon="≈" iconBg="var(--info-soft)" iconColor="var(--info)"
          label="Avg utilization" value={`${summary?.avgUtilization ?? 0}%`} detail="across all quotas" />
      </section>

      {worst && (
        <div className="card" style={{ marginBottom: 14, borderLeft: '3px solid var(--amber)' }}>
          <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 18, color: 'var(--amber)' }}>⚠</span>
            <div>
              <b style={{ color: 'var(--amber)' }}>Quota Warning</b><br />
              <span>{worst.tenant} hit {worst.pct}% of {worst.metric} quota — notify account team</span>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button className="btn-secondary" onClick={() => toast('Notification sent to account team', 'ok')}>Notify team</button>
              <button className="btn-secondary" onClick={() => toast('Alert acknowledged', 'ok')}>Acknowledge</button>
            </div>
          </div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header">
          <span className="card-title">Quota Usage by Tenant</span>
          <span className="card-sub">{rows.length} tenants</span>
        </div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead>
              <tr>
                <th>Tenant</th><th>Plan</th>
                <th className="num">Events/day Limit</th><th className="num">Events/day Actual</th>
                <th className="num">DBs Limit</th><th className="num">DBs Actual</th>
                <th className="num">Storage Limit</th><th className="num">Storage Actual</th>
                <th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={10} className="muted" style={{ textAlign: 'center', padding: 24 }}>No tenants</td></tr>}
              {rows.map(q => (
                <tr key={q.tenantId} style={q.status === 'at-limit' ? { background: 'var(--danger-soft)' } : {}}>
                  <td><b>{q.name}</b><br /><small className="muted">{q.slug}{q.custom ? ' · custom' : ''}</small></td>
                  <td><span className={`badge ${TIER_BADGE[q.tier] || 'status-gray'}`}>{TIER_LABEL[q.tier] || q.tier}</span></td>
                  <td className="num">{q.events.limit == null ? 'Custom' : fmtEvents(q.events.limit)}</td>
                  <td className="num"><Actual value={fmtEvents(q.events.actual)} pct={q.events.pct} /></td>
                  <td className="num">{fmtDbs(q.databases.limit)}</td>
                  <td className="num"><Actual value={q.databases.actual} pct={q.databases.pct} /></td>
                  <td className="num">{fmtStorageLimit(q.storage.limitGb)}</td>
                  <td className="num"><Actual value={fmtStorageActual(q.storage.actualGb)} pct={q.storage.pct} /></td>
                  <td><StatusBadge status={q.status} /></td>
                  <td>
                    {q.tier === 'business'
                      ? <button className="btn-secondary" style={{ padding: '5px 12px' }} onClick={() => toast(`Upgrade flow for ${q.name} — submitted for approval (prototype)`, 'ok')}>Upgrade</button>
                      : <button className="btn-secondary" style={{ padding: '5px 12px' }} onClick={() => setEdit(q)}>Edit</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="charts-row">
        <div className="card">
          <div className="card-header"><span className="card-title">Default Quotas by Plan Tier</span></div>
          <div className="card-body no-pad">
            <table className="data-table">
              <thead><tr><th>Plan</th><th className="num">Events/day</th><th className="num">Databases</th><th className="num">Storage</th><th>Notes</th></tr></thead>
              <tbody>
                {(plans || []).map(p => (
                  <tr key={p.tier}>
                    <td><span className={`badge ${TIER_BADGE[p.tier] || 'status-gray'}`}>{TIER_LABEL[p.tier] || p.tier}</span></td>
                    <td className="num">{p.eventsPerDay == null ? 'Custom' : fmtEvents(p.eventsPerDay)}</td>
                    <td className="num">{fmtDbs(p.maxDatabases)}</td>
                    <td className="num">{fmtStorageLimit(p.storageGb)}</td>
                    <td><small className="muted">{p.notes}</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">Enforcement Behavior</span><span className="card-sub">what happens at each threshold</span></div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              ['70-94%', 'sev-high', 'Soft warning', 'Tenant operates normally. Notifications to internal teams only — tenant admin not notified. No throttling.'],
              ['95-99%', 'sev-critical', 'Hard warning', 'Tenant admin sees a banner. P2 incident auto-created. Ops decides: extend quota or prepare to throttle.'],
              ['100%', 'sev-critical', 'Hard limit', 'Ingestion throttled (events queued, not dropped). New DB registrations blocked. P1 incident. Tenant admin emailed.'],
            ].map(([range, cls, title, desc]) => (
              <div key={range} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 9 }}>
                <span className={`badge ${cls}`} style={{ flex: 'none', marginTop: 2 }}>{range}</span>
                <div style={{ fontSize: 12.5, lineHeight: 1.5 }}><b>{title}</b> — {desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Quota Utilization</span><span className="card-sub">peak metric per tenant</span></div>
        <div className="card-body">
          {bars.length === 0 && <div className="muted">No tenants</div>}
          {bars.map(q => (
            <div key={q.tenantId} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <span style={{ minWidth: 180, fontSize: 13, fontWeight: 600 }}>{q.name}</span>
              <div style={{ flex: 1, height: 8, borderRadius: 6, background: 'var(--surface-2)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(q.maxPct, 100)}%`, background: pctColor(q.maxPct) }} />
              </div>
              <span style={{ minWidth: 40, textAlign: 'right', fontSize: 13, fontWeight: 600, color: pctColor(q.maxPct) }}>{q.maxPct}%</span>
            </div>
          ))}
        </div>
      </div>

      <div className="charts-row">
        <div className="card">
          <div className="card-header"><span className="card-title">Notification Channels</span><span className="card-sub">configured integrations</span></div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              ['💬', 'Slack', '#platform-ops · #customer-success'],
              ['🔔', 'PagerDuty', 'Escalation policy: Platform On-Call'],
              ['⚑', 'ServiceNow', 'Auto-create INC for P1/P2 quota breaches'],
              ['⚙', 'Jira', 'Project: CS-QUOTA · upsell tracking'],
              ['✉', 'Email', 'Account manager + VP Eng + tenant admin (on hard limit)'],
            ].map(([ic, name, sub]) => (
              <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 9 }}>
                <span style={{ fontSize: 16, flex: 'none' }}>{ic}</span>
                <div style={{ flex: 1 }}><b style={{ fontSize: 13 }}>{name}</b><br /><small className="muted">{sub}</small></div>
                <span className="badge status-green" style={{ fontSize: 10 }}>Connected</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">Current Quota Pressure</span><span className="card-sub">live · ≥70% utilization</span></div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(!alerts || alerts.length === 0) && (
              <div className="muted" style={{ padding: '12px 0' }}>No quota pressure right now — all tenants below 70% on every metric.</div>
            )}
            {(alerts || []).map((a, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line-2)', fontSize: 13 }}>
                <span className={`badge ${a.severity === 'critical' ? 'sev-critical' : a.severity === 'high' ? 'sev-high' : 'sev-high'}`} style={{ fontSize: 10 }}>{a.pct}%</span>
                <div style={{ flex: 1 }}><b>{a.tenant}</b> — {a.metric} at {a.pct}%</div>
                <span className="muted" style={{ fontSize: 11 }}>{a.severity}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <QuotaEditor quota={edit} onClose={() => setEdit(null)} onSaved={refreshAll} />
    </Layout>
  );
}

function QuotaEditor({ quota: q, onClose, onSaved }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  // Initialise form when a quota is selected (raw numbers; blank = unlimited).
  if (q && (!form || form._id !== q.tenantId)) {
    setForm({
      _id: q.tenantId,
      events: q.events.limit ?? '',
      dbs: q.databases.limit ?? '',
      storage: q.storage.limitGb ?? '',
      justification: '',
    });
  }
  if (!q || !form) return null;

  async function save() {
    if (!form.justification.trim()) { toast('Justification is required for the audit record', 'err'); return; }
    setSaving(true);
    const res = await apiPost(`/admin/quotas/${q.tenantId}`, {
      events_per_day: form.events === '' ? null : form.events,
      max_databases: form.dbs === '' ? null : form.dbs,
      storage_gb: form.storage === '' ? null : form.storage,
      justification: form.justification,
    });
    setSaving(false);
    if (res.ok) { toast(`Quota override saved for ${q.name}`, 'ok'); onSaved(); onClose(); }
    else toast(res.data?.error || 'Failed to save override', 'err');
  }

  const set = (patch) => setForm(f => ({ ...f, ...patch }));
  const Bar = ({ pct }) => (
    <div style={{ height: 6, borderRadius: 3, background: 'var(--surface-2)', overflow: 'hidden', flex: 1 }}>
      <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: pctColor(pct) }} />
    </div>
  );

  return (
    <Modal open={!!q} onClose={onClose} title={`Edit Quotas — ${q.name}`} width={560}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 10, marginBottom: 16, fontSize: 13 }}>
        <span className={`badge ${TIER_BADGE[q.tier] || 'status-gray'}`}>{TIER_LABEL[q.tier] || q.tier}</span>
        <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, color: 'var(--muted)' }}>{q.slug}</span>
      </div>

      <div className="form-field">
        <label>Events / day limit <span className="muted">(blank = unlimited)</span></label>
        <input type="number" value={form.events} onChange={(e) => set({ events: e.target.value })} placeholder="e.g. 250000000" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
          <span>Usage: <b style={{ color: pctColor(q.events.pct) }}>{fmtEvents(q.events.actual)}</b> ({q.events.pct}%)</span><Bar pct={q.events.pct} />
        </div>
      </div>

      <div className="form-field">
        <label>Databases limit <span className="muted">(blank = unlimited)</span></label>
        <input type="number" value={form.dbs} onChange={(e) => set({ dbs: e.target.value })} placeholder="e.g. 200" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
          <span>Usage: <b style={{ color: pctColor(q.databases.pct) }}>{q.databases.actual}</b> ({q.databases.pct}%)</span><Bar pct={q.databases.pct} />
        </div>
      </div>

      <div className="form-field">
        <label>Storage limit (GB) <span className="muted">(blank = unlimited)</span></label>
        <input type="number" value={form.storage} onChange={(e) => set({ storage: e.target.value })} placeholder="e.g. 5120" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
          <span>Usage: <b style={{ color: pctColor(q.storage.pct) }}>{fmtStorageActual(q.storage.actualGb)}</b> ({q.storage.pct}%)</span><Bar pct={q.storage.pct} />
        </div>
      </div>

      <div className="form-field">
        <label>Justification *</label>
        <textarea rows={2} value={form.justification} onChange={(e) => set({ justification: e.target.value })}
          placeholder="Reason for override (stored with operator + timestamp on the override record)" style={{ resize: 'vertical' }} />
      </div>

      <div style={{ background: 'var(--info-soft)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 14px', marginBottom: 14, fontSize: 12.5, lineHeight: 1.5 }}>
        <b style={{ color: 'var(--info)' }}>Override record:</b> the limit change is stored in the isolated <code>quota_overrides</code> table with operator + timestamp + justification (the app-maintained audit trail is not modified).
      </div>

      <div style={{ display: 'flex', gap: 10, paddingTop: 14, borderTop: '1px solid var(--line)', justifyContent: 'flex-end' }}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save quota override'}</button>
      </div>
    </Modal>
  );
}
