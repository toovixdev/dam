import { useState, useEffect } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/KpiCard';
import Modal from '../components/shared/Modal';
import { toast } from '../components/shared/Toast';
import useApiData from '../hooks/useApiData';
import { apiPut, apiPost, apiDelete } from '../api/client';
import { useAuth } from '../context/AuthContext';

// Connector cards. `type` connectors are alert-delivery channels (config rendered
// from the backend /integrations/catalog schema); `kind:'sso'` are read-only status
// cards; `kind:'smtp'` is the mail server. Icons/category/copy are presentational.
const CONNECTORS = [
  { id: 'splunk', name: 'Splunk', category: 'SIEM', description: 'Forward alerts to Splunk via HTTP Event Collector', logo: 'S', color: '#65a637', real: true, type: 'splunk' },
  { id: 'sentinel', name: 'Microsoft Sentinel', category: 'SIEM', description: 'Stream alerts to a Log Analytics workspace', logo: 'Se', color: '#0078d4', real: true, type: 'sentinel' },
  { id: 'servicenow', name: 'ServiceNow', category: 'ITSM', description: 'Auto-create incidents from alerts', logo: 'SN', color: '#62a39d', real: true, type: 'servicenow' },
  { id: 'pagerduty', name: 'PagerDuty', category: 'Alerting', description: 'Trigger on-call incidents for alerts', logo: 'PD', color: '#06ac38', real: true, type: 'pagerduty' },
  { id: 'slack', name: 'Slack', category: 'Messaging', description: 'Post alerts to a Slack channel via incoming webhook', logo: '#', color: '#4a154b', real: true, type: 'slack' },
  { id: 'teams', name: 'Microsoft Teams', category: 'Messaging', description: 'Post alerts to a Teams channel via incoming webhook', logo: 'T', color: '#6264a7', real: true, type: 'msteams' },
  { id: 'azure-ad', name: 'Azure AD', category: 'Identity', description: 'SSO sign-in via Azure AD / Entra ID', logo: 'AD', color: '#0078d4', real: true, kind: 'sso', provider: 'azure' },
  { id: 'okta', name: 'Okta', category: 'Identity', description: 'SSO authentication via Okta (OIDC)', logo: 'O', color: '#007dc1', real: true, kind: 'sso', provider: 'okta' },
  { id: 'google', name: 'Google', category: 'Identity', description: 'SSO sign-in via Google (OIDC)', logo: 'G', color: '#ea4335', real: true, kind: 'sso', provider: 'google' },
  { id: 'jira', name: 'Jira Service Management', category: 'ITSM', description: 'Create incidents from alerts (Service Desk)', logo: 'J', color: '#0052cc', real: true, type: 'jira' },
  { id: 'datadog', name: 'Datadog', category: 'Monitoring', description: 'Send alert events to Datadog', logo: 'DD', color: '#632ca6', real: true, type: 'datadog' },
  { id: 'webhook', name: 'Custom Webhook', category: 'Custom', description: 'POST alert events to any HTTPS endpoint', logo: '{ }', color: '#0ea5e9', real: true, type: 'webhook' },
  { id: 'email', name: 'Email (SMTP)', category: 'Alerting', description: 'Mail-server connection for invitations & notifications', logo: '@', color: '#0891b2', real: true, kind: 'smtp' },
  { id: 'email_alerts', name: 'Email alerts', category: 'Alerting', description: 'Email alerts to a recipient list (uses your SMTP)', logo: '✉', color: '#0891b2', real: true, type: 'email_alerts' },
];

