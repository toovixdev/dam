import { useState, useEffect } from 'react';

// Lightweight global toast — mirrors the mockups' pf.toast(message, type) feedback.
const listeners = new Set();
let seq = 0;

export function toast(message, type = 'info') {
  const item = { id: ++seq, message, type };
  listeners.forEach((fn) => fn(item));
}

export default function ToastHost() {
  const [items, setItems] = useState([]);

  useEffect(() => {
    const add = (item) => {
      setItems((prev) => [...prev, item]);
      setTimeout(() => {
        setItems((prev) => prev.filter((i) => i.id !== item.id));
      }, 3200);
    };
    listeners.add(add);
    return () => listeners.delete(add);
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="toast-host" role="status" aria-live="polite">
      {items.map((i) => (
        <div key={i.id} className={`toast toast-${i.type}`}>
          <span className="toast-ic">
            {i.type === 'ok' ? '✓' : i.type === 'err' ? '⚠' : 'ℹ'}
          </span>
          <span>{i.message}</span>
        </div>
      ))}
    </div>
  );
}
