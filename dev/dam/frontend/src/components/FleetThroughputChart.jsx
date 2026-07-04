import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export default function FleetThroughputChart({ data }) {
  if (!data || data.length === 0) {
    return <div className="chart-empty">No throughput data yet</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data}>
        <defs>
          <linearGradient id="tputGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--line, #e2e8f0)" />
        <XAxis dataKey="time" tick={{ fontSize: 11 }} stroke="var(--muted, #94a3b8)" />
        <YAxis tick={{ fontSize: 11 }} stroke="var(--muted, #94a3b8)" />
        <Tooltip
          contentStyle={{ background: 'var(--surface, #fff)', border: '1px solid var(--line, #e2e8f0)', borderRadius: 8, fontSize: 12 }}
          formatter={(val) => [`${val.toLocaleString()} events/s`, 'Throughput']}
        />
        <Area type="monotone" dataKey="eps" stroke="#6366f1" fill="url(#tputGrad)" strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
