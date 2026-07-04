import { useState, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import TabNav from '../components/shared/TabNav';
import useApiData from '../hooks/useApiData';
import { apiPost } from '../api/client';
import { toast } from '../components/shared/Toast';
import { exportCsv } from '../exportCsv';

const scoreColor = (s) => (s >= 90 ? 'var(--green)' : s >= 80 ? 'var(--amber)' : 'var(--danger)');

function Ring({ score, size = 64 }) {
  const col = scoreColor(score);
  const inner = size - 16;
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: `conic-gradient(${col} ${score * 3.6}deg, var(--line) 0)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
      <div style={{ width: inner, height: inner, borderRadius: '50%', background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: size > 80 ? 22 : 14, color: col }}>{score}%</div>
    </div>
  );
}

export default function Compliance() {
  const navigate = useNavigate();
  const { data: fwData, loading, refetch: refetchFw } = useApiData('/compliance/frameworks');
  const { data: saData } = useApiData('/compliance/sensitive-access');
  const { data: maskData, refetch: refetchMask } = useApiData('/compliance/masking');
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [tab, setTab] = useState('controls');
  const [selected, setSelected] = useState(null);
  const [expanded, setExpanded] = useState(null);

  const goEvidence = (link) => {
    if (!link) return;
    if (link.to.startsWith('tab:')) setTab(link.to.slice(4));
    else navigate(link.to);
  };

  const frameworks = Array.isArray(fwData) ? fwData : [];
  const cur = frameworks.find((f) => f.key === selected) || frameworks[0];
  const sensitive = Array.isArray(saData) ? saData : [];
  const masking = maskData || { sensitive: 0, masked: 0, pct: 100, unmasked: [] };

  const handleRefresh = () => { refetchFw(); refetchMask(); setLastRefresh(new Date()); };

  const maskColumn = async (id) => {
    const res = await apiPost(`/classification/columns/${id}/mask`, { masked: true });
    if (res && res.ok) { toast('Dynamic mask applied', 'ok'); refetchMask(); refetchFw(); }
    else toast('Could not apply mask', 'err');
  };
  const exportEvidence = () => {
    if (!cur) return;
    exportCsv(`toovix-${cur.key}-controls.csv`, ['Status', 'Control', 'Reference'], cur.controls.map((c) => [c.status, c.control, c.reference]));
    toast('Evidence pack exported', 'ok');
  };

  if (loading) {
    return <Layout activePage="compliance"><div className="loading-screen"><div className="loading-spinner" /><p>Loading compliance…</p></div></Layout>;
  }

  return (
    <Layout activePage="compliance" lastRefresh={lastRefresh} onRefresh={handleRefresh}>
      <PageHeader title="Compliance Center" meta={['continuous control validation', 'data residency: multi-region']}>
        <button className="btn-secondary" onClick={exportEvidence}>⤓ Evidence pack</button>
        <button className="btn-primary" onClick={() => navigate('/reports')}>📄 Generate report</button>
      </PageHeader>

      <div className="fwk-grid">
        {frameworks.map((f) => (
          <button key={f.key} className={`card fwk-card ${cur && f.key === cur.key ? 'on' : ''}`} onClick={() => setSelected(f.key)}>
            <Ring score={f.score} />
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: 700, fontSize: 13.5 }}>{f.name}</div>
              <span className={`badge ${f.score >= 90 ? 'green' : 'amber'} dot`} style={{ marginTop: 4 }}>{f.status}</span>
            </div>
          </button>
        ))}
      </div>

      <TabNav tabs={[{ id: 'controls', label: 'Controls' }, { id: 'sensitive', label: 'Sensitive access' }, { id: 'masking', label: 'Masking coverage' }]} active={tab} onChange={setTab} />

      {tab === 'controls' && cur && (
        <div className="card">
          <div className="card-header"><span className="card-title">{cur.name} — control status</span><span className="card-sub" style={{ color: scoreColor(cur.score), fontWeight: 700 }}>{cur.score}%</span></div>
          <div className="card-body no-pad">
            <table className="data-table">
              <thead><tr><th>Status</th><th>Control</th><th>Reference</th><th>Evidence</th></tr></thead>
              <tbody>
                {cur.controls.map((c, i) => (
                  <Fragment key={i}>
                    <tr style={{ cursor: c.evidence ? 'pointer' : 'default' }} onClick={() => c.evidence && setExpanded(expanded === i ? null : i)}>
                      <td><span className={`badge ${c.status === 'ok' ? 'green' : 'amber'} dot`}>{c.status === 'ok' ? 'pass' : 'gap'}</span></td>
                      <td>{c.control}</td>
                      <td className="mono" style={{ fontSize: 12 }}>{c.reference}</td>
                      <td>{c.evidence ? <span className="card-link">{expanded === i ? 'Hide ▴' : 'View ▾'}</span> : <span className="muted">—</span>}</td>
                    </tr>
                    {expanded === i && c.evidence && (
                      <tr>
                        <td colSpan={4} style={{ background: 'var(--surface-2)' }}>
                          <div style={{ padding: '4px 6px 10px' }}>
                            <div style={{ fontSize: 13, marginBottom: c.evidence.items && c.evidence.items.length ? 8 : 0 }}>{c.evidence.summary}</div>
                            {c.evidence.items && c.evidence.items.length > 0 && (
                              <ul className="mono" style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 12, color: 'var(--muted)' }}>
                                {c.evidence.items.map((it, k) => <li key={k}>{it}</li>)}
                              </ul>
                            )}
                            {c.evidence.link && (
                              <button className="btn-secondary" style={{ padding: '4px 12px', fontSize: 12 }} onClick={(e) => { e.stopPropagation(); goEvidence(c.evidence.link); }}>{c.evidence.link.label} →</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'sensitive' && (
        <div className="card">
          <div className="card-header"><span className="card-title">Sensitive-data access · this quarter</span><span className="card-sub">7-year retention · compliance evidence</span></div>
          <div className="card-body no-pad">
            <table className="data-table">
              <thead><tr><th>Tag</th><th>Principal</th><th>Database</th><th className="num">Accesses</th><th className="num">Rows</th><th>Status</th></tr></thead>
              <tbody>
                {sensitive.map((s, i) => (
                  <tr key={i}>
                    <td><span className={`badge ${s.tag === 'pci' ? 'amber' : 'red'}`}>{s.tag}</span></td>
                    <td>{s.principal}</td><td>{s.database_name}</td>
                    <td className="num">{Number(s.accesses).toLocaleString()}</td>
                    <td className="num">{Number(s.rows).toLocaleString()}</td>
                    <td><span className={`badge ${Number(s.rows) > 10000 ? 'amber' : 'green'} dot`}>{Number(s.rows) > 10000 ? 'high volume' : 'logged'}</span></td>
                  </tr>
                ))}
                {sensitive.length === 0 && <tr><td colSpan={6} className="chart-empty">No sensitive-data access recorded this quarter</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'masking' && (
        <div className="grid2">
          <div className="card">
            <div className="card-header"><span className="card-title">Masking coverage</span></div>
            <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
              <Ring score={masking.pct} size={96} />
              <div style={{ fontSize: 13 }}>
                <div><b>{masking.masked}</b> of <b>{masking.sensitive}</b> sensitive columns masked</div>
                <div className="muted" style={{ marginTop: 4 }}>{masking.sensitive - masking.masked} exposed</div>
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-header"><span className="card-title">Unmasked sensitive columns</span><span className="card-sub">{masking.unmasked.length} gaps</span></div>
            <div className="card-body no-pad">
              <table className="data-table">
                <thead><tr><th>Column</th><th>Tag</th><th>Sensitivity</th><th /></tr></thead>
                <tbody>
                  {masking.unmasked.map((u) => (
                    <tr key={u.id}>
                      <td className="mono" style={{ fontSize: 12 }}>{u.db}.{u.obj}.{u.col}</td>
                      <td><span className={`badge ${u.tag === 'pci' ? 'amber' : 'red'}`}>{u.tag}</span></td>
                      <td>{u.sensitivity}</td>
                      <td style={{ textAlign: 'right' }}><button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => maskColumn(u.id)}>Mask</button></td>
                    </tr>
                  ))}
                  {masking.unmasked.length === 0 && <tr><td colSpan={4} className="chart-empty">All sensitive columns are masked ✓</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
