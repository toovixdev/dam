import { useState, useEffect } from 'react';
import { fmtTs, getTimezone } from '../hooks/useTimezone';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/KpiCard';
import TabNav from '../components/shared/TabNav';
import DataTable from '../components/shared/DataTable';
import Modal from '../components/shared/Modal';
import { SeverityBadge } from '../components/shared/Badge';
import useApiData from '../hooks/useApiData';
import useFeatures from '../hooks/useFeatures';
import { UpsellPanel } from '../components/shared/FeatureGate';
import { apiPost, apiPut, apiDelete } from '../api/client';
import { toast } from '../components/shared/Toast';

const ACTION_CLR = { block: 'var(--danger)', alert: 'var(--info)', webhook: 'var(--muted)', email: 'var(--muted)' };
const STATUS_BADGE = { enabled: { cls: 'green', label: 'enabled' }, monitor: { cls: 'blue', label: 'monitor' }, disabled: { cls: '', label: 'disabled' } };

function ActionChips({ actions }) {
  return (
    <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {(Array.isArray(actions) ? actions : []).map((a) => (
        <span key={a} className="badge" style={{ fontSize: 10.5, color: ACTION_CLR[a] || 'var(--muted)' }}>{a}</span>
      ))}
    </span>
  );
}

export default function Policies() {
  const { data, loading, error, refetch } = useApiData('/policies');
  const { features } = useFeatures();
  // SQL grammar allow-list / governed exceptions is an Enterprise feature.
  const allowlistOn = features['sql-allowlist'] !== false;
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [tab, setTab] = useState('all');
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);

  const handleRefresh = () => { refetch(); setLastRefresh(new Date()); };

  const rows = Array.isArray(data) ? data : [];
  const total = rows.length;
  const enabled = rows.filter(p => p.status === 'enabled').length;
  const monitor = rows.filter(p => p.status === 'monitor').length;
  const disabled = rows.filter(p => p.status === 'disabled').length;

  const tabs = [
    { id: 'all', label: 'All', count: total },
    { id: 'alert', label: 'Alert', count: rows.filter(p => p.category === 'alert').length },
    { id: 'block', label: 'Block', count: rows.filter(p => p.category === 'block').length },
    { id: 'anomaly', label: 'Anomaly', count: rows.filter(p => p.rule_type === 'anomaly').length },
    { id: 'monitor', label: 'Monitor', count: monitor },
    { id: 'exceptions', label: allowlistOn ? 'Exceptions' : 'Exceptions 🔒' },
    { id: 'allowlist', label: allowlistOn ? 'Grammar Allow-list' : 'Grammar Allow-list 🔒' },
  ];
  const filtered = rows.filter(p =>
    tab === 'all' ? true
      : tab === 'alert' ? p.category === 'alert'
        : tab === 'block' ? p.category === 'block'
          : tab === 'anomaly' ? p.rule_type === 'anomaly'
            : p.status === 'monitor');

  const setStatus = async (id, status) => {
    const res = await apiPost(`/policies/${id}/status`, { status });
    if (res && res.ok) { toast(`Rule ${status}`, 'ok'); refetch(); setSelected(null); }
    else toast('Action failed', 'err');
  };

  const columns = [
    { key: 'name', label: 'Rule', render: (v, row) => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <b>{v}</b>
        {row.inert_on_audit_instances > 0 && (
          <span className="badge" style={{ fontSize: 10, color: 'var(--amber)', borderColor: 'var(--amber)' }}
            title={`Volume/threshold rule — needs a result-visible capture mode (network / host / proxy). It can't fire on ${row.inert_on_audit_instances} instance(s) monitored via audit-log capture (AgentLite), where row counts aren't available.`}>
            ⚠ audit-log gap
          </span>
        )}
      </span>
    ) },
    { key: 'rule_type', label: 'Type', render: (v) => <span className="badge">{v || '-'}</span> },
    { key: 'severity', label: 'Severity', render: (v) => <SeverityBadge severity={v || 'medium'} /> },
    { key: 'scope', label: 'Scope', render: (v) => <span className="mono" style={{ fontSize: 11.5 }}>{v || 'all'}</span> },
    { key: 'actions', label: 'Action', sortable: false, render: (v) => <ActionChips actions={v} /> },
    { key: 'shadow_hits', label: 'Shadow hits', align: 'right', render: (v, row) => (
      row.status === 'monitor' ? <span><b>{(v || 0).toLocaleString()}</b> <small className="muted">({row.shadow_fp || 0} FP)</small></span> : <span className="muted">—</span>
    ) },
    { key: 'status', label: 'Status', render: (v) => { const s = STATUS_BADGE[v] || STATUS_BADGE.disabled; return <span className={`badge ${s.cls} dot`}>{s.label}</span>; } },
  ];

  if (loading) {
    return <Layout activePage="policies"><div className="loading-screen"><div className="loading-spinner" /><p>Loading policies...</p></div></Layout>;
  }

  return (
    <Layout activePage="policies" lastRefresh={lastRefresh} onRefresh={handleRefresh}>
      <PageHeader title="Policies &amp; Rules" meta={['engine-neutral DSL', 'one rule → all engines', 'versioned + auditable']}>
        <button className="btn-secondary" onClick={() => toast('Rule pack import — coming soon')}>⤓ Rule pack</button>
        <button className="btn-primary" onClick={() => setCreating(true)}>＋ New rule</button>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="⚖" label="Total Rules" value={total} detail="all defined rules" />
        <KpiCard icon="◉" iconBg="var(--green-soft)" iconColor="var(--green)" label="Enabled" value={enabled} detail="actively enforcing" detailType="up" />
        <KpiCard icon="◎" iconBg="var(--info-soft)" iconColor="var(--info)" label="Monitor (shadow)" value={monitor} detail="logging, not enforcing" />
        <KpiCard icon="○" iconBg="var(--surface-2)" iconColor="var(--muted)" label="Disabled" value={disabled} detail="not active" />
      </section>

      {error && <div className="card" style={{ padding: 16, color: 'var(--danger)' }}>Error: {error}</div>}

      <TabNav tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'exceptions' ? (
        allowlistOn ? <ExceptionsPanel rules={rows} /> : <UpsellPanel name="SQL grammar allow-list / governed exceptions" inline />
      ) : tab === 'allowlist' ? (
        allowlistOn ? <GrammarAllowlistPanel /> : <UpsellPanel name="SQL grammar allow-list — positive-security deviation detection" inline />
      ) : (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Rules</span>
            <span className="card-sub">{filtered.length} shown · click a rule for details</span>
          </div>
          <div className="card-body no-pad">
            <DataTable columns={columns} data={filtered} onRowClick={setSelected} emptyMessage="No rules in this view" />
          </div>
        </div>
      )}

      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected ? selected.name : ''} width={680}>
        {selected && <PolicyDetail p={selected} onStatus={setStatus} onEdit={(p) => { setSelected(null); setEditing(p); }} />}
      </Modal>

      <Modal open={creating} onClose={() => setCreating(false)} title="Create new rule" width={620}>
        <RuleForm onClose={() => setCreating(false)} onSaved={() => { refetch(); setCreating(false); }} />
      </Modal>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing ? `Edit rule — ${editing.name}` : ''} width={620}>
        {editing && <RuleForm initial={editing} onClose={() => setEditing(null)} onSaved={() => { refetch(); setEditing(null); }} />}
      </Modal>
    </Layout>
  );
}

