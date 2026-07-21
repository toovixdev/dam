import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

// Keyed by the TYPE_LABEL values used on the Agents page.
const TYPE_COLORS = {
  Network: '#6366f1',
  'Host (eBPF)': '#0ea5e9',
  'Inline Proxy': '#ec4899',
  AgentLite: '#10b981',
  'Cloud Push': '#f59e0b',
  Collector: '#8b5cf6',
};
const FALLBACK = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#94a3b8'];
const colorFor = (name, i) => TYPE_COLORS[name] || FALLBACK[i % FALLBACK.length];

export default function AgentTypeChart({ data }) {
  const total = data.reduce((s, d) => s + d.value, 0);

  if (total === 0) {
    return <div className="chart-empty">No agents deployed</div>;
  }

  return (
    <div style={{ position: 'relative' }}>
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie data={data} cx="50%" cy="50%" innerRadius={55} outerRadius={80} dataKey="value" stroke="none">
            {data.map((entry, i) => (
              <Cell key={entry.name} fill={colorFor(entry.name, i)} />
            ))}
          </Pie>
          <Tooltip contentStyle={{ background: 'var(--surface, #fff)', border: '1px solid var(--line, #e2e8f0)', borderRadius: 8, fontSize: 12 }} />
        </PieChart>
      </ResponsiveContainer>
      <div className="donut-center">
        <span className="donut-value">{total}</span>
        <span className="donut-label">agents</span>
      </div>
      <div className="donut-legend">
        {data.map((d, i) => (
          <span key={d.name} className="legend-item">
            <span className="legend-dot" style={{ background: colorFor(d.name, i) }} />
            {d.name}: {d.value}
          </span>
        ))}
      </div>
    </div>
  );
}
