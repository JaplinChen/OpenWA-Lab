import { useState, useEffect, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { Loader2, AlertCircle } from 'lucide-react';
import { sessionApi, type Chat } from '../services/api';
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
import { useChatList } from '../hooks/useChatList';
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

  // Sessions list, chats list, search + translate-group filtering (extracted hook)
  const {
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
  } = useChatList();

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
