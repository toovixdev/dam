import { useState, useEffect } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import Layout from '../components/Layout';
import KpiCard from '../components/KpiCard';
import PageHeader from '../components/shared/PageHeader';
import Modal from '../components/shared/Modal';
import { toast } from '../components/shared/Toast';
import useApiData from '../hooks/useApiData';
import { apiFetch, apiPut, apiDelete } from '../api/client';

const TIER_BADGE = { enterprise: 'engine', business: 'sev-medium', starter: 'sev-high', professional: 'status-gray' };
const TIER_LABEL = { enterprise: 'Enterprise', business: 'Business', starter: 'Starter', professional: 'Professional' };
const BILL_BADGE = { Paid: 'status-green', 'Overage pending': 'sev-high', Processing: 'sev-medium', Trial: 'status-gray' };
const DONUT = ['#6366f1', '#f59e0b', '#3b82f6', '#22c55e', '#dc2626', '#8b5cf6'];

function usd(n) { return '$' + (n ?? 0).toLocaleString(); }
function usdK(n) { return n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'K' : '$' + (n ?? 0); }
function fmtEvents(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n ?? 0); }
function fmtGb(g) { return g >= 1024 ? (g / 1024).toFixed(1) + ' TB' : g >= 1 ? g.toFixed(1) + ' GB' : (g * 1024).toFixed(0) + ' MB'; }
function fmtDate(iso) { return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); }

// Rate card rendered live from the configurable billing_rates table.
function pricingRows(r) {
  if (!r) return [];
  return [
    ['Base platform fee', 'Monthly platform access (Enterprise)', `$${r.baseFee.toLocaleString()} / mo`],
    ['Monitored database', 'Each active monitored database', `$${r.rates.perDatabase} / db / mo`],
    ['Inline blocking', 'Real-time query blocking add-on', `$${r.rates.perInlineDb} / db / mo`],
    ['Event volume', `Included up to ${(r.limits.eventsPerDay / 1e6).toFixed(0)}M events/day`, `$${r.rates.eventOveragePerM} / 1M over`],
    ['Hot storage', `Included up to ${(r.limits.hotStorageGB / 1024).toFixed(0)} TB`, `$${r.rates.hotOveragePerGB} / GB over`],
    ['Cold storage (WORM)', 'Compliance archive · 7-year retention', `$${r.rates.coldPerGB} / GB / mo`],
    ['DSAR processing', 'Per data-subject request fulfilled', `$${r.rates.perDsar} / request`],
  ];
}

