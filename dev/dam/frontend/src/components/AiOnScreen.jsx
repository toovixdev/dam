import { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { apiFetch, apiPost } from '../api/client';

// Per-screen suggested questions (ported from the mockups). The insight itself is
// generated live from the tenant's real data — these are just quick prompts.
const SCREEN_AI = {
  '/dashboard':      { label: 'Dashboard',         asks: ['What are my top risks right now?', 'Summarize today’s critical alerts'] },
  '/active-defense': { label: 'Active Defense',    asks: ['Summarize tonight’s critical alerts', 'What triggered the latest decoy hit?'] },
  '/databases':      { label: 'Databases',         asks: ['Which databases are unmonitored?', 'Which databases hold sensitive data?'] },
  '/discovery':      { label: 'Discovery',         asks: ['Which discovered databases should I prioritise?'] },
  '/agents':         { label: 'Agents & Coverage', asks: ['Which agents are offline?', 'Where are my coverage gaps?'] },
  '/alerts':         { label: 'Alerts',            asks: ['Summarize today’s critical alerts', 'Which principal is riskiest right now?'] },
  '/policies':       { label: 'Policies & Rules',  asks: ['Which rules look noisy?', 'What should I enable?'] },
  '/quarantine':     { label: 'Quarantine',        asks: ['Which held account should I review first?', 'Why was this account quarantined?'] },
  '/classification': { label: 'Classification',    asks: ['Which sensitive columns are unmasked?', 'What’s my classification coverage?'] },
  '/masking':        { label: 'Masking',           asks: ['Which sensitive columns are unmasked?'] },
  '/access':         { label: 'Access Governance', asks: ['Which accounts are over-privileged?', 'Any dormant accounts to disable?'] },
  '/compliance':     { label: 'Compliance Center', asks: ['What’s blocking GDPR green?', 'Which controls have gaps?'] },
  '/dsar':           { label: 'DSAR Manager',      asks: ['Any DSARs approaching their deadline?'] },
  '/audit':          { label: 'Audit Trail',       asks: ['Any unusual privileged activity recently?'] },
  '/reports':        { label: 'Reports',           asks: ['What should this month’s compliance report highlight?'] },
  '/llm':            { label: 'LLM Monitoring',    asks: ['Any prompts leaking sensitive data?'] },
  '/billing':        { label: 'Billing & Usage',   asks: ['Am I close to any plan limits?'] },
  '/integrations':   { label: 'Integrations',      asks: ['Which alert channels are configured?'] },
  '/users':          { label: 'Users & Roles',     asks: ['Any over-privileged users?'] },
};
const DEFAULT_ASKS = ['What are my top security risks right now?', 'Summarize today’s critical alerts'];

const insightCache = {}; // { [screenKey]: insightText } — one generation per screen per session
let statusCache = null;   // { ready } — assistant configured?

export default function AiOnScreen() {
  const location = useLocation();
  const navigate = useNavigate();
  const path = location.pathname;

  // Match the screen (handles sub-routes like /alerts/:id → /alerts).
  const key = Object.keys(SCREEN_AI).find((k) => path === k || path.startsWith(k + '/'));
  const screen = key ? SCREEN_AI[key] : null;
  const label = screen?.label || 'this screen';
  const asks = screen?.asks || DEFAULT_ASKS;

  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(statusCache);
  const [insight, setInsight] = useState(key ? insightCache[key] : null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { setInsight(key ? insightCache[key] || null : null); }, [key]);

  useEffect(() => {
    if (statusCache) return;
    apiFetch('/assistant/status').then((d) => { statusCache = d || { ready: false }; setStatus(statusCache); }).catch(() => { statusCache = { ready: false }; setStatus(statusCache); });
  }, []);

  const genInsight = async (force) => {
    if (!status?.ready || loading) return;
    if (insightCache[key] && !force) { setInsight(insightCache[key]); return; }
    setLoading(true);
    const res = await apiPost('/assistant/screen-insight', { screen: label });
    setLoading(false);
    if (res?.ok && res.data?.insight) { insightCache[key] = res.data.insight; setInsight(res.data.insight); }
    else setInsight('⚠️ ' + (res?.data?.error || 'Could not generate an insight.'));
  };

  const openPanel = () => { setOpen(true); if (status?.ready && !insightCache[key]) genInsight(); };
  const ask = (q) => navigate('/copilot', { state: { ask: q } });

  // Don't show the widget on the Copilot screen itself (redundant).
  if (path.startsWith('/copilot')) return null;

  return (
    <>
      {open && (
        <div style={{ position: 'fixed', right: 20, bottom: 78, width: 340, maxWidth: 'calc(100vw - 40px)', zIndex: 120,
          background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14, boxShadow: '0 12px 40px rgba(15,23,42,.18)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid var(--line)', background: 'var(--primary-soft)' }}>
            <span style={{ color: 'var(--primary)', fontSize: 16 }}>✦</span>
            <b style={{ fontSize: 13.5, color: 'var(--ink)' }}>AI on {label}</b>
            <button onClick={() => setOpen(false)} style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 16 }}>✕</button>
          </div>
          <div style={{ padding: '14px' }}>
            {!status?.ready ? (
              <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, margin: 0 }}>
                Connect an AI provider (Copilot → <b>⚙ Configure</b>) to get a live insight for this screen. You can still ask a question below.
              </p>
            ) : loading ? (
              <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Analyzing this screen…</p>
            ) : insight ? (
              <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--ink)' }}>{String(insight).replace(/\*\*(.+?)\*\*/g, '$1').replace(/[*_`]/g, '')}</div>
            ) : (
              <button className="btn-secondary" style={{ fontSize: 12.5 }} onClick={() => genInsight()}>✦ Get insight for this screen</button>
            )}
            {status?.ready && insight && (
              <button onClick={() => genInsight(true)} style={{ marginTop: 8, border: 'none', background: 'none', cursor: 'pointer', color: 'var(--primary)', fontSize: 11.5, padding: 0 }}>↻ Refresh</button>
            )}

            <div style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>Ask the Copilot</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {asks.map((q) => (
                  <button key={q} className="btn-secondary" style={{ textAlign: 'left', fontSize: 12.5 }} onClick={() => ask(q)}>{q}</button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <button onClick={() => (open ? setOpen(false) : openPanel())} title="AI on this screen"
        style={{ position: 'fixed', right: 20, bottom: 20, zIndex: 120, display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '11px 16px', borderRadius: 24, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700, fontSize: 13,
          color: '#fff', background: 'linear-gradient(135deg, var(--primary, #6366f1), #8b5cf6)', boxShadow: '0 6px 20px rgba(99,102,241,.4)' }}>
        <span style={{ fontSize: 15 }}>✦</span> AI on this screen
      </button>
    </>
  );
}
