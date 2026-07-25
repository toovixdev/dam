import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { fmtTs, getTimezone } from '../hooks/useTimezone';

export default function EventsChart({ data }) {
  const chartData = data.map(row => ({
    // row.hour is a UTC epoch (seconds); render the bucket in the user's CHOSEN timezone
    // (Profile → Timezone), matching every other timestamp in the app.
    hour: fmtTs(row.hour * 1000, getTimezone(), { hour: '2-digit', minute: '2-digit', hour12: false }),
    events: parseInt(row.cnt),
  }));

  if (chartData.length === 0) {
    return <div className="chart-empty">No event data yet. Collector is gathering data...</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={chartData}>
        <defs>
          <linearGradient id="evGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--line, #e2e8f0)" />
        <XAxis dataKey="hour" tick={{ fontSize: 11 }} stroke="var(--muted, #94a3b8)" />
        <YAxis tick={{ fontSize: 11 }} stroke="var(--muted, #94a3b8)" />
        <Tooltip
          contentStyle={{ background: 'var(--surface, #fff)', border: '1px solid var(--line, #e2e8f0)', borderRadius: 8, fontSize: 12 }}
          formatter={(val) => [val.toLocaleString(), 'Events']}
        />
        <Area type="monotone" dataKey="events" stroke="#6366f1" fill="url(#evGrad)" strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
