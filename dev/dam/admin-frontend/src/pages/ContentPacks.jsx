import { useState } from 'react';
import Layout from '../components/Layout';
import KpiCard from '../components/KpiCard';
import PageHeader from '../components/shared/PageHeader';
import { toast } from '../components/shared/Toast';
import useApiData from '../hooks/useApiData';
import { apiPost, apiPut, apiDelete } from '../api/client';

const ENGINE_LABEL = { mysql: 'MySQL / MariaDB', postgresql: 'PostgreSQL', mssql: 'SQL Server', oracle: 'Oracle' };
const ENGINES = ['mysql', 'postgresql', 'mssql', 'oracle'];
const SEVS = ['critical', 'high', 'medium', 'low', 'info'];
const OPS = ['equals', 'notEquals', 'contains', 'notContains', 'empty', 'notEmpty', 'gte', 'lte', 'rowsZero', 'rowsNonZero'];
const ROW_OPS = new Set(['rowsZero', 'rowsNonZero', 'empty', 'notEmpty']);
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
function sevBadge(sev) {
  const c = { critical: '#c0392b', high: '#d98a00', medium: '#3b82f6', low: '#6b7280', info: '#6b7280' }[sev] || '#6b7280';
  return <span className="badge" style={{ background: `${c}22`, color: c, fontWeight: 700 }}>{sev}</span>;
}
const blankCheck = () => ({ _new: true, engine: 'mssql', check_id: '', benchmark: '', section: '', title: '', severity: 'medium', query: '', expect: { op: 'equals', column: '', value: '' }, remediation: '', refs: [] });