export default function Integrations() {
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [filter, setFilter] = useState('all');
  const [configType, setConfigType] = useState(null); // alert-connector type | null
  const [ssoProvider, setSsoProvider] = useState(null); // 'azure' | 'okta' | null
  const [smtpOpen, setSmtpOpen] = useState(false);
  const { data: integrations, refetch } = useApiData('/integrations', { poll: 0 });
  const { data: catalog } = useApiData('/integrations/catalog', { poll: 0 });
  const { data: azure, refetch: refetchAzure } = useApiData('/integrations/sso/azure', { poll: 0 });
  const { data: okta, refetch: refetchOkta } = useApiData('/integrations/sso/okta', { poll: 0 });
  const { data: google, refetch: refetchGoogle } = useApiData('/integrations/sso/google', { poll: 0 });
  const { data: smtp, refetch: refetchSmtp } = useApiData('/integrations/smtp', { poll: 0 });

  const handleRefresh = () => { setLastRefresh(new Date()); refetch(); refetchSmtp(); };
  const byType = (t) => (integrations || []).find(i => i.type === t);

  // Overlay live status onto the real connectors.
  const connectors = CONNECTORS.map(c => {
    if (!c.real) return c;
    if (c.kind === 'sso') { const info = { azure, okta, google }[c.provider]; const on = info?.configured && info?.enabledForTenant; return { ...c, status: on ? 'connected' : 'disconnected', sso: info }; }
    if (c.kind === 'smtp') return { ...c, status: smtp?.configured ? 'connected' : 'disconnected', smtp };
    const integ = byType(c.type);
    return { ...c, status: integ?.status === 'active' ? 'connected' : 'disconnected', cfg: integ?.config };
  });

  const connected = connectors.filter(c => c.status === 'connected').length;
  const disconnected = connectors.filter(c => c.status === 'disconnected').length;
  const categories = [...new Set(connectors.map(c => c.category))];

  const filtered = filter === 'all' ? connectors
    : filter === 'connected' ? connectors.filter(c => c.status === 'connected')
    : filter === 'disconnected' ? connectors.filter(c => c.status === 'disconnected')
    : connectors.filter(c => c.category === filter);

  const activeConnector = connectors.find(c => c.type === configType);

  return (
    <Layout activePage="integrations" lastRefresh={lastRefresh} onRefresh={handleRefresh}>
      <PageHeader title="Integrations" meta={[`${connected} connected`, `${connectors.length} available connectors`]}>
        <button className="btn-primary" onClick={() => alert('Request integration coming soon')}>+ Request Integration</button>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="◈" label="Total Connectors" value={connectors.length} detail="available integrations" />
        <KpiCard icon="◉" iconBg="var(--green-soft)" iconColor="var(--green)" label="Connected" value={connected} detail="active and syncing" detailType="up" />
        <KpiCard icon="○" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Disconnected" value={disconnected} detail="available to set up" />
        <KpiCard icon="◧" iconBg="var(--info-soft)" iconColor="var(--info)" label="Categories" value={categories.length} detail="SIEM, ITSM, Identity, etc." />
      </section>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {['all', 'connected', 'disconnected', ...categories].map(f => (
          <button key={f} className={filter === f ? 'btn-primary' : 'btn-secondary'} style={{ padding: '6px 14px', fontSize: 13, textTransform: 'capitalize' }} onClick={() => setFilter(f)}>{f}</button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
        {filtered.map(connector => {
          const connected = connector.status === 'connected';
          const detail = connector.kind === 'sso' && connected && connector.sso
            ? <><b>{connector.sso.usersProvisioned}</b> users via SSO · {connector.provider === 'okta' ? connector.sso.domain : `tenant ${String(connector.sso.tenantId || '').slice(0, 8)}…`}</>
            : connector.kind === 'smtp' && connected && connector.smtp
            ? <>{connector.smtp.source === 'env' ? 'Via environment' : connector.smtp.saved?.host} · from <b>{connector.smtp.from}</b></>
            : connector.type && connected && connector.cfg
            ? <>Forwarding ≥ <b>{connector.cfg.minSeverity || 'high'}</b> on every alert</>
            : null;
          return (
            <div className="card" key={connector.id} style={{ display: 'flex', flexDirection: 'column' }}>
              <div className="card-body" style={{ padding: 18, display: 'flex', flexDirection: 'column', flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                  <span style={{ width: 42, height: 42, flex: 'none', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: connector.logo.length > 1 ? 14 : 19, fontWeight: 800, color: '#fff', background: connector.color, letterSpacing: connector.logo.length > 1 ? '-.5px' : 0, boxShadow: 'inset 0 1px 0 rgba(255,255,255,.18)' }}>{connector.logo}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 14.5, lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{connector.name}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{connector.category}</div>
                  </div>
                </div>
                <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 10px', lineHeight: 1.5, minHeight: 38 }}>{connector.description}</p>
                {detail && <p style={{ fontSize: 11.5, color: 'var(--subtle, var(--muted))', margin: '0 0 12px', lineHeight: 1.4, wordBreak: 'break-word' }}>{detail}</p>}
                <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingTop: 4 }}>
                  <span className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: connected ? 'var(--green-soft)' : 'var(--surface-2)', color: connected ? 'var(--green)' : 'var(--muted)', borderColor: 'transparent' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: connected ? 'var(--green)' : 'var(--muted)' }} />
                    {connected ? 'Connected' : 'Available'}
                  </span>
                  <button
                    className={connected ? 'btn-secondary' : 'btn-primary'}
                    style={{ padding: '7px 16px', fontSize: 12.5, borderRadius: 9 }}
                    onClick={() => connector.kind === 'sso' ? setSsoProvider(connector.provider) : connector.kind === 'smtp' ? setSmtpOpen(true) : connector.type ? setConfigType(connector.type) : alert(`${connector.name} configuration coming soon`)}
                  >
                    {connector.kind === 'sso' ? (connector.provider === 'azure' ? 'View status' : 'Configure') : connected ? 'Configure' : 'Connect'}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <IntegrationModal
        open={!!configType}
        type={configType}
        schema={configType ? catalog?.[configType] : null}
        title={activeConnector ? `Configure ${activeConnector.name}` : ''}
        accent={activeConnector?.color}
        logo={activeConnector?.logo}
        category={activeConnector?.category}
        current={activeConnector?.cfg}
        connected={activeConnector?.status === 'connected'}
        onClose={() => setConfigType(null)}
        onSaved={refetch}
      />
      <SsoModal provider={ssoProvider} azure={azure} okta={okta} google={google} onClose={() => setSsoProvider(null)} onSaved={() => { refetchAzure(); refetchOkta(); refetchGoogle(); }} />
      <SmtpModal open={smtpOpen} info={smtp} onClose={() => setSmtpOpen(false)} onSaved={refetchSmtp} />
    </Layout>
  );
}

// Read-only SSO status card for Azure AD or Okta (both env-configured). Mirrors the
// provider's config + live provisioning, with a Test sign-in that opens its flow.
const SSO_META = {
  azure: {
    title: 'Azure AD / Entra ID — Single Sign-On', signIn: '/auth/azure',
    intro: 'Users sign in with their Microsoft work account and are provisioned just-in-time on first login. Managed via the platform environment (read-only).',
    rows: (i) => [
      ['Tenant ID', i?.tenantId || '—'], ['Client (application) ID', i?.clientId || '—'],
      ['Client secret', i?.secretConfigured ? 'Configured ✓' : 'Missing'],
      ['Redirect URI', i?.redirectUri || '—'], ['Authority', i?.authority || '—'],
    ],
    envHint: <>Set <code>AZURE_CLIENT_ID</code>, <code>AZURE_TENANT_ID</code>, <code>AZURE_CLIENT_SECRET</code> and <code>AZURE_REDIRECT_URI</code> in the platform environment to enable Azure AD sign-in.</>,
  },
  okta: {
    title: 'Okta — Single Sign-On', signIn: '/auth/okta',
    intro: 'Users sign in with their Okta account (OIDC). Configure your workspace’s Okta credentials below, enable it, then it appears on this workspace’s login.',
    rows: () => [],
    envHint: null,
  },
  google: {
    title: 'Google — Single Sign-On', signIn: '/auth/google',
    intro: 'Users sign in with their Google account (OIDC). Configure your workspace’s Google OAuth credentials below, enable it, then it appears on this workspace’s login.',
    rows: () => [],
    envHint: null,
  },
};

function SsoModal({ provider, azure, okta, google, onClose, onSaved }) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const info = { azure, okta, google }[provider];
  const isOkta = provider === 'okta';
  const isGoogle = provider === 'google';
  const isTenantCfg = isOkta || isGoogle; // credentials configured in the GUI (not env)
  const providerName = isGoogle ? 'Google' : isOkta ? 'Okta' : 'Azure AD';
  // Credential form (per-tenant, GUI-configured). Prefill from status (secret never returned).
  const [cfgForm, setCfgForm] = useState({ domain: '', clientId: '', clientSecret: '' });
  const [savingCfg, setSavingCfg] = useState(false);
  useEffect(() => {
    if (isTenantCfg && info) setCfgForm({ domain: info.domain || '', clientId: info.clientId || '', clientSecret: '' });
  }, [isTenantCfg, info]);
  if (!provider) return null;
  const meta = SSO_META[provider];
  const isAdmin = user?.role === 'tenant_admin';
  const enabled = !!info?.enabledForTenant;
  const fmt = (d) => d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  const rows = [
    ['Credentials', info?.configured ? '● Configured' : '○ Not configured', info?.configured ? 'var(--green)' : 'var(--muted)'],
    ['On your login page', enabled ? '● Enabled' : '○ Disabled', enabled ? 'var(--green)' : 'var(--muted)'],
    ...(isTenantCfg ? [] : meta.rows(info)),
    ['Users provisioned via SSO', String(info?.usersProvisioned ?? 0)],
    ['Last sign-in', fmt(info?.lastLogin)],
  ];

  async function toggle() {
    setBusy(true);
    const res = await apiPut(`/integrations/sso/${provider}`, { enabled: !enabled });
    setBusy(false);
    if (res?.ok) { toast(!enabled ? `${providerName} enabled on your login` : 'Disabled', 'ok'); onSaved && onSaved(); }
    else toast(res?.data?.error || 'Update failed', 'err');
  }

  async function saveConfig() {
    if (isOkta && !cfgForm.domain.trim()) return toast('Okta domain is required', 'err');
    if (!cfgForm.clientId.trim()) return toast('Client ID is required', 'err');
    setSavingCfg(true);
    const body = { clientId: cfgForm.clientId.trim(), clientSecret: cfgForm.clientSecret };
    if (isOkta) body.domain = cfgForm.domain.trim();
    const res = await apiPut(`/integrations/sso/${provider}/config`, body);
    setSavingCfg(false);
    if (res?.ok) { toast(`${providerName} credentials saved`, 'ok'); setCfgForm((f) => ({ ...f, clientSecret: '' })); onSaved && onSaved(); }
    else toast(res?.data?.error || 'Save failed', 'err');
  }

  const testUrl = () => {
    const base = info?.signInUrl || meta.signIn;
    const q = new URLSearchParams({ prompt: isOkta ? 'login' : 'select_account' });
    if (info?.slug) q.set('tenant', info.slug);
    return `${base}?${q.toString()}`;
  };

  const field = { width: '100%', marginTop: 4 };
  return (
    <Modal open={!!provider} onClose={onClose} title={meta.title} width={620}>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 14px' }}>
        {meta.intro} <b>Test sign-in</b> opens the account picker in a new tab.
      </p>
      <div style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden', marginBottom: 14 }}>
        {rows.map(([k, v, color], i) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '9px 14px', fontSize: 12.5, background: i % 2 ? 'var(--surface-2)' : 'transparent' }}>
            <span className="muted">{k}</span>
            <b style={{ textAlign: 'right', wordBreak: 'break-all', color: color || 'var(--ink)', fontFamily: /ID|URI|Issuer|Domain|Authority/.test(k) ? 'ui-monospace, Menlo, monospace' : 'inherit', fontSize: /ID|URI|Issuer|Domain|Authority/.test(k) ? 11.5 : 12.5 }}>{v}</b>
          </div>
        ))}
      </div>

      {/* Per-tenant editable credentials (Okta / Google) — configured here, not in .env */}
      {isTenantCfg && (
        <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '14px', marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>{providerName} credentials</div>
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 12 }}>{isGoogle ? 'From your Google Cloud OAuth client (Web application). Stored securely for this workspace.' : 'From your Okta app (OIDC Web Application). Stored securely for this workspace.'}</div>
          {isOkta && (
            <div className="form-field"><label>Okta domain</label>
              <input style={field} value={cfgForm.domain} onChange={(e) => setCfgForm((f) => ({ ...f, domain: e.target.value }))} placeholder="dev-12345.okta.com" disabled={!isAdmin} />
            </div>
          )}
          <div className="form-field"><label>Client ID</label>
            <input style={field} value={cfgForm.clientId} onChange={(e) => setCfgForm((f) => ({ ...f, clientId: e.target.value }))} placeholder={isGoogle ? '…apps.googleusercontent.com' : '0oa...'} disabled={!isAdmin} />
          </div>
          <div className="form-field"><label>Client secret</label>
            <input style={field} type="password" value={cfgForm.clientSecret} onChange={(e) => setCfgForm((f) => ({ ...f, clientSecret: e.target.value }))} placeholder={info?.secretConfigured ? '•••••••• (unchanged — leave blank to keep)' : `Paste your ${providerName} client secret`} disabled={!isAdmin} />
          </div>
          <div className="form-field"><label>Redirect URI (add this to your {providerName} app)</label>
            <input style={{ ...field, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11.5 }} value={info?.redirectUri || ''} readOnly onFocus={(e) => e.target.select()} />
          </div>
          <button className="btn-primary" disabled={!isAdmin || savingCfg} onClick={saveConfig}>{savingCfg ? 'Saving…' : 'Save credentials'}</button>
        </div>
      )}

      {info?.configured && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, border: '1px solid var(--line)', borderRadius: 10, padding: '12px 14px', marginBottom: 14 }}>
          <div style={{ fontSize: 12.5 }}>
            <b>Show on this workspace's login</b>
            <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>Members with an account here can then sign in with {providerName}. New identities still need an invite.</div>
          </div>
          <button className={enabled ? 'btn-secondary' : 'btn-primary'} disabled={!isAdmin || busy} title={!isAdmin ? 'Tenant admin only' : ''} onClick={toggle}>
            {busy ? '…' : enabled ? 'Disable' : 'Enable'}
          </button>
        </div>
      )}

      {!info?.configured && !isTenantCfg && (
        <div style={{ background: 'var(--amber-soft)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 14px', marginBottom: 14, fontSize: 12.5 }}>
          {meta.envHint}
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 12, borderTop: '1px solid var(--line)' }}>
        <button className="btn-secondary" onClick={onClose}>Close</button>
        <button className="btn-primary" disabled={!info?.configured} onClick={() => window.open(testUrl(), '_blank')}>↪ Test sign-in</button>
      </div>
    </Modal>
  );
}

