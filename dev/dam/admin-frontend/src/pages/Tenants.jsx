import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import KpiCard from '../components/KpiCard';
import PageHeader from '../components/shared/PageHeader';
import Modal from '../components/shared/Modal';
import { toast } from '../components/shared/Toast';
import useApiData from '../hooks/useApiData';
import { apiPost } from '../api/client';

function formatNumber(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n ?? 0);
}

const TIER_LABEL = { enterprise: 'Enterprise', business: 'Business', professional: 'Professional', starter: 'Starter' };
const STATUS_META = {
  active:      { cls: 'status-green',  label: 'Active' },
  trial:       { cls: 'sev-high',      label: 'Trial' },
  suspended:   { cls: 'sev-critical',  label: 'Suspended' },
  offboarding: { cls: 'sev-critical',  label: 'Offboarding' },
};

function healthColor(h) { return h >= 80 ? 'var(--green)' : h >= 60 ? 'var(--amber)' : 'var(--danger)'; }

function StatusBadge({ status }) {
  const m = STATUS_META[status] || { cls: 'status-gray', label: status };
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function Tenants() {
  const navigate = useNavigate();
  const { data: tenants, loading, lastRefresh, refetch } = useApiData('/admin/tenants', { poll: 30000 });
  const { data: summary, refetch: refetchSummary } = useApiData('/admin/tenants/summary', { poll: 30000 });
  const [query, setQuery] = useState('');
  const [manage, setManage] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);

  const refreshAll = () => { refetch(); refetchSummary(); };

  if (loading && !tenants) {
    return <div className="loading-screen"><div className="loading-spinner" /><p>Loading tenants...</p></div>;
  }

  const list = (tenants || []).filter(t => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (`${t.name} ${t.slug} ${t.region || ''}`).toLowerCase().includes(q);
  });

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refreshAll}>
      <PageHeader
        title="Tenants"
        meta={[
          `${summary?.active ?? 0} active`,
          `${summary?.regions ?? 0} regions`,
          `${summary?.plans ?? 0} plans`,
        ]}
      >
        <button className="btn-primary" onClick={() => setCreateOpen(true)}>＋ Create tenant</button>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="●" iconBg="var(--green-soft)" iconColor="var(--green)"
          label="Active" value={summary?.active ?? 0} detail={`${summary?.total ?? 0} total tenants`} detailType="up" />
        <KpiCard icon="⏱" iconBg="var(--amber-soft)" iconColor="var(--amber)"
          label="Trial" value={summary?.trial ?? 0} detail="in evaluation" />
        <KpiCard icon="⚠" iconBg="var(--danger-soft)" iconColor="var(--danger)"
          label="Suspended" value={(summary?.suspended ?? 0) + (summary?.offboarding ?? 0)}
          detail={summary?.offboarding ? `${summary.offboarding} offboarding` : 'none'} detailType={summary?.suspended ? 'down' : ''} />
        <KpiCard icon="▥" iconBg="var(--info-soft)" iconColor="var(--info)"
          label="Total DBs" value={formatNumber(summary?.totalDatabases ?? 0)} detail="across all tenants" />
      </section>

      <div className="card">
        <div className="card-header">
          <span className="card-title">All Tenants</span>
          <input
            className="db-filter" placeholder="Filter tenants..." value={query}
            onChange={(e) => setQuery(e.target.value)} style={{ marginLeft: 'auto', maxWidth: 220 }}
          />
        </div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead>
              <tr>
                <th>Tenant</th><th>Plan</th><th>Region</th>
                <th className="num">Databases</th><th className="num">Events/day</th><th className="num">Agents</th>
                <th>Status</th><th>Health</th><th></th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && (
                <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  {query ? 'No tenants match your filter' : 'No tenants registered'}
                </td></tr>
              )}
              {list.map(t => (
                <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => setManage(t)}>
                  <td><b>{t.name}</b><br /><small className="muted">{t.slug}</small></td>
                  <td><span className="badge engine">{TIER_LABEL[t.tier] || t.tier}</span></td>
                  <td className="muted">{t.region || '—'}</td>
                  <td className="num">{t.databases}</td>
                  <td className="num">{formatNumber(t.eventsPerDay)}</td>
                  <td className="num">{t.agents.online}/{t.agents.total}</td>
                  <td><StatusBadge status={t.status} /></td>
                  <td><b style={{ color: healthColor(t.health) }}>{t.health}</b><span className="muted" style={{ fontSize: 11 }}>/100</span></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button className="btn-secondary" style={{ padding: '5px 12px' }} onClick={() => setManage(t)}>Manage</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ManageModal tenant={manage} onClose={() => setManage(null)} navigate={navigate} onChanged={refreshAll} />
      <CreateWizard open={createOpen} onClose={() => setCreateOpen(false)} onCreated={refreshAll} />
    </Layout>
  );
}

