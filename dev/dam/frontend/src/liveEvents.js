// Shared WebSocket to the control plane (/ws, proxied by vite to dam-api).
// One connection per tab, auto-reconnecting, fanned out to all subscribers.
// Also tracks connection status ('online' | 'connecting' | 'offline').

let ws = null;
let reconnectTimer = null;
let status = 'offline';
const listeners = new Set();        // message subscribers
const statusListeners = new Set();  // status subscribers

function setStatus(s) {
  if (s === status) return;
  status = s;
  statusListeners.forEach((cb) => { try { cb(s); } catch { /* ignore */ } });
}
function hasSubscribers() { return listeners.size > 0 || statusListeners.size > 0; }

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  setStatus('connecting');
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${window.location.host}/ws`);
  ws.onopen = () => setStatus('online');
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    listeners.forEach((cb) => { try { cb(msg); } catch { /* ignore subscriber error */ } });
  };
  ws.onclose = () => { ws = null; setStatus('offline'); scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
}

function scheduleReconnect() {
  if (reconnectTimer || !hasSubscribers()) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000);
}
function maybeClose() {
  if (!hasSubscribers() && ws) { try { ws.close(); } catch { /* noop */ } ws = null; }
}

// Subscribe to live message events; returns an unsubscribe function.
export function subscribeLive(cb) {
  listeners.add(cb);
  connect();
  return () => { listeners.delete(cb); maybeClose(); };
}

// Subscribe to connection-status changes; fires immediately with the current status.
export function subscribeStatus(cb) {
  statusListeners.add(cb);
  cb(status);
  connect();
  return () => { statusListeners.delete(cb); maybeClose(); };
}

export function getLiveStatus() { return status; }