function SmtpModal({ open, info, onClose, onSaved }) {
  const saved = info?.saved;
  const [host, setHost] = useState('');
  const [port, setPort] = useState(587);
  const [secure, setSecure] = useState(false);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  // Re-sync the form from saved DB config each time the modal opens. The password
  // is never returned, so we leave it blank (= keep stored).
  useEffect(() => {
    if (!open) return;
    setHost(saved?.host || '');
    setPort(saved?.port || 587);
    setSecure(!!saved?.secure);
    setUser(saved?.user || '');
    setPass('');
    setFrom(saved?.from || info?.from || '');
    setTo('');
    setEnabled(saved ? info?.status !== 'inactive' : true); // new setup defaults to Enabled
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const envManaged = info?.source === 'env' && !saved; // configured purely via environment
  const formConfig = () => ({ host: host.trim(), port: Number(port) || 587, secure, user: user.trim(), pass: pass || undefined, from: from.trim() || undefined });

  async function test() {
    if (!host.trim()) return toast('Enter an SMTP host to test', 'err');
    setBusy(true);
    const res = await apiPost('/integrations/smtp/test', { ...formConfig(), to: to.trim() || undefined });
    setBusy(false);
    if (res?.ok && res.data?.ok) toast(`✓ ${res.data.message}`, 'ok');
    else toast(res?.data?.error || 'SMTP test failed', 'err');
  }
  async function save() {
    if (!host.trim()) return toast('SMTP host is required', 'err');
    setBusy(true);
    const res = await apiPut('/integrations/smtp', { ...formConfig(), enabled });
    setBusy(false);
    if (res?.ok) { toast(enabled ? 'SMTP saved — emails will send from here' : 'Saved (disabled)', 'ok'); onSaved?.(); onClose(); }
    else toast(res?.data?.error || 'Failed to save', 'err');
  }
  async function disconnect() {
    setBusy(true);
    const res = await apiDelete('/integrations/smtp');
    setBusy(false);
    if (res?.ok) { toast('SMTP settings removed', 'ok'); onSaved?.(); onClose(); }
    else toast(res?.data?.error || 'Failed to remove', 'err');
  }

  return (
    <Modal open={open} onClose={onClose} title="Configure Email (SMTP)" width={600}>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 14px' }}>
        Outbound mail server used to send user invitations and notifications. Works with Gmail,
        Microsoft 365, Amazon SES (SMTP), Mailgun, or a local relay. Send a test email to verify
        credentials before saving.
      </p>
      {envManaged && (
        <div style={{ background: 'var(--info-soft)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 14px', marginBottom: 14, fontSize: 12.5 }}>
          SMTP is currently provided by the platform environment (<b>{info?.envHost}</b>). Saving below
          overrides it with a UI-managed configuration.
        </div>
      )}
      <div className="form-field">
        <label>SMTP host</label>
        <input value={host} onChange={e => setHost(e.target.value)} placeholder="smtp.gmail.com" />
      </div>
      <div className="form-row">
        <div className="form-field"><label>Port</label>
          <input type="number" value={port} onChange={e => setPort(e.target.value)} placeholder="587" />
        </div>
        <div className="form-field"><label>Encryption</label>
          <select value={secure ? 'ssl' : 'starttls'} onChange={e => { const ssl = e.target.value === 'ssl'; setSecure(ssl); setPort(ssl ? 465 : 587); }}>
            <option value="starttls">STARTTLS (587)</option>
            <option value="ssl">SSL/TLS (465)</option>
          </select>
        </div>
      </div>
      <div className="form-row">
        <div className="form-field"><label>Username</label>
          <input value={user} onChange={e => setUser(e.target.value)} placeholder="apikey / you@example.com" autoComplete="off" />
        </div>
        <div className="form-field"><label>Password {saved?.hasPassword && <span className="muted">(stored — leave blank to keep)</span>}</label>
          <input type="password" value={pass} onChange={e => setPass(e.target.value)} placeholder={saved?.hasPassword ? '••••••••' : 'app password / API key'} autoComplete="new-password" />
        </div>
      </div>
      <div className="form-field">
        <label>From address <span className="muted">(must be your mailbox or a verified alias — leave blank to use the username)</span></label>
        <input value={from} onChange={e => setFrom(e.target.value)} placeholder={user ? `Name <${user}>` : 'Name <you@yourdomain.com>'} />
      </div>
      <div className="form-row">
        <div className="form-field"><label>Send test email to</label>
          <input value={to} onChange={e => setTo(e.target.value)} placeholder="defaults to your account email" />
        </div>
        <div className="form-field"><label>Status</label>
          <select value={enabled ? '1' : '0'} onChange={e => setEnabled(e.target.value === '1')}>
            <option value="1">Enabled</option>
            <option value="0">Disabled</option>
          </select>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center', paddingTop: 12, borderTop: '1px solid var(--line)' }}>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn-secondary" onClick={test} disabled={busy}>Send test</button>
          {saved && <button className="btn-secondary" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={disconnect} disabled={busy}>Disconnect</button>}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </Modal>
  );
}

// Schema-driven config modal — renders fields from the connector's catalog entry,
// so the same component handles Slack, Splunk, Jira, Sentinel, etc. Secret fields
// stay blank on open (server returns only a "set" flag) and are kept if left blank.
function IntegrationModal({ open, type, schema, title, accent, logo, category, current, connected, onClose, onSaved }) {
  const fields = schema?.fields || [];
  const [vals, setVals] = useState({});
  const [minSeverity, setMinSeverity] = useState('high');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);

  // Re-sync the form each time it opens: non-secret fields from stored values (or
  // defaults), secrets left blank (= keep stored).
  useEffect(() => {
    if (!open) return;
    const init = {};
    for (const f of fields) init[f.key] = f.secret ? '' : (current?.values?.[f.key] ?? f.default ?? '');
    setVals(init);
    setMinSeverity(current?.minSeverity || 'high');
    setEnabled(connected ? true : true); // default Enabled; existing connected stays enabled
  }, [open, type]); // eslint-disable-line react-hooks/exhaustive-deps

  const setVal = (k, v) => setVals(p => ({ ...p, [k]: v }));
  // Only send non-empty fields so blanks don't clobber stored secrets server-side.
  const payloadFields = () => Object.fromEntries(Object.entries(vals).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));

  async function test() {
    setBusy(true);
    const res = await apiPost(`/integrations/${type}/test`, { fields: payloadFields() });
    setBusy(false);
    if (res?.ok && res.data?.ok) toast(`✓ ${res.data.message || 'Test alert delivered'}`, 'ok');
    else toast(res?.data?.error || res?.data?.message || 'Test failed', 'err');
  }
  async function save() {
    setBusy(true);
    const res = await apiPut(`/integrations/${type}`, { fields: payloadFields(), minSeverity, enabled });
    setBusy(false);
    if (res?.ok) { toast(enabled ? 'Connected — alerts will forward' : 'Saved (disabled — not forwarding)', 'ok'); onSaved(); onClose(); }
    else toast(res?.data?.error || 'Failed to save', 'err');
  }
  async function disconnect() {
    setBusy(true);
    const res = await apiDelete(`/integrations/${type}`);
    setBusy(false);
    if (res?.ok) { toast('Integration removed', 'ok'); onSaved(); onClose(); }
    else toast(res?.data?.error || 'Failed to remove', 'err');
  }

  return (
    <Modal open={open} onClose={onClose} title={title} width={560}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 14px', margin: '0 0 16px', fontSize: 12.5 }}>
        {logo && <span style={{ width: 26, height: 26, flex: 'none', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: logo.length > 1 ? 11 : 14, fontWeight: 800, color: '#fff', background: accent || 'var(--primary)' }}>{logo}</span>}
        <span style={{ fontWeight: 600 }}>{connected ? 'Connected' : 'Not connected'}</span>
        {category && <span className="muted">{category}</span>}
        <span style={{ marginLeft: 'auto' }} className="badge" >{connected ? '● active' : '○ inactive'}</span>
      </div>
      {schema?.help && <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 14px' }}>{schema.help}</p>}
      {fields.map(f => {
        const secretSet = f.secret && current?.secrets?.[f.key]?.set;
        return (
          <div className="form-field" key={f.key}>
            <label>{f.label}{f.required ? '' : ' '}{secretSet && <span className="muted">(stored{current.secrets[f.key].masked ? `: ${current.secrets[f.key].masked}` : ''} — leave blank to keep)</span>}</label>
            {f.type === 'select' ? (
              <select value={vals[f.key] ?? ''} onChange={e => setVal(f.key, e.target.value)}>
                {(f.options || []).map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input
                type={f.type === 'password' ? 'password' : 'text'}
                value={vals[f.key] ?? ''}
                onChange={e => setVal(f.key, e.target.value)}
                placeholder={f.placeholder || (secretSet ? '••••••••' : '')}
                autoComplete={f.secret ? 'new-password' : 'off'}
              />
            )}
          </div>
        );
      })}
      {schema?.kind === 'alert' && (
        <div className="form-row">
          <div className="form-field"><label>Minimum severity</label>
            <select value={minSeverity} onChange={e => setMinSeverity(e.target.value)}>
              <option value="low">Low and above</option>
              <option value="medium">Medium and above</option>
              <option value="high">High and above</option>
              <option value="critical">Critical only</option>
            </select>
          </div>
          <div className="form-field"><label>Status</label>
            <select value={enabled ? '1' : '0'} onChange={e => setEnabled(e.target.value === '1')}>
              <option value="1">Enabled (forwarding)</option>
              <option value="0">Disabled</option>
            </select>
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center', paddingTop: 12, borderTop: '1px solid var(--line)' }}>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn-secondary" onClick={test} disabled={busy}>Send test</button>
          {current?.configured && <button className="btn-secondary" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={disconnect} disabled={busy}>Disconnect</button>}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </Modal>
  );
}
