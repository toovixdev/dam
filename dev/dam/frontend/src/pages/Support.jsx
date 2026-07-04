import { useState, useRef, useEffect } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/KpiCard';
import Modal from '../components/shared/Modal';
import { useAuth } from '../context/AuthContext';
import { toast } from '../components/shared/Toast';

const AI_RESPONSES = {
  'why are 2 agents offline?': 'I can see 2 agents are offline:\n\n1. **agent-us-214** on ORCL-TRADING-PROD — lost heartbeat 3h ago. Likely cause: the host may have been rebooted or the agent process crashed.\n\n2. **agent-us-307** on PG-CRM-PROD — lost heartbeat 11h ago. A firewall rule change was detected around the same time.\n\n**Suggested actions:**\n- SSH into the host and check `systemctl status toovix-agent`\n- Verify firewall rules on port 443 outbound\n\nWould you like me to create a support ticket for this?',
  'set up cloud push for rds': 'To set up Cloud Push for an AWS RDS database:\n\n**Step 1:** Enable native audit logging (pgaudit for PostgreSQL, SERVER_AUDIT_LOGGING for Aurora MySQL). Logs publish to CloudWatch automatically.\n\n**Step 2:** Create an IAM role `TooVixDAMAuditReader` with read access to CloudWatch Logs and RDS describe.\n\n**Step 3:** Go to Agents & Coverage → Deploy monitoring → Agentless → Cloud Push → select your RDS database.\n\n**Step 4:** Enter your AWS Account ID and IAM Role ARN, then click Validate connection.',
  'what does risk score 91 mean?': 'A risk score of **91/100** is **critical**. It means this database has high sensitivity (PII/PCI/regulated data), high exposure (multiple privileged access patterns), and active threats (recent anomalous alerts).\n\nThe score weights: sensitivity tags (40%), alert history (30%), access patterns (20%), compliance gaps (10%).',
};
const DEFAULT_RESPONSE = 'I understand your question. Based on your TooVix DAM configuration, I\'d recommend checking the relevant documentation section. If that doesn\'t resolve it, I can:\n\n1. **Create a support ticket** — automatically includes your environment context\n2. **Bring in a human engineer** — they join this chat with full history\n\nWhat would you prefer?';

const SUGGESTIONS = [
  { q: 'Why are 2 agents offline?', label: 'Why are 2 agents offline?' },
  { q: 'Set up Cloud Push for RDS', label: 'Set up Cloud Push for RDS' },
  { q: 'What does risk score 91 mean?', label: 'What does risk score 91 mean?' },
];

function renderText(text) {
  const html = text.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
  return { __html: html };
}