// ─────────────────────────────────────────────────────────────
// Manage modal — read detail + lifecycle actions.
// Status-changing actions are PROTOTYPE (toast only) so the live tenant the
// product app logs into is never disrupted; "Export"/"Migrate" are likewise stubs.
// ─────────────────────────────────────────────────────────────
const QUICK_LINKS = [
  { label: 'Tenant Health', to: '/tenant-health', bg: 'var(--green-soft)', color: 'var(--green)', ic: '◉' },
  { label: 'Feature Flags', to: '/feature-flags', bg: 'var(--primary-soft)', color: 'var(--primary)', ic: '⚑' },
  { label: 'Resource Quotas', to: '/quotas', bg: 'var(--amber-soft)', color: 'var(--amber)', ic: '◫' },
  { label: 'Impersonate', to: '/impersonation', bg: 'var(--info-soft)', color: 'var(--info)', ic: '◑' },
  { label: 'Billing & Usage', to: '/billing', bg: 'var(--amber-soft)', color: 'var(--amber)', ic: '◈' },
  { label: 'Audit Log', to: '/audit', bg: 'var(--surface-2)', color: 'var(--muted)', ic: '⛓' },
];

function Row({ k, v }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13, borderBottom: '1px solid var(--line-2)' }}>
      <span className="muted">{k}</span>
      <span style={{ fontWeight: 600, textAlign: 'right' }}>{v}</span>
    </div>
  );
}

function Section({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--subtle)', margin: '16px 0 8px' }}>{children}</div>;
}

