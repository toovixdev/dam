import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

const DOW_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TAG_COLORS = { pii: '#6366f1', pci: '#f59e0b', ssn: '#dc2626', aadhaar: '#dc2626', phi: '#3b82f6', sin: '#8b5cf6' };

export default function SensitiveAccessChart({ data }) {
  if (!data || data.length === 0) {
    return <div className="chart-empty">Sensitive access data collecting...</div>;
  }

  // Pivot: group by day-of-week, each tag becomes a line
  const tags = [...new Set(data.map(r => r.tag))];
  const byDay = {};
  data.forEach(r => {
    const day = DOW_NAMES[parseInt(r.dow)] || `Day ${r.dow}`;
    if (!byDay[day]) byDay[day] = { day };
    byDay[day][r.tag] = parseInt(r.cnt);
  });

  const chartData = Object.values(byDay);
  if (chartData.length === 0) {
    return <div className="chart-empty">Sensitive access data collecting...</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--line, #e2e8f0)" />
        <XAxis dataKey="day" tick={{ fontSize: 11 }} stroke="var(--muted, #94a3b8)" />
        <YAxis tick={{ fontSize: 11 }} stroke="var(--muted, #94a3b8)" />
        <Tooltip contentStyle={{ background: 'var(--surface, #fff)', border: '1px solid var(--line, #e2e8f0)', borderRadius: 8, fontSize: 12 }} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {tags.map(tag => (
          <Line key={tag} type="monotone" dataKey={tag} name={tag.toUpperCase()} stroke={TAG_COLORS[tag] || '#94a3b8'} strokeWidth={2} dot={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
