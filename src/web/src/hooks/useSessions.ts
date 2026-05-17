import { useState, useEffect, useCallback, useRef } from 'react';
import type { AgentSession, AgentSource } from '../types';
import { fetchSessions, fetchSessionsProgressively, fetchStatus } from '../api';

export interface UseSessionsResult {
  sessions: AgentSession[];
  loading: boolean;
  error: string | null;
  status: Record<AgentSource, boolean> | undefined;
  refresh: (showSpinner?: boolean) => void;
}

export function useSessions(
  onDataReceived?: (sessions: AgentSession[]) => void,
): UseSessionsResult {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<AgentSource, boolean> | undefined>(undefined);
  const cancelledRef = useRef(false);

  const refresh = useCallback((showSpinner = true) => {
    if (showSpinner) setLoading(true);
    
    const sessionsPromise = !showSpinner
      ? fetchSessions()
      : fetchSessionsProgressively((data) => {
          if (cancelledRef.current) return;
          setSessions(data);
          onDataReceived?.(data);
          if (data.length > 0) setLoading(false);
        });

    Promise.all([sessionsPromise, fetchStatus().catch(() => undefined)])
      .then(([data, stat]) => {
        if (cancelledRef.current) return;
        setSessions(data);
        setStatus(stat);
        setError(null);
        onDataReceived?.(data);
      })
      .catch((err) => {
        console.error('Failed to fetch sessions:', err);
        if (!cancelledRef.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelledRef.current && showSpinner) setLoading(false);
      });
  }, [onDataReceived]);

  useEffect(() => {
    cancelledRef.current = false;
    refresh(true);

    const interval = window.setInterval(() => refresh(false), 15_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh(false);
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelledRef.current = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  return { sessions, loading, error, status, refresh };
}
