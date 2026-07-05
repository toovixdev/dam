import { useState, useRef, useEffect } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import { useAuth } from '../context/AuthContext';
import { apiFetch, apiPost } from '../api/client';
import { ConfigModal } from './Copilot';

// Light markdown-ish renderer (bold, code, bullet lines, line breaks).
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
  'Explain SQL injection in simple terms.',
  'Draft an email announcing a scheduled maintenance window.',
  'What’s the difference between GDPR and CCPA?',
  'Give me a checklist for hardening a Postgres database.',
];

export default function Assistant() {
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
      const res = await apiPost('/assistant/chat', { messages: next, grounded: false });
      if (res.ok && res.data?.reply) setMessages([...next, { role: 'assistant', content: res.data.reply }]);
      else setMessages([...next, { role: 'assistant', content: '⚠️ ' + (res.data?.error || 'Something went wrong.') }]);
    } catch { setMessages([...next, { role: 'assistant', content: '⚠️ Unable to reach the server.' }]); }
    finally { setSending(false); }
  }

  const ready = status?.ready;

  return (
    <Layout>
      <PageHeader title="AI Assistant" meta={['General-purpose chat', ready ? `${status.provider} · ${status.model}` : 'not configured']}>
        {isAdmin && <button className="btn-secondary" onClick={() => setShowConfig(true)}>⚙ Configure</button>}
      </PageHeader>

      {status && !ready && (
        <div className="card" style={{ maxWidth: 620 }}>
          <div className="card-body">
            <h3 style={{ margin: '0 0 6px' }}>AI Assistant isn’t set up yet</h3>
            <p className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
              {isAdmin
                ? 'Connect your own Anthropic (Claude) or OpenAI account to enable a general-purpose AI assistant for this workspace.'
                : 'Ask a workspace admin to connect an AI provider (Anthropic or OpenAI) to enable the Assistant.'}
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
                <div style={{ fontSize: 30, marginBottom: 6 }}>✧</div>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>Ask me anything</div>
                <p className="muted" style={{ fontSize: 12.5, marginBottom: 16 }}>A general-purpose assistant powered by your workspace’s Claude / OpenAI account.</p>
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
            {sending && <div style={{ alignSelf: 'flex-start', color: 'var(--muted)', fontSize: 12.5, padding: '4px 8px' }}>Assistant is thinking…</div>}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); send(); }} style={{ display: 'flex', gap: 10, padding: '12px 16px', borderTop: '1px solid var(--line)' }}>
            <input value={input} onChange={e => setInput(e.target.value)} placeholder="Send a message…" disabled={sending}
              style={{ flex: 1, padding: '10px 14px', borderRadius: 10, border: '1px solid var(--line)', fontSize: 13.5, background: 'var(--surface)', color: 'var(--ink)' }} />
            <button type="submit" className="btn-primary" disabled={sending || !input.trim()}>Send</button>
          </form>
        </div>
      )}

      {showConfig && <ConfigModal onClose={() => setShowConfig(false)} onSaved={() => { setShowConfig(false); apiFetch('/assistant/status').then(setStatus); }} />}
    </Layout>
  );
}
