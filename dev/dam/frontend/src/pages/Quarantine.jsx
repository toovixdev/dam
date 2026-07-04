import { useState, useEffect } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/KpiCard';
import TabNav from '../components/shared/TabNav';
import DataTable from '../components/shared/DataTable';
import Modal from '../components/shared/Modal';
import { SeverityBadge, StatusBadge } from '../components/shared/Badge';
import useApiData from '../hooks/useApiData';
import useLiveEvents from '../hooks/useLiveEvents';
import LivePill from '../components/shared/LivePill';
import { apiPost, apiFetch, apiPut } from '../api/client';
import { toast } from '../components/shared/Toast';
import { exportCsv } from '../exportCsv';

function fmtDur(secs) {
  if (secs == null || secs < 0) return '-';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export default function Quarantine() {
  const [statusTab, setStatusTab] = useState('held'); // table filter
  // List filtered by the active tab; summary is the authoritative count source.
  const listPath = statusTab === 'all' ? '/quarantine' : `/quarantine?status=${statusTab}`;
  const { data, loading, refetch } = useApiData(listPath, { poll: 30000 });
  const { data: summary, refetch: refetchSummary } = useApiData('/quarantine/summary', { poll: 30000 });
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [busy, setBusy] = useState(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [detail, setDetail] = useState(null); // session row for the detail popup
  const [qAcctOpen, setQAcctOpen] = useState(false); // manual account-quarantine modal

  const refreshAll = () => { refetch(); refetchSummary(); setLastRefresh(new Date()); };

  // Live refresh on quarantine changes (new hold / release / kill) from any client.
  useLiveEvents('quarantine', refreshAll);

  const now = Date.now();
  const rows = (Array.isArray(data) ? data : []).map((s) => ({
    ...s,
    hold_time: s.status === 'held' && s.held_at ? fmtDur((now - new Date(s.held_at).getTime()) / 1000) : '-',
  }));

  // KPIs come from the authoritative summary (real COUNTs), not the capped list.
  const held = summary?.held ?? 0;
  const released = summary?.released ?? 0;
  const killed = summary?.killed ?? 0;
  const total = summary?.total ?? 0;
  const avgHoldSecs = summary?.avgHoldSecs ?? null;

  const resolve = async (row, action) => {
    setBusy(row.id);
    const res = await apiPost(`/quarantine/${row.id}/${action}`);
    setBusy(null);
    if (res && res.ok) {
      // Real DB-firewall semantics: release LIFTS the account quarantine (the agent
      // stops blocking them); terminate keeps the block and drops the live session.
      // Nothing is "resumed" and no query is replayed.
      if (action === 'release') toast(`Quarantine lifted for ${row.principal} — they may reconnect`, 'ok');
      else toast(`Session terminated · ${row.principal} kept blocked`, 'ok');
      setDetail(null);
      refreshAll();
    } else {
      toast('Action failed', 'err');
    }
  };

  const columns = [
    { key: 'principal', label: 'Account', render: (v) => <b>{v}</b> },
    { key: 'database_name', label: 'Database' },
    { key: 'source', label: 'Origin', render: (v) => <OriginTag source={v} /> },
    { key: 'reason', label: 'Reason held' },
    { key: 'severity', label: 'Severity', render: (v) => <SeverityBadge severity={v} /> },
    { key: 'hold_time', label: 'Held for' },
    { key: 'status', label: 'Status', render: (v) => <StatusBadge status={v} /> },
    { key: 'actions', label: 'Actions', sortable: false, render: (_, row) => {
      if (row.status !== 'held') return <span style={{ color: 'var(--muted)' }}>-</span>;
      return (
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} disabled={busy === row.id} onClick={() => resolve(row, 'release')} title="Lift the account quarantine — the principal may reconnect">Release</button>
          <button className="btn-primary" style={{ padding: '4px 10px', fontSize: 12, background: 'var(--danger)' }} disabled={busy === row.id} onClick={() => resolve(row, 'kill')} title="Terminate the live session and keep the account blocked">Terminate</button>
        </div>
      );
    }},
  ];

  if (loading) {
    return <Layout><div className="loading-screen"><div className="loading-spinner" /><p>Loading quarantine…</p></div></Layout>;
  }

  return (
    <Layout activePage="quarantine" lastRefresh={lastRefresh} onRefresh={refreshAll}>
      <PageHeader
        title="Quarantine"
        meta={[<LivePill key="live" />, 'Blocked accounts · containment & review', `${held} account${held === 1 ? '' : 's'} held`]}
      >
        <button className="btn-secondary" onClick={() => { exportCsv('toovix-quarantine.csv', ['Session', 'Principal', 'Database', 'Severity', 'Reason', 'Status', 'Held', 'Resolved'], rows.map((s) => [s.session_id, s.principal, s.database_name, s.severity, s.reason, s.status, s.held_at, s.resolved_at])); toast(`Exported ${rows.length} sessions`, 'ok'); }}>⤓ Export</button>
        <button className="btn-secondary" onClick={() => setQAcctOpen(true)}>⛔ Quarantine account</button>
        <button className="btn-primary" onClick={() => setPolicyOpen(true)}>⛨ Quarantine policy</button>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="⛔" iconBg="var(--danger-soft)" iconColor="var(--danger)" label="Accounts held" value={held} detail="blocked inline now" detailType={held > 0 ? 'down' : 'up'} />
        <KpiCard icon="◉" iconBg="var(--green-soft)" iconColor="var(--green)" label="Released" value={released} detail="quarantine lifted" detailType="up" />
        <KpiCard icon="⊘" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Terminated" value={killed} detail="killed, kept blocked" />
        <KpiCard icon="◎" iconBg="var(--info-soft)" iconColor="var(--info)" label="Avg hold time" value={fmtDur(avgHoldSecs)} detail="accounts held now" />
      </section>

      <TabNav
        tabs={[
          { id: 'held', label: `Held (${held})` },
          { id: 'released', label: `Released (${released})` },
          { id: 'killed', label: `Terminated (${killed})` },
          { id: 'expired', label: `Expired (${Math.max(0, total - held - released - killed)})` },
          { id: 'all', label: `All (${total})` },
        ]}
        active={statusTab}
        onChange={setStatusTab}
      />

      <div style={{ background: 'var(--info-soft)', borderRadius: 10, padding: '10px 14px', fontSize: 12.5, lineHeight: 1.5, margin: '0 0 12px' }}>
        <b style={{ color: 'var(--info)' }}>Quarantine holds accounts, not queries.</b> Every blocked query is logged on the <b>Alerts</b> page.
        An account appears here only when it is <b>contained</b> — blocked inline until released — either manually (⛔ Quarantine account)
        or automatically (if the Quarantine policy has auto-quarantine on). <b>Release</b> lifts the block; <b>Terminate</b> kills its session and keeps it blocked.
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Quarantined Accounts</span>
          <span className="card-sub">accounts blocked inline by the agent · double-click a row for the triggering query</span>
        </div>
        <div className="card-body no-pad">
          <DataTable columns={columns} data={rows} onRowDoubleClick={setDetail} emptyMessage="No accounts quarantined — a blocked query is logged in Alerts; it only lands here if you quarantine the account (manually or via auto-quarantine policy)." />
        </div>
      </div>

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail ? `Account: ${detail.principal}` : ''} width={680}>
        {detail && <SessionDetail s={detail} busy={busy === detail.id} onResolve={resolve} />}
      </Modal>

      <Modal open={policyOpen} onClose={() => setPolicyOpen(false)} title="Quarantine policy" width={640}>
        <QuarantinePolicy onClose={() => setPolicyOpen(false)} />
      </Modal>

      <Modal open={qAcctOpen} onClose={() => setQAcctOpen(false)} title="Quarantine an account" width={480}>
        <QuarantineAccount onDone={() => { setQAcctOpen(false); refreshAll(); }} onClose={() => setQAcctOpen(false)} />
      </Modal>
    </Layout>
  );
}

