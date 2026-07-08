import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import { SeverityBadge } from '../components/shared/Badge';
import { apiFetch, apiPost } from '../api/client';
import { toast } from '../components/shared/Toast';

function relativeAge(ts) {
  if (!ts) return '-';
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return `${Math.floor(diff / 86400000)}d`;
}
function scoreColor(s) {
  return s >= 90 ? 'var(--danger)' : s >= 70 ? 'var(--amber)' : 'var(--info)';
}
function KV({ k, children }) {
  return (<><span className="muted" style={{ fontSize: 12.5 }}>{k}</span><span style={{ fontSize: 12.5, textAlign: 'right' }}>{children}</span></>);
}

// Friendly, prominent status pill for an alert's current disposition.
const STATUS_META = {
  open:           { label: 'Active',              color: '#dc2626', bg: '#fef2f2', border: '#fca5a5' },
  ack:            { label: 'Acknowledged',        color: '#b45309', bg: '#fffbeb', border: '#fcd34d' },
  resolved:       { label: 'Resolved · closed',   color: '#15803d', bg: '#f0fdf4', border: '#86efac' },
  false_positive: { label: 'False positive · closed', color: '#475569', bg: '#f1f5f9', border: '#cbd5e1' },
};
function StatusPill({ status }) {
  const s = STATUS_META[status] || STATUS_META.open;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 13px', borderRadius: 20, background: s.bg, color: s.color, border: `1px solid ${s.border}`, fontWeight: 700, fontSize: 12.5, whiteSpace: 'nowrap' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'currentColor' }} />
      {s.label}
    </span>
  );
}

