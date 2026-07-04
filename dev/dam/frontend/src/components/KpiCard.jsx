export default function KpiCard({ icon, iconBg, iconColor, label, value, detail, detailType, onClick }) {
  return (
    <div className="kpi-card" onClick={onClick} style={onClick ? { cursor: 'pointer' } : {}}>
      <div className="kpi-header">
        <span className="kpi-icon" style={{ background: iconBg || '#f0f0ff', color: iconColor || '#6366f1' }}>{icon}</span>
        <span className="kpi-label">{label}</span>
      </div>
      <div className="kpi-value">{value}</div>
      {detail && (
        <div className={`kpi-detail ${detailType === 'up' ? 'up' : detailType === 'down' ? 'down' : ''}`}>
          {detail}
        </div>
      )}
    </div>
  );
}
