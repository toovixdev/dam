import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../api/client';

export default function useDashboard(refreshInterval = 30000) {
  const [kpis, setKpis] = useState(null);
  const [eventsTimeline, setEventsTimeline] = useState([]);
  const [riskyDbs, setRiskyDbs] = useState([]);
  const [recentAlerts, setRecentAlerts] = useState([]);
  const [alertSeverity, setAlertSeverity] = useState({ critical: 0, high: 0, medium: 0, low: 0, total: 0 });
  const [eventsByDb, setEventsByDb] = useState([]);
  const [sensitiveAccess, setSensitiveAccess] = useState([]);
  const [sensitiveDaily, setSensitiveDaily] = useState([]);
  const [compliance, setCompliance] = useState([]);
  const [coverage, setCoverage] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);

  const fetchAll = useCallback(async () => {
    try {
      const [k, et, rd, ra, abs, edb, sa, sd, cmp, cov] = await Promise.all([
        apiFetch('/dashboard/kpis'),
        apiFetch('/dashboard/events-timeline'),
        apiFetch('/dashboard/risky-databases'),
        apiFetch('/dashboard/recent-alerts'),
        apiFetch('/dashboard/alerts-by-severity'),
        apiFetch('/dashboard/events-by-database'),
        apiFetch('/dashboard/sensitive-access'),
        apiFetch('/dashboard/sensitive-daily'),
        apiFetch('/dashboard/compliance'),
        apiFetch('/dashboard/coverage'),
      ]);
      if (k) setKpis(k);
      if (et) setEventsTimeline(et);
      if (rd) setRiskyDbs(rd);
      if (ra) setRecentAlerts(ra);
      if (abs) setAlertSeverity(abs);
      if (edb) setEventsByDb(edb);
      if (sa) setSensitiveAccess(sa);
      if (sd) setSensitiveDaily(sd);
      if (cmp) setCompliance(cmp);
      if (cov) setCoverage(cov);
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Dashboard fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, refreshInterval);
    return () => clearInterval(id);
  }, [fetchAll, refreshInterval]);

  return { kpis, eventsTimeline, riskyDbs, recentAlerts, alertSeverity, eventsByDb, sensitiveAccess, sensitiveDaily, compliance, coverage, loading, lastRefresh, refresh: fetchAll };
}
