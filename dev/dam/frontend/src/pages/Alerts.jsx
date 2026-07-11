import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
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
  const navigate = useNavigate();
  const openDetail = (row) => navigate(`/alerts/${row.id}`, { state: { alert: row } });
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [activeTab, setActiveTab] = useState('all');
  const [qInput, setQInput] = useState('');       // raw search box value
  const [q, setQ] = useState('');                 // debounced query sent to the server
  const [groupBy, setGroupBy] = useState('none');
  const [ackAllOpen, setAckAllOpen] = useState(false); // bulk-ack dialog
  const [ackAllNote, setAckAllNote] = useState('');
  const [ackBusy, setAckBusy] = useState(false);

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
    { key: 'database_name', label: 'Database', render: (v) => v || <span className="muted">—</span> },
    { key: 'instance_host', label: 'Instance / Host', render: (v, row) => {
      const host = row.instance_host;
      if (!host && !row.instance_name) return <span className="muted">—</span>;
      return (
        <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.3 }}>
          {row.instance_name && <b style={{ fontSize: 12.5 }}>{row.instance_name}</b>}
          {host && <span className="mono muted" style={{ fontSize: 11 }}>{host}</span>}
        </span>
      );
    } },
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

  const openAckAll = () => {
    if (!totalOpen) { toast('No open alerts to acknowledge', 'ok'); return; }
    setAckAllNote(''); setAckAllOpen(true);
  };
  const confirmAckAll = async () => {
    setAckBusy(true);
    const res = await apiPost('/alerts/ack-all', { note: ackAllNote.trim() });
    setAckBusy(false);
    if (res && res.ok) { toast(`Acknowledged ${res.data.acknowledged} alert${res.data.acknowledged !== 1 ? 's' : ''}`, 'ok'); setAckAllOpen(false); refetch(); }
    else toast('Action failed', 'err');
  };
  const onExport = () => {
    exportCsv('toovix-alerts.csv',
      ['ID', 'Severity', 'Alert', 'Rule', 'Principal', 'Database', 'Instance', 'Host', 'Score', 'Status', 'Created'],
      filtered.map((a) => [a.id, a.severity, a.summary, a.rule, a.principal, a.database_name, a.instance_name || '', a.instance_host || '', a.anomaly_score, a.status, a.created_at]));
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
        <button className="btn-primary" onClick={openAckAll} disabled={!totalOpen}>✓ Acknowledge all</button>
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
            <DataTable columns={columns} data={filtered} onRowDoubleClick={openDetail} emptyMessage="No alerts matching this filter" />
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
                <DataTable columns={columns} data={rows} onRowDoubleClick={openDetail} emptyMessage="" />
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal open={ackAllOpen} onClose={() => setAckAllOpen(false)} title="Acknowledge all open alerts" width={460}>
        <p className="muted" style={{ fontSize: 13, margin: '0 0 12px', lineHeight: 1.5 }}>
          This acknowledges all <b>{totalOpen}</b> open alert{totalOpen === 1 ? '' : 's'} in this workspace. Add an optional comment — it's recorded against every alert.
        </p>
        <div className="form-field">
          <label>Comment <span className="muted">(optional)</span></label>
          <textarea value={ackAllNote} onChange={(e) => setAckAllNote(e.target.value)} rows={3} placeholder="e.g. Shift handover — all reviewed and triaged." style={{ width: '100%', resize: 'vertical' }} />
        </div>
        <div className="modal-footer" style={{ padding: '6px 0 0', justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={() => setAckAllOpen(false)} disabled={ackBusy}>Cancel</button>
          <button className="btn-primary" onClick={confirmAckAll} disabled={ackBusy}>{ackBusy ? 'Acknowledging…' : `✓ Acknowledge ${totalOpen}`}</button>
        </div>
      </Modal>
    </Layout>
  );
}
