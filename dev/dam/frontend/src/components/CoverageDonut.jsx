import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';

const COLORS = ['#6366f1', '#3b82f6', '#f59e0b', '#22c55e', '#dc2626', '#8b5cf6', '#0ea5e9'];

export default function CoverageDonut({ data }) {
  if (!data || data.length === 0) {
    return <div className="chart-empty">No coverage data</div>;
  }

  const chartData = data.map((r, i) => ({
    name: `${r.region} (${r.cnt})`,
    value: parseInt(r.cnt),
    color: COLORS[i % COLORS.length],
  }));

  const total = chartData.reduce((s, d) => s + d.value, 0);

  return (
    <div style={{ position: 'relative' }}>
      <ResponsiveContainer width="100%" height={180}>
        <PieChart>
          <Pie data={chartData} cx="50%" cy="50%" innerRadius={50} outerRadius={72} dataKey="value" stroke="none">
            {chartData.map((r, i) => <Cell key={i} fill={r.color} />)}
          </Pie>
          <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, fontSize: 12 }} />
        </PieChart>
      </ResponsiveContainer>
      <div className="donut-center">
        <span className="donut-value">{total}</span>
        <span className="donut-label">databases</span>
      </div>
      <div className="donut-legend">
        {chartData.map(r => (
          <span key={r.name} className="legend-item">
            <span className="legend-dot" style={{ background: r.color }} />
            {r.name}
          </span>
        ))}
      </div>
    </div>
  );
}
