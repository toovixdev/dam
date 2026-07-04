import { useState, useEffect, useCallback } from 'react';

// App-wide timezone preference. Persisted in localStorage and kept in sync across
// components (TopBar, Profile, …) via a window event — no provider/context needed.
export const TIMEZONES = [
  { id: 'America/Los_Angeles', label: 'Los Angeles', abbr: 'PT' },
  { id: 'America/New_York', label: 'New York', abbr: 'ET' },
  { id: 'America/Sao_Paulo', label: 'São Paulo', abbr: 'BRT' },
  { id: 'UTC', label: 'UTC', abbr: 'UTC' },
  { id: 'Europe/London', label: 'London', abbr: 'GMT' },
  { id: 'Europe/Berlin', label: 'Frankfurt', abbr: 'CET' },
  { id: 'Asia/Dubai', label: 'Dubai', abbr: 'GST' },
  { id: 'Asia/Kolkata', label: 'India', abbr: 'IST' },
  { id: 'Asia/Singapore', label: 'Singapore', abbr: 'SGT' },
  { id: 'Asia/Tokyo', label: 'Tokyo', abbr: 'JST' },
  { id: 'Australia/Sydney', label: 'Sydney', abbr: 'AEST' },
];

const STORAGE_KEY = 'nx-timezone';
const EVENT = 'nx-timezone-change';

export function getTimezone() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) return stored;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
  } catch {
    return 'Asia/Kolkata';
  }
}

export function setTimezone(tz) {
  localStorage.setItem(STORAGE_KEY, tz);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: tz }));
}

export function tzMeta(tz) {
  return TIMEZONES.find((t) => t.id === tz) || { id: tz, label: tz, abbr: tz };
}

// Short zone name (e.g. "GMT+5:30") computed live for the given date.
export function tzShortName(tz, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(date);
    const p = parts.find((x) => x.type === 'timeZoneName');
    return p ? p.value : tzMeta(tz).abbr;
  } catch {
    return tzMeta(tz).abbr;
  }
}

export function formatInTz(tz, date = new Date(), opts = { hour: '2-digit', minute: '2-digit', hour12: false }) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }).format(date);
  } catch {
    return date.toLocaleTimeString();
  }
}

export default function useTimezone() {
  const [tz, setTz] = useState(getTimezone());

  useEffect(() => {
    const onChange = (e) => setTz(e.detail || getTimezone());
    const onStorage = (e) => { if (e.key === STORAGE_KEY) setTz(getTimezone()); };
    window.addEventListener(EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const change = useCallback((newTz) => setTimezone(newTz), []);
  return [tz, change];
}
