import { useState } from 'react';
import { fmtTs, getTimezone } from '../hooks/useTimezone';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/KpiCard';
import TabNav from '../components/shared/TabNav';
import Modal from '../components/shared/Modal';
import useApiData from '../hooks/useApiData';
import { apiFetch, apiPost, getUser, getToken } from '../api/client';
import { exportCsv } from '../exportCsv';
import { toast } from '../components/shared/Toast';

// Roles allowed to sign off (mirrors the server-side EVIDENCE_ATTEST_ROLES gate).
const ATTEST_ROLES = ['tenant_admin', 'compliance', 'auditor'];
const STATUS = {
  open:      { label: 'Awaiting review', clr: 'var(--amber)' },
  attested:  { label: 'Attested',        clr: 'var(--green)' },
  exception: { label: 'Exception',       clr: 'var(--danger)' },
  escalated: { label: 'Escalated',       clr: 'var(--info)' },
};
const FRAMEWORK_CLR = { 'PCI-DSS': 'var(--danger)', SOX: 'var(--info)', GDPR: 'var(--green)', HIPAA: 'var(--amber)', 'ISO 27001': '#8b5cf6', 'SOC 2': '#0d9488' };
const FW_ORDER = ['PCI-DSS', 'SOX', 'HIPAA', 'GDPR', 'ISO 27001', 'SOC 2'];
// Framework NAME → the keys the pack + matrix/binder endpoints use (two schemes).
const FW_PACK_KEY = { 'PCI-DSS': 'pci-dss', HIPAA: 'hipaa', SOX: 'sox', GDPR: 'gdpr', 'ISO 27001': 'iso-27001', 'SOC 2': 'soc-2' };
const FW_MATRIX_KEY = { 'PCI-DSS': 'pci', HIPAA: 'hipaa', SOX: 'sox', GDPR: 'gdpr', 'ISO 27001': 'iso27001', 'SOC 2': 'soc2' };

function StatusPill({ s }) {
  const st = STATUS[s] || { label: s, clr: 'var(--muted)' };
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 650, color: st.clr }}>
    <span style={{ width: 7, height: 7, borderRadius: '50%', background: st.clr }} />{st.label}</span>;
}

