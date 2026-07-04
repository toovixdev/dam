import { useEffect, useRef } from 'react';
import { subscribeLive } from '../liveEvents';

// Calls `handler(msg)` whenever a live WebSocket event of one of `types` arrives.
// Pass an empty array to receive all events.
export default function useLiveEvents(types, handler) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const wanted = Array.isArray(types) ? types : [types];
  const key = wanted.join(',');

  useEffect(() => {
    const set = new Set(wanted.filter(Boolean));
    return subscribeLive((msg) => {
      if (set.size === 0 || set.has(msg.type)) handlerRef.current(msg);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
