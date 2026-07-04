import { useState, useEffect } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/KpiCard';
import TabNav from '../components/shared/TabNav';
import Modal from '../components/shared/Modal';
import { toast } from '../components/shared/Toast';
import useApiData from '../hooks/useApiData';
import { apiPost, apiDelete } from '../api/client';
import { useAuth } from '../context/AuthContext';

// Entitlements + service-account identity remain illustrative for now; JIT is live.
const INITIAL_ENT = [
  { principal: 'app_temp', db: 'ORCL-CBS-PROD', priv: 'DBA', used: 'just now', flag: 'excessive', cls: 'red', action: 'Revoke', msg: 'DBA role revoked from app_temp' },
  { principal: 'temp_audit', db: 'DB2-GL-PROD', priv: 'SELECT ANY TABLE', used: '142d ago', flag: 'dormant', cls: 'amber', action: 'Disable', msg: 'Account disabled' },
  { principal: 'dba_mueller', db: 'ORCL-TRADING-PROD', priv: 'SYSDBA', used: '1h ago', flag: 'recertified', cls: '', action: 'Review', msg: 'Opened review for dba_mueller' },
  { principal: 'bi_reader', db: 'PG-CRM-PROD', priv: 'SELECT (all schemas)', used: '1h ago', flag: 'excessive', cls: 'amber', action: 'Scope', msg: 'Scoped to crm schema only' },
];

const IDENTITY = [
  { shared: 'app_cbs', user: 'Suresh Iyer', via: 'app session var', db: 'ORCL-CBS-PROD', conf: '0.97' },
  { shared: 'bi_reader', user: 'Neha Gupta', via: 'SSO token', db: 'PG-CRM-PROD', conf: '0.99' },
  { shared: 'svc_etl', user: 'service (no human)', via: '—', db: 'ORCL-DWH-PROD', conf: '—' },
];

const DURATIONS = [{ v: 30, l: '30 minutes' }, { v: 60, l: '1 hour' }, { v: 120, l: '2 hours' }, { v: 240, l: '4 hours' }, { v: 480, l: '8 hours' }, { v: 1440, l: '24 hours' }];

function fmtExpires(g) {
  if (g.status === 'pending') return 'awaiting approval';
  if (g.status === 'expired') return 'expired';
  if (g.status === 'revoked') return 'revoked';
  if (g.status === 'denied') return 'denied';
  if (g.status === 'active' && g.expires_at) {
    const ms = new Date(g.expires_at).getTime() - Date.now();
    if (ms <= 0) return 'expiring…';
    const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
    return h > 0 ? `in ${h}h ${String(m % 60).padStart(2, '0')}m` : `in ${m}m`;
  }
  return '—';
}
const STATUS_CLS = { active: 'green', pending: 'amber', expired: '', revoked: 'red', denied: 'red', cancelled: '' };
const BROKER_CLS = { healthy: 'green', unhealthy: 'red', unconfigured: 'amber' };

