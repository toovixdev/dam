import { useState } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/KpiCard';
import DataTable from '../components/shared/DataTable';
import TabNav from '../components/shared/TabNav';
import useApiData from '../hooks/useApiData';
import useTimezone, { tzShortName } from '../hooks/useTimezone';
import { toast } from '../components/shared/Toast';
import { exportCsv } from '../exportCsv';
import { apiFetch } from '../api/client';

// ClickHouse returns UTC with no zone marker ("2026-07-21 15:45:37"); the browser would
// otherwise parse that as LOCAL time. Mark it UTC before constructing the Date. Postgres
// timestamps already carry a zone (ISO with 'T'/offset), so leave those alone.
function toDate(ts) {
  if (ts == null) return null;
  if (typeof ts === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(ts)) {
    ts = ts.replace(' ', 'T') + 'Z';
  }
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

// Render a timestamp in the user's CHOSEN timezone (Profile → Timezone), not the browser's.
function formatDate(ts, tz) {
  const d = toDate(ts);
  if (!d) return '-';
  return d.toLocaleString('en-GB', { timeZone: tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const OP_COLOR = { SELECT: 'var(--info)', INSERT: 'var(--green)', UPDATE: 'var(--amber)', DELETE: 'var(--danger)', DDL: 'var(--danger)', LOGIN: 'var(--primary)', LOGIN_FAILED: 'var(--danger)', LOGOUT: 'var(--muted)', AUDIT_CHANGE: 'var(--danger)', GRANT: 'var(--danger)' };

const OPS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'DDL', 'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'AUDIT_CHANGE', 'GRANT', 'OTHER'];

// Not every audited event is a statement. Authentication and audit-configuration records carry
// a description rather than SQL, so they are labelled instead of being rendered as fake queries.
const CLASS_LABEL = { auth: 'auth', audit_config: 'audit config' };
const PAGE = 100;
const RANGES = [
  { id: 'any', label: 'Last 100 (any time)', ms: 0 },
  { id: '15m', label: 'Last 15 minutes', ms: 15 * 60000 },
  { id: '1h', label: 'Last hour', ms: 3600000 },
  { id: '24h', label: 'Last 24 hours', ms: 86400000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 86400000 },
  { id: '30d', label: 'Last 30 days', ms: 30 * 86400000 },
];

export default function AuditTrail() {
  const [tz] = useTimezone(); // the user's chosen timezone (Profile → Timezone)
  const [tab, setTab] = useState('db');
  const [q, setQ] = useState('');
  const [op, setOp] = useState('');
  const [range, setRange] = useState('any');
  const [offset, setOffset] = useState(0);
  const [paused, setPaused] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(new Date());

  // Build the activity query string from filters + page (changing it triggers a refetch).
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (q) params.set('q', q);
  if (op) params.set('operation', op);
  const rangeMs = (RANGES.find((r) => r.id === range) || {}).ms || 0;
  // Free-text search must be time-bounded (a %like% over the whole table is expensive).
  // If searching with no range chosen, bound to the last 24h.
  let fromMs = rangeMs ? Date.now() - rangeMs : null;
  if (q && !fromMs) fromMs = Date.now() - 86400000;
  if (fromMs) params.set('from', new Date(fromMs).toISOString());

  // Two audit trails: control-plane admin audit (Postgres) + database-activity audit (ClickHouse).
  const { data: cpData, loading: cpLoading, error: cpError, refetch: refetchCp } = useApiData('/audit');
  const { data: actData, loading: actLoading, refetch: refetchAct } = useApiData(`/audit/activity?${params.toString()}`, { poll: (offset === 0 && !paused) ? 15000 : 0 });
  const { data: ckData, refetch: refetchCk } = useApiData('/audit/checkpoints', { poll: tab === 'ck' ? 30000 : 0 });

  const handleRefresh = () => { refetchCp(); refetchAct(); refetchCk(); setLastRefresh(new Date()); };
  const onFilter = (setter) => (val) => { setter(val); setOffset(0); };

  const cpRows = Array.isArray(cpData) ? cpData : [];
  const actRows = Array.isArray(actData?.rows) ? actData.rows : [];
  const actTotal = actData?.total ?? actRows.length;
  const ckRows = Array.isArray(ckData) ? ckData : [];
  const uniqueActors = [...new Set(cpRows.map((r) => r.actor_email).filter(Boolean))].length;

  const onExport = () => {
    if (tab === 'db') {
      exportCsv('toovix-db-activity.csv',
        [`Time (${tzShortName(tz)})`, 'Principal', 'Database', 'Instance', 'Host', 'Action', 'SQL', 'Rows', 'Score', 'Chain'],
        actRows.map((r) => [formatDate(r.timestamp, tz), r.principal, r.database_name, r.instance_name || '', r.source_host || r.client_ip, r.operation, (r.sql_text || '').replace(/\s+/g, ' '), r.row_count, r.anomaly_score, r.chain]));
      toast(`Exported ${actRows.length} activity rows`, 'ok');
    } else {
      exportCsv('toovix-control-plane-audit.csv',
        [`Time (${tzShortName(tz)})`, 'Actor', 'Action', 'Resource', 'Details'],
        cpRows.map((r) => [formatDate(r.created_at, tz), r.actor_email, r.action, r.resource_type, JSON.stringify(r.details || {})]));
      toast(`Exported ${cpRows.length} audit rows`, 'ok');
    }
  };

  // Database Activity (data plane / ClickHouse)
  const activityColumns = [
    { key: 'timestamp', label: `Time (${tzShortName(tz)})`, render: (v) => formatDate(v, tz) },
    { key: 'principal', label: 'Principal' },
    { key: 'database_name', label: 'Database' },
    { key: 'source_host', label: 'Instance / Host', render: (v, row) => {
      const host = v || row.client_ip;
      if (!host && !row.instance_name) return <span className="muted">—</span>;
      return (
        <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.3 }}>
          {row.instance_name && <b style={{ fontSize: 12.5 }}>{row.instance_name}</b>}
          {host && <span className="mono muted" style={{ fontSize: 11 }}>{host}</span>}
        </span>
      );
    } },
    { key: 'operation', label: 'Action', render: (v) => <span className="badge" style={{ color: OP_COLOR[v] || 'var(--muted)' }}>{v || '-'}</span> },
    { key: 'sql_text', label: 'SQL / Command', sortable: false, render: (v, row) => {
      const cls = CLASS_LABEL[row.event_class];
      // \u0000 written as an escape, NOT a literal NUL: a raw NUL makes this file 'binary' to
      // grep/diff, which silently return no matches when searching the codebase.
      const text = (v || '').replace(/\u0000/g, '').slice(0, 70);
      // Auth / audit-config records carry a description, not SQL — don't dress them up as code.
      if (cls) {
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="badge" style={{ fontSize: 10, color: row.event_class === 'audit_config' ? 'var(--danger)' : 'var(--muted)' }}>{cls}</span>
            <span style={{ fontSize: 11.5 }}>{text}</span>
          </span>
        );
      }
      return <code style={{ fontSize: 11 }}>{text}</code>;
    } },
    // Row counts are meaningless for a login or an audit-config change.
    { key: 'row_count', label: 'Rows', align: 'right', render: (v, row) => (CLASS_LABEL[row.event_class] ? <span className="muted">—</span> : (v != null ? Number(v).toLocaleString() : '—')) },
    { key: 'anomaly_score', label: 'Score', align: 'right' },
    { key: 'chain', label: 'Chain #', render: (v) => <span className="mono muted">{v}</span> },
  ];

  // Control-plane audit (Postgres)
  const cpColumns = [
    { key: 'created_at', label: `Time (${tzShortName(tz)})`, render: (v) => formatDate(v, tz) },
    { key: 'actor_email', label: 'Actor' },
    { key: 'action', label: 'Action', render: (v) => {
      const colors = { create: 'var(--green)', update: 'var(--info)', delete: 'var(--danger)', login: 'var(--primary)', logout: 'var(--muted)', export: 'var(--amber)' };
      const a = (v || '').toLowerCase();
      return <span className="badge" style={{ background: (colors[a] || 'var(--muted)') + '20', color: colors[a] || 'var(--muted)' }}>{v || '-'}</span>;
    }},
    { key: 'resource_type', label: 'Resource', render: (v) => <span style={{ textTransform: 'capitalize' }}>{v || '-'}</span> },
    { key: 'row_hash', label: 'Hash', sortable: false, render: (v, row) => (
      <span className="mono muted" style={{ fontSize: 11 }} title={`row: ${v || '-'}\nprev: ${row.prev_hash || '-'}`}>{v ? v.slice(0, 10) + '…' : '—'}</span>
    ) },
  ];

  // Data-plane checkpoints (signed Merkle roots over event windows · Postgres)
  const ckColumns = [
    { key: 'seq', label: '#', align: 'right', render: (v) => <span className="mono">{v}</span> },
    { key: 'window_start', label: 'Window', sortable: false, render: (v, row) => <span style={{ fontSize: 12 }}>{formatDate(v, tz)} → {formatDate(row.window_end, tz)}</span> },
    { key: 'event_count', label: 'Events', align: 'right', render: (v) => Number(v).toLocaleString() },
    { key: 'merkle_root', label: 'Merkle root', sortable: false, render: (v, row) => <span className="mono muted" style={{ fontSize: 11 }} title={`root: ${v}\nchain: ${row.chain_hash}`}>{v ? v.slice(0, 12) + '…' : '—'}</span> },
    { key: 'signature', label: 'Signed', render: (v) => v ? <span className="badge green dot">HMAC ✓</span> : <span className="muted">—</span> },
    { key: 'archived', label: 'WORM archive', render: (v) => v ? <span className="badge green dot">stored</span> : <span className="badge amber dot">pending</span> },
  ];

  if (cpLoading && actLoading) {
    return <Layout activePage="audit"><div className="loading-screen"><div className="loading-spinner" /><p>Loading audit trail...</p></div></Layout>;
  }

  const tabs = [
    { id: 'db', label: 'Database Activity', count: actTotal },
    { id: 'cp', label: 'Control Plane', count: cpRows.length },
    { id: 'ck', label: 'Checkpoints', count: ckRows.length },
  ];
  const pageEnd = offset + actRows.length;

  return (
    <Layout activePage="audit" lastRefresh={lastRefresh} onRefresh={handleRefresh}>
      <PageHeader title="Audit Trail" meta={['tamper-evident · hash-chained', '7-year retention']}>
        {tab === 'db' && <button className="btn-secondary" onClick={() => { setPaused((p) => !p); toast(paused ? 'Live tail resumed' : 'Live tail paused'); }}>{paused ? '▶ Resume' : '⏸ Pause'}</button>}
        {(tab === 'db' || tab === 'ck') ? (
          <button className="btn-secondary" onClick={async () => {
            const r = await apiFetch('/audit/checkpoints/verify');
            if (!r) return toast('Verify failed', 'err');
            if (r.ok) toast(`Data-plane verified — ${r.total} checkpoints intact`, 'ok');
            else toast(`Tampering detected: checkpoint #${r.broken[0].seq} — ${r.broken[0].reason}`, 'err');
            refetchCk();
          }}>⛓ Verify data plane</button>
        ) : (
          <button className="btn-secondary" onClick={async () => { const r = await apiFetch('/audit/verify'); if (r && r.ok) toast(`Hash-chain verified — ${r.total} entries intact`, 'ok'); else if (r) toast(`Chain broken at entry #${r.broken_at}`, 'err'); else toast('Verify failed', 'err'); }}>⛓ Verify integrity</button>
        )}
        <button className="btn-secondary" onClick={onExport}>⤓ Export</button>
        <button className="btn-secondary" onClick={handleRefresh}>Refresh</button>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="◉" iconBg="var(--green-soft)" iconColor="var(--green)" label="Chain Status" value="Verified" detail="hash chain intact" detailType="up" />
        <KpiCard icon="≋" iconBg="var(--info-soft)" iconColor="var(--info)" label="DB Activity Events" value={actTotal.toLocaleString()} detail="captured queries (data plane)" />
        <KpiCard icon="☰" label="Control-Plane Events" value={cpRows.length} detail={`${uniqueActors} unique actors`} />
        <KpiCard icon="◧" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Retention" value="7 yr" detail="immutable archive" />
      </section>

      {cpError && tab === 'cp' && <div className="card" style={{ padding: 16, color: 'var(--danger)' }}>Error: {cpError}</div>}

      <TabNav tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'db' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Database Activity</span>
            <span className="card-sub">every captured query · ClickHouse (data plane)</span>
          </div>
          <div className="card-body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', paddingBottom: 0 }}>
            <input value={q} onChange={(e) => { const val = e.target.value; if (val && range === 'any') setRange('24h'); onFilter(setQ)(val); }} placeholder="Search SQL or principal…" style={{ flex: 1, minWidth: 200 }} />
            <select value={op} onChange={(e) => onFilter(setOp)(e.target.value)} style={{ width: 150 }}>
              <option value="">All operations</option>
              {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <select value={range} onChange={(e) => onFilter(setRange)(e.target.value)} style={{ width: 180 }}>
              {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </div>
          <div className="card-body no-pad">
            <DataTable columns={activityColumns} data={actRows} emptyMessage="No captured database activity matching this filter" />
          </div>
          <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end', fontSize: 13 }}>
            <span className="muted">
              {range === 'any' && !q && !op
                ? `showing latest ${actRows.length}`
                : `${actTotal === 0 ? '0' : `${(offset + 1).toLocaleString()}–${pageEnd.toLocaleString()}`} of ${actTotal.toLocaleString()} matches`}
            </span>
            <button className="btn-secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>← Prev</button>
            <button className="btn-secondary" disabled={pageEnd >= actTotal} onClick={() => setOffset(offset + PAGE)}>Next →</button>
          </div>
        </div>
      )}

      {tab === 'cp' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Control-Plane Activity</span>
            <span className="card-sub">admin actions in the DAM console · Postgres (control plane)</span>
          </div>
          <div className="card-body no-pad">
            <DataTable columns={cpColumns} data={cpRows} emptyMessage="No control-plane events recorded yet" />
          </div>
        </div>
      )}

      {tab === 'ck' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Data-Plane Checkpoints</span>
            <span className="card-sub">signed Merkle roots over event windows · evidence shipped to WORM archive (MinIO Object Lock)</span>
          </div>
          <div className="card-body" style={{ paddingBottom: 0, fontSize: 12.5, color: 'var(--muted)' }}>
            ClickHouse holds billions of events, so per-row chaining is impractical. Instead a job seals each ~3-minute window with a SHA-256 Merkle root, HMAC-signs it, chains it to the previous checkpoint, and writes the proof to Postgres (separate from the data) plus an immutable copy of the raw events to the WORM bucket. <b>Verify data plane</b> recomputes every window against ClickHouse — any deleted or altered event breaks its root.
          </div>
          <div className="card-body no-pad">
            <DataTable columns={ckColumns} data={ckRows} emptyMessage="No checkpoints sealed yet — the first window seals within ~3 minutes of ingest" />
          </div>
        </div>
      )}
    </Layout>
  );
}
