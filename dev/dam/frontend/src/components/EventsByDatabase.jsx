import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export default function EventsByDatabase({ data }) {
  if (!data.length) {
    return <div className="chart-empty">Events data collecting...</div>;
  }

  const chartData = data.map(r => ({
    name: r.database_name,
    events: parseInt(r.cnt),
  }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={chartData} layout="vertical" margin={{ left: 20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--line, #e2e8f0)" />
        <XAxis type="number" tick={{ fontSize: 11 }} stroke="var(--muted, #94a3b8)" />
        <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} stroke="var(--muted, #94a3b8)" width={140} />
        <Tooltip
          contentStyle={{ background: 'var(--surface, #fff)', border: '1px solid var(--line, #e2e8f0)', borderRadius: 8, fontSize: 12 }}
          formatter={(val) => [val.toLocaleString(), 'Events']}
        />
        <Bar dataKey="events" fill="#6366f1" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