export default function Support() {
  const { user } = useAuth();
  const [messages, setMessages] = useState([
    { bot: true, intro: true },
  ]);
  const [input, setInput] = useState('');
  const [tktOpen, setTktOpen] = useState(false);
  const [tktPrefill, setTktPrefill] = useState(null);
  const [submitted, setSubmitted] = useState(null);
  const msgEnd = useRef(null);

  useEffect(() => { msgEnd.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const send = (textArg) => {
    const text = (textArg ?? input).trim();
    if (!text) return;
    setInput('');
    setMessages((prev) => [...prev, { bot: false, text }]);

    setTimeout(() => {
      const key = text.toLowerCase();
      if (key.includes('create a ticket') || key.includes('yes, create')) {
        setMessages((prev) => [...prev, { bot: true, text: 'I\'ve drafted a support ticket based on our conversation. I\'ll open the form so you can review and submit.' }]);
        setTimeout(() => openTicket({ subject: 'Agent offline on ORCL-TRADING-PROD', priority: 'high', category: 'Agent / Connectivity', description: '2 agents offline — agent-us-214 (ORCL-TRADING-PROD) and agent-us-307 (PG-CRM-PROD). Suspected host reboot and firewall rule change.' }), 900);
        return;
      }
      if (key.includes('bring in') || key.includes('engineer')) {
        setMessages((prev) => [...prev, { bot: true, text: 'Bringing in a support engineer with full context of our chat.\n\n**Estimated wait:** < 2 minutes (Enterprise priority queue)' }]);
        setTimeout(() => {
          setMessages((prev) => [...prev, { bot: true, engineer: true, text: 'Hi, I\'m **Ravi S.** from TooVix support. I\'ve reviewed the AI conversation and can see the offline-agent issue. Did your infra team do any maintenance on the 10.20.14.x subnet recently?' }]);
          toast('Ravi S. (Support Engineer) joined the chat', 'ok');
        }, 1600);
        return;
      }
      const response = AI_RESPONSES[key] || DEFAULT_RESPONSE;
      const offerTicket = response.includes('create a support ticket') || response.includes('human engineer');
      setMessages((prev) => [...prev, { bot: true, text: response, offerTicket }]);
    }, 700);
  };

  const openTicket = (prefill) => { setTktPrefill(prefill || {}); setSubmitted(null); setTktOpen(true); };

  return (
    <Layout>
      <PageHeader title="Support Center" meta={[user?.tenantName || 'Meridian Financial', 'Enterprise plan', 'Priority support']}>
        <button className="btn-primary" onClick={() => openTicket(null)}>＋ Create ticket</button>
      </PageHeader>

      <section className="kpi-grid" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
        <KpiCard icon="✓" iconBg="var(--green-soft)" iconColor="var(--green)" label="Open tickets" value={2} detail="1 high · 1 medium" />
        <KpiCard icon="⏱" label="Avg response" value="18 min" detail="SLA: 1 hour" detailType="up" />
        <KpiCard icon="◉" iconBg="var(--info-soft)" iconColor="var(--info)" label="Resolved (30d)" value={14} detail="100% within SLA" detailType="up" />
      </section>

      <div className="grid3" style={{ marginBottom: 14 }}>
        <div className="qa-card" onClick={() => document.getElementById('chatInput')?.focus()}>
          <div className="qa-icon">✦</div><div className="qa-title">Ask AI Assistant</div><div className="qa-desc">Get instant answers from TooVix AI</div>
        </div>
        <div className="qa-card" onClick={() => openTicket(null)}>
          <div className="qa-icon">⚑</div><div className="qa-title">Create Ticket</div><div className="qa-desc">Open a support request</div>
        </div>
        <div className="qa-card" onClick={() => toast('Opening TooVix DAM documentation', 'ok')}>
          <div className="qa-icon">📄</div><div className="qa-title">Documentation</div><div className="qa-desc">Product guides &amp; API docs</div>
        </div>
      </div>

      <div className="grid2" style={{ alignItems: 'start' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>✦ TooVix AI Assistant</div>
          <div className="chat-container">
            <div className="chat-header">
              <span className="ch-dot" />
              <div style={{ flex: 1 }}><b>TooVix Support</b><br /><span style={{ fontSize: 11, opacity: .7 }}>AI-powered — hands off to a human engineer when needed</span></div>
            </div>
            <div className="chat-messages">
              {messages.map((m, i) => {
                if (m.intro) {
                  return (
                    <div className="chat-msg bot" key={i}>
                      Hi! I&apos;m TooVix AI Assistant. I can help with troubleshooting agents, understanding alerts &amp; policies, product questions, and configuration.
                      <div className="chat-suggestions">
                        {SUGGESTIONS.map((s) => <span className="chat-sug" key={s.q} onClick={() => send(s.q)}>{s.label}</span>)}
                      </div>
                      <div className="msg-meta">TooVix AI · just now</div>
                    </div>
                  );
                }
                return (
                  <div className={`chat-msg ${m.bot ? 'bot' : 'user'}`} key={i}>
                    <span dangerouslySetInnerHTML={renderText(m.text)} />
                    {m.offerTicket && (
                      <div className="chat-suggestions" style={{ marginTop: 8 }}>
                        <span className="chat-sug" onClick={() => send('Yes, create a ticket')}>Create ticket</span>
                        <span className="chat-sug" onClick={() => send('Bring in an engineer')}>Bring in engineer</span>
                      </div>
                    )}
                    <div className="msg-meta">{m.engineer ? 'Ravi S. (Support Engineer)' : m.bot ? 'TooVix AI' : 'You'} · just now</div>
                  </div>
                );
              })}
              <div ref={msgEnd} />
            </div>
            <div className="chat-input">
              <input id="chatInput" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder="Ask a question..." />
              <button onClick={() => send()}>Send</button>
            </div>
          </div>
        </div>

        <div>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>⚑ Your Tickets</div>
          <div className="card" style={{ marginBottom: 10 }}>
            <div className="card-header"><span className="card-title">Open</span><span className="card-sub">2 tickets</span></div>
            <div className="card-body no-pad">
              <div className="tkt-card">
                <span className="badge amber" style={{ flex: 'none' }}>High</span>
                <div style={{ flex: 1 }}><b>Agent offline on ORCL-TRADING-PROD</b><br /><small className="muted">TKT-4821 · Opened 3h ago · Ravi S.</small></div>
                <span className="badge amber">In progress</span>
              </div>
              <div className="tkt-card">
                <span className="badge" style={{ flex: 'none' }}>Medium</span>
                <div style={{ flex: 1 }}><b>Classification scan not completing on PG-CRM</b><br /><small className="muted">TKT-4818 · Opened 1d ago · Maria L.</small></div>
                <span className="badge blue">Investigating</span>
              </div>
            </div>
          </div>
          <div className="card" style={{ marginBottom: 10 }}>
            <div className="card-header"><span className="card-title">Recently Resolved</span><span className="card-sub">last 30 days</span></div>
            <div className="card-body no-pad">
              {[['Alert notification delay on Slack', 'TKT-4812 · Resolved 3d ago · 4h to resolve'], ['DSAR export failing for GDPR request', 'TKT-4798 · Resolved 8d ago · 2h to resolve'], ['Custom compliance report formatting', 'TKT-4785 · Resolved 14d ago · 1d to resolve']].map(([t, s]) => (
                <div className="tkt-card" key={t}>
                  <span className="badge green" style={{ flex: 'none' }}>Resolved</span>
                  <div style={{ flex: 1 }}><b>{t}</b><br /><small className="muted">{s}</small></div>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="card-header"><span className="card-title">Contact Support</span></div>
            <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>
              <div>✉ <b>Email</b> — <span className="muted">support@toovix.security · 1 hour SLA</span></div>
              <div>📞 <b>Phone</b> — <span className="muted">+1 (888) 866-8495 · 24/7 for P1/P2</span></div>
              <div>💬 <b>Slack</b> — <span className="muted">#toovix-support shared channel</span></div>
              <div>◉ <b>CSM</b> — <span className="muted">Jessica Park · j.park@toovix.security</span></div>
            </div>
          </div>
        </div>
      </div>

      <Modal open={tktOpen} onClose={() => setTktOpen(false)} title={submitted ? 'Ticket Submitted' : 'Create Support Ticket'} width={680}>
        {submitted ? (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, background: 'var(--green-soft)', color: 'var(--green)', marginBottom: 12 }}>✓</div>
            <h3 style={{ margin: '0 0 4px', fontSize: 18 }}>Ticket created</h3>
            <p className="muted" style={{ fontSize: 13.5, maxWidth: 420, display: 'inline-block' }}><b>{submitted}</b> has been created. Our support team will respond within your SLA window (1 hour for Enterprise).</p>
            <div style={{ marginTop: 16 }}><button className="btn-secondary" onClick={() => setTktOpen(false)}>Close</button></div>
          </div>
        ) : (
          <TicketForm prefill={tktPrefill} onCancel={() => setTktOpen(false)} onSubmit={(subject) => {
            if (!subject) { toast('Subject is required', 'err'); return; }
            const id = 'TKT-' + Math.floor(4800 + Math.random() * 200);
            setSubmitted(id);
            toast(`Ticket ${id} created — support team notified`, 'ok');
          }} />
        )}
      </Modal>
    </Layout>
  );
}

function TicketForm({ prefill, onCancel, onSubmit }) {
  const [subject, setSubject] = useState(prefill?.subject || '');
  const [category, setCategory] = useState(prefill?.category || '');
  const [priority, setPriority] = useState(prefill?.priority || 'medium');
  const [description, setDescription] = useState(prefill?.description || '');

  return (
    <>
      {prefill?.subject && (
        <div style={{ background: 'var(--primary-soft)', border: '1px solid var(--primary-soft)', borderRadius: 10, padding: '10px 14px', marginBottom: 16, fontSize: 12.5 }}>
          <b style={{ color: 'var(--primary)' }}>✦ Pre-filled by AI Assistant</b> — review and edit before submitting.
        </div>
      )}
      <div className="form-row">
        <div className="form-field"><label>Subject *</label><input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Brief description of the issue" /></div>
        <div className="form-field"><label>Category</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Select category…</option><option>Agent / Connectivity</option><option>Alert Rules / Policies</option><option>Classification / Discovery</option><option>Compliance / Reports</option><option>Performance / Latency</option><option>Integration (SIEM / ITSM)</option><option>Billing / Account</option><option>Feature Request</option><option>Other</option>
          </select>
        </div>
      </div>
      <div className="form-row">
        <div className="form-field"><label>Priority</label>
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="critical">P1 — Critical (system down)</option><option value="high">P2 — High (major feature impacted)</option><option value="medium">P3 — Medium (non-critical)</option><option value="low">P4 — Low (question / enhancement)</option>
          </select>
        </div>
        <div className="form-field"><label>Affected database(s)</label>
          <select><option>All / General</option><option>ORCL-TRADING-PROD</option><option>PG-CRM-PROD</option><option>MYSQL-PAYMENTS-PROD</option><option>MONGO-PROFILES-UK</option></select>
        </div>
      </div>
      <div className="form-field"><label>Description *</label><textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe the issue in detail. Include error messages, timestamps, and steps to reproduce." style={{ resize: 'vertical' }} /></div>
      <div style={{ background: 'var(--info-soft)', borderRadius: 10, padding: '12px 14px', margin: '14px 0', fontSize: 12.5, lineHeight: 1.5 }}>
        <b style={{ color: 'var(--info)' }}>Attached automatically:</b> tenant ID, platform version, browser info, and recent error logs from the affected component. No audit data or sensitive query content is shared.
      </div>
      <div className="modal-footer" style={{ padding: '14px 0 0', justifyContent: 'flex-end' }}>
        <button className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" onClick={() => onSubmit(subject)}>Submit ticket</button>
      </div>
    </>
  );
}