function ManageModal({ tenant: t, onClose, navigate, onChanged }) {
  if (!t) return null;
  const isTrial = t.status === 'trial';
  const isSuspended = t.status === 'suspended';
  const proto = (msg) => { toast(msg, 'ok'); onClose(); };
  // Suspend/Offboard don't change the tenant directly (prototype) — they submit a
  // REAL approval request to the Approvals queue (multi-party sign-off).
  const requestApproval = async (type, detail) => {
    const r = await apiPost('/admin/approvals', { type, tenantId: t.id, detail, initiatedBy: 'Platform Ops' });
    if (r.ok) toast(`${r.data.approval.ref} submitted to Approvals — awaiting sign-off`, 'ok');
    else toast(r.data?.error || 'Failed to submit request', 'err');
    onClose();
  };

  return (
    <Modal open={!!t} onClose={onClose} title={t.name} width={760}>
      {/* Status bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 10, marginBottom: 16 }}>
        <StatusBadge status={t.status} />
        <span style={{ fontSize: 13, color: 'var(--muted)', fontFamily: 'ui-monospace, Menlo, monospace' }}>{t.slug}</span>
        <span style={{ marginLeft: 'auto', fontSize: 13 }}>Health <b style={{ color: healthColor(t.health) }}>{t.health}/100</b></span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <Section>Tenant Details</Section>
          <Row k="Organization" v={t.name} />
          <Row k="Slug" v={<span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>{t.slug}</span>} />
          <Row k="Plan" v={<span className="badge engine">{TIER_LABEL[t.tier] || t.tier}</span>} />
          <Row k="Region" v={t.region || '—'} />
          <Row k="Deployment" v={t.deployment_type || '—'} />
          <Row k="Created" v={fmtDate(t.created_at)} />
        </div>
        <div>
          <Section>Configuration</Section>
          <Row k="Primary admin" v={t.admin || '—'} />
          <Row k="Admin email" v={t.adminEmail || '—'} />
          <Row k="SSO provider" v={t.sso} />
          <Row k="Cloud" v={t.cloud_provider || 'Platform default'} />
          <Row k="Open alerts" v={t.openAlerts} />
          <Row k="Monitored DBs" v={`${t.monitoredDatabases} / ${t.databases}`} />
        </div>
      </div>

      <Section>Usage</Section>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Row k="Databases" v={t.databases} />
        <Row k="Events/day" v={formatNumber(t.eventsPerDay)} />
        <Row k="Agents" v={`${t.agents.online} / ${t.agents.total} online`} />
        <Row k="Health score" v={<span style={{ color: healthColor(t.health) }}>{t.health}/100</span>} />
      </div>

      <Section>Quick Links</Section>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {QUICK_LINKS.map(l => (
          <button key={l.label} className="btn-secondary" style={{ justifyContent: 'flex-start' }}
            onClick={() => { onClose(); navigate(l.to); }}>
            <span className="kpi-icon" style={{ background: l.bg, color: l.color, width: 24, height: 24, fontSize: 12 }}>{l.ic}</span>
            {l.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
        <button className="btn-secondary" onClick={() => proto(`Reset password for ${t.admin || t.slug} — temp password generated, MFA re-enrollment required`)}>🔒 Reset admin password</button>
        <button className="btn-secondary" onClick={() => proto(`${t.slug} — all user sessions terminated`)}>⎋ Force logout</button>
        <button className="btn-secondary" onClick={() => proto(`Export started for ${t.slug}`)}>⭳ Export data</button>
        {isTrial && <button className="btn-primary" onClick={() => proto(`${t.slug} — trial extended 14 days`)}>↻ Extend trial</button>}
        {isSuspended
          ? <button className="btn-primary" onClick={() => proto(`${t.slug} unsuspended — agents resuming`)}>✓ Unsuspend</button>
          : <button className="btn-secondary" style={{ borderColor: 'var(--amber)', color: 'var(--amber)' }} onClick={() => requestApproval('suspension', 'Operational suspension request')}>⚠ Request suspension</button>}
        <button className="btn-secondary" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => requestApproval('offboarding', 'Offboarding · contract review')}>⛔ Request offboarding</button>
      </div>
      <p className="muted" style={{ fontSize: 11, marginTop: 10 }}>
        Reset / logout / export are prototype-only. <b>Suspend</b> and <b>Offboard</b> submit a real
        multi-party approval request (visible in Approvals) — the tenant record itself is never changed here.
      </p>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────
// Create tenant wizard — 3 steps. The final step performs a REAL POST.
// ─────────────────────────────────────────────────────────────
const DEPLOY_CARDS = [
  { id: 'saas', ic: '☁', title: 'SaaS (Multi-tenant)', desc: 'Fully managed on TooVix cloud. Shared infra with tenant isolation. Fastest to provision.' },
  { id: 'cloud', ic: '⚙', title: 'Customer Cloud', desc: "Data plane runs in the customer's AWS / Azure / GCP / OCI account. Control plane on TooVix." },
  { id: 'onprem', ic: '◆', title: 'On-prem / Air-gapped', desc: "Full stack in the customer's data center. No cloud dependency." },
];
const PROVISION_STEPS = [
  'Creating tenant record (Postgres + RLS)',
  'Provisioning ClickHouse schema + partitions',
  'Creating ingestion stream + blob storage',
  'Generating encryption keys + mTLS certificates',
  'Inviting tenant admin + deploying content packs',
];

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
}

function CreateWizard({ open, onClose, onCreated }) {
  const [step, setStep] = useState(1);
  const [slugEdited, setSlugEdited] = useState(false);
  const [form, setForm] = useState({
    name: '', slug: '', plan: 'enterprise', adminName: '', adminEmail: '',
    deploy: 'saas', cloud: 'azure', region: 'eastus',
  });
  const [provisioning, setProvisioning] = useState(false);
  const [doneSteps, setDoneSteps] = useState(0);
  const [result, setResult] = useState(null); // 'success' | { error }

  // Cloud regions come from the master table (GET /api/reference/cloud-regions),
  // not a hardcoded list, so the catalog can change without a frontend rebuild.
  const { data: cloudRegions } = useApiData('/reference/cloud-regions');
  const regionsFor = (cloud) => cloudRegions?.[cloud] || [];

  const set = (patch) => setForm(f => ({ ...f, ...patch }));

  // Once regions load (or the cloud changes), make sure the selected region is
  // valid for the current cloud — default to that cloud's first region if not.
  useEffect(() => {
    const list = regionsFor(form.cloud);
    if (list.length && !list.some(r => r.v === form.region)) set({ region: list[0].v });
  }, [cloudRegions, form.cloud]); // eslint-disable-line react-hooks/exhaustive-deps

  function reset() {
    setStep(1); setSlugEdited(false); setProvisioning(false); setDoneSteps(0); setResult(null);
    setForm({ name: '', slug: '', plan: 'enterprise', adminName: '', adminEmail: '', deploy: 'saas', cloud: 'azure', region: 'eastus' });
  }
  function close() { reset(); onClose(); }

  function next1() {
    if (!form.name || !form.slug || !form.adminEmail) { toast('Please fill in all required fields', 'err'); return; }
    setStep(2);
  }

  async function provision() {
    setStep(3);
    setProvisioning(true);
    setResult(null);
    setDoneSteps(0);

    // Cosmetic provisioning animation while the real create runs.
    let i = 0;
    const tick = setInterval(() => { i += 1; setDoneSteps(Math.min(i, PROVISION_STEPS.length)); if (i >= PROVISION_STEPS.length) clearInterval(tick); }, 650);

    const status = form.plan === 'trial' ? 'trial' : 'active';
    const tier = form.plan === 'trial' ? 'starter' : form.plan;
    const body = {
      name: form.name, slug: form.slug, tier, status,
      deployment_type: form.deploy,
      cloud_provider: form.deploy === 'onprem' ? null : form.cloud,
      data_region: form.region,
      adminName: form.adminName, adminEmail: form.adminEmail,
    };

    const res = await apiPost('/admin/tenants', body);
    clearInterval(tick);
    setDoneSteps(PROVISION_STEPS.length);

    if (res.ok) {
      setResult('success');
      toast(`${form.name} provisioned on ${form.region}`, 'ok');
      onCreated();
    } else {
      setResult({ error: res.data?.error || 'Provisioning failed' });
      toast(res.data?.error || 'Provisioning failed', 'err');
    }
    setProvisioning(false);
  }

  const title = step === 3
    ? (result === 'success' ? `Provisioned — ${form.name}` : result ? `Failed — ${form.name}` : `Provisioning — ${form.name}`)
    : step === 2 ? `Deployment — ${form.name || 'New tenant'}` : 'Create Tenant';

  return (
    <Modal open={open} onClose={close} title={title} width={820}>
      <Stepper step={step} />

      {step === 1 && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <Section>Organization</Section>
              <div className="form-field"><label>Organization name *</label>
                <input value={form.name} placeholder="e.g. Meridian Financial"
                  onChange={(e) => { const name = e.target.value; set({ name, ...(slugEdited ? {} : { slug: slugify(name) }) }); }} /></div>
              <div className="form-field"><label>Tenant slug *</label>
                <input value={form.slug} style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }} placeholder="e.g. meridian-fin"
                  onChange={(e) => { setSlugEdited(true); set({ slug: e.target.value }); }} /></div>
              <Section>Plan</Section>
              <div className="form-field"><label>Plan</label>
                <select value={form.plan} onChange={(e) => set({ plan: e.target.value })}>
                  <option value="enterprise">Enterprise</option>
                  <option value="business">Business</option>
                  <option value="starter">Starter</option>
                  <option value="trial">Trial (14 days)</option>
                </select></div>
            </div>
            <div>
              <Section>Tenant Admin</Section>
              <div className="form-field"><label>Admin name</label>
                <input value={form.adminName} placeholder="e.g. Sarah Chen" onChange={(e) => set({ adminName: e.target.value })} /></div>
              <div className="form-field"><label>Admin email *</label>
                <input value={form.adminEmail} placeholder="e.g. s.chen@meridianfg.com" onChange={(e) => set({ adminEmail: e.target.value })} /></div>
              <Section>Identity</Section>
              <div className="form-field">
                <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, background: 'var(--surface-2, rgba(148,163,184,.08))', border: '1px solid var(--line)', borderRadius: 8, padding: '10px 12px' }}>
                  🔐 The first admin signs in with <b>email + password</b> and is required to set up <b>MFA</b>.
                  Single sign-on (Azure AD, Okta, Google) is enabled later from <b>Integrations → SSO</b> inside the workspace.
                </div>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line)', justifyContent: 'flex-end' }}>
            <button className="btn-secondary" onClick={close}>Cancel</button>
            <button className="btn-primary" onClick={next1}>Next →</button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <p className="muted" style={{ fontSize: 13, margin: '0 0 16px', lineHeight: 1.5 }}>
            Choose how this tenant is deployed. This determines how infrastructure is provisioned.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
            {DEPLOY_CARDS.map(c => (
              <button key={c.id} onClick={() => set({ deploy: c.id })}
                className="card" style={{
                  textAlign: 'center', padding: 14, cursor: 'pointer',
                  borderColor: form.deploy === c.id ? 'var(--primary)' : 'var(--line)',
                  background: form.deploy === c.id ? 'var(--primary-soft)' : 'var(--surface)',
                }}>
                <div style={{ fontSize: 24, marginBottom: 8 }}>{c.ic}</div>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>{c.title}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.4 }}>{c.desc}</div>
              </button>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {form.deploy !== 'onprem' && (
              <div className="form-field"><label>{form.deploy === 'saas' ? 'Hosting cloud' : 'Customer cloud'}</label>
                <select value={form.cloud} onChange={(e) => set({ cloud: e.target.value })}>
                  <option value="azure">Azure</option><option value="aws">AWS</option>
                  <option value="gcp">GCP</option><option value="oci">OCI</option>
                </select></div>
            )}
            <div className="form-field"><label>Data region</label>
              <select value={form.region} onChange={(e) => set({ region: e.target.value })} disabled={!regionsFor(form.cloud).length}>
                {regionsFor(form.cloud).length
                  ? regionsFor(form.cloud).map(r => <option key={r.v} value={r.v}>{r.l}</option>)
                  : <option value="">Loading regions…</option>}
              </select></div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line)', justifyContent: 'flex-end' }}>
            <button className="btn-secondary" onClick={() => setStep(1)}>← Back</button>
            <button className="btn-primary" onClick={provision}>Provision tenant →</button>
          </div>
        </>
      )}

      {step === 3 && (
        <div style={{ marginTop: 4 }}>
          {!result && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {PROVISION_STEPS.map((s, i) => {
                const state = i < doneSteps ? 'done' : i === doneSteps && provisioning ? 'active' : '';
                return (
                  <div key={s} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', borderRadius: 10,
                    background: state === 'done' ? 'var(--green-soft)' : state === 'active' ? 'var(--primary-soft)' : 'var(--surface-2)',
                    border: `1px solid ${state === 'done' ? 'var(--green)' : state === 'active' ? 'var(--primary)' : 'var(--line)'}`,
                  }}>
                    <span style={{
                      width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 13, fontWeight: 700, flex: 'none', color: '#fff',
                      background: state === 'done' ? 'var(--green)' : state === 'active' ? 'var(--primary)' : 'var(--muted)',
                    }}>{state === 'done' ? '✓' : i + 1}</span>
                    <span style={{ fontSize: 13.5, fontWeight: 500 }}>{s}</span>
                    <span className="muted" style={{ marginLeft: 'auto', fontSize: 11 }}>{state === 'done' ? 'done' : state === 'active' ? 'working…' : ''}</span>
                  </div>
                );
              })}
            </div>
          )}

          {result === 'success' && (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <div style={{ width: 56, height: 56, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, background: 'var(--green-soft)', color: 'var(--green)', marginBottom: 12 }}>✓</div>
              <h3 style={{ margin: '0 0 4px' }}>Tenant provisioned</h3>
              <p className="muted" style={{ maxWidth: 460, margin: '0 auto 18px' }}>
                <b>{form.name}</b> ({form.slug}) is live on <b>{form.region}</b>. An invitation was sent to <b>{form.adminEmail}</b>.
              </p>
              <button className="btn-primary" onClick={close}>Done</button>
            </div>
          )}

          {result && result.error && (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <div style={{ width: 56, height: 56, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, background: 'var(--danger-soft)', color: 'var(--danger)', marginBottom: 12 }}>✗</div>
              <h3 style={{ margin: '0 0 4px' }}>Provisioning failed</h3>
              <p className="muted" style={{ maxWidth: 460, margin: '0 auto 18px' }}>{result.error}</p>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                <button className="btn-secondary" onClick={() => setStep(1)}>← Edit details</button>
                <button className="btn-primary" onClick={provision}>↻ Retry</button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function Stepper({ step }) {
  const labels = ['Tenant Details', 'Deployment', 'Provisioning'];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: 20, padding: '0 4px' }}>
      {labels.map((l, i) => {
        const n = i + 1;
        const state = n < step ? 'done' : n === step ? 'active' : '';
        const color = state === 'done' ? 'var(--green)' : state === 'active' ? 'var(--primary)' : 'var(--subtle)';
        return (
          <div key={l} style={{ display: 'flex', alignItems: 'center', flex: i < labels.length - 1 ? 1 : 'none' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color }}>
              <span style={{
                width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 700, color: state ? '#fff' : 'var(--subtle)',
                background: state === 'done' ? 'var(--green)' : state === 'active' ? 'var(--primary)' : 'var(--surface)',
                border: `1.5px solid ${state ? color : 'var(--line)'}`,
              }}>{n < step ? '✓' : n}</span>
              {l}
            </span>
            {i < labels.length - 1 && <span style={{ flex: 1, height: 1.5, background: n < step ? 'var(--green)' : 'var(--line)', margin: '0 10px', minWidth: 24 }} />}
          </div>
        );
      })}
    </div>
  );
}
