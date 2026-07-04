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
import { apiPost } from '../api/client';
import { toast } from '../components/shared/Toast';
import { exportCsv } from '../exportCsv';

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

const LIST_CAP = 500; // server caps the table at 500 rows; counts come from the aggregate

// Map the active tab to the server-side filter for the alert list.
function tabQuery(tab) {
  if (tab === 'acknowledged') return 'status=ack';
  if (tab === 'closed') return 'status=closed';
  if (tab === 'all') return 'status=open';
  return `status=open&severity=${tab}`; // critical / high / medium / low
}

const GROUP_FIELDS = { none: 'No grouping', database_name: 'Database', principal: 'Principal', rule: 'Rule', severity: 'Severity' };

export default function Alerts() {
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [activeTab, setActiveTab] = useState('all');
  const [selected, setSelected] = useState(null); // alert row for the detail popup
  const [qInput, setQInput] = useState('');       // raw search box value
  const [q, setQ] = useState('');                 // debounced query sent to the server
  const [groupBy, setGroupBy] = useState('none');

  // Debounce the search box so we don't refetch on every keystroke.
  useEffect(() => { const t = setTimeout(() => setQ(qInput.trim()), 350); return () => clearTimeout(t); }, [qInput]);

  // Authoritative counts (all alerts, grouped) — drives KPIs + tab badges.
  const { data: summary, refetch: refetchSummary } = useApiData('/alerts/summary', { poll: 30000 });
  // The table itself is fetched per active tab (+ search) so visible rows match the badge.
  const listUrl = `/alerts?${tabQuery(activeTab)}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const { data, loading, error, refetch: refetchList } = useApiData(listUrl);

  const refetch = () => { refetchSummary(); refetchList(); };
  const handleRefresh = () => { refetch(); setLastRefresh(new Date()); };

  // Live refresh: the control plane pushes `alert` events over WebSocket.
  useLiveEvents('alert', () => { refetch(); setLastRefresh(new Date()); });

  const filtered = Array.isArray(data) ? data : [];
  const open = summary?.open || { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
  const critical = open.critical, high = open.high, medium = open.medium, totalOpen = open.total;
  const tabTotal = { all: totalOpen, critical, high, medium, low: open.low, acknowledged: summary?.ack ?? 0, closed: summary?.closed ?? 0 }[activeTab];
  const capped = filtered.length >= LIST_CAP;

  // Group the visible rows by the chosen field (count desc).
  const groups = groupBy === 'none' ? null : Object.entries(
    filtered.reduce((acc, r) => { const k = r[groupBy] || '—'; (acc[k] = acc[k] || []).push(r); return acc; }, {})
  ).sort((a, b) => b[1].length - a[1].length);

  const tabs = [
    { id: 'all', label: 'All Open', count: totalOpen },
    { id: 'critical', label: 'Critical', count: critical },
    { id: 'high', label: 'High', count: high },
    { id: 'medium', label: 'Medium', count: medium },
    { id: 'low', label: 'Low', count: open.low },
    { id: 'acknowledged', label: 'Acknowledged', count: summary?.ack ?? 0 },
    { id: 'closed', label: 'Closed', count: summary?.closed ?? 0 },
  ];

  const columns = [
    { key: 'severity', label: 'Sev', render: (v) => <SeverityBadge severity={v || 'low'} /> },
    { key: 'summary', label: 'Alert', render: (v, row) => (
      <div><b>{v}</b><br /><small className="muted mono">{(row.id || '').slice(0, 8)} · {row.rule || '—'}</small></div>
    ) },
    { key: 'principal', label: 'Principal', render: (v, row) => (
      <div>{v}<br /><small className="muted">{row.user_type || '—'}</small></div>
    ) },
    { key: 'database_name', label: 'Database' },
    { key: 'anomaly_score', label: 'Score', align: 'right', render: (v) => {
      const s = v || 0;
      return <span style={{ fontWeight: 700, color: scoreColor(s) }}>{s}</span>;
    }},
    { key: 'flags', label: 'Flags', sortable: false, render: (v) => (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {(Array.isArray(v) ? v : []).map((f) => <span key={f} className="badge" style={{ fontSize: 10 }}>{f}</span>)}
      </div>
    ) },
    { key: 'status', label: 'Status', render: (v) => (v === 'false_positive' ? <span className="badge">false positive</span> : <StatusBadge status={v || 'open'} />) },
    { key: 'created_at', label: 'Age', render: (v) => <span className="muted">{relativeAge(v)}</span> },
  ];

  const setStatus = async (id, status) => {
    const res = await apiPost(`/alerts/${id}/status`, { status });
    if (res && res.ok) { refetch(); return true; }
    toast('Action failed', 'err'); return false;
  };
  const ackAll = async () => {
    if (!totalOpen) { toast('No open alerts to acknowledge', 'ok'); return; }
    if (!window.confirm(`Acknowledge all ${totalOpen} open alert${totalOpen > 1 ? 's' : ''}?`)) return;
    const res = await apiPost('/alerts/ack-all');
    if (res && res.ok) { toast(`Acknowledged ${res.data.acknowledged} alert${res.data.acknowledged !== 1 ? 's' : ''}`, 'ok'); refetch(); }
    else toast('Action failed', 'err');
  };
  const onAck = async () => { if (await setStatus(selected.id, 'ack')) { toast('Alert acknowledged', 'ok'); setSelected(null); } };
  const onResolve = async () => { if (await setStatus(selected.id, 'resolved')) { toast('Alert resolved', 'ok'); setSelected(null); } };
  const onFalsePositive = async (scope, reason) => {
    const res = await apiPost(`/alerts/${selected.id}/false-positive`, { scope, reason });
    if (res && res.ok) { toast('Marked false positive — suppression created', 'ok'); refetch(); setSelected(null); }
    else toast('Action failed', 'err');
  };
  const onAct = (msg) => { toast(msg, 'ok'); setSelected(null); };
  const onExport = () => {
    exportCsv('toovix-alerts.csv',
      ['ID', 'Severity', 'Alert', 'Rule', 'Principal', 'Database', 'Score', 'Status', 'Created'],
      filtered.map((a) => [a.id, a.severity, a.summary, a.rule, a.principal, a.database_name, a.anomaly_score, a.status, a.created_at]));
    toast(`Exported ${filtered.length} alerts`, 'ok');
  };

  if (loading) {
    return (
      <Layout activePage="alerts">
        <div className="loading-screen"><div className="loading-spinner" /><p>Loading alerts...</p></div>
      </Layout>
    );
  }

  return (
    <Layout activePage="alerts" lastRefresh={lastRefresh} onRefresh={handleRefresh}>
      <PageHeader
        title="Alerts"
        meta={[<LivePill key="live" />, `${totalOpen} open`, `${critical} critical`, `${high} high`]}
      >
        <button className="btn-secondary" onClick={handleRefresh}>Refresh</button>
        <button className="btn-secondary" onClick={onExport}>⤓ Export</button>
        <button className="btn-primary" onClick={ackAll} disabled={!totalOpen}>✓ Acknowledge all</button>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="⚠" iconBg="var(--danger-soft)" iconColor="var(--danger)" label="Total Open" value={totalOpen} detail="requiring attention" detailType={totalOpen > 0 ? 'down' : 'up'} />
        <KpiCard icon="⛔" iconBg="var(--danger-soft)" iconColor="var(--danger)" label="Critical" value={critical} detail="immediate action needed" detailType={critical > 0 ? 'down' : 'up'} />
        <KpiCard icon="◎" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="High" value={high} detail="investigate soon" detailType={high > 0 ? 'down' : 'up'} />
        <KpiCard icon="◉" iconBg="var(--info-soft)" iconColor="var(--info)" label="Medium" value={medium} detail="review when possible" />
      </section>

      {error && <div className="card" style={{ padding: 16, color: 'var(--danger)' }}>Error: {error}</div>}

      <TabNav tabs={tabs} active={activeTab} onChange={setActiveTab} />

      <div className="card">
        <div className="card-header">
          <span className="card-title">Alerts</span>
          <span className="card-sub">
            {q ? `${filtered.length} matching “${q}”` : (tabTotal != null ? `${filtered.length}${!capped && filtered.length < tabTotal ? ` of ${tabTotal}` : ''} showing` : `${filtered.length} showing`)}
            {' · double-click a row for details'}
          </span>
        </div>
        <div className="card-body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', paddingBottom: 0 }}>
          <input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Search principal, alert, rule, object or database…" style={{ flex: 1, minWidth: 220 }} />
          {qInput && <button className="btn-secondary" onClick={() => setQInput('')}>Clear</button>}
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={{ width: 170 }}>
            {Object.entries(GROUP_FIELDS).map(([k, v]) => <option key={k} value={k}>Group by: {v}</option>)}
          </select>
        </div>

        {capped && (
          <div className="card-body" style={{ paddingTop: 10, paddingBottom: 0 }}>
            <div style={{ background: 'var(--amber-soft)', color: 'var(--amber)', borderRadius: 8, padding: '8px 12px', fontSize: 12.5 }}>
              ⚠ Showing the first {LIST_CAP} alerts (display limit){tabTotal != null ? ` of ${tabTotal} in this view` : ''}. Use search or the severity tabs to narrow results.
            </div>
          </div>
        )}

        {groupBy === 'none' ? (
          <div className="card-body no-pad">
            <DataTable columns={columns} data={filtered} onRowDoubleClick={setSelected} emptyMessage="No alerts matching this filter" />
          </div>
        ) : (
          <div className="card-body no-pad">
            {groups.length === 0 && <div className="chart-empty" style={{ padding: 20 }}>No alerts matching this filter</div>}
            {groups.map(([name, rows]) => (
              <div key={name} style={{ borderTop: '1px solid var(--line)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', background: 'var(--surface-2)', fontSize: 13 }}>
                  <b>{name}</b>
                  <span className="muted" style={{ fontSize: 12 }}>{GROUP_FIELDS[groupBy]}</span>
                  <span className="badge" style={{ marginLeft: 'auto' }}>{rows.length}</span>
                </div>
                <DataTable columns={columns} data={rows} onRowDoubleClick={setSelected} emptyMessage="" />
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected ? selected.summary : ''} width={740}>
        {selected && <AlertDetail a={selected} onAck={onAck} onResolve={onResolve} onFalsePositive={onFalsePositive} onAct={onAct} />}
      </Modal>
    </Layout>
  );
}

function KV({ k, children }) {
  return (<><span className="muted" style={{ fontSize: 12.5 }}>{k}</span><span style={{ fontSize: 12.5, textAlign: 'right' }}>{children}</span></>);
}

function AlertDetail({ a, onAck, onResolve, onFalsePositive, onAct }) {
  const tags = Array.isArray(a.sensitivity_tags) ? a.sensitivity_tags : [];
  const [fp, setFp] = useState(false);
  const [scope, setScope] = useState('both');
  const [reason, setReason] = useState('');
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', marginBottom: 14, fontSize: 13, color: 'var(--muted)', alignItems: 'center' }}>
        <SeverityBadge severity={a.severity || 'low'} />
        <span className="mono">{(a.id || '').slice(0, 8)}</span>
        <span>Score <b style={{ color: scoreColor(a.anomaly_score || 0) }}>{a.anomaly_score || 0}/100</b></span>
        <span>Rule <b style={{ color: 'var(--ink)' }}>{a.rule || '—'}</b></span>
        <span>Age <b style={{ color: 'var(--ink)' }}>{relativeAge(a.created_at)}</b></span>
        <StatusBadge status={a.status || 'open'} />
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

      {!fp ? (
        <div className="modal-footer" style={{ padding: '4px 0 0', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-start' }}>
          <button className="btn-primary" onClick={onAck}>✓ Acknowledge</button>
          <button className="btn-secondary" onClick={onResolve}>✓ Resolve</button>
          <button className="btn-secondary" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => onAct('Quarantined — session killed')}>⛔ Quarantine &amp; kill</button>
          <button className="btn-secondary" onClick={() => onAct('Escalated to on-call')}>↗ Escalate</button>
          <button className="btn-secondary" onClick={() => setFp(true)}>✗ False positive</button>
          <button className="btn-secondary" onClick={() => onAct('Opening session reconstruction')}>⎚ Session timeline</button>
        </div>
      ) : (
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
              <button className="btn-secondary" onClick={() => setFp(false)}>Cancel</button>
              <button className="btn-primary" onClick={() => onFalsePositive(scope, reason)}>Confirm false positive</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