// Manually block (quarantine) a principal — a real containment action. The agent
// then drops that account's sessions inline until it is released.
function QuarantineAccount({ onDone, onClose }) {
  const [principal, setPrincipal] = useState('');
  const [database, setDatabase] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!principal.trim()) return toast('Principal is required', 'err');
    setBusy(true);
    const res = await apiPost('/quarantine/account', { principal: principal.trim(), database: database.trim() || undefined, reason: reason.trim() || undefined });
    setBusy(false);
    if (res?.ok) { toast(`Account ${principal.trim()} quarantined — agent will block its sessions`, 'ok'); onDone(); }
    else toast(res?.data?.error || 'Failed', 'err');
  };
  return (
    <>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 14px' }}>
        Immediately block a database account. The inline agent refuses its traffic and drops its live sessions until you
        release it. This is containment — not a query block or a replay.
      </p>
      <div className="form-field"><label>Principal (DB user)</label>
        <input value={principal} onChange={(e) => setPrincipal(e.target.value)} placeholder="e.g. app_payments" />
      </div>
      <div className="form-field"><label>Database (optional)</label>
        <input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="e.g. payments" />
      </div>
      <div className="form-field"><label>Reason (optional)</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this account being blocked?" />
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 12, borderTop: '1px solid var(--line)' }}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" style={{ background: 'var(--danger)' }} disabled={busy} onClick={submit}>{busy ? 'Quarantining…' : 'Quarantine account'}</button>
      </div>
    </>
  );
}