export default function Attestations() {
  const user = getUser();
  const canAttest = ATTEST_ROLES.includes(user?.role);
  const [tab, setTab] = useState('catalog');
  const [days, setDays] = useState(90);
  const [running, setRunning] = useState('');
  const [detail, setDetail] = useState(null);       // full evidence record in the drawer
  const [decision, setDecision] = useState('attested');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const [binderFw, setBinderFw] = useState('');
  const [changelog, setChangelog] = useState(null);   // { fw, revisions } for the changelog modal

  const { data: cat } = useApiData('/compliance/catalog');
  const { data: ev, refetch: refetchEv } = useApiData('/compliance/evidence');
  const { data: packsData } = useApiData('/compliance/packs');

  const items = cat?.items || [];
  const evidence = ev?.evidence || [];
  const packs = packsData?.packs || {};
  const sum = ev?.summary || { open: 0, attested: 0, exception: 0, escalated: 0 };
  const fmt = (ts) => (ts ? fmtTs(ts, getTimezone(), { dateStyle: 'medium', timeStyle: 'short' }) : '—');

  // Group catalog by EVERY framework each control satisfies (the crosswalk), so ISO 27001 and
  // SOC 2 — which are entirely cross-mapped citations — get their own groups too. The citation
  // shown per group is that framework's citation (from mappings), not the primary.
  const citationFor = (it, fw) => (it.mappings || []).find((x) => x.framework === fw)?.control || it.control;
  const grouped = items.reduce((m, it) => {
    const fws = (it.frameworks && it.frameworks.length) ? it.frameworks : [it.framework];
    for (const fw of fws) (m[fw] = m[fw] || []).push(it);
    return m;
  }, {});
  const orderedFws = Object.keys(grouped).sort((a, b) => ((FW_ORDER.indexOf(a) + 1 || 99) - (FW_ORDER.indexOf(b) + 1 || 99)));

  const downloadBinder = async (fw) => {
    const key = FW_MATRIX_KEY[fw]; if (!key) return;
    setBinderFw(fw);
    try {
      const res = await fetch(`/api/compliance/framework/${key}/binder.pdf`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error();
      const blob = await res.blob(); const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `audit-binder-${key}.pdf`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      toast('Downloaded audit binder', 'ok');
    } catch { toast('Could not generate the binder', 'err'); }
    setBinderFw('');
  };
  const openChangelog = async (fw) => {
    const key = FW_PACK_KEY[fw]; if (!key) return;
    const r = await apiFetch(`/compliance/pack/${key}/history`);
    setChangelog({ fw, revisions: r?.revisions || [] });
  };

  const run = async (id) => {
    setRunning(id);
    const res = await apiPost(`/compliance/catalog/${id}/run`, { days });
    setRunning('');
    if (res?.ok) {
      toast(`Evidence sealed · ${res.data.total} events · ${String(res.data.content_hash).slice(0, 12)}…`, 'ok');
      refetchEv(); setTab('evidence');
    } else toast(res?.data?.error || 'Run failed', 'err');
  };

  const openDetail = async (id) => {
    const rec = await apiFetch(`/compliance/evidence/${id}`);
    if (rec) { setDetail(rec); setDecision('attested'); setNote(''); }
  };

  const attest = async () => {
    if (!detail) return;
    setBusy(true);
    const res = await apiPost(`/compliance/evidence/${detail.id}/attest`, { decision, note });
    setBusy(false);
    if (res?.ok) { toast(`Signed off · ${res.data.status}`, 'ok'); setDetail(null); refetchEv(); }
    else toast(res?.data?.error || 'Sign-off failed', 'err');
  };

  const verify = async () => {
    const r = await apiFetch('/compliance/evidence/verify');
    if (!r) return;
    if (r.ok) toast(`Integrity verified · ${r.checked} sealed, ${r.signed} signed`, 'ok');
    else toast(`Tamper detected on ${r.broken?.id?.slice(0, 8)} (${r.broken?.reason})`, 'err');
  };

  const exportRows = () => {
    const rows = detail?.result_json?.rows || [];
    exportCsv(`evidence-${detail.catalog_id}-${detail.id.slice(0, 8)}.csv`,
      ['Time', 'Principal', 'Database', 'Object', 'Operation', 'Rows', 'Client IP', 'Tags', 'Statement'],
      rows.map((r) => [r.ts, r.principal, r.database_name, r.object, r.operation, r.rows, r.client_ip, r.tags, r.sql_preview]));
    toast(`Exported ${rows.length} evidence rows`, 'ok');
  };

  // Sealed + digitally-signed PDF — the artifact you hand an auditor (they verify offline,
  // no DAM login). Authed binary download, so fetch → blob → trigger save.
  const downloadPdf = async () => {
    try {
      const res = await fetch(`/api/compliance/evidence/${detail.id}/pdf`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) return toast('Could not generate the signed PDF', 'err');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `evidence-${detail.catalog_id}-${detail.id.slice(0, 8)}.pdf`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      toast('Downloaded sealed & signed PDF', 'ok');
    } catch { toast('Could not generate the signed PDF', 'err'); }
  };

  const rj = detail?.result_json || {};
  const detailRows = rj.rows || [];

  return (
    <Layout activePage="attestations">
      <PageHeader title="Attestations" meta={['control-mapped evidence', 'reviewer sign-off', 'tamper-evident']}>
        <button className="btn-secondary" onClick={verify}>⛓ Verify integrity</button>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="◷" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Awaiting review" value={sum.open} detail="evidence runs open" detailType={sum.open ? 'down' : 'up'} />
        <KpiCard icon="✓" iconBg="var(--green-soft)" iconColor="var(--green)" label="Attested" value={sum.attested} detail="signed off" />
        <KpiCard icon="⚠" iconBg="var(--danger-soft)" iconColor="var(--danger)" label="Exceptions" value={sum.exception + sum.escalated} detail="flagged / escalated" detailType={sum.exception + sum.escalated ? 'down' : 'up'} />
        <KpiCard icon="◫" label="Catalog reports" value={items.length} detail="control-mapped" />
      </section>

      <TabNav
        tabs={[{ id: 'catalog', label: 'Report catalog', count: items.length }, { id: 'evidence', label: 'Evidence & sign-off', count: evidence.length }]}
        active={tab} onChange={setTab} />

      {tab === 'catalog' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Control-mapped reports</span>
            <label style={{ fontSize: 12.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
              Period
              <select value={days} onChange={(e) => setDays(parseInt(e.target.value))} className="input-sm">
                <option value={7}>Last 7 days</option>
                <option value={30}>Last 30 days</option>
                <option value={90}>Last 90 days</option>
              </select>
            </label>
          </div>
          <div className="card-body">
            {orderedFws.map((fw) => {
              const list = grouped[fw];
              const pk = packs[FW_PACK_KEY[fw]];
              const clr = FRAMEWORK_CLR[fw] || 'var(--muted)';
              return (
              <div key={fw} style={{ marginBottom: 22 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 12px', flexWrap: 'wrap' }}>
                  <span style={{ width: 4, height: 15, borderRadius: 2, background: clr }} />
                  <b style={{ fontSize: 13.5 }}>{fw}</b>
                  <span className="muted" style={{ fontSize: 12 }}>{list.length} report{list.length === 1 ? '' : 's'}</span>
                  {pk && <span className="muted" style={{ fontSize: 11 }}>· pack v{pk.revision} · eff {pk.effective_date}{pk.validated_by ? ` · ✓ ${pk.validated_by}` : ''}</span>}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                    <button className="btn-secondary btn-sm" disabled={binderFw === fw} onClick={() => downloadBinder(fw)}>{binderFw === fw ? 'Generating…' : '⤓ Audit binder'}</button>
                    <button className="btn-secondary btn-sm" onClick={() => openChangelog(fw)}>Pack changelog</button>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
                  {list.map((it) => {
                    const total = Object.values(it.runs).reduce((a, b) => a + b, 0);
                    const others = (it.frameworks || []).filter((f) => f !== fw);
                    return (
                      <div key={it.id + '|' + fw} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '14px 15px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                          <b style={{ fontSize: 13.3, lineHeight: 1.3 }}>{it.name}</b>
                          <span style={{ flex: 'none', fontFamily: 'var(--mono, monospace)', fontSize: 10, fontWeight: 700, color: clr, border: `1px solid ${clr}`, borderRadius: 5, padding: '2px 6px', whiteSpace: 'nowrap' }}>{citationFor(it, fw)}</span>
                        </div>
                        <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>{it.description}</div>
                        {others.length > 0 && <div className="muted" style={{ fontSize: 10.5 }}>also satisfies: {others.join(' · ')}</div>}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
                          <span className="muted" style={{ fontSize: 11.5 }}>
                            {it.runs.open ? <span style={{ color: 'var(--amber)' }}>{it.runs.open} open</span> : (total ? `${total} run${total === 1 ? '' : 's'}` : 'never run')}
                          </span>
                          <button className="btn-primary btn-sm" disabled={running === it.id} onClick={() => run(it.id)}>
                            {running === it.id ? 'Sealing…' : 'Generate evidence'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              );
            })}
            {!items.length && <div className="muted" style={{ fontSize: 12.5, padding: 12 }}>Loading catalog…</div>}
          </div>
        </div>
      )}

      {tab === 'evidence' && (
        <div className="card">
          <div className="card-header"><span className="card-title">Evidence records</span></div>
          <div className="card-body" style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ minWidth: 820 }}>
              <thead>
                <tr>
                  <th>Report</th><th>Control</th><th>Period</th><th style={{ textAlign: 'right' }}>Events</th>
                  <th>Status</th><th>Reviewer</th><th>Generated</th><th></th>
                </tr>
              </thead>
              <tbody>
                {evidence.map((e) => (
                  <tr key={e.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(e.id)}>
                    <td><b style={{ fontSize: 12.8 }}>{e.report_name}</b><div className="muted" style={{ fontSize: 11 }}>{e.framework}</div></td>
                    <td style={{ fontFamily: 'var(--mono, monospace)', fontSize: 11 }}>{e.control}</td>
                    <td className="muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{fmt(e.period_from).split(',')[0]} → {fmt(e.period_to).split(',')[0]}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 650 }}>{e.row_total}</td>
                    <td><StatusPill s={e.status} /></td>
                    <td className="muted" style={{ fontSize: 11.5 }}>{e.reviewer || '—'}</td>
                    <td className="muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{fmt(e.generated_at)}</td>
                    <td style={{ textAlign: 'right' }}><button className="btn-secondary btn-sm" onClick={(ev2) => { ev2.stopPropagation(); openDetail(e.id); }}>Review</button></td>
                  </tr>
                ))}
                {!evidence.length && <tr><td colSpan={8} className="muted" style={{ fontSize: 12.5, padding: 14 }}>No evidence yet — generate a report from the catalog.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.report_name || 'Evidence'} width={860}>
        {detail && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, fontSize: 12.5 }}>
              <span><span className="muted">Control</span><br /><b style={{ fontFamily: 'var(--mono, monospace)' }}>{detail.control}</b></span>
              <span><span className="muted">Period</span><br /><b>{fmt(detail.period_from)} → {fmt(detail.period_to)}</b></span>
              <span><span className="muted">Events</span><br /><b>{detail.row_total}{detail.row_returned < detail.row_total ? ` (showing ${detail.row_returned})` : ''}</b></span>
              <span><span className="muted">Status</span><br /><StatusPill s={detail.status} /></span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 11px', borderRadius: 8, background: detail.content_ok ? 'var(--green-soft)' : 'var(--danger-soft)', border: `1px solid ${detail.content_ok ? 'var(--green)' : 'var(--danger)'}`, fontSize: 11.8 }}>
              <span style={{ color: detail.content_ok ? 'var(--green)' : 'var(--danger)' }}>{detail.content_ok ? '⛓ Seal intact' : '⚠ Seal broken'}</span>
              <code style={{ fontFamily: 'var(--mono, monospace)', color: 'var(--muted)', fontSize: 10.5 }}>sha256:{String(detail.content_hash).slice(0, 24)}…</code>
              <button className="btn-secondary btn-sm" style={{ marginLeft: 'auto' }} onClick={exportRows}>Export CSV</button>
              <button className="btn-primary btn-sm" onClick={downloadPdf}>⤓ Signed PDF</button>
            </div>

            <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
              <table className="data-table" style={{ minWidth: 760, fontSize: 11.6 }}>
                <thead><tr><th>Time</th><th>Principal</th><th>Database</th><th>Object</th><th>Op</th><th style={{ textAlign: 'right' }}>Rows</th><th>Tags</th></tr></thead>
                <tbody>
                  {detailRows.slice(0, 200).map((r, i) => (
                    <tr key={i}>
                      <td style={{ whiteSpace: 'nowrap' }} className="muted">{fmt(r.ts)}</td>
                      <td>{r.principal}</td><td>{r.database_name}</td><td>{r.object}</td><td>{r.operation}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.rows}</td>
                      <td className="muted">{r.tags}</td>
                    </tr>
                  ))}
                  {!detailRows.length && <tr><td colSpan={7} className="muted" style={{ padding: 12 }}>No matching events in this window — a clean control period.</td></tr>}
                </tbody>
              </table>
            </div>

            {detail.reviewer && (
              <div className="muted" style={{ fontSize: 12, borderLeft: '3px solid var(--line)', paddingLeft: 10 }}>
                Signed off <b>{detail.status}</b> by <b>{detail.reviewer}</b> on {fmt(detail.reviewed_at)}
                {detail.reviewer_note ? <> — “{detail.reviewer_note}”</> : null}
              </div>
            )}

            {canAttest ? (
              <div style={{ borderTop: '1px solid var(--line)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <b style={{ fontSize: 13 }}>Reviewer sign-off</b>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {[['attested', 'Attest — reviewed & compliant'], ['exception', 'Flag exception'], ['escalated', 'Escalate']].map(([v, l]) => (
                    <button key={v} className={decision === v ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'} onClick={() => setDecision(v)}>{l}</button>
                  ))}
                </div>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                  placeholder={decision === 'attested' ? 'Optional reviewer note…' : 'Required: describe the exception / escalation…'}
                  style={{ width: '100%', resize: 'vertical', fontSize: 12.5, padding: 9, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink)' }} />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                  <button className="btn-secondary" onClick={() => setDetail(null)}>Close</button>
                  <button className="btn-primary" disabled={busy} onClick={attest}>{busy ? 'Signing…' : 'Sign off & seal'}</button>
                </div>
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
                Sign-off is restricted to Compliance, Auditor, and Admin roles.
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal open={!!changelog} onClose={() => setChangelog(null)} title={changelog ? `${changelog.fw} — pack changelog` : 'Changelog'} width={640}>
        {changelog && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {changelog.revisions.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>No revision history.</div>}
            {changelog.revisions.map((r, i) => (
              <div key={i} style={{ borderLeft: `3px solid ${i === 0 ? 'var(--green)' : 'var(--line)'}`, paddingLeft: 12 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 13 }}>v{r.revision}</b>
                  <span className="muted" style={{ fontSize: 11.5 }}>effective {String(r.effective_date || '').slice(0, 10)}</span>
                  <span className="muted" style={{ fontSize: 11.5 }}>· by {r.published_by}</span>
                  <span className="muted" style={{ fontSize: 11.5 }}>· {fmt(r.published_at)}</span>
                </div>
                <div style={{ fontSize: 12.3, marginTop: 3 }}>{r.changelog}</div>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </Layout>
  );
}
