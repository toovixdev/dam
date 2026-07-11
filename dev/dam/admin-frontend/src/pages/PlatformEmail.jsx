import { useState, useEffect } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import useApiData from '../hooks/useApiData';
import { apiPut, apiPost } from '../api/client';
import { toast } from '../components/shared/Toast';

// Platform (system) SMTP — the operator configures the sender for signup verification
// and invite emails here. It is NOT a tenant's mail server (those live in each tenant's
// Integrations → Email). Password is write-only (never returned by the API).
export default function PlatformEmail() {
  const { data, refetch } = useApiData('/admin/platform/smtp', { poll: 0 });
  const [f, setF] = useState({ host: '', port: 587, secure: false, username: '', password: '', from: '' });
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  // Platform control-plane URL (the public endpoint agents enroll/report to).
  const { data: settings, refetch: refetchSettings } = useApiData('/admin/platform/settings', { poll: 0 });
  const [cp, setCp] = useState('');
  const [cpBusy, setCpBusy] = useState(false);

  useEffect(() => {
    if (data) setF({ host: data.host || '', port: data.port || 587, secure: !!data.secure, username: data.username || '', password: '', from: data.from || '' });
  }, [data]);
  useEffect(() => { if (settings?.controlPlane) setCp(settings.controlPlane); }, [settings]);

  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  const save = async () => {
    if (!f.host.trim()) return toast('Host is required', 'err');
    setBusy(true);
    const res = await apiPut('/admin/platform/smtp', { ...f, port: Number(f.port) || 587, actor: 'Platform Ops' });
    setBusy(false);
    if (res?.ok) { toast('Platform SMTP saved', 'ok'); setF((p) => ({ ...p, password: '' })); refetch(); }
    else toast(res?.data?.error || 'Save failed', 'err');
  };

  const sendTest = async () => {
    if (!testTo.trim()) return toast('Enter a test recipient', 'err');
    setTesting(true);
    const res = await apiPost('/admin/platform/smtp/test', { ...f, port: Number(f.port) || 587, to: testTo.trim() });
    setTesting(false);
    if (res?.ok && res.data?.ok) toast(res.data.message || 'Test sent', 'ok');
    else toast(res?.data?.error || 'Test failed', 'err');
  };

  const saveCp = async () => {
    if (!cp.trim()) return toast('Enter the control-plane URL', 'err');
    setCpBusy(true);
    const res = await apiPut('/admin/platform/settings', { controlPlane: cp.trim(), actor: 'Platform Ops' });
    setCpBusy(false);
    if (res?.ok) { toast('Control-plane URL saved', 'ok'); setCp(res.data.controlPlane || cp.trim()); refetchSettings(); }
    else toast(res?.data?.error || 'Save failed', 'err');
  };

  const badge = data?.configured
    ? <span className="badge status-green">configured · {data.source}</span>
    : <span className="badge status-gray">not configured</span>;

  return (
    <Layout>
      <PageHeader title="Platform Settings" meta={['Control-plane URL · system SMTP']}>{badge}</PageHeader>

      <div className="card" style={{ maxWidth: 640, marginBottom: 16 }}>
        <div className="card-body">
          <h3 style={{ margin: '0 0 6px', fontSize: 15 }}>Agent control-plane URL</h3>
          <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 14px' }}>
            The public HTTPS endpoint agents enroll and report to — it's baked into the install instructions
            in each tenant's <b>Deploy monitoring</b> flow. Agents dial this outbound.
            {settings?.controlPlaneSource && <> Current source: <b>{settings.controlPlaneSource}</b>.</>}
          </p>
          <div className="form-field"><label>Control-plane URL</label>
            <input value={cp} onChange={(e) => setCp(e.target.value)} placeholder="https://dam.yourcompany.com" />
            <span className="muted" style={{ fontSize: 11 }}>The DAM's public address, reachable from customer networks (e.g. https://dam.suchirasoistories.in).</span>
          </div>
          <div style={{ display: 'flex', gap: 10, paddingTop: 10, borderTop: '1px solid var(--line)', marginTop: 6 }}>
            <button className="btn-primary" disabled={cpBusy} onClick={saveCp}>{cpBusy ? 'Saving…' : 'Save control-plane URL'}</button>
          </div>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 640 }}>
        <div className="card-body">
          <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 16px' }}>
            This is the <b>platform</b> mail sender for <b>system emails</b> — signup email verification and user
            invitations — which happen <b>before</b> a tenant is provisioned, so they can't use a tenant's own SMTP.
            Configure it once here. (A tenant's own alert emails are set per-tenant in their Integrations → Email.)
          </p>

          <div className="form-row" style={{ display: 'flex', gap: 12 }}>
            <div className="form-field" style={{ flex: 2 }}><label>SMTP host</label>
              <input value={f.host} onChange={(e) => set('host', e.target.value)} placeholder="smtp.zeptomail.in" />
            </div>
            <div className="form-field" style={{ flex: 1 }}><label>Port</label>
              <input value={f.port} onChange={(e) => set('port', e.target.value)} placeholder="587" />
            </div>
            <div className="form-field" style={{ flex: '0 0 auto', alignSelf: 'flex-end', paddingBottom: 8 }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                <input type="checkbox" checked={f.secure} onChange={(e) => set('secure', e.target.checked)} /> SSL (465)
              </label>
            </div>
          </div>

          <div className="form-field"><label>Username</label>
            <input value={f.username} onChange={(e) => set('username', e.target.value)} placeholder="emailapikey (ZeptoMail) or full mailbox" />
          </div>
          <div className="form-field"><label>Password / token</label>
            <input type="password" value={f.password} onChange={(e) => set('password', e.target.value)} placeholder={data?.passwordSet ? '•••••••• (unchanged — leave blank to keep)' : 'Send Mail Token / SMTP password'} />
          </div>
          <div className="form-field"><label>From address</label>
            <input value={f.from} onChange={(e) => set('from', e.target.value)} placeholder="TooVix DAM <alerts@yourdomain.com>" />
            <span className="muted" style={{ fontSize: 11 }}>Must be on a domain your provider is allowed to send from.</span>
          </div>

          <div style={{ display: 'flex', gap: 10, paddingTop: 10, borderTop: '1px solid var(--line)', marginTop: 6 }}>
            <button className="btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save platform SMTP'}</button>
          </div>

          <div className="form-field" style={{ marginTop: 18 }}><label>Send a test email to</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@company.com" style={{ flex: 1 }} />
              <button className="btn-secondary" disabled={testing} onClick={sendTest}>{testing ? 'Sending…' : 'Send test'}</button>
            </div>
            <span className="muted" style={{ fontSize: 11 }}>Uses the values in the form (saved or not), so you can verify before saving.</span>
          </div>
        </div>
      </div>
    </Layout>
  );
}
