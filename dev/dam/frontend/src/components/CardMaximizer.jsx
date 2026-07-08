import { useState, useEffect, useCallback } from 'react';

// Double-click any card tile within `scope` to maximize it to (near) full screen; double-click
// again, press Esc, click the backdrop, or hit ✕ to restore. The card's real DOM node is kept
// (via a CSS class), so live charts stay mounted — we just fire a resize so they refit.
export default function CardMaximizer({ scope = '.dashboard-content' }) {
  const [maxEl, setMaxEl] = useState(null);

  const fireResize = () => setTimeout(() => window.dispatchEvent(new Event('resize')), 60);

  const restore = useCallback((card) => {
    if (!card) return;
    card.classList.remove('card-maximized');
    document.body.classList.remove('has-maximized-card');
    setMaxEl(null);
    fireResize();
  }, []);

  const maximize = useCallback((card) => {
    document.querySelectorAll('.card-maximized').forEach((c) => c.classList.remove('card-maximized'));
    card.classList.add('card-maximized');
    document.body.classList.add('has-maximized-card');
    setMaxEl(card);
    fireResize();
  }, []);

  useEffect(() => {
    const root = () => document.querySelector(scope);
    function onDbl(e) {
      const card = e.target.closest && e.target.closest('.card');
      if (!card) return;
      const r = root();
      if (!r || !r.contains(card)) return; // only cards inside the dashboard
      window.getSelection && window.getSelection().removeAllRanges();
      if (card.classList.contains('card-maximized')) restore(card);
      else maximize(card);
    }
    function onKey(e) {
      if (e.key === 'Escape') { const c = document.querySelector('.card-maximized'); if (c) restore(c); }
    }
    document.addEventListener('dblclick', onDbl);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('dblclick', onDbl);
      document.removeEventListener('keydown', onKey);
      const c = document.querySelector('.card-maximized'); if (c) restore(c); // cleanup on unmount
    };
  }, [scope, maximize, restore]);

  if (!maxEl) return null;
  return (
    <>
      <div className="card-maximize-backdrop" onClick={() => restore(maxEl)} />
      <button className="card-maximize-close" onClick={() => restore(maxEl)} title="Restore (Esc)">✕ Close</button>
    </>
  );
}
