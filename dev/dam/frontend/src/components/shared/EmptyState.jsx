export default function EmptyState({ icon = '◎', message = 'No data', action, onAction }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <p>{message}</p>
      {action && <button className="btn-primary" onClick={onAction}>{action}</button>}
    </div>
  );
}