function PolicyDetail({ p, onStatus, onEdit }) {
  const dsl = typeof p.rule_definition === 'string' ? p.rule_definition : JSON.stringify(p.rule_definition || {}, null, 2);
  const { data: versionData } = useApiData(`/policies/${p.id}/versions`);
  const versions = Array.isArray(versionData) ? versionData : [];
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const runTest = async () => {
    setTesting(true);
    const res = await apiPost('/policies/test', { rule_definition: p.rule_definition });
    setTesting(false);
    if (res && res.ok) setTestResult(res.data);
    else toast('Test failed', 'err');
  };
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginBottom: 12, fontSize: 13, color: 'var(--muted)', alignItems: 'center' }}>
        <SeverityBadge severity={p.severity || 'medium'} />
        <span className="badge">{p.rule_type}</span>
        <span>Scope <b className="mono" style={{ color: 'var(--ink)' }}>{p.scope || 'all'}</b></span>
        <ActionChips actions={p.actions} />
        <span className={`badge ${(STATUS_BADGE[p.status] || STATUS_BADGE.disabled).cls} dot`}>{p.status}</span>
      </div>
      <p style={{ fontSize: 13, lineHeight: 1.5, margin: '0 0 12px' }}>{p.description || '—'}</p>

      {p.inert_on_audit_instances > 0 && (
        <div style={{ background: 'var(--amber-soft)', border: '1px solid var(--amber)', borderRadius: 8, padding: '10px 12px', margin: '0 0 12px', fontSize: 12.5, lineHeight: 1.55 }}>
          <b style={{ color: 'var(--amber)' }}>⚠ Not effective on audit-log capture.</b> This rule thresholds on <b>rows returned</b>, but AgentLite (audit-log) capture records only the statement — <span className="mono">row_count</span> is always 0 there, so it <b>cannot fire</b> on <b>{p.inert_on_audit_instances}</b> instance{p.inert_on_audit_instances === 1 ? '' : 's'} monitored this way. Use <b>network</b> or <b>host (eBPF)</b> capture on those databases for volume-based detection.
        </div>
      )}

      {p.status === 'monitor' && (
        <div style={{ background: 'var(--info-soft)', borderRadius: 10, padding: '10px 14px', fontSize: 12.5, marginBottom: 12 }}>
          Shadow mode — <b>{(p.shadow_hits || 0).toLocaleString()}</b> hits ({p.shadow_fp || 0} false positives). Promote to Enabled to start enforcing.
        </div>
      )}

      <div className="section-label">Rule condition (engine-neutral DSL)</div>
      <pre className="dep-cmd" style={{ whiteSpace: 'pre-wrap', margin: '0 0 14px' }}>{dsl}</pre>

      {versions.length > 0 && (
        <>
          <div className="section-label">Version history</div>
          <div style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden', marginBottom: 14 }}>
            {versions.map((v) => (
              <div key={v.version} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderTop: '1px solid var(--line-2)', fontSize: 12.5 }}>
                <span className="badge">v{v.version}</span>
                <span style={{ flex: 1 }}>{v.change}</span>
                <span className="muted">{v.changed_by || 'system'}</span>
                <span className="muted">{fmtTs(v.created_at, getTimezone(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="modal-footer" style={{ padding: '4px 0 0', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <button className="btn-secondary" style={{ marginRight: 'auto' }} onClick={() => onEdit(p)}>✎ Edit rule</button>
        {p.status !== 'enabled' && <button className="btn-primary" onClick={() => onStatus(p.id, 'enabled')}>✓ Enable</button>}
        {p.status !== 'monitor' && <button className="btn-secondary" onClick={() => onStatus(p.id, 'monitor')}>◎ Move to Monitor</button>}
        {p.status !== 'disabled' && <button className="btn-secondary" onClick={() => onStatus(p.id, 'disabled')}>○ Disable</button>}
        <button className="btn-secondary" onClick={runTest} disabled={testing}>{testing ? 'Testing…' : '▷ Test against last 24h'}</button>
      </div>

      {testResult && (
        <div style={{ background: 'var(--surface-2)', borderRadius: 10, padding: '12px 14px', marginTop: 12, fontSize: 13 }}>
          {testResult.matches == null ? (
            <span className="muted">{testResult.note || 'Not backtestable.'}</span>
          ) : (
            <>
              <b style={{ color: testResult.matches > 0 ? 'var(--amber)' : 'var(--green)' }}>
                {testResult.matches.toLocaleString()} event{testResult.matches === 1 ? '' : 's'}
              </b> would have matched in the last 24h.
              {testResult.ignored && testResult.ignored.length > 0 && (
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Ignored (not backtestable): {testResult.ignored.join(', ')}</div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

const RULE_TYPES = ['threshold', 'pattern', 'anomaly', 'first_time', 'privileged'];
const ALL_ACTIONS = ['alert', 'block', 'webhook', 'email'];

function RuleForm({ initial = null, onClose, onSaved }) {
  const isEdit = !!(initial && initial.id);
  const initDsl = initial
    ? (typeof initial.rule_definition === 'string' ? initial.rule_definition : JSON.stringify(initial.rule_definition || {}, null, 2))
    : '{\n  "action_type": "READ",\n  "rows_affected": { "gte": 10000 }\n}';
  const [name, setName] = useState(initial?.name || '');
  const [ruleType, setRuleType] = useState(initial?.rule_type || 'threshold');
  const [category, setCategory] = useState(initial?.category || 'alert');
  const [severity, setSeverity] = useState(initial?.severity || 'high');
  const [scope, setScope] = useState(initial?.scope || 'all');
  const [actions, setActions] = useState(Array.isArray(initial?.actions) ? initial.actions : ['alert']);
  const [status, setStatus] = useState(initial?.status || 'monitor');
  const [description, setDescription] = useState(initial?.description || '');
  const [dsl, setDsl] = useState(initDsl);
  const [saving, setSaving] = useState(false);

  const toggleAction = (a) => setActions((p) => (p.includes(a) ? p.filter((x) => x !== a) : [...p, a]));

  const save = async () => {
    if (!name.trim()) { toast('Name is required', 'err'); return; }
    try { JSON.parse(dsl); } catch { toast('Rule condition must be valid JSON', 'err'); return; }
    setSaving(true);
    const body = { name, description, rule_type: ruleType, category, severity, scope, actions, status, rule_definition: dsl };
    const res = isEdit ? await apiPut(`/policies/${initial.id}`, body) : await apiPost('/policies', body);
    setSaving(false);
    if (res && res.ok) { toast(`Rule "${name}" ${isEdit ? 'updated' : 'created'}`, 'ok'); onSaved(); }
    else toast(res?.data?.error || `Could not ${isEdit ? 'update' : 'create'} rule`, 'err');
  };

  return (
    <>
      <div className="form-field"><label>Rule name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bulk read of sensitive data" /></div>
      <div className="form-row" style={{ display: 'flex', gap: 12 }}>
        <div className="form-field" style={{ flex: 1 }}><label>Type</label>
          <select value={ruleType} onChange={(e) => setRuleType(e.target.value)}>{RULE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
        </div>
        <div className="form-field" style={{ flex: 1 }}><label>Category</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)}><option value="alert">alert</option><option value="block">block</option></select>
        </div>
        <div className="form-field" style={{ flex: 1 }}><label>Severity</label>
          <select value={severity} onChange={(e) => setSeverity(e.target.value)}><option>critical</option><option>high</option><option>medium</option><option>low</option></select>
        </div>
      </div>
      <div className="form-field"><label>Scope</label><input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="all · db_group: prod · compliance_tag: pii · engine: llm" /></div>
      <div className="form-field"><label>Actions</label>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13 }}>
          {ALL_ACTIONS.map((a) => <label key={a} style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={actions.includes(a)} onChange={() => toggleAction(a)} /> {a}</label>)}
        </div>
      </div>
      <div className="form-field"><label>Description</label><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this rule detect?" /></div>
      <div className="form-field"><label>Rule condition (engine-neutral JSON DSL)</label>
        <textarea className="mono" value={dsl} onChange={(e) => setDsl(e.target.value)} rows={6} style={{ width: '100%', fontSize: 12 }} />
        <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>Canonical actions: READ / WRITE / DELETE / DDL / GRANT / LOGIN / ADMIN. One rule fires across all engines.</div>
      </div>
      <div className="form-field"><label>Status</label>
        <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="monitor">Monitor (shadow)</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select>
      </div>
      <div className="modal-footer" style={{ padding: '6px 0 0', justifyContent: 'flex-end' }}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : isEdit ? 'Save changes' : status === 'enabled' ? 'Save & Enable' : 'Save as Monitor'}</button>
      </div>
    </>
  );
}

// ── Governed exceptions / allow-list ──────────────────────────────────────
// Proactive, db-qualified, optionally-expiring exemptions the detection engine honors.
const EXPIRY_OPTS = [{ v: 0, l: 'Never (permanent)' }, { v: 1, l: '1 day' }, { v: 7, l: '7 days' }, { v: 30, l: '30 days' }, { v: 90, l: '90 days' }];
function ExceptionsPanel({ rules }) {
  const [showAll, setShowAll] = useState(false);
  const { data, refetch } = useApiData(showAll ? '/policies/exceptions?include=all' : '/policies/exceptions', { poll: 0 });
  const { data: databases } = useApiData('/databases', { poll: 0 });
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(null);
  const list = Array.isArray(data) ? data : [];

  const revoke = async (id) => {
    setBusy(id);
    const res = await apiDelete(`/policies/exceptions/${id}`);
    setBusy(null);
    if (res?.ok) { toast('Exception revoked — kept in the trail', 'ok'); refetch(); }
    else toast(res?.data?.error || 'Could not revoke', 'err');
  };
  const fmtD = (d) => d ? fmtTs(d, getTimezone(), { day: '2-digit', month: 'short' }) : '—';
  const short = (s) => { if (!s) return '—'; const at = s.indexOf('@'); const v = at > 0 ? s.slice(0, at) : s; return v.length > 16 ? v.slice(0, 16) + '…' : v; };
  const state = (e) => e.status === 'revoked' ? 'revoked' : (e.expired ? 'expired' : 'active');
  const stateBadge = { active: 'status-green', expired: 'sev-high', revoked: '' };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, background: 'var(--info-soft)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 14px', marginBottom: 14, fontSize: 12.5, lineHeight: 1.5 }}>
        <div>Exceptions exempt a specific, vetted flow from a rule so it stops firing — scope them narrowly
          (database + table, ideally a principal) and set an <b>expiry</b>. The detection engine honors active ones; capture/audit is unaffected.
          Revoking <b>retains</b> the record (who/when), and every grant/revoke is also in the hash-chained audit trail.</div>
        <button className="btn-primary" style={{ flex: 'none' }} onClick={() => setAdding(true)}>＋ Add exception</button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button className={showAll ? 'btn-secondary' : 'btn-primary'} style={{ padding: '5px 14px', fontSize: 12.5 }} onClick={() => setShowAll(false)}>Active</button>
        <button className={showAll ? 'btn-primary' : 'btn-secondary'} style={{ padding: '5px 14px', fontSize: 12.5 }} onClick={() => setShowAll(true)}>All (incl. revoked / expired)</button>
      </div>
      <div className="card"><div className="card-body no-pad">
        <table className="data-table" style={{ tableLayout: 'fixed', width: '100%' }}>
          <thead><tr>
            <th style={{ width: '20%' }}>Rule</th>
            <th style={{ width: '26%' }}>Scope</th>
            <th style={{ width: '16%' }}>Reason</th>
            <th style={{ width: '22%' }}>Lifecycle</th>
            <th style={{ width: '9%' }}>Expiry</th>
            <th style={{ width: '7%' }} />
          </tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={6} className="muted" style={{ padding: 18, textAlign: 'center' }}>{showAll ? 'No exceptions have ever been created.' : 'No active exceptions. Everything is subject to the rules.'}</td></tr>}
            {list.map((e) => {
              const st = state(e);
              const ell = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
              return (
                <tr key={e.id} style={{ opacity: busy === e.id ? 0.5 : (st === 'active' ? 1 : 0.66) }}>
                  <td><b style={{ ...ell, display: 'block' }} title={e.rule}>{e.rule}</b></td>
                  <td>
                    <div className="mono" style={{ fontSize: 12, ...ell }} title={`${e.database_name || 'any db'} · ${e.object_name || 'any object'}`}>{e.object_name || <span className="muted">any object</span>}</div>
                    <div className="muted" style={{ fontSize: 11, ...ell }}>{e.database_name || 'any db'} · {e.principal || 'any principal'}</div>
                  </td>
                  <td className="muted" style={{ fontSize: 12, ...ell }} title={e.reason || ''}>{e.reason || '—'}</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span className={`badge ${stateBadge[st]}`}>{st}</span>
                    </div>
                    <div className="muted" style={{ fontSize: 10.5, marginTop: 3, ...ell }} title={`granted by ${e.created_by || '—'} on ${fmtD(e.created_at)}`}>granted {short(e.created_by)} · {fmtD(e.created_at)}</div>
                    {st === 'revoked' && <div className="muted" style={{ fontSize: 10.5, ...ell }} title={`revoked by ${e.revoked_by || '—'} on ${fmtD(e.revoked_at)}`}>revoked {short(e.revoked_by)} · {fmtD(e.revoked_at)}</div>}
                  </td>
                  <td style={{ fontSize: 12 }}>{e.expires_at ? fmtD(e.expires_at) : <span className="muted">never</span>}</td>
                  <td style={{ textAlign: 'right' }}>
                    {st === 'active'
                      ? <button className="btn-secondary" style={{ padding: '3px 9px', fontSize: 11, color: 'var(--danger)', borderColor: 'var(--danger)' }} disabled={busy === e.id} onClick={() => revoke(e.id)}>Revoke</button>
                      : <span className="muted">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div></div>
      <Modal open={adding} onClose={() => setAdding(false)} title="Add exception" width={560}>
        <AddException rules={rules} databases={databases || []} onClose={() => setAdding(false)} onCreated={() => { setAdding(false); refetch(); }} />
      </Modal>
    </>
  );
}

function AddException({ rules, databases, onClose, onCreated }) {
  const [rule, setRule] = useState('');
  const [databaseName, setDatabaseName] = useState('');
  const [objectName, setObjectName] = useState('');
  const [principal, setPrincipal] = useState('');
  const [reason, setReason] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (rules.length && !rule) setRule(rules[0].name); }, [rules]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!rule) return toast('Pick a rule', 'err');
    if (!objectName.trim() && !principal.trim()) return toast('Set at least an object (table) or a principal — a rule-wide exception is too broad', 'err');
    setBusy(true);
    const res = await apiPost('/policies/exceptions', { rule, databaseName: databaseName || undefined, objectName: objectName.trim() || undefined, principal: principal.trim() || undefined, reason: reason.trim() || undefined, expiresInDays });
    setBusy(false);
    if (res?.ok) { toast('Exception added — the engine will honor it', 'ok'); onCreated(); }
    else toast(res?.data?.error || 'Could not add', 'err');
  };

  return (
    <>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 14px' }}>
        Exempt a specific flow from a rule. Keep it narrow (database + table + principal) and time-boxed.
      </p>
      <div className="form-field"><label>Rule</label>
        <select value={rule} onChange={(e) => setRule(e.target.value)}>
          {rules.map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}
        </select>
      </div>
      <div className="form-row">
        <div className="form-field"><label>Database</label>
          <select value={databaseName} onChange={(e) => setDatabaseName(e.target.value)}>
            <option value="">Any database</option>
            {databases.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
          </select>
        </div>
        <div className="form-field"><label>Object (schema.table)</label>
          <input value={objectName} onChange={(e) => setObjectName(e.target.value)} placeholder="e.g. payments.customers" />
        </div>
      </div>
      <div className="form-row">
        <div className="form-field"><label>Principal <span className="muted">(optional)</span></label>
          <input value={principal} onChange={(e) => setPrincipal(e.target.value)} placeholder="e.g. reporting_svc" />
        </div>
        <div className="form-field"><label>Expiry</label>
          <select value={expiresInDays} onChange={(e) => setExpiresInDays(Number(e.target.value))}>
            {EXPIRY_OPTS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
        </div>
      </div>
      <div className="form-field"><label>Reason</label>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Business justification (recommended)" />
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 12, borderTop: '1px solid var(--line)' }}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy} onClick={save}>{busy ? 'Adding…' : 'Add exception'}</button>
      </div>
    </>
  );
}

// ── SQL Grammar Allow-list (positive security) ────────────────────────────────
function ModeBadge({ mode }) {
  const m = { learning: { cls: 'blue', label: 'learning' }, enforcing: { cls: 'green', label: 'enforcing' }, off: { cls: '', label: 'off' } }[mode] || { cls: '', label: mode };
  return <span className={`badge ${m.cls} dot`}>{m.label}</span>;
}

function GrammarAllowlistPanel() {
  const { data, refetch } = useApiData('/allowlist/profiles', { poll: 0 });
  const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
  const available = Array.isArray(data?.available) ? data.available : [];
  const [sel, setSel] = useState(null);      // selected database_name (detail)
  const [adding, setAdding] = useState(false);
  const fmtD = (d) => d ? fmtTs(d, getTimezone(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

  const setMode = async (p, mode) => {
    const res = await apiPut(`/allowlist/profiles/${p.id}`, { mode });
    if (res?.ok) { toast(`${p.database_name} → ${mode}`, 'ok'); refetch(); } else toast(res?.data?.error || 'Failed', 'err');
  };
  const del = async (p) => {
    if (!window.confirm(`Remove the grammar allow-list for ${p.database_name}? Learned grammars and deviation history are discarded.`)) return;
    const res = await apiDelete(`/allowlist/profiles/${p.id}`);
    if (res?.ok) { toast('Allow-list removed', 'ok'); if (sel === p.database_name) setSel(null); refetch(); } else toast('Failed', 'err');
  };

  return (
    <>
      <div style={{ background: 'var(--info-soft)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 14px', marginBottom: 14, fontSize: 12.5, lineHeight: 1.5, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div><b>Positive security (default-deny).</b> Put a database in <b>learning</b> to capture its normal set of SQL query
          <i> grammars</i> (statements with literals collapsed to <span className="mono">?</span>). Promote to <b>enforcing</b> and any
          statement whose grammar isn't on the list is a <b>deviation</b> — raised as an alert and queued for review. Inline blocking is on the roadmap.</div>
        <button className="btn-primary" style={{ flex: 'none' }} disabled={!available.length} onClick={() => setAdding(true)}
          title={available.length ? '' : 'All monitored databases already have a profile'}>＋ Start learning</button>
      </div>

      <div className="card"><div className="card-body no-pad">
        <table className="data-table" style={{ width: '100%' }}>
          <thead><tr>
            <th>Database</th><th>Mode</th><th style={{ textAlign: 'right' }}>Allowed</th>
            <th style={{ textAlign: 'right' }}>Blocked</th><th style={{ textAlign: 'right' }}>Open deviations</th>
            <th>Window</th><th style={{ width: 260 }} />
          </tr></thead>
          <tbody>
            {profiles.length === 0 && <tr><td colSpan={7} className="muted" style={{ padding: 18, textAlign: 'center' }}>No databases under a grammar allow-list yet. Start learning on one to begin.</td></tr>}
            {profiles.map((p) => (
              <tr key={p.id} style={{ cursor: 'pointer', background: sel === p.database_name ? 'var(--surface-2)' : undefined }} onClick={() => setSel(sel === p.database_name ? null : p.database_name)}>
                <td><b>{p.database_name}</b></td>
                <td><ModeBadge mode={p.mode} /></td>
                <td style={{ textAlign: 'right' }}>{p.allowed_count}</td>
                <td style={{ textAlign: 'right' }}>{p.blocked_count ? <span style={{ color: 'var(--danger)' }}>{p.blocked_count}</span> : '—'}</td>
                <td style={{ textAlign: 'right' }}>{p.open_deviations ? <span style={{ color: 'var(--amber)', fontWeight: 600 }}>{p.open_deviations}</span> : '—'}</td>
                <td className="muted" style={{ fontSize: 11.5 }}>{p.mode === 'learning' ? (p.learn_until ? `auto-enforce ${fmtD(p.learn_until)}` : 'manual') : `since ${fmtD(p.learn_started_at)}`}</td>
                <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                  <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {p.mode !== 'enforcing' && <button className="btn-secondary" style={btnXs} onClick={() => setMode(p, 'enforcing')}>Enforce</button>}
                    {p.mode !== 'learning' && <button className="btn-secondary" style={btnXs} onClick={() => setMode(p, 'learning')}>Re-learn</button>}
                    {p.mode !== 'off' && <button className="btn-secondary" style={btnXs} onClick={() => setMode(p, 'off')}>Off</button>}
                    <button className="btn-secondary" style={{ ...btnXs, color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => del(p)}>Delete</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div></div>

      {sel && <AllowlistDetail database={sel} onChanged={refetch} />}

      <Modal open={adding} onClose={() => setAdding(false)} title="Start learning a database" width={520}>
        <StartLearning available={available} onClose={() => setAdding(false)} onCreated={() => { setAdding(false); refetch(); }} />
      </Modal>
    </>
  );
}

const btnXs = { padding: '3px 9px', fontSize: 11 };

function StartLearning({ available, onClose, onCreated }) {
  const [databaseName, setDatabaseName] = useState(available[0] || '');
  const [learnDays, setLearnDays] = useState(7);
  const [severity, setSeverity] = useState('high');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!databaseName) return toast('Pick a database', 'err');
    setBusy(true);
    const res = await apiPost('/allowlist/profiles', { databaseName, learnDays: Number(learnDays) || 0, severity });
    setBusy(false);
    if (res?.ok) { toast(`Learning started on ${databaseName}`, 'ok'); onCreated(); } else toast(res?.data?.error || 'Failed', 'err');
  };
  return (
    <>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 14px' }}>
        DAM will watch this database's traffic and record every distinct query grammar it sees. When the window ends it flips to
        <b> enforcing</b> automatically (or promote it yourself anytime). Choose a window that covers a full business cycle.
      </p>
      <div className="form-field"><label>Database</label>
        <select value={databaseName} onChange={(e) => setDatabaseName(e.target.value)}>
          {available.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      <div className="form-row">
        <div className="form-field"><label>Learning window</label>
          <select value={learnDays} onChange={(e) => setLearnDays(e.target.value)}>
            <option value={0}>Manual (promote myself)</option>
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
          </select>
        </div>
        <div className="form-field"><label>Deviation severity</label>
          <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
            {['low', 'medium', 'high', 'critical'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 12, borderTop: '1px solid var(--line)' }}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy} onClick={save}>{busy ? 'Starting…' : 'Start learning'}</button>
      </div>
    </>
  );
}

function AllowlistDetail({ database, onChanged }) {
  const [sub, setSub] = useState('learned');
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span className="card-title">{database}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className={sub === 'learned' ? 'btn-primary' : 'btn-secondary'} style={{ padding: '4px 12px', fontSize: 12 }} onClick={() => setSub('learned')}>Learned grammars</button>
          <button className={sub === 'deviations' ? 'btn-primary' : 'btn-secondary'} style={{ padding: '4px 12px', fontSize: 12 }} onClick={() => setSub('deviations')}>Deviations</button>
        </div>
      </div>
      <div className="card-body no-pad">
        {sub === 'learned' ? <LearnedGrammars database={database} onChanged={onChanged} /> : <DeviationList database={database} onChanged={onChanged} />}
      </div>
    </div>
  );
}

const stateBadgeCls = { approved: 'green', learned: 'blue', blocked: '' };
function LearnedGrammars({ database, onChanged }) {
  const { data, refetch } = useApiData(`/allowlist/entries?database=${encodeURIComponent(database)}`, { poll: 0 });
  const [adding, setAdding] = useState(false);
  const rows = Array.isArray(data) ? data : [];
  const act = async (fn) => { const res = await fn(); if (res?.ok) { toast('Updated', 'ok'); refetch(); onChanged?.(); } else toast(res?.data?.error || 'Failed', 'err'); };
  return (
    <>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 12 }}>{rows.length} grammar(s). Blocked shapes always deviate; approve to bless a shape permanently.</span>
        <button className="btn-secondary" style={btnXs} onClick={() => setAdding(true)}>＋ Add grammar</button>
      </div>
      <table className="data-table" style={{ width: '100%', tableLayout: 'fixed' }}>
        <thead><tr>
          <th style={{ width: '48%' }}>Grammar</th><th style={{ width: '10%' }}>Op</th><th style={{ width: '15%' }}>Principal</th>
          <th style={{ width: '9%', textAlign: 'right' }}>Hits</th><th style={{ width: '9%' }}>State</th><th style={{ width: '9%' }} />
        </tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={6} className="muted" style={{ padding: 16, textAlign: 'center' }}>No grammars learned yet.</td></tr>}
          {rows.map((e) => {
            const ell = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
            return (
              <tr key={e.id} style={{ opacity: e.state === 'blocked' ? 0.7 : 1 }}>
                <td className="mono" style={{ fontSize: 11.5, ...ell }} title={e.pattern}>{e.pattern}</td>
                <td><span className="badge">{e.operation || '—'}</span></td>
                <td className="muted" style={{ fontSize: 11.5, ...ell }} title={e.principal}>{e.principal || '—'}</td>
                <td style={{ textAlign: 'right' }}>{Number(e.hit_count || 0).toLocaleString()}</td>
                <td><span className={`badge ${stateBadgeCls[e.state] || ''}`}>{e.state}</span></td>
                <td style={{ textAlign: 'right' }}>
                  {e.state === 'blocked'
                    ? <button className="btn-secondary" style={btnXs} onClick={() => act(() => apiPost(`/allowlist/entries/${e.id}/state`, { state: 'approved' }))}>Unblock</button>
                    : <button className="btn-secondary" style={{ ...btnXs, color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => act(() => apiPost(`/allowlist/entries/${e.id}/state`, { state: 'blocked' }))}>Block</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Modal open={adding} onClose={() => setAdding(false)} title="Add an allowed grammar" width={560}>
        <AddGrammar database={database} onClose={() => setAdding(false)} onCreated={() => { setAdding(false); refetch(); onChanged?.(); }} />
      </Modal>
    </>
  );
}

function AddGrammar({ database, onClose, onCreated }) {
  const [sql, setSql] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!sql.trim()) return toast('Paste a sample statement', 'err');
    setBusy(true);
    const res = await apiPost('/allowlist/entries', { databaseName: database, sql: sql.trim() });
    setBusy(false);
    if (res?.ok) { toast('Grammar approved', 'ok'); onCreated(); } else toast(res?.data?.error || 'Failed', 'err');
  };
  return (
    <>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 12px' }}>
        Paste a representative statement. DAM normalizes it to its grammar (literals → <span className="mono">?</span>) and adds that shape as <b>approved</b> — every parameterization of it is then allowed.
      </p>
      <div className="form-field"><label>Sample SQL for {database}</label>
        <textarea value={sql} onChange={(e) => setSql(e.target.value)} rows={4} style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)', fontSize: 12.5 }} placeholder="SELECT id, email FROM customers WHERE region = 'APAC'" />
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 12, borderTop: '1px solid var(--line)' }}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy} onClick={save}>{busy ? 'Adding…' : 'Approve grammar'}</button>
      </div>
    </>
  );
}

function DeviationList({ database, onChanged }) {
  const { data, refetch } = useApiData(`/allowlist/deviations?database=${encodeURIComponent(database)}&status=open`, { poll: 0 });
  const rows = Array.isArray(data) ? data : [];
  const fmtD = (d) => d ? fmtTs(d, getTimezone(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  const act = async (fn) => { const res = await fn(); if (res?.ok) { toast('Done', 'ok'); refetch(); onChanged?.(); } else toast(res?.data?.error || 'Failed', 'err'); };
  return (
    <table className="data-table" style={{ width: '100%', tableLayout: 'fixed' }}>
      <thead><tr>
        <th style={{ width: '42%' }}>Deviating grammar</th><th style={{ width: '9%' }}>Op</th><th style={{ width: '14%' }}>Principal</th>
        <th style={{ width: '8%', textAlign: 'right' }}>Hits</th><th style={{ width: '12%' }}>Last seen</th><th style={{ width: '15%' }} />
      </tr></thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={6} className="muted" style={{ padding: 16, textAlign: 'center' }}>No open deviations. Everything this database ran matched the allow-list.</td></tr>}
        {rows.map((d) => {
          const ell = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
          return (
            <tr key={d.id}>
              <td className="mono" style={{ fontSize: 11.5, ...ell }} title={d.sample_sql || d.pattern}>{d.pattern}</td>
              <td><span className="badge">{d.operation || '—'}</span></td>
              <td className="muted" style={{ fontSize: 11.5, ...ell }} title={d.principal}>{d.principal || '—'}</td>
              <td style={{ textAlign: 'right' }}>{Number(d.hit_count || 0).toLocaleString()}</td>
              <td className="muted" style={{ fontSize: 11.5 }}>{fmtD(d.last_seen)}</td>
              <td style={{ textAlign: 'right' }}>
                <div style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button className="btn-secondary" style={{ ...btnXs, color: 'var(--green)', borderColor: 'var(--green)' }} onClick={() => act(() => apiPost(`/allowlist/deviations/${d.id}/approve`))}>Approve</button>
                  <button className="btn-secondary" style={btnXs} onClick={() => act(() => apiPost(`/allowlist/deviations/${d.id}/dismiss`))}>Dismiss</button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