export default function AccessGovernance() {
  const { user } = useAuth();
  const [tab, setTab] = useState('jit');
  const [ent, setEnt] = useState(INITIAL_ENT);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [reqOpen, setReqOpen] = useState(false);
  const [brokerOpen, setBrokerOpen] = useState(false);
  const [approve, setApprove] = useState(null); // grant being approved
  const [issued, setIssued] = useState(null);    // credential shown once
  const [busy, setBusy] = useState(null);

  const { data: jitData, refetch } = useApiData('/access/jit', { poll: 30000 });
  const { data: brokerData, refetch: refetchBrokers } = useApiData('/access/jit/brokers', { poll: 0 });
  const { data: jitDbs, refetch: refetchDbs } = useApiData('/access/jit/databases', { poll: 0 });
  const { data: signerCfg } = useApiData('/access/jit/signer', { poll: 0 });
  const jit = jitData?.grants || [];
  const jitActive = jitData?.summary?.active ?? 0;
  const brokers = brokerData?.brokers || [];
  const healthyCount = brokers.filter((b) => b.status === 'healthy').length;
  const isAdmin = user?.role === 'tenant_admin';   // broker management is admin-only
  const myEmail = (user?.email || '').toLowerCase().trim();
  const ownersOf = (g) => ((brokers.find((b) => b.id === g.broker_id) || {}).owners || []).map((o) => String(o).toLowerCase());
  const isMine = (g) => (g.requester || '').toLowerCase().trim() === myEmail;
  const canApproveGrant = (g) => g.status === 'pending' && !isMine(g) && (ownersOf(g).includes(myEmail) || isAdmin);
  const canRevokeGrant = (g) => isMine(g) || ownersOf(g).includes(myEmail) || isAdmin;

  const handleRefresh = () => { refetch(); refetchBrokers(); refetchDbs(); setLastRefresh(new Date()); };

  const resolveEnt = (i) => {
    const row = ent[i];
    toast(row.msg, 'ok');
    if (row.action === 'Revoke' || row.action === 'Disable') setEnt((prev) => prev.filter((_, idx) => idx !== i));
    else if (row.action === 'Scope') setEnt((prev) => prev.map((r, idx) => idx === i ? { ...r, flag: 'recertified', cls: '', action: 'Review', msg: 'Opened review' } : r));
  };

  // Cancel/deny (pending) or revoke (active) — plain DAM calls, no signature needed.
  const act = async (g, action) => {
    setBusy(g.id);
    const res = await apiPost(`/access/jit/${g.id}/${action}`);
    setBusy(null);
    if (res?.ok) {
      const s = res.data?.grant?.status;
      toast(s === 'cancelled' ? 'Request cancelled' : s === 'denied' ? 'Request denied' : 'Access revoked — minted user dropped', 'ok');
      refetch();
    } else toast(res?.data?.error || 'Action failed', 'err');
  };

  const runHealth = async (b) => {
    setBusy(b.id);
    const res = await apiPost(`/access/jit/brokers/${b.id}/health`);
    setBusy(null);
    if (res?.ok) { toast(`Broker ${res.data.status}`, res.data.status === 'healthy' ? 'ok' : 'err'); refetchBrokers(); refetchDbs(); }
    else toast(res?.data?.error || 'Health check failed', 'err');
  };

  const removeBroker = async (b) => {
    if (!window.confirm(`Remove broker ${b.label}? Its database will no longer be offerable for JIT.`)) return;
    const res = await apiDelete(`/access/jit/brokers/${b.id}`);
    if (res?.ok) { toast('Broker removed', 'ok'); refetchBrokers(); refetchDbs(); }
    else toast(res?.data?.error || 'Failed', 'err');
  };

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={handleRefresh}>
      <PageHeader title="Access Governance" meta={['brokers · JIT · recertification']}>
        <button className="btn-secondary" onClick={() => toast('Recertification campaign started · 14 reviewers')}>⟳ Recertify</button>
        <button className="btn-primary" onClick={() => { setReqOpen(true); setTab('jit'); }}>＋ JIT request</button>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="⊟" label="JIT brokers" value={brokers.length} detail={`${healthyCount} healthy`} />
        <KpiCard icon="⏲" iconBg="var(--info-soft)" iconColor="var(--info)" label="JIT active" value={jitActive} detail="auto-expiring" />
        <KpiCard icon="◔" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Pending approval" value={jitData?.summary?.pending ?? 0} detail="awaiting signer" />
        <KpiCard icon="▲" iconBg="var(--danger-soft)" iconColor="var(--danger)" label="Excessive entitlements" value={ent.filter((e) => e.flag === 'excessive').length} detail="over-privileged" detailType="down" />
      </section>

      <TabNav
        tabs={[
          { id: 'jit', label: `JIT requests${jitData?.summary?.pending ? ` (${jitData.summary.pending})` : ''}` },
          ...(isAdmin ? [{ id: 'brokers', label: `Brokers${brokers.length ? ` (${brokers.length})` : ''}` }] : []),
          { id: 'ent', label: 'Entitlements' },
          { id: 'ident', label: 'Service-account identity' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'jit' && (
        <>
          {isAdmin && !brokers.length && (
            <div className="card" style={{ marginBottom: 12 }}><div className="card-body" style={{ fontSize: 13 }}>
              No JIT brokers yet. A database is only offerable for JIT once a <b>healthy broker</b> is registered for it
              (see <span className="mono">docs/JIT-BROKER-SETUP.md</span>). Go to the <b>Brokers</b> tab to add one.
            </div></div>
          )}
          <div className="card"><div className="card-body no-pad">
            <table className="data-table">
              <thead><tr><th>Requester</th><th>Database</th><th>Scope</th><th>Minted user</th><th>Expires</th><th>Status</th><th /></tr></thead>
              <tbody>
                {jit.length === 0 && <tr><td colSpan={7} className="muted" style={{ padding: 18, textAlign: 'center' }}>No JIT requests yet — use ＋ JIT request to create one.</td></tr>}
                {jit.map((g) => (
                  <tr key={g.id} style={{ opacity: busy === g.id ? 0.5 : 1 }}>
                    <td><b>{g.requester}</b></td>
                    <td>{g.db_name || '—'}</td>
                    <td>{g.scope}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{g.provisioned_user || '—'}</td>
                    <td className="muted">{fmtExpires(g)}</td>
                    <td><span className={`badge ${STATUS_CLS[g.status] || ''}`}>{g.status}</span></td>
                    <td style={{ textAlign: 'right' }}>
                      {g.status === 'pending' && (
                        <span style={{ display: 'inline-flex', gap: 6 }}>
                          {canApproveGrant(g) && <button className="btn-primary" style={{ padding: '4px 10px' }} disabled={busy === g.id} onClick={() => setApprove(g)}>Approve…</button>}
                          {canApproveGrant(g) && <button className="btn-secondary" style={{ padding: '4px 10px', borderColor: 'var(--danger)', color: 'var(--danger)' }} disabled={busy === g.id} onClick={() => act(g, 'revoke')}>Deny</button>}
                          {!canApproveGrant(g) && isMine(g) && <button className="btn-secondary" style={{ padding: '4px 10px' }} disabled={busy === g.id} onClick={() => act(g, 'revoke')}>Cancel</button>}
                          {!canApproveGrant(g) && !isMine(g) && <span className="muted">awaiting owner</span>}
                        </span>
                      )}
                      {g.status === 'active' && (
                        canRevokeGrant(g)
                          ? <button className="btn-secondary" style={{ padding: '4px 10px', borderColor: 'var(--danger)', color: 'var(--danger)' }} disabled={busy === g.id} onClick={() => act(g, 'revoke')}>{isMine(g) ? 'Return early' : 'Revoke'}</button>
                          : <span className="muted">—</span>
                      )}
                      {!['pending', 'active'].includes(g.status) && <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div></div>
        </>
      )}

      {tab === 'brokers' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '0 0 12px' }}>
            <p className="muted" style={{ fontSize: 12.5, margin: 0, maxWidth: 640 }}>
              A broker's privileged credential lives in <b>Vault</b>{signerCfg?.configured ? '' : ''} — DAM stores no DB password.
              A database is offerable for JIT only when its broker is <b>healthy</b>.
              Vault: <b style={{ color: brokerData?.vault ? 'var(--success)' : 'var(--danger)' }}>{brokerData?.vault ? 'connected' : 'not configured'}</b> ·
              Signer: <b style={{ color: brokerData?.signer ? 'var(--success)' : 'var(--danger)' }}>{brokerData?.signer ? 'configured' : 'not configured'}</b>
            </p>
            <button className="btn-primary" onClick={() => setBrokerOpen(true)}>＋ Set up broker</button>
          </div>
          <div className="card"><div className="card-body no-pad">
            <table className="data-table">
              <thead><tr><th>Broker</th><th>Engine</th><th>Vault role(s)</th><th>Allowed scopes (ceiling)</th><th>Rate/hr</th><th>Status</th><th /></tr></thead>
              <tbody>
                {brokers.length === 0 && <tr><td colSpan={7} className="muted" style={{ padding: 18, textAlign: 'center' }}>No brokers registered.</td></tr>}
                {brokers.map((b) => (
                  <tr key={b.id} style={{ opacity: busy === b.id ? 0.5 : 1 }}>
                    <td><b>{b.label}</b><div className="muted mono" style={{ fontSize: 11 }}>{b.host}:{b.port || ''}</div><div className="muted" style={{ fontSize: 10.5 }}>owners: {(b.owners || []).length ? (b.owners || []).join(', ') : 'admin-only'}</div></td>
                    <td>{b.engine}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{[...new Set((b.allowed_scopes || []).map((s) => s.vault_role))].join(', ') || '—'}</td>
                    <td style={{ fontSize: 11.5 }}>{(b.allowed_scopes || []).map((s) => `${s.privilege} ${s.schema}.${s.object || '*'}`).join('  ·  ') || '—'}</td>
                    <td className="num">{b.rate_limit_per_hour}</td>
                    <td>
                      <span className={`badge ${BROKER_CLS[b.status] || ''}`}>{b.status}</span>
                      {b.health_detail?.notes?.some((n) => /FAIL/.test(n)) && <div className="muted" style={{ fontSize: 10.5, color: 'var(--danger)' }}>{b.health_detail.notes.filter((n) => /FAIL/.test(n))[0]}</div>}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn-secondary" style={{ padding: '4px 10px' }} disabled={busy === b.id} onClick={() => runHealth(b)}>Health check</button>{' '}
                      <button className="btn-secondary" style={{ padding: '4px 8px', borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => removeBroker(b)}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div></div>
        </>
      )}

      {tab === 'ent' && (
        <div className="card"><div className="card-body no-pad">
          <div className="card-header" style={{ padding: '10px 14px' }}><span className="muted" style={{ fontSize: 12 }}>Illustrative — entitlement review sample data</span></div>
          <table className="data-table">
            <thead><tr><th>Principal</th><th>Database</th><th>Privileges</th><th>Last used</th><th>Flag</th><th /></tr></thead>
            <tbody>
              {ent.map((r, i) => (
                <tr key={r.principal}>
                  <td><b>{r.principal}</b></td><td>{r.db}</td><td>{r.priv}</td><td>{r.used}</td>
                  <td>{r.flag === 'recertified' ? <span className="badge">recertified</span> : <span className={`badge ${r.cls}`}>{r.flag}</span>}</td>
                  <td style={{ textAlign: 'right' }}><button className="btn-secondary" style={{ padding: '4px 10px' }} onClick={() => resolveEnt(i)}>{r.action}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></div>
      )}

      {tab === 'ident' && (
        <div className="card">
          <div className="card-header"><span className="card-title">Resolving shared / pooled accounts to real users</span><span className="muted" style={{ fontSize: 12 }}>Illustrative</span></div>
          <div className="card-body no-pad">
            <table className="data-table">
              <thead><tr><th>Shared account</th><th>Resolved user</th><th>Via</th><th>Database</th><th className="num">Confidence</th></tr></thead>
              <tbody>
                {IDENTITY.map((r) => (
                  <tr key={r.shared}>
                    <td className="mono">{r.shared}</td>
                    <td>{r.user === 'service (no human)' ? <i>{r.user}</i> : <b>{r.user}</b>}</td>
                    <td>{r.via}</td><td>{r.db}</td><td className="num">{r.conf}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <JitRequestModal open={reqOpen} databases={jitDbs?.databases || []} defaultRequester={user?.email || ''} onClose={() => setReqOpen(false)} onCreated={() => { setReqOpen(false); refetch(); }} />
      <BrokerWizard open={brokerOpen} onClose={() => setBrokerOpen(false)} onSaved={() => { setBrokerOpen(false); refetchBrokers(); }} />
      <ApproveModal grant={approve} broker={brokers.find((b) => b.id === approve?.broker_id)} me={user} signerUrl={signerCfg?.signerUrl} onClose={() => setApprove(null)}
        onProvisioned={(cred) => { setApprove(null); setIssued(cred); refetch(); refetchDbs(); }} />
      <CredentialModal cred={issued} onClose={() => setIssued(null)} />
    </Layout>
  );
}

function JitRequestModal({ open, databases, defaultRequester, onClose, onCreated }) {
  const [brokerId, setBrokerId] = useState('');
  const [scopeId, setScopeId] = useState('');
  const [reason, setReason] = useState('');
  const [durationMins, setDurationMins] = useState(120);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) { setBrokerId(''); setScopeId(''); setReason(''); setDurationMins(120); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const broker = databases.find((d) => d.brokerId === brokerId);
  const scopes = broker?.scopes || [];

  const submit = async () => {
    if (!brokerId || !scopeId) return toast('Pick a database and scope', 'err');
    setBusy(true);
    // The requester is set server-side from your login — never sent from the client.
    const res = await apiPost('/access/jit', { brokerId, scopeId, reason: reason.trim() || undefined, durationMins });
    setBusy(false);
    if (res?.ok) { toast('JIT request submitted — pending signed approval', 'ok'); onCreated(); }
    else toast(res?.data?.error || 'Could not submit', 'err');
  };

  return (
    <Modal open={open} onClose={onClose} title="Request just-in-time access" width={520}>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 14px' }}>
        Only databases with a healthy broker are offerable, and only that broker's pre-approved scopes (the ceiling).
        Once approved by a separate <b>data owner</b> (never you), a short-lived scoped DB user is minted via Vault and auto-expires.
      </p>
      {databases.length === 0 && <p style={{ fontSize: 12.5, color: 'var(--danger)' }}>No broker-gated databases available — register a healthy broker first.</p>}
      <div className="form-field"><label>Requester (you)</label>
        <input value={defaultRequester || ''} disabled readOnly style={{ opacity: 0.75 }} />
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Bound to your login — access is minted for you.</span>
      </div>
      <div className="form-row">
        <div className="form-field"><label>Database (broker-gated)</label>
          <select value={brokerId} onChange={(e) => { setBrokerId(e.target.value); setScopeId(''); }}>
            <option value="">— select —</option>
            {databases.map((d) => <option key={d.brokerId} value={d.brokerId}>{d.label} ({d.engine})</option>)}
          </select>
        </div>
        <div className="form-field"><label>Duration</label>
          <select value={durationMins} onChange={(e) => setDurationMins(Number(e.target.value))}>
            {DURATIONS.map((d) => <option key={d.v} value={d.v}>{d.l}</option>)}
          </select>
        </div>
      </div>
      <div className="form-field"><label>Scope (within ceiling)</label>
        <select value={scopeId} onChange={(e) => setScopeId(e.target.value)} disabled={!broker}>
          <option value="">{broker ? '— select —' : 'pick a database first'}</option>
          {scopes.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </div>
      <div className="form-field"><label>Reason</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Business justification (optional)" />
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 12, borderTop: '1px solid var(--line)' }}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy} onClick={submit}>{busy ? 'Submitting…' : 'Submit request'}</button>
      </div>
    </Modal>
  );
}

const slugify = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function genPw() { const a = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 22; i++) s += a[Math.floor(Math.random() * a.length)]; return s; }

function CopyBlock({ title, who, text }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{title} {who && <span className="badge" style={{ marginLeft: 4 }}>{who}</span>}</span>
        <button className="btn-secondary" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => { navigator.clipboard?.writeText(text); toast('Copied', 'ok'); }}>Copy</button>
      </div>
      <pre style={{ fontFamily: 'var(--mono, monospace)', background: 'var(--bg-subtle)', border: '1px solid var(--line)', borderRadius: 6, padding: 10, fontSize: 11, lineHeight: 1.5, overflowX: 'auto', whiteSpace: 'pre', margin: 0 }}>{text}</pre>
    </div>
  );
}

// Guided broker onboarding: pick the DB + scopes → get the exact steps for the DBA
// and Vault admin to run → register the broker's metadata once those steps are done.
function BrokerWizard({ open, onClose, onSaved }) {
  const [step, setStep] = useState(1);
  const [f, setF] = useState({});
  const [scopes, setScopes] = useState([]);
  const [pw, setPw] = useState('');
  const [ran, setRan] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setStep(1); setRan(false); setPw(genPw());
      setF({ label: '', engine: 'mysql', host: '', port: 3306, rateLimitPerHour: 10, owners: '' });
      setScopes([{ privilege: 'read', schema: '', object: '*' }]);
    }
  }, [open]);

  const setScope = (i, k, v) => setScopes((p) => p.map((s, idx) => idx === i ? { ...s, [k]: v } : s));
  const isPg = f.engine === 'postgres';

  // Derived identifiers + the tailored steps.
  const validScopes = scopes.filter((s) => s.schema);
  const slug = slugify(f.label || validScopes[0]?.schema || 'broker');
  const connName = `${slug}-${isPg ? 'pg' : 'mysql'}`;
  const brokerUser = `dam_jit_${slugify(validScopes[0]?.schema || slug).replace(/-/g, '_')}`;
  const scopesMeta = validScopes.map((s) => {
    const objPart = (!s.object || s.object === '*') ? 'all' : slugify(s.object);
    return { ...s, object: s.object || '*', id: `${s.privilege}-${slugify(s.schema)}-${objPart}`, label: `${s.privilege} ${s.schema}.${s.object || '*'}`, vault_role: `jit-${slugify(s.schema)}-${objPart}-${s.privilege}` };
  });
  const roleNames = scopesMeta.map((s) => s.vault_role).join(',');
  const schemas = [...new Set(scopesMeta.map((s) => s.schema))];

  // Step 2 text — DBA SQL.
  let dbaSql = '';
  if (isPg) {
    dbaSql = `-- Run as a PostgreSQL admin, ONCE.\nCREATE ROLE ${brokerUser} LOGIN PASSWORD '${pw}' CREATEROLE;\n`;
    schemas.forEach((sch) => {
      dbaSql += `GRANT USAGE ON SCHEMA ${sch} TO ${brokerUser};\nGRANT SELECT ON ALL TABLES IN SCHEMA ${sch} TO ${brokerUser} WITH GRANT OPTION;\n`;
      if (scopesMeta.some((s) => s.schema === sch && s.privilege === 'write')) dbaSql += `GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${sch} TO ${brokerUser} WITH GRANT OPTION;\n`;
    });
  } else {
    dbaSql = `-- Run as a MySQL admin, ONCE.\nCREATE USER '${brokerUser}'@'%' IDENTIFIED BY '${pw}';\nGRANT CREATE USER ON *.* TO '${brokerUser}'@'%';\n`;
    schemas.forEach((sch) => {
      dbaSql += `GRANT SELECT ON ${sch}.* TO '${brokerUser}'@'%' WITH GRANT OPTION;\n`;
      if (scopesMeta.some((s) => s.schema === sch && s.privilege === 'write')) dbaSql += `GRANT INSERT, UPDATE, DELETE ON ${sch}.* TO '${brokerUser}'@'%' WITH GRANT OPTION;\n`;
    });
    dbaSql += `FLUSH PRIVILEGES;`;
  }

  // Step 2 text — Vault config.
  const connUrl = isPg ? `postgresql://{{username}}:{{password}}@${f.host}:${f.port || 5432}/postgres?sslmode=disable` : `{{username}}:{{password}}@tcp(${f.host}:${f.port || 3306})/`;
  const plugin = isPg ? 'postgresql-database-plugin' : 'mysql-database-plugin';
  let roleCmds = '';
  scopesMeta.forEach((s) => {
    const privKw = s.privilege === 'write' ? 'SELECT, INSERT, UPDATE, DELETE' : 'SELECT';
    if (isPg) {
      const objClause = s.object === '*' ? `ALL TABLES IN SCHEMA ${s.schema}` : `${s.schema}.${s.object}`;
      roleCmds += `vault write database/roles/${s.vault_role} \\\n  db_name=${connName} \\\n  creation_statements="CREATE ROLE \\"{{name}}\\" LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT USAGE ON SCHEMA ${s.schema} TO \\"{{name}}\\"; GRANT ${privKw} ON ${objClause} TO \\"{{name}}\\";" \\\n  revocation_statements="DROP ROLE IF EXISTS \\"{{name}}\\";" \\\n  default_ttl=1h max_ttl=24h\n\n`;
    } else {
      const objClause = s.object === '*' ? `${s.schema}.*` : `${s.schema}.${s.object}`;
      roleCmds += `vault write database/roles/${s.vault_role} \\\n  db_name=${connName} \\\n  creation_statements="CREATE USER '{{name}}'@'%' IDENTIFIED BY '{{password}}'; GRANT ${privKw} ON ${objClause} TO '{{name}}'@'%';" \\\n  revocation_statements="DROP USER '{{name}}'@'%';" \\\n  default_ttl=1h max_ttl=24h\n\n`;
    }
  });
  const vaultCmds = `# Run wherever the Vault CLI is configured, ONCE.\nvault secrets enable -path=database database   # skip if already enabled\n\nvault write database/config/${connName} \\\n  plugin_name=${plugin} \\\n  connection_url='${connUrl}' \\\n  allowed_roles="${roleNames}" \\\n  username="${brokerUser}" password="${pw}"\n\n${roleCmds}# Rotate so ONLY Vault knows the password from here on:\nvault write -f database/rotate-root/${connName}`;

  const ownerList = (f.owners || '').split(/[,\s]+/).map((o) => o.trim().toLowerCase()).filter(Boolean);
  const canNext1 = f.host && validScopes.length > 0;
  const register = async () => {
    setBusy(true);
    const res = await apiPost('/access/jit/brokers', {
      label: f.label || f.host, engine: f.engine, host: f.host, port: Number(f.port) || null, vaultMount: 'database',
      vaultRole: scopesMeta[0].vault_role,
      allowedScopes: scopesMeta.map((s) => ({ id: s.id, label: s.label, privilege: s.privilege, schema: s.schema, object: s.object, vault_role: s.vault_role })),
      rateLimitPerHour: Number(f.rateLimitPerHour) || 10,
      owners: ownerList,
    });
    setBusy(false);
    if (res?.ok) { toast('Broker registered — run a health check', 'ok'); onSaved(); }
    else toast(res?.data?.error || 'Failed', 'err');
  };

  const StepDots = () => (
    <div style={{ display: 'flex', gap: 8, fontSize: 11.5, marginBottom: 14 }}>
      {['1 · Choose DB & scopes', '2 · Run the setup steps', '3 · Register'].map((t, i) => (
        <span key={i} style={{ padding: '3px 8px', borderRadius: 12, background: step === i + 1 ? 'var(--brand-soft, var(--info-soft))' : 'var(--bg-subtle)', color: step === i + 1 ? 'var(--brand, var(--info))' : 'var(--text-muted)', fontWeight: step === i + 1 ? 600 : 400 }}>{t}</span>
      ))}
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title="Set up a JIT broker" width={680}>
      <StepDots />

      {step === 1 && (<>
        <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 12px' }}>
          Choose the client database you want to enable for JIT, and the access it should ever be able to grant (the ceiling).
          Next, we'll generate the exact one-time setup steps for your DBA and Vault admin.
        </p>
        <div className="form-row">
          <div className="form-field"><label>Label</label><input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="e.g. MySQL — payments" /></div>
          <div className="form-field" style={{ flex: '0 0 130px' }}><label>Engine</label>
            <select value={f.engine} onChange={(e) => setF({ ...f, engine: e.target.value, port: e.target.value === 'postgres' ? 5432 : 3306 })}><option value="mysql">mysql</option><option value="postgres">postgres</option></select>
          </div>
        </div>
        <div className="form-row">
          <div className="form-field"><label>Host</label><input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="db host reachable by Vault" /></div>
          <div className="form-field" style={{ flex: '0 0 110px' }}><label>Port</label><input value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} /></div>
          <div className="form-field" style={{ flex: '0 0 110px' }}><label>Rate / hr</label><input value={f.rateLimitPerHour} onChange={(e) => setF({ ...f, rateLimitPerHour: e.target.value })} /></div>
        </div>
        <label style={{ fontSize: 12, fontWeight: 600, display: 'block', margin: '8px 0 4px' }}>Allowed scopes (the ceiling)</label>
        {scopes.map((s, i) => (
          <div key={i} className="form-row" style={{ gap: 6, alignItems: 'flex-end' }}>
            <div className="form-field" style={{ flex: '0 0 96px' }}><label>Priv</label>
              <select value={s.privilege} onChange={(e) => setScope(i, 'privilege', e.target.value)}><option value="read">read</option><option value="write">write</option></select>
            </div>
            <div className="form-field"><label>Schema</label><input value={s.schema} onChange={(e) => setScope(i, 'schema', e.target.value)} placeholder="e.g. payments" /></div>
            <div className="form-field"><label>Object (table)</label><input value={s.object} onChange={(e) => setScope(i, 'object', e.target.value)} placeholder="* for all tables" /></div>
            {scopes.length > 1 && <button className="btn-secondary" style={{ padding: '6px 8px' }} onClick={() => setScopes((p) => p.filter((_, idx) => idx !== i))}>✕</button>}
          </div>
        ))}
        <button className="btn-secondary" style={{ padding: '4px 10px', marginTop: 4 }} onClick={() => setScopes((p) => [...p, { privilege: 'read', schema: '', object: '*' }])}>＋ scope</button>
        <div className="form-field" style={{ marginTop: 12 }}><label>Data owners — who may approve JIT for this DB</label>
          <input value={f.owners} onChange={(e) => setF({ ...f, owners: e.target.value })} placeholder="owner1@company.com, owner2@company.com" />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Only these people (or a tenant_admin as break-glass) can approve — and never the requester. Leave blank to allow admin-only approval.</span>
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 14, marginTop: 12, borderTop: '1px solid var(--line)' }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!canNext1} onClick={() => setStep(2)}>Next: setup steps →</button>
        </div>
      </>)}

      {step === 2 && (<>
        <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 12px' }}>
          Hand these to the people who hold the credentials. DAM never runs them and never sees the password —
          it only registers that the broker exists (next step). The generated password below must be identical in both blocks.
        </p>
        <div style={{ fontSize: 12, marginBottom: 10 }}>Broker account: <b className="mono">{brokerUser}</b> · generated password: <b className="mono">{pw}</b>{' '}
          <button className="btn-secondary" style={{ padding: '1px 7px', fontSize: 11 }} onClick={() => setPw(genPw())}>↻</button></div>
        <CopyBlock title="1) Create the broker account" who="DBA" text={dbaSql} />
        <CopyBlock title="2) Configure Vault (holds the credential, mints temp users)" who="Vault admin" text={vaultCmds} />
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, marginTop: 6 }}>
          <input type="checkbox" checked={ran} onChange={(e) => setRan(e.target.checked)} /> These steps have been run successfully.
        </label>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', paddingTop: 14, marginTop: 8, borderTop: '1px solid var(--line)' }}>
          <button className="btn-secondary" onClick={() => setStep(1)}>← Back</button>
          <button className="btn-primary" disabled={!ran} onClick={() => setStep(3)}>Next: register →</button>
        </div>
      </>)}

      {step === 3 && (<>
        <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 12px' }}>
          Register this broker with DAM. This just records that it exists and what it may grant — then you run a health check,
          which asks Vault to mint a throwaway test user to confirm everything works.
        </p>
        <table className="data-table"><tbody>
          <tr><td style={{ width: 150 }}>Label</td><td>{f.label || f.host}</td></tr>
          <tr><td>Engine · Host · Port</td><td className="mono">{f.engine} · {f.host} · {f.port}</td></tr>
          <tr><td>Vault connection</td><td className="mono">{connName}</td></tr>
          <tr><td>Scopes (ceiling)</td><td>{scopesMeta.map((s) => <div key={s.id} className="mono" style={{ fontSize: 11.5 }}>{s.label} → {s.vault_role}</div>)}</td></tr>
          <tr><td>Data owners (approvers)</td><td>{ownerList.length ? ownerList.join(', ') : <span className="muted">none — admin-only (break-glass) approval</span>}</td></tr>
          <tr><td>Rate limit / hr</td><td>{f.rateLimitPerHour}</td></tr>
        </tbody></table>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', paddingTop: 14, marginTop: 10, borderTop: '1px solid var(--line)' }}>
          <button className="btn-secondary" onClick={() => setStep(2)}>← Back</button>
          <button className="btn-primary" disabled={busy} onClick={register}>{busy ? 'Registering…' : 'Register broker'}</button>
        </div>
      </>)}
    </Modal>
  );
}

// Approve routes through the SEPARATE signer (its key DAM never holds), then DAM
// verifies the signature and provisions. The approver is YOUR verified login — not a
// typed field — and DAM enforces that you own this DB and are not the requester.
function ApproveModal({ grant, broker, me, signerUrl, onClose, onProvisioned }) {
  const [cred, setCred] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (grant) setCred(''); }, [grant]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!grant) return null;

  const approver = (me?.email || '').toLowerCase().trim();
  const owners = (broker?.owners || []).map((o) => String(o).toLowerCase());
  const isRequester = approver === (grant.requester || '').toLowerCase().trim();
  const isOwner = owners.includes(approver);
  const isAdmin = me?.role === 'tenant_admin';
  const breakGlass = isAdmin && !isOwner;
  const canApprove = !isRequester && (isOwner || isAdmin);

  const approveAndProvision = async () => {
    if (!canApprove) return;
    if (!signerUrl) return toast('Approval Signer URL not configured', 'err');
    setBusy(true);
    try {
      // 1) Obtain a signature from the separate signer (browser → signer directly).
      const descriptor = { grant_id: grant.id, requester: grant.requester, broker_id: grant.broker_id, privilege: grant.privilege, schema: grant.schema_name, object: grant.object_name, duration_mins: grant.duration_mins };
      const sr = await fetch(`${signerUrl}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${cred}` }, body: JSON.stringify({ descriptor, approver }) });
      const sb = await sr.json().catch(() => ({}));
      if (!sr.ok) { setBusy(false); return toast(sb.error || 'Signer rejected the approval', 'err'); }
      // 2) DAM verifies the signature + your identity (owner, not requester) and provisions.
      const res = await apiPost(`/access/jit/${grant.id}/provision`, { signature: sb.signature });
      setBusy(false);
      if (res?.ok) { toast('Approved & provisioned — credentials issued', 'ok'); onProvisioned(res.data.credential); }
      else toast(res?.data?.error || 'Provisioning failed', 'err');
    } catch (e) { setBusy(false); toast(`Signer unreachable: ${e.message}`, 'err'); }
  };

  return (
    <Modal open={!!grant} onClose={onClose} title="Approve JIT grant" width={520}>
      <div style={{ fontSize: 12.5, background: 'var(--bg-subtle)', border: '1px solid var(--line)', borderRadius: 8, padding: 12, marginBottom: 14 }}>
        <div>Requester: <b>{grant.requester}</b> · {grant.db_name}</div>
        <div className="muted">Scope: {grant.scope} · {grant.duration_mins}m</div>
      </div>
      <div className="form-field"><label>Approver (you)</label>
        <input value={me?.email || ''} disabled readOnly style={{ opacity: 0.75 }} />
      </div>
      {isRequester && <p style={{ fontSize: 12, color: 'var(--danger)', margin: '0 0 10px' }}>You are the requester — separation of duties blocks this. A different data owner must approve.</p>}
      {!isRequester && !isOwner && !isAdmin && <p style={{ fontSize: 12, color: 'var(--danger)', margin: '0 0 10px' }}>You are not a data owner of <b>{grant.db_name}</b>, so you cannot approve this request.</p>}
      {!isRequester && isOwner && <p style={{ fontSize: 12, color: 'var(--success)', margin: '0 0 10px' }}>✓ You are a data owner of {grant.db_name} — you may approve.</p>}
      {!isRequester && breakGlass && <p style={{ fontSize: 12, color: 'var(--amber)', margin: '0 0 10px' }}>⚠ You are not a listed owner — approving as <b>break-glass admin</b> (audited).</p>}
      <p className="muted" style={{ fontSize: 12, lineHeight: 1.5, margin: '0 0 12px' }}>
        Your approval is signed by a <b>separate service</b> whose key DAM never holds — so a compromised DAM cannot forge it.
        Enter your signer credential (held by you + the signer only).
      </p>
      <div className="form-field"><label>Approver credential (signer)</label>
        <input type="password" value={cred} onChange={(e) => setCred(e.target.value)} placeholder="signer approver token" disabled={!canApprove} />
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 12, borderTop: '1px solid var(--line)' }}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy || !canApprove} onClick={approveAndProvision}>{busy ? 'Signing & provisioning…' : 'Approve & provision'}</button>
      </div>
    </Modal>
  );
}

// Minted credentials are shown ONCE and never persisted by DAM.
function CredentialModal({ cred, onClose }) {
  if (!cred) return null;
  const rows = [['Host', cred.host], ['Port', cred.port], ['Engine', cred.engine], ['Database', cred.database], ['Username', cred.username], ['Password', cred.password], ['Expires in', `${Math.round((cred.ttl_seconds || 0) / 60)} min`]];
  return (
    <Modal open={!!cred} onClose={onClose} title="Issued credentials (shown once)" width={480}>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 12px' }}>
        Vault minted this short-lived, scoped DB user. Copy it now — DAM does <b>not</b> store the password. It auto-drops at expiry.
      </p>
      <table className="data-table"><tbody>
        {rows.map(([k, v]) => <tr key={k}><td style={{ width: 110 }}>{k}</td><td className="mono" style={{ fontSize: 12 }}>{String(v)}</td></tr>)}
      </tbody></table>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 14 }}>
        <button className="btn-secondary" onClick={() => { navigator.clipboard?.writeText(`${cred.username} / ${cred.password}`); toast('Copied', 'ok'); }}>Copy user/pass</button>
        <button className="btn-primary" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
