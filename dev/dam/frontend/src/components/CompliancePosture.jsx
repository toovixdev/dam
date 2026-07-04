import { Link } from 'react-router-dom';

export default function CompliancePosture({ data }) {
  if (!data || data.length === 0) {
    return <div className="chart-empty">No compliance data</div>;
  }

  return (
    <div>
      {data.map(f => (
        <div key={f.framework} className="cmp-row">
          <span className="cmp-label">{f.framework}</span>
          <span className="cmp-bar">
            <span className="cmp-fill" style={{ width: `${f.score}%`, background: f.score >= 85 ? 'var(--green)' : 'var(--amber)' }} />
          </span>
          <span className="cmp-value" style={{ color: f.score >= 85 ? 'var(--green)' : 'var(--amber)' }}>{f.score}%</span>
        </div>
      ))}
      <Link className="cmp-link" to="/compliance">Open Compliance Center →</Link>
    </div>
  );
}
