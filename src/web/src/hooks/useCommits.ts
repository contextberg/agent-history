import { useState, useEffect, useCallback, useRef } from 'react';
import type { CommitWithLinks } from '../types';
import { fetchCommits } from '../api';

export interface UseCommitsResult {
  commits: CommitWithLinks[];
  loading: boolean;
  error: string | null;
  refresh: (showSpinner?: boolean) => void;
}

export function useCommits(
  enabled: boolean,
  onDataReceived?: (commits: CommitWithLinks[]) => void,
): UseCommitsResult {
  const [commits, setCommits] = useState<CommitWithLinks[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const hasLoadedRef = useRef(false);

  const refresh = useCallback((showSpinner = true) => {
    if (!enabled) return;
    if (showSpinner && !hasLoadedRef.current) setLoading(true);

    fetchCommits()
      .then((data) => {
        if (cancelledRef.current) return;
        setCommits(data);
        setError(null);
        hasLoadedRef.current = true;
        onDataReceived?.(data);
      })
      .catch((err) => {
        console.error('Failed to fetch commits:', err);
        if (!cancelledRef.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelledRef.current) setLoading(false);
      });
  }, [enabled, onDataReceived]);

  useEffect(() => {
    if (!enabled) return;
    
    cancelledRef.current = false;
    refresh(true);
    
    const interval = window.setInterval(() => refresh(false), 30_000);
    return () => {
      cancelledRef.current = true;
      window.clearInterval(interval);
    };
  }, [enabled, refresh]);

  return { commits, loading, error, refresh };
}
