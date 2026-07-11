import { useState } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/KpiCard';
import TabNav from '../components/shared/TabNav';
import Modal from '../components/shared/Modal';
import useApiData from '../hooks/useApiData';
import { apiPut, apiPost } from '../api/client';
import { exportCsv } from '../exportCsv';
import { toast } from '../components/shared/Toast';

const STATUS_CLR = { pending: 'var(--amber)', attested: 'var(--green)', unauthorized: 'var(--danger)', exempt: 'var(--muted)' };

export default function ChangeLog() {
  const [days, setDays] = useState(30);
  const [status, setStatus] = useState('');
  const { data, loading, refetch } = useApiData(`/ddl-changes?days=${days}${status ? `&status=${status}` : ''}`);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [draft, setDraft] = useState({});
  const [emailOpen, setEmailOpen] = useState(false);

  const changes = Array.isArray(data?.changes) ? data.changes : [];
  const s = data?.summary || { total: 0, pending: 0, attested: 0, outOfWindow: 0 };
  const handleRefresh = () => { refetch(); setLastRefresh(new Date()); };

  const setD = (id, k, v) => setDraft((p) => ({ ...p, [id]: { ...p[id], [k]: v } }));
  const valOf = (row, k) => (draft[row.id]?.[k] !== undefined ? draft[row.id][k] : (row[k] || ''));

  const save = async (row) => {
    const d = draft[row.id] || {};
    const body = {};
    if (d.cr_number !== undefined) body.cr_number = d.cr_number;
    if (d.status !== undefined) body.status = d.status;
    if (!Object.keys(body).length) return;
    const res = await apiPut(`/ddl-changes/${row.id}`, body);
    if (res?.ok) { toast('Change updated', 'ok'); setDraft((p) => { const n = { ...p }; delete n[row.id]; return n; }); refetch(); }
    else toast(res?.data?.error || 'Update failed', 'err');
  };

  const onExport = () => {
    exportCsv('toovix-ddl-change-log.csv',
      ['When (UTC)', 'Principal', 'Database', 'Object', 'Operation', 'In change window', 'CR#', 'Status', 'Statement'],
      changes.map((c) => [c.event_ts, c.principal, c.database_name, c.object_name, c.operation, c.in_window ? 'yes' : 'no', c.cr_number, c.status, c.statement]));
    toast(`Exported ${changes.length} changes`, 'ok');
  };

  const tabs = [
    { id: '', label: 'All', count: s.total },
    { id: 'pending', label: 'Pending CR#', count: s.pending },
    { id: 'attested', label: 'Attested', count: s.attested },
    { id: 'unauthorized', label: 'Unauthorized' },
  ];

  return (
    <Layout activePage="change-log" lastRefresh={lastRefresh} onRefresh={handleRefresh}>
      <PageHeader title="DDL Change Log" meta={['schema & privilege changes', 'attest with a CR#']}>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ marginRight: 8 }}>
          <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
        </select>
        <button className="btn-secondary" onClick={onExport}>⤓ Export CSV</button>
        <button className="btn-primary" onClick={() => setEmailOpen(true)}>✉ Email to app teams</button>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="⛭" label="Changes captured" value={s.total} detail={`last ${days} days`} />
        <KpiCard icon="◷" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Awaiting CR#" value={s.pending} detail="not yet attested" detailType={s.pending ? 'down' : undefined} />
        <KpiCard icon="✓" iconBg="var(--green-soft)" iconColor="var(--green)" label="Attested" value={s.attested} detail="CR# recorded" detailType="up" />
        <KpiCard icon="⚠" iconBg="var(--danger-soft)" iconColor="var(--danger)" label="Outside change window" value={s.outOfWindow} detail="ran off-window" detailType={s.outOfWindow ? 'down' : undefined} />
      </section>

      <TabNav tabs={tabs} active={status} onChange={setStatus} />

      <div className="card">
        <div className="card-header">
          <span className="card-title">Captured DDL / privilege changes</span>
          <span className="card-sub">{changes.length} shown · record the CR# each change was made under</span>
        </div>
        <div className="card-body no-pad" style={{ overflowX: 'auto' }}>
          {loading ? <div style={{ padding: 24 }} className="muted">Loading…</div> : (
            <table className="data-table">
              <thead><tr>
                <th>When (UTC)</th><th>Principal</th><th>Database</th><th>Object</th><th>Op</th>
                <th style={{ textAlign: 'center' }}>Window</th><th>Statement</th><th style={{ width: 150 }}>CR#</th><th style={{ width: 130 }}>Status</th><th />
              </tr></thead>
              <tbody>
                {changes.length === 0 && <tr><td colSpan={10} className="muted" style={{ padding: 20, textAlign: 'center' }}>No DDL changes captured in this window.</td></tr>}
                {changes.map((c) => {
                  const dirty = !!draft[c.id];
                  return (
                    <tr key={c.id}>
                      <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{new Date(c.event_ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                      <td style={{ fontSize: 12.5 }}>{c.principal}</td>
                      <td style={{ fontSize: 12.5 }}>{c.database_name || '—'}</td>
                      <td style={{ fontSize: 12.5 }}>{c.object_name || '—'}</td>
                      <td><span className="badge">{c.operation}</span></td>
                      <td style={{ textAlign: 'center' }}>{c.in_window
                        ? <span className="badge" style={{ color: 'var(--green)' }}>in</span>
                        : <span className="badge" style={{ color: 'var(--danger)' }}>off</span>}</td>
                      <td><code style={{ fontSize: 11 }} title={c.statement}>{String(c.statement || '').slice(0, 60)}</code></td>
                      <td><input value={valOf(c, 'cr_number')} onChange={(e) => setD(c.id, 'cr_number', e.target.value)} placeholder="CHG…" style={{ width: 130, fontSize: 12 }} /></td>
                      <td>
                        <select value={valOf(c, 'status') || 'pending'} onChange={(e) => setD(c.id, 'status', e.target.value)} style={{ fontSize: 12, color: STATUS_CLR[valOf(c, 'status') || 'pending'] }}>
                          <option value="pending">pending</option><option value="attested">attested</option><option value="unauthorized">unauthorized</option><option value="exempt">exempt</option>
                        </select>
                      </td>
                      <td>{dirty && <button className="btn-primary" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => save(c)}>Save</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <Modal open={emailOpen} onClose={() => setEmailOpen(false)} title="Email change log to application teams" width={520}>
        <EmailForm pending={s.pending} onClose={() => setEmailOpen(false)} />
      </Modal>
    </Layout>
  );
}

function EmailForm({ pending, onClose }) {
  const [recipients, setRecipients] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!recipients.trim()) return toast('Enter at least one recipient', 'err');
    setBusy(true);
    const res = await apiPost('/ddl-changes/email', { recipients });
    setBusy(false);
    if (res?.ok) { toast(`Sent to ${res.data.sent} recipient(s) · ${res.data.pending} pending change(s)`, 'ok'); onClose(); }
    else toast(res?.data?.error || 'Send failed', 'err');
  };
  return (
    <>
      <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 0 14px' }}>
        Emails the <b>{pending} pending</b> (un-attested) change(s) to the app teams with a CSV attached, so they can
        reply with the CR# each change was carried out under. Uses the platform mailer.
      </p>
      <div className="form-field"><label>Recipients</label>
        <input value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="app-team@company.com, dba-lead@company.com" />
        <span className="muted" style={{ fontSize: 11 }}>Comma or space separated.</span>
      </div>
      <div className="modal-footer" style={{ padding: '6px 0 0', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy} onClick={send}>{busy ? 'Sending…' : 'Send report'}</button>
      </div>
    </>
  );
}
