import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

const PALETTE = ['#6366f1', '#f59e0b', '#3b82f6', '#22c55e', '#dc2626', '#8b5cf6', '#14b8a6', '#94a3b8'];

// Tenant distribution by data region.
export default function RegionDonut({ data }) {
  const rows = (data || []).filter(d => d.count > 0).map(d => ({ name: d.region, value: d.count }));
  const total = rows.reduce((s, d) => s + d.value, 0);

  if (total === 0) {
    return <div className="chart-empty">No tenants yet</div>;
  }

  return (
    <div style={{ position: 'relative' }}>
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie data={rows} cx="50%" cy="50%" innerRadius={55} outerRadius={80} dataKey="value" stroke="none">
            {rows.map((entry, i) => <Cell key={entry.name} fill={PALETTE[i % PALETTE.length]} />)}
          </Pie>
          <Tooltip contentStyle={{ background: 'var(--surface, #fff)', border: '1px solid var(--line, #e2e8f0)', borderRadius: 8, fontSize: 12 }} />
        </PieChart>
      </ResponsiveContainer>
      <div className="donut-center">
        <span className="donut-value">{total}</span>
        <span className="donut-label">tenants</span>
      </div>
      <div className="donut-legend">
        {rows.map((d, i) => (
          <span key={d.name} className="legend-item">
            <span className="legend-dot" style={{ background: PALETTE[i % PALETTE.length] }} />
            {d.name}: {d.value}
          </span>
        ))}
      </div>
    </div>
  );
}
