import { useState } from 'react';
import Layout from '../components/Layout';
import KpiCard from '../components/KpiCard';
import PageHeader from '../components/shared/PageHeader';
import { toast } from '../components/shared/Toast';
import useApiData from '../hooks/useApiData';
import { apiPost } from '../api/client';

const VIEWERS = [
  { id: 'ops', name: 'David Kim (Platform Ops)', role: 'ops' },
  { id: 'sales', name: 'Priya Nair (Sales)', role: 'sales' },
  { id: 'finance', name: 'Lisa Wong (Finance)', role: 'finance' },
  { id: 'lead', name: 'Alex Torres (Platform Lead)', role: 'lead' },
];
const TYPE_BADGE = { upgrade: 'engine', suspension: 'sev-high', offboarding: 'sev-critical' };
const ROLE_LABEL = { sales: 'Sales', finance: 'Finance', lead: 'Platform Lead', ops: 'Platform Ops' };
const CHAINS = [
  ['Upgrade', 'engine', 'Plan upgrade — Sales (contract) → Finance (billing) → Platform Lead (capacity). All three required.'],
  ['Suspend', 'sev-high', 'Tenant suspension — Platform Lead only. Single approver, immediate effect.'],
  ['Offboard', 'sev-critical', 'Tenant offboarding — Sales (contract ended) → Platform Lead (grace period). Both required.'],
];
const CHANNELS = [['✉', 'Email', 'Approvers get email with one-click approve/reject links', 'status-green', 'Active'], ['💬', 'Slack', '#approvals channel with interactive buttons', 'status-green', 'Active'], ['⚙', 'Jira', 'Optional CS-UPGRADE tickets for tracking', 'status-gray', 'Optional']];

function ChainBadges({ chain }) {
  return <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{chain.map((c, i) => (
    <span key={i} className={`badge ${c.status === 'approved' ? 'status-green' : c.status === 'rejected' ? 'sev-critical' : 'status-gray'}`} style={{ fontSize: 10 }}>
      {ROLE_LABEL[c.role] || c.role} {c.status === 'approved' ? '✓' : c.status === 'rejected' ? '✗' : '—'}
    </span>
  ))}</div>;
}
function ago(d) {
  const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / 1440)}d ago`;
}

export default function Approvals() {
  const { data, loading, lastRefresh, refetch } = useApiData('/admin/approvals', { poll: 15000 });
  const [viewer, setViewer] = useState(VIEWERS[3]);
  const [busy, setBusy] = useState(null);

  async function decide(a, decision) {
    setBusy(a.id);
    const res = await apiPost(`/admin/approvals/${a.id}/decision`, { role: viewer.role, decision, actor: viewer.name.split(' (')[0] });
    setBusy(null);
    if (res.ok) { toast(`${a.ref} ${decision}d as ${ROLE_LABEL[viewer.role]}`, decision === 'approve' ? 'ok' : 'err'); refetch(); }
    else toast(res.data?.error || 'Failed', 'err');
  }

  if (loading && !data) return <div className="loading-screen"><div className="loading-spinner" /><p>Loading approvals…</p></div>;
  const k = data?.kpis || {};
  const pending = data?.pending || [];
  const history = data?.history || [];
  const canActOn = (a) => { const step = a.chain.find(c => c.role === viewer.role); return step && step.status === 'pending'; };

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={refetch}>
      <PageHeader title="Approval Requests" meta={['tenant lifecycle approvals', 'upgrade · suspension · offboarding']}>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Viewing as:</span>
        <select value={viewer.id} onChange={e => setViewer(VIEWERS.find(v => v.id === e.target.value))} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink)', fontSize: 12.5, fontWeight: 600 }}>
          {VIEWERS.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="⏱" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Pending" value={k.pending} detail="awaiting approval" detailType={k.pending ? 'down' : 'up'} />
        <KpiCard icon="✓" iconBg="var(--green-soft)" iconColor="var(--green)" label="Approved (30d)" value={k.approved} detail="all applied" detailType="up" />
        <KpiCard icon="✗" iconBg="var(--danger-soft)" iconColor="var(--danger)" label="Rejected (30d)" value={k.rejected} detail="declined" />
        <KpiCard icon="⇄" iconBg="var(--info-soft)" iconColor="var(--info)" label="Avg approval time" value={`${k.avgHours}h`} detail="across all types" />
      </section>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Pending Approvals</span><span className="card-sub">requires action</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Request</th><th>Type</th><th>Tenant</th><th>Initiated by</th><th>Approval chain</th><th>Submitted</th><th>Actions</th></tr></thead>
            <tbody>
              {pending.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>No pending approvals 🎉</td></tr>}
              {pending.map(a => (
                <tr key={a.id}>
                  <td><b>{a.ref}</b></td>
                  <td><span className={`badge ${TYPE_BADGE[a.type] || 'status-gray'}`}>{a.type}</span></td>
                  <td>{a.tenantName}<br /><small className="muted">{a.detail}</small></td>
                  <td className="muted">{a.initiatedBy}</td>
                  <td><ChainBadges chain={a.chain} /></td>
                  <td className="muted">{ago(a.submittedAt)}</td>
                  <td>
                    {canActOn(a) ? (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn-primary" style={{ padding: '4px 10px', fontSize: 11 }} disabled={busy === a.id} onClick={() => decide(a, 'approve')}>Approve</button>
                        <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 11, color: 'var(--danger)', borderColor: 'var(--danger)' }} disabled={busy === a.id} onClick={() => decide(a, 'reject')}>Reject</button>
                      </div>
                    ) : <span className="muted" style={{ fontSize: 11.5 }}>{a.chain.find(c => c.role === viewer.role) ? 'You already decided' : `No ${ROLE_LABEL[viewer.role]} step`}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-header"><span className="card-title">Recent History</span><span className="card-sub">{history.length} resolved</span></div>
        <div className="card-body no-pad">
          <table className="data-table">
            <thead><tr><th>Request</th><th>Type</th><th>Tenant</th><th>Result</th><th>Approval chain</th><th>Resolved</th></tr></thead>
            <tbody>
              {history.map(a => (
                <tr key={a.id}>
                  <td><b>{a.ref}</b></td>
                  <td><span className={`badge ${TYPE_BADGE[a.type] || 'status-gray'}`}>{a.type}</span></td>
                  <td>{a.tenantName}<br /><small className="muted">{a.detail}</small></td>
                  <td><span className={`badge ${a.status === 'approved' ? 'status-green' : 'sev-critical'}`}>{a.status}</span></td>
                  <td><ChainBadges chain={a.chain} /></td>
                  <td className="muted">{a.resolvedAt ? ago(a.resolvedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <section className="charts-row" style={{ marginBottom: 14 }}>
        <div className="card">
          <div className="card-header"><span className="card-title">Approval Chains by Type</span></div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {CHAINS.map(([tag, cls, desc]) => (
              <div key={tag} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 9 }}>
                <span className={`badge ${cls}`} style={{ flex: 'none', marginTop: 2 }}>{tag}</span>
                <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>{desc}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">Notification Channels</span></div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {CHANNELS.map(([ic, name, sub, cls, label]) => (
              <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 9 }}>
                <span style={{ fontSize: 16 }}>{ic}</span>
                <div style={{ flex: 1 }}><b style={{ fontSize: 13 }}>{name}</b><br /><small className="muted">{sub}</small></div>
                <span className={`badge ${cls}`} style={{ fontSize: 10 }}>{label}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </Layout>
  );
}
