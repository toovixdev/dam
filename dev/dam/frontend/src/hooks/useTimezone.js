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

// ── Shared timestamp formatting (UTC-aware + chosen-timezone) ──────────────────
// ClickHouse returns UTC with NO zone marker ("2026-07-21 15:45:37"); the browser would
// parse that as LOCAL time. Mark it UTC first. Postgres timestamps already carry a zone
// (ISO with 'T'/offset) and pass through unchanged. Returns null for empty/invalid input.
export function toDate(ts) {
  if (ts == null || ts === '') return null;
  if (typeof ts === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(ts)) {
    ts = ts.replace(' ', 'T') + 'Z';
  }
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

const FMT_DATETIME = { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };

// Format an absolute timestamp in the user's chosen timezone. Pass `opts` to vary the fields.
export function fmtTs(ts, tz, opts) {
  const d = toDate(ts);
  if (!d) return '—';
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...(opts || FMT_DATETIME) }).format(d); }
  catch { return new Intl.DateTimeFormat('en-GB', opts || FMT_DATETIME).format(d); }
}

// Relative "time ago" — timezone-independent, but still needs the UTC-aware parse to be correct.
export function timeAgo(ts) {
  const d = toDate(ts);
  if (!d) return '-';
  const diff = Date.now() - d.getTime();
  if (diff < 0) return 'just now';
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
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
