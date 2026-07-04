import { useState } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/KpiCard';
import DataTable from '../components/shared/DataTable';
import Modal from '../components/shared/Modal';
import useApiData from '../hooks/useApiData';
import { apiPost, apiFetch } from '../api/client';
import { toast } from '../components/shared/Toast';
import { exportCsv } from '../exportCsv';

function formatDate(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function daysUntil(ts) {
  if (!ts) return null;
  return Math.ceil((new Date(ts).getTime() - Date.now()) / 86400000);
}

const TYPE_CLS = { erasure: 'red', rectification: 'amber', access: 'badge-ind', portability: 'badge-ind', restriction: 'badge-ind' };
const STATUS_CLS = { discovering: 'badge-ind', in_progress: 'sev-high', fulfilled: 'status-green' };
const STATUS_LABEL = { discovering: 'discovering', in_progress: 'in progress', fulfilled: 'fulfilled' };
const TAG_CLS = { ssn: 'sev-critical', aadhaar: 'sev-critical', pan: 'sev-critical', gdpr: 'sev-critical', pci: 'sev-high', email: 'badge-ind', phone: 'badge-ind', name: 'badge-ind', pii: 'badge-ind' };

export default function Dsar() {
  const { data, loading, error, refetch } = useApiData('/dsar');
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [showNew, setShowNew] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [detail, setDetail] = useState(null);      // full request + hits + steps
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ subject_name: '', subject_identifier: '', request_type: 'access', regulation: 'GDPR' });

  const rows = Array.isArray(data) ? data : [];
  const open = rows.filter((r) => r.status === 'discovering' || r.status === 'in_progress').length;
  const dueSoon = rows.filter((r) => { const d = daysUntil(r.deadline); return d !== null && d <= 7 && d >= 0 && r.status !== 'fulfilled'; }).length;
  const fulfilled = rows.filter((r) => r.status === 'fulfilled').length;
  const fulfilledRows = rows.filter((r) => r.fulfilled_at && r.created_at);
  const avgDays = fulfilledRows.length
    ? Math.round(fulfilledRows.reduce((s, r) => s + (new Date(r.fulfilled_at) - new Date(r.created_at)) / 86400000, 0) / fulfilledRows.length)
    : 0;

  const handleRefresh = () => { refetch(); setLastRefresh(new Date()); };

  const openDetail = async (id) => {
    const d = await apiFetch(`/dsar/${id}`);
    if (d && !d.error) setDetail(d);
    else toast('Could not load request', 'err');
  };

  const handleCreate = async () => {
    setSubmitting(true);
    try {
      const res = await apiPost('/dsar', form);
      if (res && res.ok) {
        setShowNew(false);
        setForm({ subject_name: '', subject_identifier: '', request_type: 'access', regulation: 'GDPR' });
        refetch();
        const n = (res.data.hits || []).length;
        toast(`${res.data.reference} created · found data in ${res.data.databases_found || 0} database(s)`, 'ok');
        if (n >= 0) setDetail(res.data);
      } else {
        toast(res?.data?.error || 'Failed to create request', 'err');
      }
    } finally { setSubmitting(false); }
  };

  const rescan = async () => {
    setBusy(true);
    const res = await apiPost(`/dsar/${detail.id}/discover`, {});
    setBusy(false);
    if (res && res.ok) { setDetail(res.data); refetch(); toast(`Re-scan complete · ${res.data.databases_found} database(s)`, 'ok'); }
    else toast('Re-scan failed', 'err');
  };
  const fulfill = async () => {
    setBusy(true);
    const res = await apiPost(`/dsar/${detail.id}/fulfill`, {});
    setBusy(false);
    if (res && res.ok) { setDetail(res.data); refetch(); toast(`${detail.reference} fulfilled`, 'ok'); }
    else toast('Could not complete request', 'err');
  };
  const exportLocations = () => {
    if (!detail) return;
    exportCsv(`${detail.reference}-data-locations.csv`,
      ['Database', 'Schema', 'Object', 'Columns', 'Tags', 'Rows'],
      (detail.hits || []).map((h) => [h.database_name, h.schema_name, h.object_name, (h.columns || []).join(' '), (h.tags || []).join(' '), h.row_count]));
    toast('Data-locations export downloaded', 'ok');
  };

  const columns = [
    { key: 'reference', label: 'Ref', render: (v) => <code style={{ fontSize: 12 }}>{v}</code> },
    { key: 'subject_name', label: 'Data subject', render: (v, r) => <div><b>{v}</b><div className="muted" style={{ fontSize: 11 }}>{r.subject_identifier}</div></div> },
    { key: 'request_type', label: 'Type', render: (v) => <span className={`badge ${TYPE_CLS[v] || ''}`} style={{ textTransform: 'capitalize' }}>{v}</span> },
    { key: 'databases_found', label: 'Found in', render: (v, r) => r.status === 'discovering' && !v ? <span className="muted">scanning…</span> : <span className="muted">{v || 0} DB{(v || 0) === 1 ? '' : 's'} · {r.columns_found || 0} cols</span> },
    { key: 'deadline', label: 'Due', render: (v, r) => {
      if (r.status === 'fulfilled') return <span className="muted">done</span>;
      const d = daysUntil(v);
      const color = d !== null && d <= 7 ? 'var(--danger)' : d !== null && d <= 14 ? 'var(--amber)' : 'var(--muted)';
      return <span style={{ color, fontWeight: d !== null && d <= 7 ? 600 : 400 }}>{formatDate(v)}{d !== null && d >= 0 ? ` (${d}d)` : d !== null ? ' overdue' : ''}</span>;
    } },
    { key: 'status', label: 'Status', render: (v) => <span className={`badge ${STATUS_CLS[v] || ''} dot`}>{STATUS_LABEL[v] || v}</span> },
    { key: '_', label: '', sortable: false, render: (_, r) => <button className="btn-secondary" style={{ padding: '4px 12px', fontSize: 12 }} onClick={() => openDetail(r.id)}>Open</button> },
  ];

  if (loading) return <Layout activePage="dsar"><div className="loading-screen"><div className="loading-spinner" /><p>Loading DSAR requests…</p></div></Layout>;

  return (
    <Layout activePage="dsar" lastRefresh={lastRefresh} onRefresh={handleRefresh}>
      <PageHeader title="DSAR Manager" meta={['Data Subject Access Request', 'GDPR / DPDPA / CCPA', 'SLA 30 days']}>
        <button className="btn-secondary" onClick={handleRefresh}>Refresh</button>
        <button className="btn-primary" onClick={() => setShowNew(true)}>＋ New request</button>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="◔" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Open" value={open} detail="in progress" detailType={open > 0 ? 'down' : 'up'} />
        <KpiCard icon="⏲" iconBg="var(--danger-soft)" iconColor="var(--danger)" label="Due soon" value={dueSoon} detail="deadline within 7 days" detailType={dueSoon > 0 ? 'down' : 'up'} />
        <KpiCard icon="✓" iconBg="var(--green-soft)" iconColor="var(--green)" label="Fulfilled" value={fulfilled} detail="completed requests" detailType="up" />
        <KpiCard icon="⊙" iconBg="var(--info-soft)" iconColor="var(--info)" label="Avg time" value={`${avgDays}d`} detail="to fulfill" />
      </section>

      {error && <div className="card" style={{ padding: 16, color: 'var(--danger)' }}>Error: {error}</div>}

      <div className="card">
        <div className="card-header"><span className="card-title">Requests</span><span className="card-sub">{rows.length} total</span></div>
        <div className="card-body no-pad">
          <DataTable columns={columns} data={rows} emptyMessage="No DSAR requests yet — create one to discover where a subject's data lives" />
        </div>
      </div>

      {/* New request */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="＋ New DSAR request">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Data subject name</span>
            <input value={form.subject_name} onChange={(e) => setForm({ ...form, subject_name: e.target.value })} placeholder="Full name" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Identifier (email / SSN / national ID)</span>
            <input value={form.subject_identifier} onChange={(e) => setForm({ ...form, subject_identifier: e.target.value })} placeholder="email or ID number" />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Request type</span>
            <select value={form.request_type} onChange={(e) => setForm({ ...form, request_type: e.target.value })}>
              <option value="access">Access (copy of data)</option>
              <option value="erasure">Erasure (right to be forgotten)</option>
              <option value="rectification">Rectification</option>
              <option value="restriction">Restrict processing</option>
              <option value="portability">Data portability</option>
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Regulation</span>
            <select value={form.regulation} onChange={(e) => setForm({ ...form, regulation: e.target.value })}>
              <option value="GDPR">GDPR</option>
              <option value="CCPA">CCPA</option>
              <option value="DPDPA 2023">DPDPA 2023</option>
            </select>
          </label>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
            <button className="btn-secondary" onClick={() => setShowNew(false)}>Cancel</button>
            <button className="btn-primary" onClick={handleCreate} disabled={submitting || !form.subject_name || !form.subject_identifier}>
              {submitting ? 'Discovering…' : 'Create & discover data'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Fulfillment detail */}
      {detail && (
        <Modal open onClose={() => setDetail(null)} title={`${detail.reference} — ${detail.request_type} request`} width={760}>
          <div style={{ display: 'flex', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 180, padding: '12px 14px', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 8 }}>
              <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.4px' }}>Data subject</div>
              <div style={{ fontSize: 14, fontWeight: 700, marginTop: 2 }}>{detail.subject_name}</div>
              <div className="muted" style={{ fontSize: 12 }}>{detail.subject_identifier}</div>
            </div>
            <div style={{ padding: '12px 14px', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 8 }}>
              <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.4px' }}>Regulation</div>
              <div style={{ fontSize: 14, fontWeight: 700, marginTop: 2 }}>{detail.regulation}</div>
            </div>
            <div style={{ padding: '12px 14px', background: detail.status === 'fulfilled' ? 'var(--green-soft)' : 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 8 }}>
              <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.4px' }}>Deadline</div>
              <div style={{ fontSize: 14, fontWeight: 700, marginTop: 2, color: detail.status === 'fulfilled' ? 'var(--green)' : 'var(--fg)' }}>{detail.status === 'fulfilled' ? 'Fulfilled' : formatDate(detail.deadline)}</div>
            </div>
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--subtle)', marginBottom: 8 }}>Workflow progress</div>
          <div style={{ marginBottom: 18 }}>
            {(detail.steps || []).map((st, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 0', borderBottom: i < detail.steps.length - 1 ? '1px solid var(--line-2, var(--line))' : 'none', fontSize: 13 }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700,
                  background: st.s === 'done' ? 'var(--green-soft)' : st.s === 'active' ? 'var(--primary-soft)' : 'var(--surface-2)',
                  color: st.s === 'done' ? 'var(--green)' : st.s === 'active' ? 'var(--primary)' : 'var(--muted)' }}>
                  {st.s === 'done' ? '✓' : st.s === 'active' ? '●' : '○'}
                </div>
                <div style={{ flex: 1 }}><b>{st.l}</b><div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{st.d}</div></div>
              </div>
            ))}
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--subtle)', marginBottom: 10 }}>
            Data locations found {detail.hits && detail.hits.length > 0 && <span className="muted">· {detail.hits.length} object(s)</span>}
          </div>
          {(detail.hits || []).length === 0 ? (
            <div className="muted" style={{ fontSize: 13, padding: '8px 0 14px' }}>No personal data found for this subject in the classified databases.</div>
          ) : (
            (detail.hits || []).map((h, j) => (
              <div key={j} style={{ padding: '10px 14px', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 8, marginBottom: 8, fontSize: 12.5 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                  <b>{h.database_name}</b>
                  <span className="muted" style={{ fontSize: 12 }}>{h.schema_name}.{h.object_name}</span>
                  {(h.tags || []).map((t) => <span key={t} className={`badge ${TAG_CLS[t] || ''}`} style={{ fontSize: 10 }}>{t}</span>)}
                  <span className="muted" style={{ marginLeft: 'auto' }}>{Number(h.row_count).toLocaleString()} row(s) · {(h.columns || []).length} cols</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {(h.columns || []).map((c) => <span key={c} className="mono" style={{ fontSize: 11, padding: '3px 8px', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 4 }}>{c}</span>)}
                </div>
              </div>
            ))
          )}

          <div style={{ display: 'flex', gap: 8, paddingTop: 14, marginTop: 14, borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}>
            {detail.status !== 'fulfilled' ? (
              <>
                <button className="btn-primary" disabled={busy} onClick={fulfill}>
                  {detail.request_type === 'erasure' ? 'Execute erasure' : detail.request_type === 'rectification' ? 'Apply rectification' : 'Compile data export'}
                </button>
                <button className="btn-secondary" disabled={busy} onClick={rescan}>{busy ? 'Scanning…' : 'Re-scan'}</button>
                <button className="btn-secondary" onClick={exportLocations}>Export data locations</button>
              </>
            ) : (
              <button className="btn-secondary" onClick={exportLocations}>Download evidence</button>
            )}
            <button className="btn-secondary" style={{ marginLeft: 'auto' }} onClick={() => setDetail(null)}>Close</button>
          </div>
        </Modal>
      )}
    </Layout>
  );
}
