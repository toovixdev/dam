import { useState, useEffect } from 'react';
import { subscribeStatus } from '../liveEvents';

// Returns the live WebSocket connection status: 'online' | 'connecting' | 'offline'.
export default function useLiveStatus() {
  const [status, setStatus] = useState('connecting');
  useEffect(() => subscribeStatus(setStatus), []);
  return status;
}