function fmtTime(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Why the account is held: a deliberate manual quarantine, or auto-quarantined by a policy block.
function OriginTag({ source }) {
  const map = {
    manual: { label: 'Manual', bg: 'var(--info-soft)', fg: 'var(--info)' },
    policy_block: { label: 'Policy block', bg: 'var(--amber-soft)', fg: 'var(--amber)' },
  };
  const s = map[source];
  if (!s) return <span className="muted">—</span>;
  return <span style={{ background: s.bg, color: s.fg, fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, whiteSpace: 'nowrap' }}>{s.label}</span>;
}

// Plain-language explanation of why the statement was blocked, derived from the SQL.
function explainWhy(s) {
  const q = (s.query_preview || '').toUpperCase();
  if (q.includes('DROP DATABASE')) return 'The statement drops an entire database — irreversible destruction blocked pending review.';
  if (q.includes('DROP TABLE')) return 'The statement drops a table — irreversible schema destruction blocked pending review.';
  if (q.includes('TRUNCATE')) return 'TRUNCATE empties a table with no row-level undo — blocked pending review.';
  if (q.includes('GRANT')) return 'The statement grants elevated privileges — a common persistence/escalation technique — blocked pending review.';
  if (q.includes('DELETE')) return 'The statement performs a mass row deletion — blocked pending review.';
  if (q.includes('ALTER')) return 'The statement alters a protected object’s schema — blocked pending review.';
  return 'The query matched an inline blocking policy and was stopped before reaching the database.';
}

function SessionDetail({ s, busy, onResolve }) {
  const rule = s.reason || 'Blocking policy match';
  const why = explainWhy(s);
  const cell = (label, value) => (
    <div style={{ padding: '10px 14px', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 8 }}>
      <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.4px' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, marginTop: 2 }}>{value}</div>
    </div>
  );
  return (
    <>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        {cell('Principal', s.principal || '—')}
        {cell('Database', s.database_name || '—')}
        <div style={{ padding: '10px 14px', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 8 }}>
          <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.4px' }}>Severity</div>
          <div style={{ marginTop: 4 }}><SeverityBadge severity={s.severity} /></div>
        </div>
        <div style={{ padding: '10px 14px', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 8 }}>
          <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.4px' }}>Status</div>
          <div style={{ marginTop: 4 }}><StatusBadge status={s.status} /></div>
        </div>
        <div style={{ padding: '10px 14px', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 8 }}>
          <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.4px' }}>Origin</div>
          <div style={{ marginTop: 6 }}><OriginTag source={s.source} /></div>
        </div>
      </div>

      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--subtle)', marginBottom: 8 }}>Why this account is held</div>
      <div style={{ background: 'var(--danger-soft)', border: '1px solid var(--line)', borderRadius: 10, padding: '12px 14px', marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--danger)' }}>{rule}</div>
        <div style={{ fontSize: 13, marginTop: 4, lineHeight: 1.5 }}>{why}</div>
        {s.client_ip && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Source: {s.client_ip}</div>}
      </div>

      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--subtle)', marginBottom: 8 }}>Query that triggered the hold</div>
      <pre style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 8, padding: '12px 14px', fontSize: 12.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>
        {s.query_preview || '(query text not captured)'}
      </pre>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--muted)', marginTop: 12 }}>
        <span>Held: <b style={{ color: 'var(--fg)' }}>{fmtTime(s.held_at)}</b></span>
        {s.status === 'held' ? <span>In hold for: <b style={{ color: 'var(--fg)' }}>{s.hold_time}</b></span> : <span>Resolved: <b style={{ color: 'var(--fg)' }}>{fmtTime(s.resolved_at)}</b></span>}
      </div>

      {s.status === 'held' && (
        <>
          <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 16, lineHeight: 1.5 }}>
            The account is <b>quarantined</b> — the inline agent drops its sessions. There is no session resume or query
            replay: <b>Release</b> lifts the block so the principal can reconnect and retry; <b>Terminate</b> kills the
            live session and keeps the account blocked.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 10, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
            <button className="btn-secondary" disabled={busy} onClick={() => onResolve(s, 'release')}>Release (lift quarantine)</button>
            <button className="btn-primary" style={{ background: 'var(--danger)' }} disabled={busy} onClick={() => onResolve(s, 'kill')}>Terminate session</button>
          </div>
        </>
      )}
    </>
  );
}

