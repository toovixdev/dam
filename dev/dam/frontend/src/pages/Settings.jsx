import { useState, useEffect } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import TabNav from '../components/shared/TabNav';
import { useAuth } from '../context/AuthContext';
import { toast } from '../components/shared/Toast';
import { getBranding, setBranding, resetBranding } from '../branding';
import useApiData from '../hooks/useApiData';
import { apiPut, apiDelete } from '../api/client';

function Toggle({ on, onChange }) {
  return <button className={`switch ${on ? 'on' : ''}`} aria-label="toggle" onClick={onChange} />;
}

function SettingRow({ title, sub, children }) {
  return (
    <div className="set-row">
      <div className="set-txt"><b>{title}</b><small>{sub}</small></div>
      {children}
    </div>
  );
}

export default function Settings() {
  const { user } = useAuth();
  const [tab, setTab] = useState(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return ['gen', 'ret', 'sec', 'pay', 'plan'].includes(t) ? t : 'gen';
  });
  const [toggles, setToggles] = useState({
    airgap: false, ha: true, coldExport: true, legalHold: false,
    mfa: true, byok: true, noNative: true, selfAudit: true,
  });
  const flip = (k) => setToggles((t) => ({ ...t, [k]: !t[k] }));
  const tenant = user?.tenantName || 'Meridian Financial';

  // White-label branding
  const initBrand = getBranding();
  const [bName, setBName] = useState(initBrand.custom ? initBrand.name : '');
  const [bLogo, setBLogo] = useState(initBrand.logo);
  const [bPlace, setBPlace] = useState(initBrand.placement);
  const onLogo = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 512 * 1024) { toast('Logo must be under 512 KB', 'err'); return; }
    const reader = new FileReader();
    reader.onload = () => setBLogo(reader.result);
    reader.readAsDataURL(file);
  };
  const saveBrand = async () => { const ok = await setBranding({ name: bName, logo: bLogo, placement: bPlace }); toast(ok ? 'Branding applied' : 'Could not save branding', ok ? 'ok' : 'err'); };
  const resetBrand = async () => { const ok = await resetBranding(); setBName(''); setBLogo(''); setBPlace('sidebar'); toast(ok ? 'Branding reset to default' : 'Could not reset branding', ok ? 'ok' : 'err'); };

  const usage = [
    { label: 'DBs', value: 47, color: 'var(--primary)' },
    { label: 'Events (B)', value: 9, color: 'var(--info)' },
    { label: 'Storage (TB)', value: 14, color: 'var(--green)' },
    { label: 'Alerts (k)', value: 8, color: 'var(--amber)' },
  ];
  const maxUsage = Math.max(...usage.map((u) => u.value));

  return (
    <Layout>
      <PageHeader title="Settings" meta={[`tenant · ${tenant}`, 'meridian']}>
        <button className="btn-primary" onClick={() => toast('Settings saved', 'ok')}>Save changes</button>
      </PageHeader>

      <TabNav
        tabs={[{ id: 'gen', label: 'General' }, { id: 'ret', label: 'Retention' }, { id: 'sec', label: 'Security' }, { id: 'pay', label: 'Payments' }, { id: 'plan', label: 'Plan & usage' }]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'gen' && (
        <>
        <div className="grid2">
          <div className="card">
            <div className="card-header"><span className="card-title">Tenant</span></div>
            <div className="card-body">
              <div className="form-field"><label>Display name</label><input defaultValue={tenant} /></div>
              <div className="form-field"><label>Data plane region</label>
                <select defaultValue="US — Virginia (primary)">
                  <option>US — Virginia (primary)</option><option>EU — Frankfurt</option><option>UK — London</option><option>Canada — Montreal</option><option>India — Mumbai</option>
                </select>
              </div>
              <div className="form-field"><label>Default theme</label>
                <select defaultValue="Dark"><option>Dark</option><option>Light</option><option>Saffron</option></select>
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-header"><span className="card-title">Deployment</span></div>
            <div className="card-body" style={{ paddingTop: 4 }}>
              <SettingRow title="Hosting model" sub="On-prem · customer Kubernetes"><span className="badge engine">on-prem</span></SettingRow>
              <SettingRow title="Air-gapped mode" sub="Offline licensing + content packs"><Toggle on={toggles.airgap} onChange={() => flip('airgap')} /></SettingRow>
              <SettingRow title="High availability" sub="N+1 gateways · auto-failover"><Toggle on={toggles.ha} onChange={() => flip('ha')} /></SettingRow>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-header"><span className="card-title">Branding (white-label)</span><span className="card-sub">shown in the sidebar</span></div>
          <div className="card-body">
            <div className="form-field"><label>Product name</label>
              <input value={bName} onChange={(e) => setBName(e.target.value)} placeholder="TooVix DAM" />
            </div>
            <div className="form-field"><label>Logo</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {bLogo
                  ? <img src={bLogo} alt="logo preview" style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'contain', background: '#fff', border: '1px solid var(--line)' }} />
                  : <span className="brand-dot" style={{ width: 40, height: 40 }}>{(bName[0] || 'T').toUpperCase()}</span>}
                <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" onChange={onLogo} />
                {bLogo && <button className="btn-secondary" onClick={() => setBLogo('')}>Remove</button>}
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>PNG / SVG / JPG, under 512 KB. Stored in your browser.</div>
            </div>
            <div className="form-field"><label>Logo placement</label>
              <select value={bPlace} onChange={(e) => setBPlace(e.target.value)}>
                <option value="sidebar">Sidebar only</option>
                <option value="header">Header only</option>
                <option value="both">Sidebar + header</option>
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn-primary" onClick={saveBrand}>Apply branding</button>
              <button className="btn-secondary" onClick={resetBrand}>Reset to default</button>
            </div>
          </div>
        </div>

        <WindowCard
          endpoint="/settings/business-hours"
          title="Business hours"
          sub="drives off-hours / after-hours detection"
          desc={<>Access outside these hours (in your timezone) is treated as <b>off-hours</b> by policies such as <b>“Privileged off-hours access.”</b> Set your organisation’s working window and days.</>}
        />
        <WindowCard
          endpoint="/settings/change-window"
          title="DDL change window"
          sub="approved maintenance window for schema changes"
          desc={<>Schema changes (<b>DDL</b>) <b>outside</b> this approved window are flagged by <b>“DDL change control.”</b> Set the window and days your team is allowed to make changes.</>}
        />
        <CloudProviders />
        <FinancialAssumptions />
        </>
      )}

      {tab === 'ret' && (
        <div className="card"><div className="card-body">
          <div className="form-field"><label>Hot retention (audit_events)</label><input defaultValue="90 days" /></div>
          <div className="form-field"><label>Cold / archive retention</label><input defaultValue="7 years (2555 days)" /></div>
          <div className="form-field"><label>Sensitive-access retention</label><input defaultValue="7 years (compliance)" /></div>
          <SettingRow title="Cold export to Parquet" sub="Nightly · immutable blob"><Toggle on={toggles.coldExport} onChange={() => flip('coldExport')} /></SettingRow>
          <SettingRow title="Legal hold" sub="Override TTL for held subjects"><Toggle on={toggles.legalHold} onChange={() => flip('legalHold')} /></SettingRow>
        </div></div>
      )}

      {tab === 'sec' && (
        <div className="card"><div className="card-body" style={{ paddingTop: 4 }}>
          <SettingRow title="Enforce MFA" sub="All users"><Toggle on={toggles.mfa} onChange={() => flip('mfa')} /></SettingRow>
          <SettingRow title="BYOK (customer KMS)" sub="HashiCorp Vault · key rotation 90d"><Toggle on={toggles.byok} onChange={() => flip('byok')} /></SettingRow>
          <SettingRow title="No native DB audit" sub="Self-managed only · PaaS exception"><Toggle on={toggles.noNative} onChange={() => flip('noNative')} /></SettingRow>
          <SettingRow title="Inline blocking fail mode" sub="Fail-open default; fail-closed for crown-jewel DBs"><span className="badge amber">fail-open</span></SettingRow>
          <SettingRow title="Control-plane self-audit" sub="Hash-chained"><Toggle on={toggles.selfAudit} onChange={() => flip('selfAudit')} /></SettingRow>
        </div></div>
      )}

      {tab === 'pay' && <PaymentsTab key={tab} />}

      {tab === 'plan' && (
        <div className="grid2">
          <div className="card">
            <div className="card-header"><span className="card-title">Plan</span></div>
            <div className="card-body">
              <div style={{ fontSize: 22, fontWeight: 800 }}>Enterprise</div>
              <p className="muted" style={{ fontSize: 13 }}>Unlimited databases · all engines · on-prem · air-gap</p>
              <button className="btn-secondary" onClick={() => toast('Plan details')}>Manage plan</button>
            </div>
          </div>
          <div className="card">
            <div className="card-header"><span className="card-title">Usage this month</span></div>
            <div className="card-body">
              <div className="barchart">
                {usage.map((u) => (
                  <div className="barchart-row" key={u.label}>
                    <span className="barchart-label">{u.label}</span>
                    <span className="barchart-track"><span className="barchart-fill" style={{ width: `${(u.value / maxUsage) * 100}%`, background: u.color }} /></span>
                    <span className="barchart-val">{u.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}

// ── Reusable time-window editor (business hours + DDL change window) ───────────
const DOW = [{ v: 1, l: 'Mon' }, { v: 2, l: 'Tue' }, { v: 3, l: 'Wed' }, { v: 4, l: 'Thu' }, { v: 5, l: 'Fri' }, { v: 6, l: 'Sat' }, { v: 7, l: 'Sun' }];
const hhLabel = (h) => `${String(h).padStart(2, '0')}:00`;
function WindowCard({ endpoint, title, sub, desc }) {
  const { data, refetch } = useApiData(endpoint, { poll: 0 });
  const [tz, setTz] = useState('UTC');
  const [start, setStart] = useState(8);
  const [end, setEnd] = useState(18);
  const [days, setDays] = useState([1, 2, 3, 4, 5]);
  const [busy, setBusy] = useState(false);
  const zones = data?.timezones || ['UTC'];

  useEffect(() => {
    if (!data) return;
    setTz(data.timezone || 'UTC');
    setStart(Number.isInteger(data.start) ? data.start : 8);
    setEnd(Number.isInteger(data.end) ? data.end : 18);
    setDays(Array.isArray(data.days) && data.days.length ? data.days : [1, 2, 3, 4, 5]);
  }, [data]);

  const toggleDay = (d) => setDays((p) => (p.includes(d) ? p.filter((x) => x !== d) : [...p, d]).sort((a, b) => a - b));

  const save = async () => {
    if (end <= start) return toast('End hour must be after start hour', 'err');
    if (!days.length) return toast('Pick at least one day', 'err');
    setBusy(true);
    const res = await apiPut(endpoint, { timezone: tz, start: Number(start), end: Number(end), days });
    setBusy(false);
    if (res?.ok) { toast(`${title} saved`, 'ok'); refetch(); }
    else toast(res?.data?.error || 'Could not save', 'err');
  };

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-header">
        <span className="card-title">{title}</span>
        <span className="card-sub">{sub}</span>
      </div>
      <div className="card-body">
        <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 14px' }}>{desc}</p>
        <div className="form-row" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div className="form-field" style={{ flex: 2, minWidth: 180 }}><label>Timezone</label>
            <select value={tz} onChange={(e) => setTz(e.target.value)}>
              {zones.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </div>
          <div className="form-field" style={{ flex: 1, minWidth: 110 }}><label>Work start</label>
            <select value={start} onChange={(e) => setStart(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hhLabel(h)}</option>)}
            </select>
          </div>
          <div className="form-field" style={{ flex: 1, minWidth: 110 }}><label>Work end</label>
            <select value={end} onChange={(e) => setEnd(Number(e.target.value))}>
              {Array.from({ length: 25 }, (_, h) => <option key={h} value={h}>{hhLabel(h)}</option>)}
            </select>
          </div>
        </div>
        <div className="form-field"><label>Days</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {DOW.map((d) => (
              <button key={d.v} type="button" onClick={() => toggleDay(d.v)}
                className={days.includes(d.v) ? 'btn-primary' : 'btn-secondary'}
                style={{ padding: '6px 12px', fontSize: 12.5 }}>{d.l}</button>
            ))}
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
          Window: <b style={{ color: 'var(--ink)' }}>{hhLabel(start)}–{hhLabel(end)} {tz}</b> · {days.map((d) => DOW.find((x) => x.v === d)?.l).join(', ') || '—'}
        </div>
        <div style={{ display: 'flex', gap: 8, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
          <button className="btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : `Save ${title.toLowerCase()}`}</button>
        </div>
      </div>
    </div>
  );
}

// ── Cloud environment — which cloud(s) the tenant runs in (drives cloud discovery) ──
function CloudProviders() {
  const { data, refetch } = useApiData('/settings/cloud-providers', { poll: 0 });
  const [sel, setSel] = useState([]);
  const [busy, setBusy] = useState(false);
  const available = data?.available || [];

  useEffect(() => { if (data?.providers) setSel(data.providers); }, [data]);
  const toggle = (id) => setSel((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const save = async () => {
    setBusy(true);
    const res = await apiPut('/settings/cloud-providers', { providers: sel });
    setBusy(false);
    if (res?.ok) { toast('Cloud environment saved', 'ok'); refetch(); }
    else toast(res?.data?.error || 'Could not save', 'err');
  };

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-header">
        <span className="card-title">Cloud environment</span>
        <span className="card-sub">which clouds to run cloud (agentless) discovery against</span>
      </div>
      <div className="card-body">
        <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 14px' }}>
          Select the cloud(s) your databases run in. The DAM invokes the matching <b>read-only</b>
          discovery adapter per cloud (e.g. Cloud SQL, RDS, Azure SQL) to enumerate managed databases —
          no network scan needed. Self-managed DBs on VMs are still found by the network scanner.
        </p>
        <div style={{ display: 'grid', gap: 8 }}>
          {available.map((p) => (
            <label key={p.id} className="approach-card" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', cursor: 'pointer' }}>
              <input type="checkbox" checked={sel.includes(p.id)} onChange={() => toggle(p.id)} />
              <span style={{ fontSize: 13 }}><b style={{ textTransform: 'uppercase', marginRight: 6 }}>{p.id}</b><span className="muted">{p.label}</span></span>
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, paddingTop: 12, marginTop: 12, borderTop: '1px solid var(--line)' }}>
          <button className="btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save cloud environment'}</button>
        </div>
      </div>
    </div>
  );
}

// ── Financial assumptions — the configurable coefficients behind the Dashboard ROI cards ──
function FinancialAssumptions() {
  const { data, refetch } = useApiData('/settings/financial-assumptions', { poll: 0 });
  const [breach, setBreach] = useState('');
  const [fine, setFine] = useState('');
  const [siem, setSiem] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data) {
      setBreach(data.breach_cost_per_db ?? '');
      setFine(data.fine_per_framework ?? '');
      setSiem(data.siem_cost_per_event ?? '');
    }
  }, [data]);

  const save = async () => {
    setBusy(true);
    const res = await apiPut('/settings/financial-assumptions', {
      breach_cost_per_db: Number(breach),
      fine_per_framework: Number(fine),
      siem_cost_per_event: Number(siem),
    });
    setBusy(false);
    if (res?.ok) { toast('Financial assumptions saved', 'ok'); refetch(); }
    else toast(res?.data?.error || 'Could not save', 'err');
  };

  const inputStyle = { width: 220, padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 6, background: 'var(--bg)', color: 'var(--ink)', fontSize: 13 };

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-header">
        <span className="card-title">Financial assumptions</span>
        <span className="card-sub">the coefficients behind the Dashboard ROI cards</span>
      </div>
      <div className="card-body">
        <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 14px' }}>
          The Dashboard’s <b>Breach Exposure</b>, <b>Compliance Fines Risk</b> and <b>SIEM Cost Saved</b> cards
          are <b>estimates</b> — live data × these per-unit assumptions. Set them to your organisation’s own
          figures. (<b>Monthly Platform Cost</b> is your actual billed amount, not an assumption.)
        </p>
        <label style={{ display: 'block', marginBottom: 12 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 2 }}>Breach cost per database ($)</div>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>assumed loss if a database is breached</div>
          <input type="number" min="0" step="1000" value={breach} onChange={(e) => setBreach(e.target.value)} style={inputStyle} />
        </label>
        <label style={{ display: 'block', marginBottom: 12 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 2 }}>Compliance fine per framework ($)</div>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>assumed fine per framework scoring below 90%</div>
          <input type="number" min="0" step="10000" value={fine} onChange={(e) => setFine(e.target.value)} style={inputStyle} />
        </label>
        <label style={{ display: 'block', marginBottom: 12 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 2 }}>SIEM cost per event ($)</div>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>assumed SIEM ingestion cost avoided per filtered event</div>
          <input type="number" min="0" step="0.0001" value={siem} onChange={(e) => setSiem(e.target.value)} style={inputStyle} />
        </label>
        <div style={{ display: 'flex', gap: 8, paddingTop: 12, marginTop: 12, borderTop: '1px solid var(--line)' }}>
          <button className="btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save assumptions'}</button>
        </div>
      </div>
    </div>
  );
}

// ── Payments tab — configure the Razorpay & PayU gateway credentials ──────────
function PaymentsTab() {
  const { data, refetch } = useApiData('/billing/gateways/config', { poll: 0 });
  return (
    <>
      <p className="muted" style={{ fontSize: 13, margin: '4px 0 16px', lineHeight: 1.5 }}>
        Credentials for taking real payments on the Billing page. Secrets are stored server-side and never
        shown again. Use <b>test/sandbox</b> keys here. With no Razorpay key set, the Billing page opens
        Razorpay's real checkout UI with a public <b>demo</b> key (test cards only).
      </p>
      <div className="grid2">
        <GatewayCard
          provider="razorpay" title="Razorpay" accent="#0c2451"
          info={data?.razorpay}
          fields={[
            { key: 'key_id', label: 'Key ID', placeholder: 'rzp_test_…', secret: false },
            { key: 'key_secret', label: 'Key secret', placeholder: 'Razorpay key secret', secret: true },
          ]}
          help="Razorpay Dashboard → Settings → API Keys (Test Mode). Only the Key ID reaches the browser."
          onSaved={refetch}
        />
        <GatewayCard
          provider="payu" title="PayU" accent="#01bd9b"
          info={data?.payu}
          fields={[
            { key: 'merchant_key', label: 'Merchant key', placeholder: 'PayU merchant key', secret: false },
            { key: 'salt', label: 'Salt', placeholder: 'PayU salt (v1)', secret: true },
            { key: 'mode', label: 'Mode', type: 'select', options: ['test', 'live'] },
          ]}
          help="PayU merchant Test key + salt. Public sandbox creds also work: gtKFFx / eCwWELxi."
          onSaved={refetch}
        />
      </div>
    </>
  );
}

function GatewayCard({ provider, title, accent, info, fields, help, onSaved }) {
  const [vals, setVals] = useState({});
  const [busy, setBusy] = useState(false);
  const idKey = fields[0].key;
  const secretField = fields.find((f) => f.secret);
  const configured = info && (info.source === 'database' || info.source === 'env') && info.source !== 'demo';

  useEffect(() => {
    if (!info) return;
    const init = {};
    fields.forEach((f) => {
      if (f.secret) init[f.key] = '';
      else if (f.key === 'mode') init[f.key] = info.mode || 'test';
      else init[f.key] = (provider === 'razorpay' ? info.keyId : info.merchantKey) || '';
    });
    setVals(init);
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  const setVal = (k, v) => setVals((p) => ({ ...p, [k]: v }));
  const hasSecret = info && (info.hasSecret || info.hasSalt);

  const save = async () => {
    setBusy(true);
    const body = {};
    Object.entries(vals).forEach(([k, v]) => { if (v !== '' && v != null) body[k] = typeof v === 'string' ? v.trim() : v; });
    const res = await apiPut(`/billing/gateways/${provider}`, body);
    setBusy(false);
    if (res?.ok) { toast(`${title} saved — live mode`, 'ok'); onSaved?.(); }
    else toast(res?.data?.error || 'Failed to save', 'err');
  };
  const disconnect = async () => {
    setBusy(true);
    const res = await apiDelete(`/billing/gateways/${provider}`);
    setBusy(false);
    if (res?.ok) { toast(`${title} disconnected`, 'ok'); onSaved?.(); }
    else toast(res?.data?.error || 'Failed to remove', 'err');
  };

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 22, height: 22, borderRadius: 6, background: accent, display: 'inline-block' }} />{title}
        </span>
        <span className="badge" style={{ background: configured ? 'var(--green-soft)' : 'var(--surface-2)', color: configured ? 'var(--green)' : 'var(--muted)', borderColor: 'transparent' }}>
          {info?.source === 'database' ? 'Live · saved' : info?.source === 'env' ? 'Live · env' : info?.source === 'demo' ? 'Demo (test UI)' : 'Not configured'}
        </span>
      </div>
      <div className="card-body">
        <p className="muted" style={{ fontSize: 12, margin: '0 0 12px', lineHeight: 1.5 }}>{help}</p>
        {fields.map((f) => (
          <div className="form-field" key={f.key}>
            <label style={{ textTransform: 'capitalize' }}>
              {f.label}{f.secret && hasSecret && <span className="muted"> (stored — leave blank to keep)</span>}
            </label>
            {f.type === 'select' ? (
              <select value={vals[f.key] ?? 'test'} onChange={(e) => setVal(f.key, e.target.value)}>
                {f.options.map((o) => <option key={o} value={o}>{o === 'test' ? 'Test / sandbox' : 'Live / production'}</option>)}
              </select>
            ) : (
              <input type={f.secret ? 'password' : 'text'} value={vals[f.key] ?? ''} placeholder={f.secret && hasSecret ? '••••••••' : f.placeholder} autoComplete={f.secret ? 'new-password' : 'off'} onChange={(e) => setVal(f.key, e.target.value)} />
            )}
          </div>
        ))}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
          {configured ? <button className="btn-secondary" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} disabled={busy} onClick={disconnect}>Disconnect</button> : <span />}
          <button className="btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save keys'}</button>
        </div>
      </div>
    </div>
  );
}
