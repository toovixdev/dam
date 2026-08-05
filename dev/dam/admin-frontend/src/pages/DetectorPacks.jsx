import { useState } from 'react';
import Layout from '../components/Layout';
import KpiCard from '../components/KpiCard';
import PageHeader from '../components/shared/PageHeader';
import { toast } from '../components/shared/Toast';
import useApiData from '../hooks/useApiData';
import { apiFetch, apiPost, apiPut, apiDelete } from '../api/client';

const CATS = ['PII', 'PCI', 'PHI', 'FINANCIAL', 'SECRET', 'NETWORK'];
const SEVS = ['critical', 'high', 'medium', 'low'];
const KINDS = ['none', 'regex', 'luhn'];
const REGIONS = ['any', 'IN', 'US', 'EU', 'UK', 'global'];
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
function sevBadge(sev) {
  const c = { critical: '#c0392b', high: '#d98a00', medium: '#3b82f6', low: '#6b7280' }[sev] || '#6b7280';
  return <span className="badge" style={{ background: `${c}22`, color: c, fontWeight: 700 }}>{sev}</span>;
}
const blankDetector = () => ({ _new: true, detector_id: '', tag: '', label: '', category: 'PII', sensitivity: 'high', name_regex: '', content_kind: 'none', content_regex: '', threshold: 0.6, region: 'any' });

