import { useState, useEffect, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { sessionApi, type Session } from '../services/api';
import { queryKeys } from './queries';
import { useToast } from '../components/Toast';
import { useWebSocket } from './useWebSocket';

interface SessionsControllerOptions {
  showQr: (id: string) => void;
  onSessionStopped: (id: string) => void;
}

export function useSessionsController({ showQr, onSessionStopped }: SessionsControllerOptions) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSessions = useCallback(async (): Promise<Session[]> => {
    try {
      setLoading(true);
      const data = await sessionApi.list();
      setSessions(data);
      // Keep the shared React Query cache (read by the Dashboard via useSessionsQuery /
      // useSessionStatsQuery) in sync after this page's mutations reload local state — otherwise the
      // Dashboard shows stale session counts/status. This runs on every reload (mount / WS-failed /
      // mutation), which is harmless: the Sessions page holds no active observer on a ['sessions', …]
      // query, so invalidation only marks the shared cache stale (no refetch here, no loop) and the
      // Dashboard/other views refetch lazily on next mount. Prefix-matches every session-scoped key
      // (sessions, sessionStats, per-session groups/chats/templates).
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : t('sessions.create.errorDefault'));
      return [];
    } finally {
      setLoading(false);
    }
  }, [t, queryClient]);

  // Mirror the latest sessions in a ref so the WS handler can compare against the current status without
  // depending on `sessions` (which would churn the callback identity and re-subscribe the socket). Kept
  // in sync with every state update (fetch / create / delete / WS) via the effect below.
  const sessionsRef = useRef<Session[]>([]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const { isConnected, subscribe } = useWebSocket({
    onSessionStatus: useCallback(
      (event: { sessionId: string; status: string }) => {
        const prev = sessionsRef.current.find(s => s.id === event.sessionId);
        // Some engines double-signal one transition; only react to an ACTUAL status change so the toast
        // and the failed-refresh don't fire on every redundant envelope. Update the ref synchronously so
        // a duplicate arriving in the same tick (before the sync effect runs) is also caught.
        if (prev && prev.status === event.status) return;
        sessionsRef.current = sessionsRef.current.map(s =>
          s.id === event.sessionId ? { ...s, status: event.status as Session['status'] } : s,
        );
        setSessions(sessionsRef.current);
        if (event.status === 'ready') {
          toast.success(t('sessions.toasts.readyTitle'), t('sessions.toasts.readyDesc'));
        } else if (event.status === 'disconnected') {
          toast.warning(t('sessions.toasts.disconnectedTitle'), t('sessions.toasts.disconnectedDesc'));
        } else if (event.status === 'failed') {
          // Refresh so the card picks up the lastError reason from the API.
          void fetchSessions();
          toast.error(t('sessions.toasts.failedTitle'), t('sessions.toasts.failedDesc'));
        }
      },
      [toast, t, fetchSessions],
    ),
  });

  // The gateway delivers events only to subscribed rooms; join the wildcard
  // session.status room so status changes for every session are received live.
  useEffect(() => {
    if (isConnected) {
      subscribe('*', ['session.status', 'session.qr']);
    }
  }, [isConnected, subscribe]);

  useEffect(() => {
    fetchSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreate = async (name: string): Promise<boolean> => {
    if (!name.trim()) return false;
    try {
      const newSession = await sessionApi.create(name);
      setSessions([...sessions, newSession]);
      toast.success(t('sessions.create.successTitle'), t('sessions.create.successDesc', { name: newSession.name }));
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('sessions.create.errorDefault');
      setError(msg);
      toast.error(t('sessions.create.errorTitle'), msg);
      return false;
    }
  };

  const handleDelete = async (id: string) => {
    const session = sessions.find(s => s.id === id);
    try {
      await sessionApi.delete(id);
      setSessions(sessions.filter(s => s.id !== id));
      toast.success(
        t('sessions.delete.successTitle'),
        session
          ? t('sessions.delete.successDescNamed', { name: session.name })
          : t('sessions.delete.successDescGeneric'),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('sessions.delete.errorDefault');
      console.error('Failed to delete:', err);
      toast.error(t('sessions.delete.errorTitle'), msg);
    }
  };

  const handleStart = async (id: string) => {
    const session = sessions.find(s => s.id === id);
    if (session && ['initializing', 'connecting', 'qr_ready'].includes(session.status)) {
      showQr(id);
      return;
    }

    try {
      await sessionApi.start(id);
      setSessions(sessions.map(s => (s.id === id ? { ...s, status: 'connecting' } : s)));
      await fetchSessions();
      showQr(id);
    } catch (err) {
      console.error('Failed to start:', err);
      const fresh = await fetchSessions();
      const current = fresh.find(s => s.id === id);
      if (current?.status !== 'ready') showQr(id);
    }
  };

  const handleStop = async (id: string) => {
    try {
      await sessionApi.stop(id);
      setSessions(sessions.map(s => (s.id === id ? { ...s, status: 'disconnected' } : s)));
      onSessionStopped(id);
    } catch (err) {
      console.error('Failed to stop:', err);
      fetchSessions();
    }
  };

  const handleForceKill = async (id: string) => {
    try {
      await sessionApi.forceKill(id);
      setSessions(sessions.map(s => (s.id === id ? { ...s, status: 'disconnected' } : s)));
      toast.success(t('sessions.forceKill.successTitle'), t('sessions.forceKill.success'));
    } catch (err) {
      console.error('Failed to force-kill:', err);
      toast.error(t('sessions.forceKill.failedTitle'), t('sessions.forceKill.failed'));
      fetchSessions();
    }
  };

  return {
    sessions,
    loading,
    error,
    sessionsRef,
    fetchSessions,
    handleCreate,
    handleDelete,
    handleStart,
    handleStop,
    handleForceKill,
  };
}