function CheckEditor({ check, onCancel, onSaved }) {
  const [f, setF] = useState({ ...check, expect: { op: 'equals', column: '', value: '', ...(check.expect || {}) }, refs: Array.isArray(check.refs) ? check.refs.join(', ') : (check.refs || '') });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const setEx = (k, v) => setF((s) => ({ ...s, expect: { ...s.expect, [k]: v } }));
  const needsVal = !ROW_OPS.has(f.expect.op);

  async function save() {
    const body = { ...f, refs: f.refs };
    setSaving(true);
    const res = check._new ? await apiPost('/admin/va/checks', body) : await apiPut(`/admin/va/checks/${check.id}`, body);
    setSaving(false);
    if (res.ok) { toast(check._new ? 'Check created' : 'Check saved', 'ok'); onSaved(); }
    else toast(res.data?.error || 'Save failed', 'err');
  }

  const inp = { width: '100%', fontSize: 12.5, padding: '5px 8px' };
  const lbl = { fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' };
  return (
    <div className="card" style={{ marginBottom: 14, border: '1px solid var(--primary)' }}>
      <div className="card-header"><span className="card-title">{check._new ? 'New check' : `Edit — ${check.check_id}`}</span>
        <span className="card-sub">agents pull + run this on their next scan — no rebuild</span></div>
      <div className="card-body">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          <div><div style={lbl}>Engine</div><select style={inp} value={f.engine} onChange={(e) => set('engine', e.target.value)}>{ENGINES.map((x) => <option key={x} value={x}>{ENGINE_LABEL[x]}</option>)}</select></div>
          <div><div style={lbl}>Check ID</div><input style={inp} value={f.check_id} placeholder="mssql-my-check" onChange={(e) => set('check_id', e.target.value)} /></div>
          <div><div style={lbl}>Severity</div><select style={inp} value={f.severity} onChange={(e) => set('severity', e.target.value)}>{SEVS.map((x) => <option key={x} value={x}>{x}</option>)}</select></div>
          <div><div style={lbl}>Section</div><input style={inp} value={f.section} placeholder="2.1" onChange={(e) => set('section', e.target.value)} /></div>
          <div style={{ gridColumn: '1 / -1' }}><div style={lbl}>Title</div><input style={inp} value={f.title} placeholder="Ensure 'x' is disabled" onChange={(e) => set('title', e.target.value)} /></div>
          <div style={{ gridColumn: '1 / -1' }}><div style={lbl}>Query (read-only)</div><textarea style={{ ...inp, fontFamily: 'monospace', minHeight: 54 }} value={f.query} placeholder="SELECT value_in_use v FROM sys.configurations WHERE name='xp_cmdshell'" onChange={(e) => set('query', e.target.value)} /></div>
          <div><div style={lbl}>Expect · op</div><select style={inp} value={f.expect.op} onChange={(e) => setEx('op', e.target.value)}>{OPS.map((x) => <option key={x} value={x}>{x}</option>)}</select></div>
          <div><div style={lbl}>Column {needsVal ? '' : '(n/a)'}</div><input style={inp} value={f.expect.column} placeholder="v" disabled={f.expect.op === 'rowsZero' || f.expect.op === 'rowsNonZero'} onChange={(e) => setEx('column', e.target.value)} /></div>
          <div style={{ gridColumn: 'span 2' }}><div style={lbl}>Value {needsVal ? '' : '(n/a)'}</div><input style={inp} value={f.expect.value} placeholder="0" disabled={!['equals', 'notEquals', 'contains', 'notContains', 'gte', 'lte'].includes(f.expect.op)} onChange={(e) => setEx('value', e.target.value)} /></div>
          <div style={{ gridColumn: '1 / -1' }}><div style={lbl}>Remediation</div><input style={inp} value={f.remediation} placeholder="EXEC sp_configure 'x',0; RECONFIGURE;" onChange={(e) => set('remediation', e.target.value)} /></div>
          <div style={{ gridColumn: '1 / -1' }}><div style={lbl}>References (comma-separated)</div><input style={inp} value={f.refs} placeholder="CIS SQL Server §2.1, PCI-DSS 2.2.5" onChange={(e) => set('refs', e.target.value)} /></div>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>
          <b>op guide:</b> <code>rowsZero</code>/<code>rowsNonZero</code> → check passes on 0 / ≥1 returned rows (offending-rows pattern). <code>equals/notEquals/contains/gte/lte</code> → compare a column of the first row. Column empty = first column.
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : (check._new ? 'Create check' : 'Save changes')}</button>
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export default function ContentPacks() {
  const { data, loading, lastRefresh, refetch } = useApiData('/admin/va/checks', { poll: 0 });
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(null);

  const engines = data?.engines || [];
  const checks = data?.checks || [];
  const totals = {
    total: checks.length,
    enabled: checks.filter((c) => c.enabled).length,
    custom: checks.filter((c) => c.source === 'custom').length,
    high: checks.filter((c) => (c.severity === 'critical' || c.severity === 'high') && c.enabled).length,
  };

  async function toggle(c) {
    setBusy(c.id);
    const res = await apiPost(`/admin/va/checks/${c.id}/toggle`, { enabled: !c.enabled });
    setBusy('');
    if (res.ok) { toast(`${c.check_id} ${!c.enabled ? 'enabled' : 'disabled'}`, 'ok'); refetch(); }
    else toast(res.data?.error || 'Failed', 'err');
  }
  async function remove(c) {
    if (!window.confirm(`Delete ${c.check_id}?${c.source === 'agent' ? ' (an agent will re-register it on next run — disable instead to keep it out)' : ''}`)) return;
    const res = await apiDelete(`/admin/va/checks/${c.id}`);
    if (res.ok) { toast('Check deleted', 'ok'); refetch(); } else toast(res.data?.error || 'Delete failed', 'err');
  }

  if (loading && !data) return <div className="loading-screen"><div className="loading-spinner" /><p>Loading benchmark library…</p></div>;

  const shown = (filter === 'all' ? checks : checks.filter((c) => c.engine === filter))
    .slice().sort((a, b) => a.engine.localeCompare(b.engine) || (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]) || a.check_id.localeCompare(b.check_id));

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refetch}>
      <PageHeader title="Content Packs — VA Benchmarks" meta={['CIS database checks', 'centrally managed · agents pull the curated pack']}>
        <button className="btn-primary" onClick={() => setEditing(blankCheck())}>+ Add check</button>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="▤" iconBg="var(--primary-soft)" iconColor="var(--primary)" label="Checks" value={totals.total} detail={`${engines.length} engines`} />
        <KpiCard icon="▮" iconBg="var(--green-soft)" iconColor="var(--green)" label="Enabled" value={totals.enabled} detail="pushed to agents" detailType="up" />
        <KpiCard icon="✎" iconBg="var(--info-soft)" iconColor="var(--info)" label="Custom" value={totals.custom} detail="authored centrally" />
        <KpiCard icon="▲" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Critical + High" value={totals.high} detail="enabled" />
      </section>

      {editing && <CheckEditor check={editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); refetch(); }} />}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Benchmark packs</span><span className="card-sub">one pack per engine · version changes when the enabled set changes</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Engine</th><th className="num">Enabled / Total</th><th>Pack version</th><th></th></tr></thead>
            <tbody>
              {engines.map((e) => (
                <tr key={e.engine}>
                  <td><b>{ENGINE_LABEL[e.engine] || e.engine}</b></td>
                  <td className="num">{e.enabled} / {e.total}</td>
                  <td><span className="mono" style={{ fontSize: 12 }}>{e.version}</span></td>
                  <td><button className="btn-secondary" style={{ padding: '4px 12px' }} onClick={() => setFilter(filter === e.engine ? 'all' : e.engine)}>{filter === e.engine ? 'Show all' : 'View checks'}</button></td>
                </tr>
              ))}
              {engines.length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 18, textAlign: 'center' }}>No checks yet — an agent populates the library on its first VA scan, or add one above.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Check library{filter !== 'all' ? ` — ${ENGINE_LABEL[filter] || filter}` : ''}</span>
          <span className="card-sub">{shown.length} checks · toggle to curate, edit to tune, + Add to extend</span>
          {filter !== 'all' && <button className="btn-secondary" style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: 12 }} onClick={() => setFilter('all')}>All engines</button>}
        </div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Engine</th><th>Check</th><th>Sect.</th><th style={{ width: 84 }}>Severity</th><th>Src</th><th style={{ width: 200 }}>Actions</th></tr></thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id} style={{ opacity: c.enabled ? 1 : 0.5 }}>
                  <td><small className="muted">{c.engine}</small></td>
                  <td><b>{c.title}</b><br /><small className="muted mono">{c.check_id}</small></td>
                  <td>{c.section || '—'}</td>
                  <td>{sevBadge(c.severity)}</td>
                  <td>{c.source === 'custom' ? <span className="badge sev-medium">custom</span> : <span className="badge status-gray">agent</span>}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className={c.enabled ? 'btn-secondary' : 'btn-primary'} style={{ padding: '3px 10px', fontSize: 11.5 }} disabled={busy === c.id} onClick={() => toggle(c)}>{busy === c.id ? '…' : c.enabled ? 'On' : 'Off'}</button>
                      <button className="btn-secondary" style={{ padding: '3px 10px', fontSize: 11.5 }} onClick={() => setEditing({ ...c })}>Edit</button>
                      <button className="btn-secondary" style={{ padding: '3px 10px', fontSize: 11.5, color: 'var(--danger, #c0392b)' }} onClick={() => remove(c)}>Del</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}