const TRIGGER_RULES = [
  { id: 'bulk', label: 'Bulk sensitive-data export', desc: 'PII/PCI rows above threshold', threshold: { label: 'rows >', value: 5000 } },
  { id: 'ddl', label: 'Destructive DDL on production', desc: 'DROP · TRUNCATE · destructive ALTER' },
  { id: 'privesc', label: 'Privilege escalation', desc: 'GRANT ALL · role grants' },
  { id: 'offhours', label: 'Access outside change window', desc: 'Off-hours / unapproved window' },
  { id: 'sqli', label: 'SQL-injection signature', desc: 'Known injection patterns' },
  { id: 'anomaly', label: 'Anomaly score threshold', desc: 'Behavioural model score', threshold: { label: '≥', value: 80 } },
];

const AUTOQ_CATS = [
  { id: 'privilege_escalation', label: 'Privilege escalation (GRANT / role grants)' },
  { id: 'destructive_ddl', label: 'Destructive DDL (DROP / TRUNCATE)' },
  { id: 'schema_change', label: 'Schema modification (ALTER on protected objects)' },
  { id: 'mass_delete', label: 'Mass row deletion (DELETE)' },
];

function QuarantinePolicy({ onClose }) {
  const [autoQ, setAutoQ] = useState(false);   // block-only (false) vs auto-quarantine account (true)
  const [cats, setCats] = useState([]);        // categories that auto-quarantine (empty = all)
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  // Illustrative trigger-rule display (not enforced — the enforced behaviour is the
  // block-list + the auto-quarantine policy below).
  const [rules] = useState(() => Object.fromEntries(TRIGGER_RULES.map((r) => [r.id, { on: r.id !== 'offhours', threshold: r.threshold?.value }])));

  useEffect(() => {
    apiFetch('/quarantine/policy').then((p) => { if (p) { setAutoQ(!!p.auto_quarantine); setCats(p.categories || []); } setLoaded(true); });
  }, []);

  const toggleCat = (id) => setCats((c) => c.includes(id) ? c.filter((x) => x !== id) : [...c, id]);
  const save = async () => {
    setBusy(true);
    const res = await apiPut('/quarantine/policy', { autoQuarantine: autoQ, categories: cats });
    setBusy(false);
    if (res?.ok) { toast(autoQ ? 'Saved — auto-quarantine enabled' : 'Saved — block-only (accounts stay active)', 'ok'); onClose(); }
    else toast(res?.data?.error || 'Failed to save', 'err');
  };

  return (
    <>
      <div className="section-label">Automatic response when a query is blocked</div>
      <div className="form-field">
        <label>On a policy block</label>
        <select value={autoQ ? 'auto' : 'blockonly'} onChange={(e) => setAutoQ(e.target.value === 'auto')} disabled={!loaded}>
          <option value="blockonly">Block statement + alert only — account stays active (recommended)</option>
          <option value="auto">Block + auto-quarantine the account — lock it out inline until released</option>
        </select>
      </div>

      {autoQ && (
        <div style={{ margin: '2px 0 12px' }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Auto-quarantine only for these categories <i>(none selected = every blocked query)</i>:</div>
          {AUTOQ_CATS.map((c) => (
            <label key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 5 }}>
              <input type="checkbox" checked={cats.includes(c.id)} onChange={() => toggleCat(c.id)} /> {c.label}
            </label>
          ))}
        </div>
      )}

      <div style={{ background: autoQ ? 'var(--danger-soft)' : 'var(--info-soft)', borderRadius: 10, padding: '10px 14px', fontSize: 12.5, lineHeight: 1.5, marginBottom: 16 }}>
        {autoQ
          ? <><b style={{ color: 'var(--danger)' }}>⚠ Auto-quarantine ON</b> — a matching blocked query locks the whole account: the inline agent <b>drops all its sessions</b> until a data owner releases it. (Statement block + alert always happen regardless.)</>
          : <><b style={{ color: 'var(--info)' }}>Block-only</b> — a blocked query is refused and alerted, but the account keeps working. Quarantining an account is then a deliberate action (⛔ Quarantine account or here).</>}
      </div>

      <div className="section-label">Trigger rules <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>· illustrative</span></div>
      {TRIGGER_RULES.map((r) => (
        <div key={r.id} className={`approach-card ${rules[r.id].on ? 'on' : ''}`} style={{ padding: 10, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 12, opacity: 0.85 }}>
          <input type="checkbox" checked={rules[r.id].on} readOnly />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{r.label}</div>
            <div className="muted" style={{ fontSize: 12 }}>{r.desc}</div>
          </div>
        </div>
      ))}

      <div className="modal-footer" style={{ padding: '18px 0 0', justifyContent: 'flex-end' }}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy || !loaded} onClick={save}>{busy ? 'Saving…' : 'Save policy'}</button>
      </div>
    </>
  );
}
