import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { sessionApi, translateApi, type Session, type Chat } from '../services/api';
import { useToast } from '../components/Toast';

// Sessions list, chats list, and the search/translate-group filtering for the Chats sidebar.
export function useChatList() {
  const { t } = useTranslation();
  const { error: showErrorToast } = useToast();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [loadingSessions, setLoadingSessions] = useState<boolean>(true);

  const [chats, setChats] = useState<Chat[]>([]);
  const [loadingChats, setLoadingChats] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  // Translation-group filter: show only the groups selected on the Translate page.
  const [translateGroupIds, setTranslateGroupIds] = useState<Set<string>>(new Set());
  const [onlyTranslateGroups, setOnlyTranslateGroups] = useState<boolean>(true);

  // 1. Fetch available connected sessions on mount
  useEffect(() => {
    const loadSessions = async () => {
      try {
        setLoadingSessions(true);
        const list = await sessionApi.list();
        const readySessions = list.filter(s => s.status === 'ready');
        setSessions(readySessions);
        if (readySessions.length > 0) {
          setSelectedSessionId(readySessions[0].id);
        }
      } catch (err) {
        showErrorToast(t('chats.errors.loadSessions'), err instanceof Error ? err.message : undefined);
      } finally {
        setLoadingSessions(false);
      }
    };
    void loadSessions();
  }, [t, showErrorToast]);

  // Load the translation-group list so the chat list can be filtered to it. Best-effort: on failure
  // the set stays empty and the toggle simply shows nothing until translate config is reachable.
  useEffect(() => {
    void translateApi
      .getConfig()
      .then(cfg => setTranslateGroupIds(new Set(cfg.groupIds)))
      .catch(() => undefined);
  }, []);

  // 2. Fetch chats when active session changes
  const loadChats = useCallback(
    async (sessionId: string) => {
      if (!sessionId) return;
      try {
        setLoadingChats(true);
        const data = await sessionApi.getChats(sessionId);
        const sorted = [...data].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        setChats(sorted);
      } catch (err) {
        showErrorToast(t('chats.errors.loadChats'), err instanceof Error ? err.message : undefined);
        setChats([]);
      } finally {
        setLoadingChats(false);
      }
    },
    [t, showErrorToast],
  );

  const formatChatTime = useCallback(
    (timestamp?: number) => {
      if (!timestamp) return '';
      const date = new Date(timestamp * 1000);
      const today = new Date();
      if (date.toDateString() === today.toDateString()) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      if (date.toDateString() === yesterday.toDateString()) {
        return t('chats.yesterday');
      }
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    },
    [t],
  );

  const filteredChats = chats.filter(c => {
    if (onlyTranslateGroups && !translateGroupIds.has(c.id)) return false;
    return (
      c.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.id.toLowerCase().includes(searchQuery.toLowerCase())
    );
  });

  return {
    sessions,
    selectedSessionId,
    setSelectedSessionId,
    loadingSessions,
    chats,
    setChats,
    loadingChats,
    loadChats,
    searchQuery,
    setSearchQuery,
    onlyTranslateGroups,
    setOnlyTranslateGroups,
    filteredChats,
    formatChatTime,
  };
}
