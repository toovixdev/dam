import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const TAG_COLORS = { pii: '#6366f1', pci: '#f59e0b', ssn: '#dc2626', aadhaar: '#dc2626', phi: '#3b82f6', sin: '#8b5cf6', ni: '#0ea5e9', gdpr: '#dc2626' };

export default function SensitiveAccess({ data }) {
  if (!data.length) {
    return <div className="chart-empty">No sensitive access data yet</div>;
  }

  const chartData = data.map(r => ({
    tag: r.tag.toUpperCase(),
    accesses: parseInt(r.cnt),
    fill: TAG_COLORS[r.tag] || '#94a3b8',
  }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--line, #e2e8f0)" />
        <XAxis dataKey="tag" tick={{ fontSize: 11 }} stroke="var(--muted, #94a3b8)" />
        <YAxis tick={{ fontSize: 11 }} stroke="var(--muted, #94a3b8)" />
        <Tooltip
          contentStyle={{ background: 'var(--surface, #fff)', border: '1px solid var(--line, #e2e8f0)', borderRadius: 8, fontSize: 12 }}
          formatter={(val) => [val.toLocaleString(), 'Accesses']}
        />
        <Bar dataKey="accesses" radius={[4, 4, 0, 0]}>
          {chartData.map((entry, i) => (
            <rect key={i} fill={entry.fill} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
