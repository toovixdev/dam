import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../api/client';

export default function useApiData(path, opts = {}) {
  const { poll = 0, skip = false } = opts;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refetch = useCallback(async () => {
    if (skip) return;
    try {
      const result = await apiFetch(path);
      if (result !== null) { setData(result); setError(null); }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [path, skip]);

  useEffect(() => {
    refetch();
    if (poll > 0) {
      const id = setInterval(refetch, poll);
      return () => clearInterval(id);
    }
  }, [refetch, poll]);

  return { data, loading, error, refetch };
}
