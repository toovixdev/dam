function riskColor(score) {
  if (score >= 80) return '#dc2626';
  if (score >= 60) return '#f59e0b';
  return '#22c55e';
}

export default function RiskyDatabases({ databases }) {
  if (!databases.length) {
    return <div className="chart-empty">No databases registered</div>;
  }

  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Database</th>
          <th>Engine</th>
          <th>Region</th>
          <th className="num">Risk</th>
          <th className="num">Alerts</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {databases.map(db => (
          <tr key={db.id}>
            <td><b>{db.name}</b></td>
            <td><span className="badge engine">{db.engine} {db.version}</span></td>
            <td className="muted">{db.region || '-'}</td>
            <td className="num">
              <span className="risk-score" style={{ color: riskColor(db.risk_score) }}>{db.risk_score}</span>
            </td>
            <td className="num">
              {db.open_alerts > 0 ? (
                <span className={`badge ${db.open_alerts >= 3 ? 'sev-critical' : 'sev-high'}`}>{db.open_alerts}</span>
              ) : (
                <span className="muted">0</span>
              )}
            </td>
            <td>
              <span className={`badge ${db.monitoring_status === 'monitored' ? 'status-green' : 'status-gray'}`}>
                {db.monitoring_status}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