export default function AlertDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [a, setA] = useState(location.state?.alert || null); // instant render when navigated from the list
  const [loading, setLoading] = useState(!location.state?.alert);
  const [notFound, setNotFound] = useState(false);
  const [panel, setPanel] = useState(null); // null | 'ack' | 'resolve' | 'fp' | 'quarantine'
  const [note, setNote] = useState('');
  const [scope, setScope] = useState('both');
  const [reason, setReason] = useState('');
  const [qReason, setQReason] = useState('');
  const [notes, setNotes] = useState([]);
  const [busy, setBusy] = useState(false);
  const [escInfo, setEscInfo] = useState(null); // {teams,slack,email,emailRecipients}
  const [escSel, setEscSel] = useState({ teams: false, slack: false, email: false });
  const [escNote, setEscNote] = useState('');
  const [escRecipients, setEscRecipients] = useState('');

  const loadNotes = () => apiFetch(`/alerts/${id}/notes`).then((d) => setNotes(Array.isArray(d) ? d : [])).catch(() => {});
  const reloadAlert = () => apiFetch(`/alerts/${id}`).then((d) => { if (d && !d.error) setA(d); });

  useEffect(() => {
    let live = true;
    apiFetch(`/alerts/${id}`)
      .then((d) => { if (!live) return; if (d && !d.error) setA(d); else setNotFound(true); })
      .catch(() => live && setNotFound(true))
      .finally(() => live && setLoading(false));
    loadNotes();
    apiFetch('/alerts/escalation-channels').then((d) => { if (live && d && !d.error) { setEscInfo(d); setEscRecipients(d.emailRecipients || ''); } }).catch(() => {});
    return () => { live = false; };
  }, [id]);

  const back = () => navigate('/alerts');
  const closePanel = () => { setPanel(null); setNote(''); };

  const onAck = async () => {
    setBusy(true);
    const res = await apiPost(`/alerts/${id}/status`, { status: 'ack', note: note.trim() });
    setBusy(false);
    if (res && res.ok) { toast('Alert acknowledged', 'ok'); closePanel(); reloadAlert(); loadNotes(); }
    else toast(res?.data?.error || 'Action failed', 'err');
  };
  const onResolve = async () => {
    if (!note.trim()) { toast('A resolution note is required', 'err'); return; }
    setBusy(true);
    const res = await apiPost(`/alerts/${id}/status`, { status: 'resolved', note: note.trim() });
    setBusy(false);
    if (res && res.ok) { toast('Alert resolved', 'ok'); back(); }
    else toast(res?.data?.error || 'Action failed', 'err');
  };
  const onFalsePositive = async () => {
    setBusy(true);
    const res = await apiPost(`/alerts/${id}/false-positive`, { scope, reason });
    setBusy(false);
    if (res && res.ok) { toast('Marked false positive — suppression created', 'ok'); back(); }
    else toast(res?.data?.error || 'Action failed', 'err');
  };
  const onQuarantine = async () => {
    if (!a.principal) { toast('This alert has no principal to quarantine', 'err'); return; }
    setBusy(true);
    const res = await apiPost('/quarantine/account', { principal: a.principal, database: a.database_name || null, reason: qReason.trim() || `Quarantined from alert: ${a.rule || a.summary || ''}`.trim() });
    setBusy(false);
    if (res && res.ok) { toast(`Account "${a.principal}" quarantined — inline block active`, 'ok'); navigate('/quarantine'); }
    else toast(res?.data?.error || 'Quarantine failed', 'err');
  };
  const onEscalate = async () => {
    const channels = Object.keys(escSel).filter((k) => escSel[k]);
    if (!channels.length) { toast('Pick at least one channel', 'err'); return; }
    setBusy(true);
    const res = await apiPost(`/alerts/${id}/escalate`, { channels, note: escNote.trim(), recipients: escRecipients.trim() });
    setBusy(false);
    if (res && res.ok && res.data?.sent?.length) {
      const failed = (res.data.failed || []).map((f) => `${f.channel} (${f.error})`);
      toast(`Escalated via ${res.data.sent.join(', ')}` + (failed.length ? ` · failed: ${failed.join(', ')}` : ''), failed.length ? 'err' : 'ok');
      setPanel(null); setEscNote(''); loadNotes();
    } else {
      const failed = (res?.data?.failed || []).map((f) => `${f.channel}: ${f.error}`);
      toast(failed.length ? `Escalation failed — ${failed.join('; ')}` : (res?.data?.error || 'Escalation failed'), 'err');
    }
  };
  const onAct = (msg) => toast(msg, 'ok');

  if (loading) {
    return <Layout activePage="alerts"><div className="loading-screen"><div className="loading-spinner" /><p>Loading alert…</p></div></Layout>;
  }
  if (notFound || !a) {
    return (
      <Layout activePage="alerts">
        <PageHeader title="Alert not found" meta={['This alert may have been removed']}>
          <button className="btn-secondary" onClick={back}>← Back to Alerts</button>
        </PageHeader>
        <div className="card"><div className="card-body">The alert <span className="mono">{id}</span> could not be found in this workspace.</div></div>
      </Layout>
    );
  }

  const tags = Array.isArray(a.sensitivity_tags) ? a.sensitivity_tags : [];

  return (
    <Layout activePage="alerts">
      <PageHeader
        title={a.summary || 'Alert'}
        meta={[<StatusPill key="status" status={a.status || 'open'} />, <SeverityBadge key="sev" severity={a.severity || 'low'} />, <span key="id" className="mono">{(a.id || '').slice(0, 8)}</span>, `Age ${relativeAge(a.created_at)}`]}
      >
        <button className="btn-secondary" onClick={back}>← Back to Alerts</button>
      </PageHeader>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', marginBottom: 14, fontSize: 13, color: 'var(--muted)', alignItems: 'center' }}>
        <StatusPill status={a.status || 'open'} />
        <span>Score <b style={{ color: scoreColor(a.anomaly_score || 0) }}>{a.anomaly_score || 0}/100</b></span>
        <span>Rule <b style={{ color: 'var(--ink)' }}>{a.rule || '—'}</b></span>
        {a.resolved_at && <span>Closed <b style={{ color: 'var(--ink)' }}>{new Date(a.resolved_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</b></span>}
      </div>

      <div className="card" style={{ marginBottom: 12, background: 'var(--primary-soft)' }}>
        <div className="card-body">
          <b style={{ color: 'var(--primary)' }}>✦ Why this fired</b>
          <p style={{ margin: '6px 0 0', fontSize: 13, lineHeight: 1.5 }}>{a.why || a.summary || '—'}</p>
        </div>
      </div>

      <div className="section-label">SQL / Command</div>
      <pre className="dep-cmd" style={{ whiteSpace: 'pre-wrap', margin: '0 0 12px' }}>{a.raw_sql || '—'}</pre>

      <div className="grid2" style={{ marginBottom: 12 }}>
        <div className="card">
          <div className="card-header"><span className="card-title" style={{ fontSize: 13 }}>Triggering event</span></div>
          <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px' }}>
            <KV k="Principal">{a.principal} <small className="muted">({a.user_type || '—'})</small></KV>
            <KV k="Action">{a.action || '—'} <small className="muted">/ {a.subtype || '—'}</small></KV>
            <KV k="Object"><span className="mono">{a.object_name || '—'}</span></KV>
            <KV k="Rows">{a.rows_affected || '—'}</KV>
            <KV k="Client IP"><span className="mono">{a.client_ip || '—'}</span></KV>
            <KV k="Program">{a.program || '—'}</KV>
            <KV k="Database">{a.database_name || '—'}</KV>
            <KV k="Sensitivity">{tags.length ? tags.map((t) => <span key={t} className={`badge ${t === 'pci' ? 'amber' : 'red'}`} style={{ marginLeft: 4 }}>{t}</span>) : '—'}</KV>
          </div>
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title" style={{ fontSize: 13 }}>Rule condition (DSL)</span></div>
          <div className="card-body"><pre className="dep-cmd" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{a.rule_condition || '—'}</pre></div>
        </div>
      </div>

      {!panel && (
        <div className="card"><div className="card-body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn-primary" onClick={() => { setNote(''); setPanel('ack'); }}>✓ Acknowledge</button>
          <button className="btn-secondary" onClick={() => { setNote(''); setPanel('resolve'); }}>✓ Resolve</button>
          <button className="btn-secondary" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => { setQReason(`Quarantined from alert: ${a.rule || a.summary || 'manual'}`); setPanel('quarantine'); }}>⛔ Quarantine &amp; kill</button>
          <button className="btn-secondary" onClick={() => { setEscNote(''); setEscSel({ teams: false, slack: false, email: false }); setPanel('escalate'); }}>↗ Escalate</button>
          <button className="btn-secondary" onClick={() => setPanel('fp')}>✗ False positive</button>
          <button className="btn-secondary" onClick={() => onAct('Opening session reconstruction')}>⎚ Session timeline</button>
        </div></div>
      )}

      {panel === 'ack' && (
        <div className="card" style={{ background: 'var(--surface-2)' }}>
          <div className="card-body">
            <div className="section-label">Acknowledge alert</div>
            <p className="muted" style={{ fontSize: 12.5, margin: '0 0 10px' }}>Marks the alert as being worked on. Add a note if you like.</p>
            <div className="form-field">
              <label>Note <span className="muted">(optional)</span></label>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="e.g. Investigating — looks like the nightly ETL job." style={{ width: '100%', resize: 'vertical' }} />
            </div>
            <div className="modal-footer" style={{ padding: '6px 0 0', justifyContent: 'flex-end' }}>
              <button className="btn-secondary" onClick={closePanel} disabled={busy}>Cancel</button>
              <button className="btn-primary" onClick={onAck} disabled={busy}>{busy ? 'Saving…' : '✓ Confirm acknowledge'}</button>
            </div>
          </div>
        </div>
      )}

      {panel === 'resolve' && (
        <div className="card" style={{ background: 'var(--surface-2)' }}>
          <div className="card-body">
            <div className="section-label">Resolve alert</div>
            <p className="muted" style={{ fontSize: 12.5, margin: '0 0 10px' }}>Closes the alert. A resolution note is required for the audit trail.</p>
            <div className="form-field">
              <label>Resolution notes <span style={{ color: 'var(--danger)' }}>*</span></label>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} placeholder="What did you find, and how was it resolved?" style={{ width: '100%', resize: 'vertical' }} autoFocus />
            </div>
            <div className="modal-footer" style={{ padding: '6px 0 0', justifyContent: 'flex-end' }}>
              <button className="btn-secondary" onClick={closePanel} disabled={busy}>Cancel</button>
              <button className="btn-primary" onClick={onResolve} disabled={busy || !note.trim()}>{busy ? 'Saving…' : '✓ Confirm resolve'}</button>
            </div>
          </div>
        </div>
      )}

      {panel === 'escalate' && (
        <div className="card" style={{ background: 'var(--surface-2)' }}>
          <div className="card-body">
            <div className="section-label">Escalate alert</div>
            <p className="muted" style={{ fontSize: 12.5, margin: '0 0 10px', lineHeight: 1.5 }}>Notify a channel and record the escalation. The alert stays open.</p>
            <div className="form-field">
              <label>Notify via</label>
              {!escInfo ? (
                <p className="muted" style={{ fontSize: 12.5, margin: '2px 0' }}>Checking available channels…</p>
              ) : (!escInfo.teams && !escInfo.slack && !escInfo.email) ? (
                <div style={{ background: 'var(--amber-soft)', color: 'var(--amber)', borderRadius: 8, padding: '9px 12px', fontSize: 12.5, lineHeight: 1.5 }}>
                  No notification channels are configured yet. An admin can set up <b>Slack</b>, <b>Microsoft Teams</b>, or <b>Email</b> under <b>Integrations</b> — then they'll be selectable here.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {ESC_CHANNELS.map(({ key, label, letter, color }) => {
                    const available = !!escInfo[key];
                    const selected = !!escSel[key];
                    return (
                      <button key={key} type="button" disabled={!available}
                        onClick={() => setEscSel((s) => ({ ...s, [key]: !s[key] }))}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
                          padding: '11px 14px', borderRadius: 10, fontFamily: 'inherit', fontSize: 13.5,
                          border: `1.5px solid ${selected ? 'var(--primary)' : 'var(--line)'}`,
                          background: selected ? 'var(--primary-soft)' : 'var(--surface)',
                          cursor: available ? 'pointer' : 'not-allowed', opacity: available ? 1 : 0.55, transition: '.12s',
                        }}>
                        <span style={{ width: 30, height: 30, borderRadius: 8, background: color, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 15, flex: 'none' }}>{letter}</span>
                        <span style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{label}</div>
                          {!available && <div className="muted" style={{ fontSize: 11 }}>Not configured — set up in Integrations</div>}
                        </span>
                        <span style={{
                          width: 20, height: 20, borderRadius: '50%', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          border: `1.5px solid ${selected ? 'var(--primary)' : 'var(--line)'}`, background: selected ? 'var(--primary)' : 'transparent',
                          color: '#fff', fontSize: 12,
                        }}>{selected ? '✓' : ''}</span>
                      </button>
                    );
                  })}
                  <p className="muted" style={{ fontSize: 11.5, margin: '2px 0 0' }}>Pick one or more — the alert is sent to each selected channel.</p>
                </div>
              )}
            </div>
            {escSel.email && (
              <div className="form-field">
                <label>Email recipients <span className="muted">(comma-separated)</span></label>
                <input value={escRecipients} onChange={(e) => setEscRecipients(e.target.value)} placeholder="soc@company.com, oncall@company.com" />
              </div>
            )}
            <div className="form-field">
              <label>Note <span className="muted">(optional — e.g. target / why)</span></label>
              <input value={escNote} onChange={(e) => setEscNote(e.target.value)} placeholder="e.g. to on-call — suspected data exfiltration" />
            </div>
            <div className="modal-footer" style={{ padding: '6px 0 0', justifyContent: 'flex-end', alignItems: 'center', gap: 10 }}>
              {!Object.values(escSel).some(Boolean) && <span className="muted" style={{ fontSize: 11.5, marginRight: 'auto' }}>Select at least one channel to escalate.</span>}
              <button className="btn-secondary" onClick={() => setPanel(null)} disabled={busy}>Cancel</button>
              <button className="btn-primary" onClick={onEscalate} disabled={busy || !Object.values(escSel).some(Boolean)}>{busy ? 'Escalating…' : '↗ Escalate'}</button>
            </div>
          </div>
        </div>
      )}

      {panel === 'quarantine' && (
        <div className="card" style={{ background: 'var(--surface-2)', borderColor: 'var(--danger)' }}>
          <div className="card-body">
            <div className="section-label" style={{ color: 'var(--danger)' }}>Quarantine &amp; kill account</div>
            <p style={{ fontSize: 12.5, margin: '0 0 10px', lineHeight: 1.5 }}>
              This blocks <b>every</b> SQL statement from <b>{a.principal || '—'}</b> inline and drops their live session(s), until an admin releases them from the Quarantine screen. This is a real containment action.
            </p>
            <div className="form-field">
              <label>Reason</label>
              <input value={qReason} onChange={(e) => setQReason(e.target.value)} placeholder="Why is this account being quarantined?" />
            </div>
            <div className="modal-footer" style={{ padding: '6px 0 0', justifyContent: 'flex-end' }}>
              <button className="btn-secondary" onClick={() => setPanel(null)} disabled={busy}>Cancel</button>
              <button className="btn-primary" style={{ background: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={onQuarantine} disabled={busy || !a.principal}>{busy ? 'Quarantining…' : `⛔ Quarantine ${a.principal || ''}`}</button>
            </div>
          </div>
        </div>
      )}

      {panel === 'fp' && (
        <div className="card" style={{ background: 'var(--surface-2)' }}>
          <div className="card-body">
            <div className="section-label">Mark as false positive</div>
            <p className="muted" style={{ fontSize: 12.5, margin: '0 0 10px', lineHeight: 1.5 }}>
              Creates a suppression so <b>{a.rule || 'this rule'}</b> stops firing for the selected scope.
            </p>
            <div className="form-field">
              <label>Suppression scope</label>
              <select value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="principal">This principal — {a.principal}</option>
                <option value="object">This object — {a.object_name || '—'}</option>
                <option value="both">This principal + object</option>
                <option value="rule">Rule-wide — {a.rule}</option>
              </select>
            </div>
            <div className="form-field">
              <label>Reason (optional)</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this a false positive?" />
            </div>
            <div className="modal-footer" style={{ padding: '6px 0 0', justifyContent: 'flex-end' }}>
              <button className="btn-secondary" onClick={() => { setPanel(null); setReason(''); }} disabled={busy}>Cancel</button>
              <button className="btn-primary" onClick={onFalsePositive} disabled={busy}>Confirm false positive</button>
            </div>
          </div>
        </div>
      )}

      {notes.length > 0 && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="card-header"><span className="card-title" style={{ fontSize: 13 }}>Disposition history</span><span className="card-sub">{notes.length}</span></div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {notes.map((n, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, borderTop: i ? '1px solid var(--line)' : 'none', paddingTop: i ? 10 : 0 }}>
                <span className={`badge ${NOTE_BADGE[n.action] || ''}`} style={{ height: 'fit-content', whiteSpace: 'nowrap' }}>{NOTE_LABEL[n.action] || n.action}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {n.note && <div style={{ fontSize: 13, lineHeight: 1.5 }}>{n.note}</div>}
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{n.actor_email || '—'} · {new Date(n.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Layout>
  );
}

const NOTE_LABEL = { ack: 'Acknowledged', resolved: 'Resolved', false_positive: 'False positive', open: 'Reopened', escalate: 'Escalated' };
const NOTE_BADGE = { resolved: 'green', false_positive: '', ack: 'amber', escalate: 'amber' };

// Escalation channels (brand-tinted icon badges for the selector).
const ESC_CHANNELS = [
  { key: 'teams', label: 'Microsoft Teams', letter: 'T', color: '#4b53bc' },
  { key: 'slack', label: 'Slack', letter: '#', color: '#611f69' },
  { key: 'email', label: 'Email', letter: '@', color: '#0891b2' },
];
