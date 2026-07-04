export default function PageHeader({ title, meta, children }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {meta && <div className="page-meta">{meta.map((m, i) => <span key={i}>{m}</span>)}</div>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}
