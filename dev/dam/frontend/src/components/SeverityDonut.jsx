import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

const COLORS = { critical: '#dc2626', high: '#f59e0b', medium: '#3b82f6', low: '#94a3b8' };

export default function SeverityDonut({ counts: countsProp, alerts }) {
  // Prefer real aggregated counts (all open alerts); fall back to counting a passed list.
  let counts = { critical: 0, high: 0, medium: 0, low: 0 };
  if (countsProp) {
    counts = { critical: countsProp.critical || 0, high: countsProp.high || 0, medium: countsProp.medium || 0, low: countsProp.low || 0 };
  } else if (Array.isArray(alerts)) {
    alerts.forEach(a => { if (counts[a.severity] !== undefined) counts[a.severity]++; });
  }

  const data = Object.entries(counts)
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({ name: name.charAt(0).toUpperCase() + name.slice(1), value }));

  const total = data.reduce((s, d) => s + d.value, 0);

  if (total === 0) {
    return <div className="chart-empty">No open alerts</div>;
  }

  return (
    <div style={{ position: 'relative' }}>
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie data={data} cx="50%" cy="50%" innerRadius={55} outerRadius={80} dataKey="value" stroke="none">
            {data.map((entry) => (
              <Cell key={entry.name} fill={COLORS[entry.name.toLowerCase()] || '#94a3b8'} />
            ))}
          </Pie>
          <Tooltip contentStyle={{ background: 'var(--surface, #fff)', border: '1px solid var(--line, #e2e8f0)', borderRadius: 8, fontSize: 12 }} />
        </PieChart>
      </ResponsiveContainer>
      <div className="donut-center">
        <span className="donut-value">{total}</span>
        <span className="donut-label">open</span>
      </div>
      <div className="donut-legend">
        {data.map(d => (
          <span key={d.name} className="legend-item">
            <span className="legend-dot" style={{ background: COLORS[d.name.toLowerCase()] }} />
            {d.name}: {d.value}
          </span>
        ))}
      </div>
    </div>
  );
}
