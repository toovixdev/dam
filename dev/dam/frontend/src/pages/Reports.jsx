import { useState } from 'react';
import { fmtTs, getTimezone } from '../hooks/useTimezone';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import TabNav from '../components/shared/TabNav';
import Modal from '../components/shared/Modal';
import { toast } from '../components/shared/Toast';
import { apiFetch, apiPost, apiDelete } from '../api/client';
import useApiData from '../hooks/useApiData';
import { useAuth } from '../context/AuthContext';
import { printReport } from '../reportPrint';

const LIBRARY = [
  { id: 'gdpr', ic: '⚖', n: 'GDPR compliance', d: 'EU data-subject rights, processing logs, retention', c: 'var(--primary)' },
  { id: 'dpdpa', ic: '🇮🇳', n: 'DPDPA / RBI compliance', d: 'India data protection, Aadhaar monitoring, RBI baseline', c: 'var(--primary)' },
  { id: 'sox', ic: '🏦', n: 'SOX controls quarterly', d: 'Financial data integrity, access controls', c: 'var(--green)' },
  { id: 'pci', ic: '💳', n: 'PCI-DSS Req 10', d: 'All access to cardholder data this period', c: 'var(--amber)' },
  { id: 'sensitive', ic: '◧', n: 'Sensitive-data access', d: 'Who accessed PII/PHI/PCI/Aadhaar', c: 'var(--danger)' },
  { id: 'privileged', ic: '⊠', n: 'Privileged user activity', d: 'DBA & service-account actions', c: 'var(--info)' },
  { id: 'va', ic: '⚷', n: 'VA findings', d: 'Vulnerabilities by severity + remediation', c: 'var(--primary)' },
  { id: 'audit', ic: '⛓', n: 'Audit integrity', d: 'Hash-chain verification evidence pack', c: 'var(--green)' },
  { id: 'llm', ic: '✦', n: 'AI/LLM data exposure', d: 'Prompts touching sensitive data', c: 'var(--primary)' },
  { id: 'exec', ic: '◎', n: 'Executive summary', d: 'Risk, alerts, posture at a glance', c: 'var(--amber)' },
];

