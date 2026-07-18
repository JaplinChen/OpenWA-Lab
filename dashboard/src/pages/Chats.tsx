import { useState, useEffect, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { Loader2, AlertCircle } from 'lucide-react';
import { sessionApi, translateApi, type Session, type Chat } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { GlobalSearch } from '../components/GlobalSearch';
import { useChatMessages, useChatMessagesActions } from '../hooks/useChatMessages';
import { useChatScrollPosition } from '../hooks/useChatScrollPosition';
import { useChatRealtime } from '../hooks/useChatRealtime';
import { useMessageSender } from '../hooks/useMessageSender';
import { useMessageReactions } from '../hooks/useMessageReactions';
import { useSearchHitNavigation } from '../hooks/useSearchHitNavigation';
import { getMediaSrc } from '../components/chats/chatMedia';
import { ChatListSidebar } from '../components/chats/ChatListSidebar';
import { ChatRoom } from '../components/chats/ChatRoom';
import MediaLightbox, { type LightboxItem } from '../components/chats/MediaLightbox';
import './Chats.css';

export function Chats() {
  const { t } = useTranslation();
  useDocumentTitle(t('nav.chats'));
  const { canWrite } = useRole();
  const { error: showErrorToast, warning: showWarningToast } = useToast();

  // Sessions list & active session
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [loadingSessions, setLoadingSessions] = useState<boolean>(true);

  // Chats list
  const [chats, setChats] = useState<Chat[]>([]);
  const [loadingChats, setLoadingChats] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  // Translation-group filter: show only the groups selected on the Translate page.
  const [translateGroupIds, setTranslateGroupIds] = useState<Set<string>>(new Set());
  const [onlyTranslateGroups, setOnlyTranslateGroups] = useState<boolean>(true);

  // Selected chat & message history
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const {
    data: messages = [],
    isLoading: loadingMessages,
    isError: messagesError,
  } = useChatMessages(selectedSessionId, activeChat?.id ?? null);
  const { appendMessage, updateMessage } = useChatMessagesActions();
  const queryClient = useQueryClient();

  // Lightbox state for media viewer
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Per-chat scroll-position memory + auto-scroll heuristic.
  // Pass `messages.length > 0` as the loaded signal: it stays stable once the
  // chat has any message (doesn't toggle per append) and covers both the
  // first-fetch resolution and a WS-driven first message on a previously-empty
  // chat. `loadingMessages` alone would miss the latter case.
  const { containerRef: messagesContainerRef, onMessageAppended } =
    useChatScrollPosition(activeChat?.id ?? null, messages.length > 0);

  // Composer state + optimistic send / echo dedup / attachment handling.
  const sender = useMessageSender({
    selectedSessionId,
    activeChat,
    queryClient,
    appendMessage,
    updateMessage,
    onMessageAppended,
    setChats,
    showErrorToast,
    t,
  });
  const { clearAttachment } = sender;

  const { handleReactMessage, handleDeleteMessage } = useMessageReactions({
    selectedSessionId,
    activeChat,
    sessions,
    queryClient,
    updateMessage,
    showErrorToast,
    t,
  });

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

  useEffect(() => {
    if (selectedSessionId) {
      void loadChats(selectedSessionId);
      setActiveChat(null);
      clearAttachment();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId, loadChats]);

  const markChatRead = useCallback(
    (chatId: string) => {
      void sessionApi.markChatRead(selectedSessionId, chatId).catch(err => {
        showWarningToast(t('chats.errors.markRead'), err instanceof Error ? err.message : undefined);
      });
    },
    [selectedSessionId, t, showWarningToast],
  );

  // 3. WebSocket integration for real-time messages
  const { connectionFailed, reconnect } = useChatRealtime({
    selectedSessionId,
    activeChat,
    loadChats,
    markChatRead,
    appendMessage,
    onMessageAppended,
    queryClient,
    setChats,
    t,
  });

  // 4. Message history is fetched by useChatMessages (React Query). The active-chat side effects
  // (mark-as-read + clear sidebar unread badge) live in a small effect below.

  // Side effects when the active chat changes: mark-as-read on the gateway + clear sidebar unread badge.
  // The message-history fetch is driven by useChatMessages; scroll restoration is driven by
  // useChatScrollPosition (both keyed off activeChat?.id). Deliberately keying off `activeChat?.id`
  // (not the whole object) so a sidebar reshuffle that mutates the activeChat instance doesn't re-fire
  // the mark-as-read RPC for the same chat.
  useEffect(() => {
    if (!activeChat) return;
    markChatRead(activeChat.id);
    setChats(prev => prev.map(c => (c.id === activeChat.id ? { ...c, unreadCount: 0 } : c)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChat?.id, markChatRead]);

  const { handleSearchHit } = useSearchHitNavigation({
    selectedSessionId,
    setSelectedSessionId,
    chats,
    activeChat,
    setActiveChat,
    loadingMessages,
    messages,
    messagesContainerRef,
  });

  const formatLastMessageSnippet = (chat: Chat) => chat.lastMessage || '';

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

  // Image media items for the lightbox, in render order. `getMediaSrc` reconstructs a usable src
  // from either a base64 payload or a URL — the ChatMessageView shape stores both in `data`.
  const imageMedia = useMemo<LightboxItem[]>(
    () =>
      messages
        .filter(m => m.type === 'image' && Boolean(getMediaSrc(m.metadata?.media)))
        .map(m => ({
          id: m.id,
          url: getMediaSrc(m.metadata?.media),
          alt: m.body || m.metadata?.media?.filename || '',
          senderName: undefined,
          timestamp: formatChatTime(m.timestamp || Math.floor(new Date(m.createdAt).getTime() / 1000)),
        })),
    [messages, formatChatTime],
  );

  return (
    <div className="chats-page">
      <PageHeader
        title={t('nav.chats')}
        subtitle={t('chats.subtitle')}
        actions={
          sessions.length > 0 && (
            <GlobalSearch currentSessionId={selectedSessionId} onHit={handleSearchHit} />
          )
        }
      />

      {/* Real-time connection permanently dropped — let the user re-establish it instead of
          silently showing stale chats. */}
      {connectionFailed && (
        <div className="chats-reconnect-banner" role="alert">
          <AlertCircle size={16} />
          <span>{t('common.disconnected')}</span>
          <button className="btn-secondary" onClick={reconnect}>
            {t('common.refresh')}
          </button>
        </div>
      )}

      {loadingSessions ? (
        <div className="chats-loading-container">
          <Loader2 className="animate-spin" size={32} />
          <p>{t('common.loading')}</p>
        </div>
      ) : sessions.length === 0 ? (
        <div className="chats-error-state">
          <AlertCircle size={48} className="text-warn" />
          <h3>{t('chats.noSessionsTitle')}</h3>
          <p>
            <Trans i18nKey="chats.noSessionsDesc">
              Please connect a WhatsApp session from the <strong>Sessions</strong> menu first to use the chat
              feature.
            </Trans>
          </p>
        </div>
      ) : (
        <div className={`chats-layout ${activeChat ? 'has-active-chat' : ''}`}>
          {/* LEFT SIDEBAR: session & chat rooms */}
          <ChatListSidebar
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            onSelectSession={setSelectedSessionId}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onlyTranslateGroups={onlyTranslateGroups}
            onToggleTranslateGroups={setOnlyTranslateGroups}
            filteredChats={filteredChats}
            activeChat={activeChat}
            onSelectChat={setActiveChat}
            loadingChats={loadingChats}
            formatChatTime={formatChatTime}
            formatLastMessageSnippet={formatLastMessageSnippet}
            t={t}
          />

          {/* RIGHT VIEW: active chat room */}
          <ChatRoom
            activeChat={activeChat}
            onBack={() => setActiveChat(null)}
            messages={messages}
            loadingMessages={loadingMessages}
            messagesError={messagesError}
            messagesContainerRef={messagesContainerRef}
            imageMedia={imageMedia}
            onOpenLightbox={setLightboxIndex}
            onReact={handleReactMessage}
            onDelete={handleDeleteMessage}
            sender={sender}
            canWrite={canWrite}
            t={t}
          />
        </div>
      )}

      <MediaLightbox
        items={imageMedia}
        index={lightboxIndex}
        onClose={() => setLightboxIndex(null)}
        onNavigate={setLightboxIndex}
      />
    </div>
  );
}
