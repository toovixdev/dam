import { useState, useRef, useEffect } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import { useAuth } from '../context/AuthContext';
import { apiFetch, apiPost, apiPut } from '../api/client';
import { toast } from '../components/shared/Toast';

// Very small markdown-ish renderer (bold, code, bullet lines, line breaks).
function renderText(t) {
  return String(t || '').split('\n').map((line, i) => {
    const bullet = /^\s*[-*]\s+/.test(line);
    const html = line
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^\s*[-*]\s+/, '');
    return <div key={i} style={bullet ? { paddingLeft: 16, position: 'relative' } : undefined}>
      {bullet && <span style={{ position: 'absolute', left: 2 }}>•</span>}
      <span dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }} />
    </div>;
  });
}

const SUGGESTIONS = [
  'What are my top security risks right now?',
  'Summarize today’s critical alerts.',
  'Which databases have sensitive data exposure?',
  'Are any accounts quarantined, and why?',
];

export default function Copilot() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'tenant_admin';
  const [status, setStatus] = useState(null); // { ready, provider, model }
  const [messages, setMessages] = useState([]); // {role, content}
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => { apiFetch('/assistant/status').then(setStatus).catch(() => setStatus({ ready: false })); }, []);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [messages, sending]);

  async function send(text) {
    const content = (text ?? input).trim();
    if (!content || sending) return;
    const next = [...messages, { role: 'user', content }];
    setMessages(next); setInput(''); setSending(true);
    try {
      const res = await apiPost('/assistant/chat', { messages: next });
      if (res.ok && res.data?.reply) setMessages([...next, { role: 'assistant', content: res.data.reply }]);
      else setMessages([...next, { role: 'assistant', content: '⚠️ ' + (res.data?.error || 'Something went wrong.') }]);
    } catch { setMessages([...next, { role: 'assistant', content: '⚠️ Unable to reach the server.' }]); }
    finally { setSending(false); }
  }

  const ready = status?.ready;

  return (
    <Layout>
      <PageHeader title="Copilot" meta={['AI security assistant', ready ? `${status.provider} · ${status.model}` : 'not configured']}>
        {isAdmin && <button className="btn-secondary" onClick={() => setShowConfig(true)}>⚙ Configure</button>}
      </PageHeader>

      {status && !ready && (
        <div className="card" style={{ maxWidth: 620 }}>
          <div className="card-body">
            <h3 style={{ margin: '0 0 6px' }}>AI Copilot isn’t set up yet</h3>
            <p className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
              {isAdmin
                ? 'Connect your own Anthropic (Claude) or OpenAI account to enable a security assistant grounded in this workspace’s data.'
                : 'Ask a workspace admin to connect an AI provider (Anthropic or OpenAI) to enable the Copilot.'}
            </p>
            {isAdmin && <button className="btn-primary" onClick={() => setShowConfig(true)}>Configure AI provider</button>}
          </div>
        </div>
      )}

      {ready && (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 200px)', minHeight: 440 }}>
          <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {messages.length === 0 && (
              <div style={{ margin: 'auto', textAlign: 'center', maxWidth: 460 }}>
                <div style={{ fontSize: 30, marginBottom: 6 }}>✦</div>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Ask about your database security</div>
                <p className="muted" style={{ fontSize: 12.5, marginBottom: 16 }}>Grounded in this workspace’s live alerts, policies, databases and risk.</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {SUGGESTIONS.map(s => <button key={s} className="btn-secondary" style={{ textAlign: 'left', fontSize: 12.5 }} onClick={() => send(s)}>{s}</button>)}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '80%' }}>
                <div style={{
                  padding: '10px 14px', borderRadius: 12, fontSize: 13.5, lineHeight: 1.55,
                  background: m.role === 'user' ? 'var(--primary, #6366f1)' : 'var(--surface-2, #f1f5f9)',
                  color: m.role === 'user' ? '#fff' : 'var(--ink)',
                }}>{renderText(m.content)}</div>
              </div>
            ))}
            {sending && <div style={{ alignSelf: 'flex-start', color: 'var(--muted)', fontSize: 12.5, padding: '4px 8px' }}>Copilot is thinking…</div>}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); send(); }} style={{ display: 'flex', gap: 10, padding: '12px 16px', borderTop: '1px solid var(--line)' }}>
            <input value={input} onChange={e => setInput(e.target.value)} placeholder="Ask about alerts, risk, policies, PII exposure…" disabled={sending}
              style={{ flex: 1, padding: '10px 14px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13.5, background: 'var(--surface)', color: 'var(--ink)' }} />
            <button type="submit" className="btn-primary" disabled={sending || !input.trim()}>Send</button>
          </form>
        </div>
      )}

      {showConfig && <ConfigModal onClose={() => setShowConfig(false)} onSaved={() => { setShowConfig(false); apiFetch('/assistant/status').then(setStatus); }} />}
    </Layout>
  );
}

export function ConfigModal({ onClose, onSaved }) {
  const [cfg, setCfg] = useState(null);
  const [form, setForm] = useState({ provider: 'anthropic', model: '', apiKey: '', enabled: true });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    apiFetch('/assistant/config').then(d => {
      setCfg(d);
      setForm({ provider: d.provider || 'anthropic', model: d.model || '', apiKey: '', enabled: d.enabled !== false });
    }).catch(() => setCfg({ providers: [] }));
  }, []);
  const providers = cfg?.providers || [{ key: 'anthropic', name: 'Anthropic (Claude)', defaultModel: 'claude-sonnet-4-6' }, { key: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o' }];
  const curProv = providers.find(p => p.key === form.provider);

  async function save() {
    if (!form.apiKey.trim() && !cfg?.keySet) return toast('An API key is required', 'err');
    setBusy(true);
    const res = await apiPut('/assistant/config', { provider: form.provider, model: form.model.trim() || curProv?.defaultModel, apiKey: form.apiKey, enabled: form.enabled });
    setBusy(false);
    if (res.ok) { toast('AI assistant saved', 'ok'); onSaved(); }
    else toast(res.data?.error || 'Save failed', 'err');
  }

  const field = { width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid var(--line)', fontSize: 13.5, marginTop: 4, background: 'var(--surface)', color: 'var(--ink)' };
  return (
    <div className="modal-overlay" onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
      <div className="card" onClick={e => e.stopPropagation()} style={{ width: 480, maxWidth: '92vw' }}>
        <div className="card-body">
          <h3 style={{ margin: '0 0 4px' }}>AI Assistant</h3>
          <p className="muted" style={{ fontSize: 12, margin: '0 0 16px', lineHeight: 1.5 }}>Bring your own LLM account. The key is stored securely for this workspace and never sent to the browser.</p>
          <div className="form-field"><label>Provider</label>
            <select style={field} value={form.provider} onChange={e => setForm(f => ({ ...f, provider: e.target.value, model: '' }))}>
              {providers.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
            </select>
          </div>
          <div className="form-field"><label>Model</label>
            <input style={field} value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} placeholder={curProv?.defaultModel || ''} />
          </div>
          <div className="form-field"><label>API key</label>
            <input style={field} type="password" value={form.apiKey} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))} placeholder={cfg?.keySet ? '•••••••• (unchanged — leave blank to keep)' : (form.provider === 'anthropic' ? 'sk-ant-…' : 'sk-…')} />
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, margin: '10px 0' }}>
            <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} /> Enable the Copilot for this workspace
          </label>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 10, borderTop: '1px solid var(--line)' }}>
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