function downloadReportCsv(report) {
  const esc = (v) => `"${(v == null ? '' : String(v)).replace(/"/g, '""')}"`;
  const lines = [[report.title], ['Generated', report.generated_at], ['Period', report.period || ''], [], ['Summary']];
  (report.kpis || []).forEach((k) => lines.push([k.label, k.value, k.sub || '']));
  (report.tables || []).forEach((t) => { lines.push([], [t.title], t.columns); t.rows.forEach((r) => lines.push(r)); });
  const csv = lines.map((r) => r.map(esc).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url; a.download = `securera-${report.type}-report.csv`; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

function ReportView({ report, onPrint }) {
  return (
    <div className="report-print">
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
        {report.period} · generated {fmtTs(report.generated_at, getTimezone(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
      </div>
      {report.note && <div style={{ background: 'var(--amber-soft)', borderRadius: 10, padding: '10px 14px', fontSize: 12.5, marginBottom: 14, lineHeight: 1.5 }}>{report.note}</div>}

      <section className="kpi-grid c5" style={{ marginBottom: 14 }}>
        {(report.kpis || []).map((k) => (
          <div className="kpi-card" key={k.label}>
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value" style={{ fontSize: 22 }}>{k.value}</div>
            {k.sub && <div className="kpi-detail">{k.sub}</div>}
          </div>
        ))}
      </section>

      {(report.tables || []).map((t) => (
        <div className="card" key={t.title} style={{ marginBottom: 12 }}>
          <div className="card-header"><span className="card-title">{t.title}</span><span className="card-sub">{t.rows.length} rows</span></div>
          <div className="card-body no-pad">
            {t.rows.length === 0 ? <div className="chart-empty">No data</div> : (
              <table className="data-table">
                <thead><tr>{t.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>{t.rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j}>{String(cell)}</td>)}</tr>)}</tbody>
              </table>
            )}
          </div>
        </div>
      ))}

      <div className="modal-footer no-print" style={{ padding: '6px 0 0', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn-secondary" onClick={() => downloadReportCsv(report)}>⤓ Export CSV</button>
        <button className="btn-primary" onClick={onPrint}>⤓ Download / Print PDF</button>
      </div>
    </div>
  );
}

const FREQUENCIES = ['Daily', 'Weekly', 'Monthly', 'Quarterly'];

// Custom report builder (Sl.86) — no-code field/period allow-lists mirrored from the API.
const CUSTOM_COLS = [
  ['timestamp', 'Time'], ['principal', 'Principal'], ['database_name', 'Database'],
  ['operation', 'Operation'], ['row_count', 'Rows'], ['client_ip', 'Client IP'], ['tags', 'Tags'],
];
const CUSTOM_PERIODS = [['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days']];
const CUSTOM_GROUPS = [['none', 'No grouping'], ['principal', 'Principal'], ['database_name', 'Database'], ['operation', 'Operation']];
const DEFAULT_CUSTOM = {
  name: '', period: '30d', groupBy: 'none',
  columns: ['timestamp', 'principal', 'database_name', 'operation', 'row_count'],
  filters: { database_name: '', principal: '', operation: '', sensitive_only: false, min_rows: '' },
};

export default function Reports() {
  const { user } = useAuth();
  const [tab, setTab] = useState('lib');
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(null);
  const [scheduleFor, setScheduleFor] = useState(null); // report card being scheduled
  const [freq, setFreq] = useState('Monthly');
  const [recipients, setRecipients] = useState('');
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState(DEFAULT_CUSTOM);
  const [customBusy, setCustomBusy] = useState(false);

  const { data: schedData, refetch: refetchSched } = useApiData('/report-schedules');
  const schedules = Array.isArray(schedData) ? schedData : [];

  const generate = async (id) => {
    setBusy(id);
    const r = await apiFetch(`/reports/${id}`);
    setBusy(null);
    if (r && !r.error) setReport(r); else toast('Could not generate report', 'err');
  };

  const handlePrint = () => {
    if (!report) return;
    const ok = printReport(report, {
      tenantName: user?.tenantName || '',
      generatedBy: user?.fullName || user?.email || '',
    });
    if (!ok) toast('Allow pop-ups for this site to download the PDF', 'err');
  };

  const openCustom = () => { setCustom(DEFAULT_CUSTOM); setCustomOpen(true); };
  const toggleCol = (key) => setCustom((c) => ({
    ...c, columns: c.columns.includes(key) ? c.columns.filter((k) => k !== key) : [...c.columns, key],
  }));
  const setFilter = (key, val) => setCustom((c) => ({ ...c, filters: { ...c.filters, [key]: val } }));
  const runCustom = async () => {
    if (!custom.columns.length) { toast('Pick at least one column', 'err'); return; }
    setCustomBusy(true);
    const res = await apiPost('/reports/custom', custom);
    setCustomBusy(false);
    if (res && !res.error) { setCustomOpen(false); setReport(res); }
    else toast('Could not generate custom report', 'err');
  };

  const openSchedule = (r) => { setScheduleFor(r); setFreq('Monthly'); setRecipients(''); };
  const saveSchedule = async () => {
    const res = await apiPost('/report-schedules', { report_type: scheduleFor.id, report_name: scheduleFor.n, frequency: freq, recipients });
    if (res && res.ok) { toast(`Scheduled "${scheduleFor.n}" — ${freq}`, 'ok'); setScheduleFor(null); refetchSched(); setTab('sched'); }
    else toast('Could not schedule', 'err');
  };
  const toggleSchedule = async (s) => { const res = await apiPost(`/report-schedules/${s.id}/toggle`); if (res && res.ok) refetchSched(); };
  const removeSchedule = async (s) => { const res = await apiDelete(`/report-schedules/${s.id}`); if (res && res.ok) { toast('Schedule removed', 'ok'); refetchSched(); } };

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={() => { setLastRefresh(new Date()); refetchSched(); }}>
      <PageHeader title="Reports" meta={['pre-built + scheduled', 'PDF / CSV / signed evidence']}>
        <button className="btn-primary" onClick={openCustom}>＋ Custom report</button>
      </PageHeader>

      <TabNav tabs={[{ id: 'lib', label: 'Library' }, { id: 'sched', label: 'Scheduled', count: schedules.length }]} active={tab} onChange={setTab} />

      {tab === 'lib' && (
        <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 14px', margin: '0 0 14px', borderRadius: 10, background: 'var(--surface)', border: '1px solid var(--line)', fontSize: 12.5 }}>
          <span style={{ fontSize: 15 }}>✍</span>
          <span className="muted">These are <b>summary</b> reports (schedulable · PDF/CSV). For <b>sealed, attestable audit evidence</b> — per-control, tamper-evident, with reviewer sign-off across PCI · SOX · HIPAA · GDPR · ISO 27001 · SOC 2 — use </span>
          <a href="/attestations" style={{ color: 'var(--primary)', fontWeight: 600 }}>Attestations →</a>
        </div>
        <div className="report-grid">
          {LIBRARY.map((r) => (
            <div className="card report-card" key={r.id}>
              <div className="rc-head">
                <span className="rc-icon" style={{ background: r.c }}>{r.ic}</span>
                <b>{r.n}</b>
              </div>
              <p className="muted" style={{ fontSize: 12.5, margin: '0 0 12px' }}>{r.d}</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-primary" style={{ padding: '6px 12px', flex: 1, justifyContent: 'center' }} disabled={busy === r.id} onClick={() => generate(r.id)}>{busy === r.id ? 'Generating…' : 'Generate'}</button>
                <button className="btn-secondary" style={{ padding: '6px 12px' }} onClick={() => openSchedule(r)}>Schedule</button>
              </div>
            </div>
          ))}
        </div>
        </>
      )}

      {tab === 'sched' && (
        <div className="card"><div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Report</th><th>Schedule</th><th>Recipients</th><th>Next run</th><th>Status</th><th /></tr></thead>
            <tbody>
              {schedules.map((s) => (
                <tr key={s.id}>
                  <td><b>{s.report_name}</b></td><td>{s.frequency}</td><td>{s.recipients || '—'}</td><td>{s.next_run || '—'}</td>
                  <td><span className={`badge ${s.status === 'on' ? 'green' : ''} dot`}>{s.status}</span></td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => toggleSchedule(s)}>{s.status === 'on' ? 'Pause' : 'Resume'}</button>{' '}
                    <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => removeSchedule(s)}>Remove</button>
                  </td>
                </tr>
              ))}
              {schedules.length === 0 && <tr><td colSpan={6} className="chart-empty">No scheduled reports</td></tr>}
            </tbody>
          </table>
        </div></div>
      )}

      <Modal open={customOpen} onClose={() => setCustomOpen(false)} title="Build a custom report" width={560}>
        <p className="muted" style={{ fontSize: 12.5, margin: '0 0 14px' }}>
          Assemble a report from database activity — pick the period, columns, grouping and filters. No query or code needed; the result exports to PDF / CSV / Excel like any library report.
        </p>
        <div className="form-field"><label>Report name</label>
          <input value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} placeholder="e.g. Finance-DB privileged access — Q3" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div className="form-field"><label>Period</label>
            <select value={custom.period} onChange={(e) => setCustom({ ...custom, period: e.target.value })}>
              {CUSTOM_PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="form-field"><label>Group summary by</label>
            <select value={custom.groupBy} onChange={(e) => setCustom({ ...custom, groupBy: e.target.value })}>
              {CUSTOM_GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </div>
        <div className="form-field"><label>Columns</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {CUSTOM_COLS.map(([key, label]) => (
              <button key={key} type="button" onClick={() => toggleCol(key)}
                className={`badge ${custom.columns.includes(key) ? 'green' : ''}`}
                style={{ cursor: 'pointer', border: '1px solid var(--line)', padding: '5px 11px', fontSize: 12 }}>
                {custom.columns.includes(key) ? '✓ ' : ''}{label}
              </button>
            ))}
          </div>
        </div>
        <div className="form-field" style={{ marginBottom: 6 }}><label>Filters (optional)</label></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div className="form-field"><input value={custom.filters.database_name} onChange={(e) => setFilter('database_name', e.target.value)} placeholder="Database name" /></div>
          <div className="form-field"><input value={custom.filters.principal} onChange={(e) => setFilter('principal', e.target.value)} placeholder="Principal / user" /></div>
          <div className="form-field"><input value={custom.filters.operation} onChange={(e) => setFilter('operation', e.target.value)} placeholder="Operation (SELECT, GRANT…)" /></div>
          <div className="form-field"><input type="number" min="0" value={custom.filters.min_rows} onChange={(e) => setFilter('min_rows', e.target.value)} placeholder="Min rows affected" /></div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, margin: '2px 0 4px', cursor: 'pointer' }}>
          <input type="checkbox" checked={custom.filters.sensitive_only} onChange={(e) => setFilter('sensitive_only', e.target.checked)} />
          Sensitive-data access only (events touching classified columns)
        </label>
        <div className="modal-footer" style={{ padding: '10px 0 0', justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={() => setCustomOpen(false)}>Cancel</button>
          <button className="btn-primary" disabled={customBusy} onClick={runCustom}>{customBusy ? 'Generating…' : 'Generate report'}</button>
        </div>
      </Modal>

      <Modal open={!!report} onClose={() => setReport(null)} title={report ? report.title : 'Report'} width={780}>
        {report && <ReportView report={report} onPrint={handlePrint} />}
      </Modal>

      <Modal open={!!scheduleFor} onClose={() => setScheduleFor(null)} title={scheduleFor ? `Schedule — ${scheduleFor.n}` : ''} width={460}>
        {scheduleFor && (
          <>
            <div className="form-field"><label>Frequency</label>
              <select value={freq} onChange={(e) => setFreq(e.target.value)}>{FREQUENCIES.map((f) => <option key={f}>{f}</option>)}</select>
            </div>
            <div className="form-field"><label>Recipients (comma-separated)</label>
              <input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="compliance@acme.com, ciso@acme.com" />
            </div>
            <div className="modal-footer" style={{ padding: '6px 0 0', justifyContent: 'flex-end' }}>
              <button className="btn-secondary" onClick={() => setScheduleFor(null)}>Cancel</button>
              <button className="btn-primary" onClick={saveSchedule}>Schedule report</button>
            </div>
          </>
        )}
      </Modal>
    </Layout>
  );
}
