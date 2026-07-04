import { useState } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import TabNav from '../components/shared/TabNav';
import Modal from '../components/shared/Modal';
import { toast } from '../components/shared/Toast';
import { apiFetch, apiPost, apiDelete } from '../api/client';
import useApiData from '../hooks/useApiData';

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
  a.href = url; a.download = `toovix-${report.type}-report.csv`; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

function ReportView({ report }) {
  return (
    <div className="report-print">
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
        {report.period} · generated {new Date(report.generated_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
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
        <button className="btn-secondary" onClick={() => window.print()}>🖨 Print / PDF</button>
      </div>
    </div>
  );
}

const FREQUENCIES = ['Daily', 'Weekly', 'Monthly', 'Quarterly'];

export default function Reports() {
  const [tab, setTab] = useState('lib');
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(null);
  const [scheduleFor, setScheduleFor] = useState(null); // report card being scheduled
  const [freq, setFreq] = useState('Monthly');
  const [recipients, setRecipients] = useState('');

  const { data: schedData, refetch: refetchSched } = useApiData('/report-schedules');
  const schedules = Array.isArray(schedData) ? schedData : [];

  const generate = async (id) => {
    setBusy(id);
    const r = await apiFetch(`/reports/${id}`);
    setBusy(null);
    if (r && !r.error) setReport(r); else toast('Could not generate report', 'err');
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
        <button className="btn-primary" onClick={() => toast('Custom report builder opened')}>＋ Custom report</button>
      </PageHeader>

      <TabNav tabs={[{ id: 'lib', label: 'Library' }, { id: 'sched', label: 'Scheduled', count: schedules.length }]} active={tab} onChange={setTab} />

      {tab === 'lib' && (
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

      <Modal open={!!report} onClose={() => setReport(null)} title={report ? report.title : 'Report'} width={780}>
        {report && <ReportView report={report} />}
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