function DetectorEditor({ det, onCancel, onSaved }) {
  const [f, setF] = useState({ ...det, threshold: det.threshold ?? 0.6 });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const needsContentRe = f.content_kind === 'regex';

  async function save() {
    const body = { ...f, threshold: Number(f.threshold) || 0.6 };
    setSaving(true);
    const res = det._new ? await apiPost('/admin/classification/detectors', body) : await apiPut(`/admin/classification/detectors/${det.id}`, body);
    setSaving(false);
    if (res.ok) { toast(det._new ? 'Detector created' : 'Detector saved', 'ok'); onSaved(); }
    else toast(res.data?.error || 'Save failed', 'err');
  }

  const inp = { width: '100%', fontSize: 12.5, padding: '5px 8px' };
  const lbl = { fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em' };
  return (
    <div className="card" style={{ marginBottom: 14, border: '1px solid var(--primary)' }}>
      <div className="card-header"><span className="card-title">{det._new ? 'New detector' : `Edit — ${det.detector_id}`}</span>
        <span className="card-sub">agents pull + apply this on their next classification scan — no rebuild</span></div>
      <div className="card-body">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
          <div><div style={lbl}>Detector ID</div><input style={inp} value={f.detector_id} placeholder="us-ssn" onChange={(e) => set('detector_id', e.target.value)} /></div>
          <div><div style={lbl}>Tag</div><input style={inp} value={f.tag} placeholder="ssn" onChange={(e) => set('tag', e.target.value)} /></div>
          <div><div style={lbl}>Category</div><select style={inp} value={f.category || ''} onChange={(e) => set('category', e.target.value)}>{CATS.map((x) => <option key={x} value={x}>{x}</option>)}</select></div>
          <div><div style={lbl}>Sensitivity</div><select style={inp} value={f.sensitivity} onChange={(e) => set('sensitivity', e.target.value)}>{SEVS.map((x) => <option key={x} value={x}>{x}</option>)}</select></div>
          <div style={{ gridColumn: '1 / -1' }}><div style={lbl}>Label</div><input style={inp} value={f.label} placeholder="US Social Security Number" onChange={(e) => set('label', e.target.value)} /></div>
          <div style={{ gridColumn: '1 / -1' }}><div style={lbl}>Name pattern (column-name regex, case-insensitive)</div><input style={{ ...inp, fontFamily: 'monospace' }} value={f.name_regex} placeholder="ssn|social_security" onChange={(e) => set('name_regex', e.target.value)} /></div>
          <div><div style={lbl}>Content rule</div><select style={inp} value={f.content_kind} onChange={(e) => set('content_kind', e.target.value)}>{KINDS.map((x) => <option key={x} value={x}>{x}</option>)}</select></div>
          <div style={{ gridColumn: 'span 3' }}><div style={lbl}>Content regex {needsContentRe ? '' : '(n/a)'}</div><input style={{ ...inp, fontFamily: 'monospace' }} value={f.content_regex} placeholder="^\\d{3}-?\\d{2}-?\\d{4}$" disabled={!needsContentRe} onChange={(e) => set('content_regex', e.target.value)} /></div>
          <div><div style={lbl}>Threshold</div><input style={inp} type="number" min="0.1" max="1" step="0.05" value={f.threshold} onChange={(e) => set('threshold', e.target.value)} /></div>
          <div><div style={lbl}>Region</div><select style={inp} value={f.region || 'any'} onChange={(e) => set('region', e.target.value)}>{REGIONS.map((x) => <option key={x} value={x}>{x}</option>)}</select></div>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>
          <b>How it matches:</b> content is authoritative — a value match (Luhn or content regex over ≥ threshold of sampled values) tags the column even if its name gives no hint; a corroborating <b>name pattern</b> promotes the finding to <code>validator</code>. A detector needs a name pattern <em>or</em> a content rule.
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : (det._new ? 'Create detector' : 'Save changes')}</button>
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export default function DetectorPacks() {
  const { data, loading, lastRefresh, refetch } = useApiData('/admin/classification/detectors', { poll: 0 });
  const [filter, setFilter] = useState('all'); // all | <category>
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');

  async function doImport() {
    let parsed;
    try { parsed = JSON.parse(importText); } catch { return toast('Paste valid JSON (an array of detectors, or { "detectors": [...] })', 'err'); }
    const res = await apiPost('/admin/classification/detectors/import', parsed);
    if (res.ok) {
      const d = res.data;
      toast(`Imported: +${d.added} added, ${d.updated} updated${d.errors?.length ? `, ${d.errors.length} error(s)` : ''}`, d.errors?.length ? 'err' : 'ok');
      if (d.errors?.length) console.warn('detector import errors:', d.errors);
      setImporting(false); setImportText(''); refetch();
    } else toast(res.data?.error || 'Import failed', 'err');
  }
  async function doExport() {
    try {
      const data = await apiFetch('/admin/classification/detectors/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'classifier-detectors-pack.json'; a.click();
      URL.revokeObjectURL(a.href);
      toast(`Exported ${data.count} detectors`, 'ok');
    } catch (e) { toast('Export failed', 'err'); }
  }

  const detectors = data?.detectors || [];
  const cats = [...new Set(detectors.map((d) => d.category).filter(Boolean))].sort();
  const totals = {
    total: detectors.length,
    enabled: detectors.filter((d) => d.enabled).length,
    custom: detectors.filter((d) => d.source === 'custom' || d.source === 'import').length,
    content: detectors.filter((d) => d.content_kind && d.content_kind !== 'none' && d.enabled).length,
  };

  async function toggle(d) {
    setBusy(d.id);
    const res = await apiPost(`/admin/classification/detectors/${d.id}/toggle`, { enabled: !d.enabled });
    setBusy('');
    if (res.ok) { toast(`${d.detector_id} ${!d.enabled ? 'enabled' : 'disabled'}`, 'ok'); refetch(); }
    else toast(res.data?.error || 'Failed', 'err');
  }
  async function remove(d) {
    if (!window.confirm(`Delete ${d.detector_id}?${d.source === 'agent' ? ' (an agent may re-register it — disable instead to keep it out)' : ''}`)) return;
    const res = await apiDelete(`/admin/classification/detectors/${d.id}`);
    if (res.ok) { toast('Detector deleted', 'ok'); refetch(); } else toast(res.data?.error || 'Delete failed', 'err');
  }

  if (loading && !data) return <div className="loading-screen"><div className="loading-spinner" /><p>Loading detector library…</p></div>;

  const shown = (filter === 'all' ? detectors : detectors.filter((d) => d.category === filter))
    .slice().sort((a, b) => (SEV_ORDER[a.sensitivity] - SEV_ORDER[b.sensitivity]) || a.detector_id.localeCompare(b.detector_id));

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refetch}>
      <PageHeader title="Content Packs — Classification Detectors" meta={['PII / PCI / PHI patterns', 'centrally managed · agents pull the signed pack']}>
        <button className="btn-secondary" onClick={() => setImporting((v) => !v)}>Import pack</button>
        <button className="btn-secondary" onClick={doExport}>Export</button>
        <button className="btn-primary" onClick={() => setEditing(blankDetector())}>+ Add detector</button>
      </PageHeader>

      {importing && (
        <div className="card" style={{ marginBottom: 14, border: '1px solid var(--primary)' }}>
          <div className="card-header"><span className="card-title">Import a detector pack</span>
            <span className="card-sub">paste an array of detectors, or {'{ "detectors": [...] }'} — new detectors added, existing ones updated in place (curation preserved)</span></div>
          <div className="card-body">
            <textarea value={importText} onChange={(e) => setImportText(e.target.value)} placeholder='[{"detector_id":"ca-sin","tag":"gov_id","category":"PII","sensitivity":"critical","name_regex":"\\bsin\\b","content_kind":"regex","content_regex":"^\\d{3}-?\\d{3}-?\\d{3}$","region":"any"}]'
              style={{ width: '100%', minHeight: 160, fontFamily: 'monospace', fontSize: 12 }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btn-primary" onClick={doImport}>Import</button>
              <button className="btn-secondary" onClick={() => { setImporting(false); setImportText(''); }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <section className="kpi-grid">
        <KpiCard icon="▤" iconBg="var(--primary-soft)" iconColor="var(--primary)" label="Detectors" value={totals.total} detail={`${cats.length} categories`} />
        <KpiCard icon="▮" iconBg="var(--green-soft)" iconColor="var(--green)" label="Enabled" value={totals.enabled} detail={`pack ${data?.version || ''}`} detailType="up" />
        <KpiCard icon="✎" iconBg="var(--info-soft)" iconColor="var(--info)" label="Custom / imported" value={totals.custom} detail="authored centrally" />
        <KpiCard icon="◈" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Content-validated" value={totals.content} detail="Luhn / regex over values" />
      </section>

      {editing && <DetectorEditor det={editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); refetch(); }} />}

      <div className="card">
        <div className="card-header">
          <span className="card-title">Detector library{filter !== 'all' ? ` — ${filter}` : ''}</span>
          <span className="card-sub">{shown.length} detectors · toggle to curate, edit to tune, + Add to extend</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button className={`btn-secondary ${filter === 'all' ? 'active' : ''}`} style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setFilter('all')}>All</button>
            {cats.map((c) => <button key={c} className={`btn-secondary ${filter === c ? 'active' : ''}`} style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setFilter(c)}>{c}</button>)}
          </div>
        </div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Category</th><th>Detector</th><th>Tag</th><th style={{ width: 84 }}>Severity</th><th>Match</th><th>Region</th><th>Src</th><th style={{ width: 200 }}>Actions</th></tr></thead>
            <tbody>
              {shown.map((d) => (
                <tr key={d.id} style={{ opacity: d.enabled ? 1 : 0.5 }}>
                  <td><small className="muted">{d.category || '—'}</small></td>
                  <td><b>{d.label || d.detector_id}</b><br /><small className="muted mono">{d.detector_id}</small></td>
                  <td><span className="mono" style={{ fontSize: 12 }}>{d.tag}</span></td>
                  <td>{sevBadge(d.sensitivity)}</td>
                  <td><small className="muted">{d.name_regex ? 'name' : ''}{d.name_regex && d.content_kind !== 'none' ? ' + ' : ''}{d.content_kind !== 'none' ? (d.content_kind === 'luhn' ? 'Luhn' : 'content') : ''}</small></td>
                  <td>{d.region && d.region !== 'any' ? <span className="badge" style={{ fontSize: 10 }}>{d.region}</span> : <small className="muted">any</small>}</td>
                  <td>{d.source === 'custom' ? <span className="badge sev-medium">custom</span> : d.source === 'import' ? <span className="badge sev-low">import</span> : <span className="badge status-gray">{d.source}</span>}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className={d.enabled ? 'btn-secondary' : 'btn-primary'} style={{ padding: '3px 10px', fontSize: 11.5 }} disabled={busy === d.id} onClick={() => toggle(d)}>{busy === d.id ? '…' : d.enabled ? 'On' : 'Off'}</button>
                      <button className="btn-secondary" style={{ padding: '3px 10px', fontSize: 11.5 }} onClick={() => setEditing({ ...d })}>Edit</button>
                      <button className="btn-secondary" style={{ padding: '3px 10px', fontSize: 11.5, color: 'var(--danger, #c0392b)' }} onClick={() => remove(d)}>Del</button>
                    </div>
                  </td>
                </tr>
              ))}
              {shown.length === 0 && <tr><td colSpan={8} className="muted" style={{ padding: 18, textAlign: 'center' }}>No detectors — the platform seeds a library on first boot, or add one above.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}