export default function Billing() {
  const { data, loading, lastRefresh, refetch } = useApiData('/admin/billing', { poll: 30000 });
  const { data: ratesData, refetch: refetchRates } = useApiData('/admin/billing/rates', { poll: 0 });
  const [editOpen, setEditOpen] = useState(false);
  const [contractTenant, setContractTenant] = useState(null);
  if (loading && !data) return <div className="loading-screen"><div className="loading-spinner" /><p>Computing invoices…</p></div>;

  const k = data?.kpis || {};
  const invoices = data?.invoices || [];
  const rev = data?.revenueByRegion || [];
  const events = data?.recentEvents || [];
  const totalRev = rev.reduce((s, r) => s + r.amount, 0);

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refetch}>
      <PageHeader title="Billing & Plans" meta={['Super Admin', 'revenue & subscription management']} />

      <section className="kpi-grid">
        <KpiCard icon="$" iconBg="var(--green-soft)" iconColor="var(--green)" label="MRR"
          value={usdK(k.mrr)} detail="computed from live usage" detailType="up" />
        <KpiCard icon="▦" iconBg="var(--primary-soft)" iconColor="var(--primary)" label="Active subscriptions"
          value={k.activeSubs} detail="billable tenants" />
        <KpiCard icon="≈" iconBg="var(--info-soft)" iconColor="var(--info)" label="Avg revenue/tenant"
          value={usdK(k.avgRevenue)} detail="monthly" />
        <KpiCard icon="⚠" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Overages"
          value={k.overages} detail={k.overages ? 'invoices pending' : 'none this cycle'} detailType={k.overages ? 'down' : 'up'} />
      </section>

      <section className="charts-row" style={{ marginBottom: 14 }}>
        <div className="card">
          <div className="card-header"><span className="card-title">Plan Tiers</span></div>
          <div className="card-body no-pad">
            <table className="data-table">
              <thead><tr><th>Plan</th><th>Price</th><th>Databases</th><th>Retention</th></tr></thead>
              <tbody>
                <tr><td><span className="badge sev-high">Starter</span></td><td><b>Free</b><br /><small className="muted">14-day trial</small></td><td>Up to 5</td><td>30 days</td></tr>
                <tr><td><span className="badge sev-medium">Business</span></td><td><b>$100/db/mo + usage</b></td><td>Unlimited</td><td>1 year</td></tr>
                <tr><td><span className="badge engine">Enterprise</span></td><td><b>$8,000/mo base + usage</b><br /><small className="muted">annual contract</small></td><td>Unlimited</td><td>Custom</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">Revenue by Region</span></div>
          <div className="card-body">
            {totalRev === 0 ? <div className="chart-empty">No billable revenue yet</div> : (
              <div style={{ position: 'relative' }}>
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={rev} cx="50%" cy="50%" innerRadius={55} outerRadius={80} dataKey="amount" nameKey="region" stroke="none">
                      {rev.map((e, i) => <Cell key={e.region} fill={DONUT[i % DONUT.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: 'var(--surface, #fff)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 12 }} formatter={(v) => usd(v)} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="donut-center"><span className="donut-value" style={{ fontSize: 18 }}>{usdK(totalRev)}</span><span className="donut-label">MRR</span></div>
                <div className="donut-legend">{rev.map((r, i) => <span key={r.region} className="legend-item"><span className="legend-dot" style={{ background: DONUT[i % DONUT.length] }} />{r.region}: {usdK(r.amount)}</span>)}</div>
              </div>
            )}
          </div>
        </div>
      </section>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header">
          <span className="card-title">Pricing Model</span>
          <span className="card-sub">live rate card · matches product billing</span>
          <button className="btn-secondary" style={{ marginLeft: 'auto', padding: '5px 12px' }} onClick={() => setEditOpen(true)} disabled={!ratesData}>✎ Edit rates</button>
        </div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Component</th><th>Description</th><th className="num">Rate</th></tr></thead>
            <tbody>{pricingRows(ratesData).map(r => <tr key={r[0]}><td><b>{r[0]}</b></td><td className="muted">{r[1]}</td><td className="num">{r[2]}</td></tr>)}</tbody>
          </table>
        </div>
        {ratesData?.updatedAt && (
          <div className="card-body" style={{ paddingTop: 0 }}>
            <small className="muted">Last updated {new Date(ratesData.updatedAt).toLocaleString('en-GB')}{ratesData.updatedBy ? ` by ${ratesData.updatedBy}` : ''}. Changes apply to both the admin and product billing immediately.</small>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Tenant Usage & Invoice Breakdown</span><span className="card-sub">current cycle · computed live</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Tenant</th><th>Plan</th><th className="num">DBs</th><th className="num">Events/day</th><th className="num">Storage</th><th className="num">Base + DB</th><th className="num">Overages</th><th className="num">Total</th><th>Billing</th><th>Contract</th></tr></thead>
            <tbody>
              {invoices.map(i => (
                <tr key={i.id} style={i.status === 'trial' ? { background: 'var(--surface-2)' } : {}}>
                  <td><b>{i.name}</b>{i.negotiated && <><br /><small className="badge sev-medium" style={{ fontSize: 10 }}>Negotiated{i.contractValidUntil ? ` · until ${new Date(i.contractValidUntil).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}` : ''}</small></>}</td>
                  <td><span className={`badge ${i.status === 'trial' ? 'sev-high' : TIER_BADGE[i.tier] || 'status-gray'}`}>{i.status === 'trial' ? 'Trial' : TIER_LABEL[i.tier] || i.tier}</span></td>
                  <td className="num">{i.dbs}</td>
                  <td className="num">{fmtEvents(i.eventsDay)}</td>
                  <td className="num">{fmtGb(i.storageGb)}</td>
                  <td className="num">{i.status === 'trial' ? <span className="muted">$0</span> : usd(i.baseDb)}</td>
                  <td className="num">{i.overage > 0 ? <b style={{ color: 'var(--amber)' }}>{usd(i.overage)}</b> : <span className="muted">$0</span>}</td>
                  <td className="num"><b>{i.status === 'trial' ? '$0' : usd(i.total)}</b></td>
                  <td><span className={`badge ${BILL_BADGE[i.billing] || 'status-gray'}`}>{i.billing}</span></td>
                  <td><button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => setContractTenant(i)}>{i.negotiated ? '✎ Edit' : '＋ Set'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Recent Billing Events</span><span className="card-sub">derived from current invoices</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Date</th><th>Tenant</th><th>Event</th><th>Details</th><th className="num">Amount</th><th>Status</th></tr></thead>
            <tbody>
              {events.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 20 }}>No billing events</td></tr>}
              {events.map((e, n) => (
                <tr key={n}>
                  <td className="muted">{fmtDate(e.date)}</td>
                  <td><b>{e.tenant}</b></td>
                  <td>{e.event === 'Overage' ? <span className="badge sev-high">Overage</span> : e.event}</td>
                  <td className="muted">{e.details}</td>
                  <td className="num"><b>{usd(e.amount)}</b></td>
                  <td><span className={`badge ${BILL_BADGE[e.status] || 'status-gray'}`}>{e.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <RatesEditor open={editOpen} rates={ratesData} onClose={() => setEditOpen(false)} onSaved={() => { refetchRates(); refetch(); }} />
      <ContractEditor tenant={contractTenant} onClose={() => setContractTenant(null)} onSaved={refetch} />
    </Layout>
  );
}

// Per-tenant negotiated rates — each field overrides the global card; blank = global.
const CONTRACT_FIELDS = [
  ['baseFee', 'Base platform fee ($/mo)'],
  ['perDatabase', 'Per monitored DB ($/mo)'],
  ['perInlineDb', 'Inline blocking ($/db/mo)'],
  ['eventOveragePerM', 'Event overage ($/1M)'],
  ['hotOveragePerGB', 'Hot storage overage ($/GB)'],
  ['coldPerGB', 'Cold storage ($/GB/mo)'],
  ['perDsar', 'DSAR processing ($/request)'],
];

function ContractEditor({ tenant, onClose, onSaved }) {
  const [data, setData] = useState(null);   // { override, globals }
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!tenant) { setData(null); setForm(null); return; }
    let live = true;
    apiFetch(`/admin/tenants/${tenant.id}/billing-override`).then(d => {
      if (!live) return;
      setData(d);
      const o = d.override || {};
      setForm({
        baseFee: o.baseFee ?? '', perDatabase: o.perDatabase ?? '', perInlineDb: o.perInlineDb ?? '',
        eventOveragePerM: o.eventOveragePerM ?? '', hotOveragePerGB: o.hotOveragePerGB ?? '',
        coldPerGB: o.coldPerGB ?? '', perDsar: o.perDsar ?? '',
        validUntil: o.validUntil ? String(o.validUntil).slice(0, 10) : '', reason: o.reason ?? '',
      });
    }).catch(() => toast('Failed to load contract', 'err'));
    return () => { live = false; };
  }, [tenant]);

  if (!tenant) return null;
  const g = data?.globals;
  const ph = (key) => (g ? (key === 'baseFee' ? g.baseFee : g.rates[key]) : '');
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true);
    const body = { reason: form.reason, validUntil: form.validUntil || null };
    CONTRACT_FIELDS.forEach(([k]) => { body[k] = form[k] === '' ? null : +form[k]; });
    const res = await apiPut(`/admin/tenants/${tenant.id}/billing-override`, body);
    setSaving(false);
    if (res.ok) { toast(`Contract saved for ${tenant.name} — invoice recomputed`, 'ok'); onSaved(); onClose(); }
    else toast(res.data?.error || 'Failed to save contract', 'err');
  }
  async function clearContract() {
    setSaving(true);
    const res = await apiDelete(`/admin/tenants/${tenant.id}/billing-override`);
    setSaving(false);
    if (res.ok) { toast(`Contract removed for ${tenant.name} — back to global rates`, 'ok'); onSaved(); onClose(); }
    else toast(res.data?.error || 'Failed to remove contract', 'err');
  }

  return (
    <Modal open={!!tenant} onClose={onClose} title={`Negotiated contract — ${tenant.name}`} width={640}>
      {!form ? <div className="muted" style={{ padding: 16 }}>Loading…</div> : (
        <>
          <p className="muted" style={{ fontSize: 12.5, margin: '0 0 14px', lineHeight: 1.5 }}>
            Set this customer's negotiated rates. Leave a field blank to use the global rate card (shown as the placeholder). The contract applies until its valid-until date, then reverts to global automatically.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
            {CONTRACT_FIELDS.map(([key, label]) => (
              <div className="form-field" key={key}><label>{label}</label>
                <input type="number" step="any" min="0" value={form[key]} placeholder={`global: ${ph(key)}`} onChange={(e) => set(key, e.target.value)} /></div>
            ))}
          </div>
          <div className="form-row">
            <div className="form-field"><label>Valid until <span className="muted">(blank = open-ended)</span></label>
              <input type="date" value={form.validUntil} onChange={(e) => set('validUntil', e.target.value)} /></div>
            <div className="form-field"><label>Contract reference / reason</label>
              <input type="text" value={form.reason} placeholder="e.g. MSA-2026-0142" onChange={(e) => set('reason', e.target.value)} /></div>
          </div>
          <div style={{ background: 'var(--info-soft)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 14px', margin: '4px 0 14px', fontSize: 12.5, lineHeight: 1.5 }}>
            <b style={{ color: 'var(--info)' }}>Applies to the customer too:</b> the tenant's product billing screen recomputes at these contracted rates. Stored in the isolated <code>tenant_billing_overrides</code> table.
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', paddingTop: 12, borderTop: '1px solid var(--line)' }}>
            {data?.override && <button className="btn-secondary" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={clearContract} disabled={saving}>Remove contract</button>}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save contract'}</button>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

const RATE_FIELDS = [
  ['baseFee', 'Base platform fee ($/mo)', 'base'],
  ['perDatabase', 'Per monitored DB ($/mo)', 'rates'],
  ['perInlineDb', 'Inline blocking ($/db/mo)', 'rates'],
  ['eventOveragePerM', 'Event overage ($/1M)', 'rates'],
  ['hotOveragePerGB', 'Hot storage overage ($/GB)', 'rates'],
  ['coldPerGB', 'Cold storage ($/GB/mo)', 'rates'],
  ['perDsar', 'DSAR processing ($/request)', 'rates'],
];
const LIMIT_FIELDS = [
  ['databases', 'Included databases'],
  ['eventsPerDay', 'Included events/day'],
  ['hotStorageGB', 'Included hot storage (GB)'],
];

function RatesEditor({ open, rates, onClose, onSaved }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  // Seed the form from the current rate card when the modal opens.
  if (open && rates && (!form || form._loaded !== rates.updatedAt)) {
    setForm({
      _loaded: rates.updatedAt,
      baseFee: rates.baseFee,
      ...rates.rates,
      databases: rates.limits.databases, eventsPerDay: rates.limits.eventsPerDay, hotStorageGB: rates.limits.hotStorageGB,
    });
  }
  if (!open || !form) return null;

  const set = (kk, v) => setForm(f => ({ ...f, [kk]: v }));
  async function save() {
    setSaving(true);
    const body = {
      baseFee: +form.baseFee,
      rates: { perDatabase: +form.perDatabase, perInlineDb: +form.perInlineDb, coldPerGB: +form.coldPerGB, eventOveragePerM: +form.eventOveragePerM, hotOveragePerGB: +form.hotOveragePerGB, perDsar: +form.perDsar },
      limits: { databases: +form.databases, eventsPerDay: +form.eventsPerDay, hotStorageGB: +form.hotStorageGB },
    };
    const res = await apiPut('/admin/billing/rates', body);
    setSaving(false);
    if (res.ok) { toast('Rate card updated — invoices recomputed', 'ok'); onSaved(); onClose(); }
    else toast(res.data?.error || 'Failed to update rates', 'err');
  }

  return (
    <Modal open={open} onClose={onClose} title="Edit billing rate card" width={620}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--subtle)', margin: '0 0 8px' }}>Rates</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
        {RATE_FIELDS.map(([key, label]) => (
          <div className="form-field" key={key}><label>{label}</label>
            <input type="number" step="any" min="0" value={form[key]} onChange={(e) => set(key, e.target.value)} /></div>
        ))}
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--subtle)', margin: '6px 0 8px' }}>Plan limits (overage thresholds)</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 16px' }}>
        {LIMIT_FIELDS.map(([key, label]) => (
          <div className="form-field" key={key}><label>{label}</label>
            <input type="number" step="any" min="0" value={form[key]} onChange={(e) => set(key, e.target.value)} /></div>
        ))}
      </div>
      <div style={{ background: 'var(--info-soft)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 14px', margin: '4px 0 14px', fontSize: 12.5, lineHeight: 1.5 }}>
        <b style={{ color: 'var(--info)' }}>Applies everywhere:</b> saved to the isolated <code>billing_rates</code> table and reloaded in memory — both the admin breakdown and the product billing screen recompute against the new card instantly.
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 12, borderTop: '1px solid var(--line)' }}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save rate card'}</button>
      </div>
    </Modal>
  );
}
