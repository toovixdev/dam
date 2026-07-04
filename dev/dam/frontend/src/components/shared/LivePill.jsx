import useLiveStatus from '../../hooks/useLiveStatus';

const LABEL = { online: 'Live', connecting: 'Connecting', offline: 'Offline' };

// Realtime WebSocket status pill — use on pages that stream live data.
export default function LivePill() {
  const status = useLiveStatus();
  return (
    <span className={`ws-pill ${status}`} title={`Realtime: ${status}`}>
      <span className="bl" /> {LABEL[status] || 'Offline'}
    </span>
  );
}
