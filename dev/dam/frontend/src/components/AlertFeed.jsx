const SEV_STYLE = {
  critical: { bg: '#fef2f2', color: '#dc2626', icon: '⚠' },
  high:     { bg: '#fffbeb', color: '#f59e0b', icon: '⚷' },
  medium:   { bg: '#eff6ff', color: '#3b82f6', icon: '◷' },
  low:      { bg: '#f8fafc', color: '#94a3b8', icon: '○' },
};

function timeAgo(dateStr) {
  if (!dateStr) return '-';
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (diff < 1) return 'just now';
  if (diff < 60) return `${diff}m ago`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
  return `${Math.floor(diff / 1440)}d ago`;
}

export default function AlertFeed({ alerts }) {
  if (!alerts.length) {
    return <div className="chart-empty">No recent alerts</div>;
  }

  return (
    <div className="alert-feed">
      {alerts.slice(0, 6).map(a => {
        const s = SEV_STYLE[a.severity] || SEV_STYLE.low;
        return (
          <div key={a.id} className="alert-row">
            <span className="alert-icon" style={{ background: s.bg, color: s.color }}>{s.icon}</span>
            <div className="alert-body">
              <b>{a.summary || `${a.severity} alert on ${a.database_name}`}</b>
              <small>{a.principal} · {a.database_name} · score {a.anomaly_score}</small>
            </div>
            <div className="alert-meta">
              <span className={`badge sev-${a.severity}`}>{a.severity}</span>
              <small>{timeAgo(a.created_at)}</small>
            </div>
          </div>
        );
      })}
    </div>
  );
}
