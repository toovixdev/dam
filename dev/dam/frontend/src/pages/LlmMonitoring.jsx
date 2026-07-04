import { useState } from 'react';
import Layout from '../components/Layout';
import PageHeader from '../components/shared/PageHeader';
import KpiCard from '../components/KpiCard';
import { toast } from '../components/shared/Toast';

const APPS = [
  { label: 'ChatGPT', value: 1820, color: 'var(--primary)' },
  { label: 'Copilot', value: 980, color: 'var(--info)' },
  { label: 'Azure', value: 740, color: 'var(--green)' },
  { label: 'Bedrock', value: 362, color: 'var(--amber)' },
];

const EVENTS = [
  { user: 'finance.analyst', app: 'ChatGPT', action: 'redacted', cls: 'green', detail: '3 SSN values masked in prompt', when: '2h' },
  { user: 'kyc.ops', app: 'Azure OpenAI', action: 'redacted', cls: 'green', detail: '2 Aadhaar numbers masked in summarize request', when: '3h' },
  { user: 'dev.karan', app: 'Copilot', action: 'blocked', cls: 'red', detail: 'pasted CUSTOMERS export (PII + Aadhaar)', when: '4h' },
  { user: 'support.lead', app: 'Bedrock', action: 'flagged', cls: 'amber', detail: 'RAG index pulled PII table', when: '5h' },
];

export default function LlmMonitoring() {
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const max = Math.max(...APPS.map((a) => a.value));

  return (
    <Layout lastRefresh={lastRefresh} onRefresh={() => setLastRefresh(new Date())}>
      <PageHeader title="LLM Monitoring" meta={['prompt-time data protection', 'ChatGPT · Bedrock · Azure OpenAI']}>
        <button className="btn-primary" onClick={() => toast('AI firewall policy opened')}>⚑ AI firewall policy</button>
      </PageHeader>

      <section className="kpi-grid">
        <KpiCard icon="✦" label="Prompts today" value="3,902" detail="across 4 AI apps" />
        <KpiCard icon="▦" iconBg="var(--green-soft)" iconColor="var(--green)" label="PII redacted" value={61} detail="before reaching LLM" detailType="up" />
        <KpiCard icon="⛔" iconBg="var(--danger-soft)" iconColor="var(--danger)" label="Blocked" value={4} detail="exfil attempts" detailType="down" />
        <KpiCard icon="⊙" iconBg="var(--amber-soft)" iconColor="var(--amber)" label="Shadow AI" value={2} detail="unsanctioned tools" detailType="down" />
      </section>

      <div className="charts-row">
        <div className="card">
          <div className="card-header"><span className="card-title">Prompts by AI app</span></div>
          <div className="card-body">
            <div className="barchart">
              {APPS.map((a) => (
                <div className="barchart-row" key={a.label}>
                  <span className="barchart-label">{a.label}</span>
                  <span className="barchart-track"><span className="barchart-fill" style={{ width: `${(a.value / max) * 100}%`, background: a.color }} /></span>
                  <span className="barchart-val">{a.value.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">Recent AI events</span></div>
          <div className="card-body no-pad">
            <table className="data-table">
              <thead><tr><th>User</th><th>AI app</th><th>Action</th><th>Detail</th><th>When</th></tr></thead>
              <tbody>
                {EVENTS.map((e, i) => (
                  <tr key={i}>
                    <td>{e.user}</td><td>{e.app}</td>
                    <td><span className={`badge ${e.cls}`}>{e.action}</span></td>
                    <td>{e.detail}</td><td className="muted">{e.when}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-header"><span className="card-title">Prompt-time redaction · live example</span></div>
        <div className="card-body">
          <div className="grid2">
            <div>
              <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>USER TYPED</div>
              <div className="mono" style={{ fontSize: 12.5, background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 10, padding: 12 }}>
                Summarise this customer: John Reynolds, SSN <span style={{ color: 'var(--danger)', textDecoration: 'line-through', opacity: .7 }}>412-88-9011</span>, card <span style={{ color: 'var(--danger)', textDecoration: 'line-through', opacity: .7 }}>4539 1488 0343 6467</span>, DOB <span style={{ color: 'var(--danger)', textDecoration: 'line-through', opacity: .7 }}>1985-03-14</span>
              </div>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>SENT TO LLM</div>
              <div className="mono" style={{ fontSize: 12.5, background: 'var(--green-soft)', border: '1px solid var(--green)', borderRadius: 10, padding: 12 }}>
                Summarise this customer: John Reynolds, SSN <b>[REDACTED]</b>, card <b>[REDACTED]</b>, DOB <b>[REDACTED]</b>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}
