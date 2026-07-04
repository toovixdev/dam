export default function Modal({ open, onClose, title, width = 580, children }) {
  if (!open) return null;
  return (
    <>
      <div className="modal-overlay" onClick={onClose} />
      <div className="modal-box" style={{ width: `min(${width}px, calc(100vw - 32px))` }}>
        <div className="modal-header">
          <b>{title}</b>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </>
  );
}
