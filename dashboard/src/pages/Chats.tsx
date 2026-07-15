import { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import {
  Loader2,
  User,
  Users,
  AlertCircle,
  MessageSquare,
  ArrowLeft,
  ChevronDown,
} from 'lucide-react';
import {
  sessionApi,
  messageApi,
  translateApi,
  type Session,
  type Chat,
  type SearchHit,
} from '../services/api';
import { type ChatMessageView } from '../utils/chatMessages';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { GlobalSearch } from '../components/GlobalSearch';
import {
  useChatMessages,
  useChatMessagesActions,
  messagesQueryKey,
} from '../hooks/useChatMessages';
import { useChatScrollPosition } from '../hooks/useChatScrollPosition';
import { useChatRealtime } from '../hooks/useChatRealtime';
import { getMediaSrc, messageTypeFromMime } from '../components/chats/chatMedia';
import { ChatListSidebar } from '../components/chats/ChatListSidebar';
import { MessageBubble } from '../components/chats/MessageBubble';
import { MessageComposer } from '../components/chats/MessageComposer';
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
  // Show the "scroll to newest" button only when scrolled up away from the bottom.
  const [showScrollDown, setShowScrollDown] = useState<boolean>(false);

  // Selected chat & message history
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const {
    data: messages = [],
    isLoading: loadingMessages,
    isError: messagesError,
  } = useChatMessages(selectedSessionId, activeChat?.id ?? null);
  const { appendMessage, updateMessage } = useChatMessagesActions();
  const queryClient = useQueryClient();
  const [messageInput, setMessageInput] = useState<string>('');
  const [sending, setSending] = useState<boolean>(false);

  // Lightbox state for media viewer
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // File attachments
  const [attachment, setAttachment] = useState<{
    file: File;
    base64: string;
    mimetype: string;
    filename: string;
  } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState<boolean>(false);

  // References
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessageView | null>(null);

  // Per-chat scroll-position memory + auto-scroll heuristic.
  // Pass `messages.length > 0` as the loaded signal: it stays stable once the
  // chat has any message (doesn't toggle per append) and covers both the
  // first-fetch resolution and a WS-driven first message on a previously-empty
  // chat. `loadingMessages` alone would miss the latter case.
  const { containerRef: messagesContainerRef, onMessageAppended } =
    useChatScrollPosition(activeChat?.id ?? null, messages.length > 0);

  // Popular emojis
  const popularEmojis = ['😀', '😂', '👍', '❤️', '🔥', '👏', '🙏', '🎉', '💡', '🤔', '😅', '😍', '😊', '😭', '😎', '😜', '🚀', '✨'];

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
      setAttachment(null);
      setPreviewUrl(null);
    }
  }, [selectedSessionId, loadChats]);

  // Revoke the object URL created for an image-attachment preview once it is replaced, cleared, or
  // the page unmounts. The cleanup runs with the previous value on every change, so this single
  // effect covers all paths (new file, remove, session switch) — otherwise each preview leaks a
  // blob held for the lifetime of the document.
  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

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

  const handleReactMessage = async (msg: ChatMessageView, emoji: string) => {
    if (!selectedSessionId || !activeChat) return;

    const msgId = msg.waMessageId || msg.id;
    const currentReactions = msg.metadata?.reactions || {};
    const sessionPhone = sessions.find(s => s.id === selectedSessionId)?.phone || 'me';

    let alreadyReacted = false;
    for (const [sender, emo] of Object.entries(currentReactions)) {
      if ((sender === 'me' || sender.includes(sessionPhone)) && emo === emoji) {
        alreadyReacted = true;
        break;
      }
    }

    const emojiToSend = alreadyReacted ? '' : emoji;

    try {
      await messageApi.react(selectedSessionId, {
        chatId: activeChat.id,
        messageId: msgId,
        emoji: emojiToSend,
      });

      // Deep-merge metadata.reactions so existing media / quotedMessage on metadata survive.
      const key = messagesQueryKey(selectedSessionId, activeChat.id);
      queryClient.setQueryData<ChatMessageView[]>(key, (old = []) =>
        old.map(m => {
          if (m.id === msg.id || m.waMessageId === msg.id) {
            const metadata = m.metadata || {};
            const reactions = { ...(metadata.reactions || {}) };
            if (emojiToSend === '') {
              delete reactions['me'];
            } else {
              reactions['me'] = emojiToSend;
            }
            return { ...m, metadata: { ...metadata, reactions } };
          }
          return m;
        }),
      );
    } catch (err) {
      showErrorToast(t('chats.errors.react'), err instanceof Error ? err.message : undefined);
    }
  };

  const handleDeleteMessage = async (msg: ChatMessageView) => {
    if (!selectedSessionId || !activeChat) return;
    const msgId = msg.waMessageId || msg.id;

    if (!window.confirm(t('chats.deleteConfirm'))) return;

    try {
      await messageApi.delete(selectedSessionId, {
        chatId: activeChat.id,
        messageId: msgId,
        forEveryone: true,
      });

      updateMessage(selectedSessionId, activeChat.id, msg.id, { body: '', type: 'revoked' });
    } catch (err) {
      showErrorToast(t('chats.errors.delete'), err instanceof Error ? err.message : undefined);
    }
  };

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

  // --- Global search: jump to a hit's chat (and best-effort scroll to the message) ---
  // A cross-session hit switches session, which asynchronously reloads the chats list — so the
  // target chat may not be available at click time. pendingHitRef carries the intent across that
  // async gap: the chat-select effect picks it up once the list lands, and the scroll effect runs
  // once the messages have rendered.
  const pendingHitRef = useRef<{ chatId: string; waMessageId: string } | null>(null);

  const handleSearchHit = useCallback(
    (hit: SearchHit) => {
      pendingHitRef.current = { chatId: hit.chatId, waMessageId: hit.waMessageId };
      if (hit.sessionId !== selectedSessionId) {
        // Switching session triggers loadChats; the effect below selects the chat once the list lands.
        setSelectedSessionId(hit.sessionId);
      } else {
        const chat = chats.find(c => c.id === hit.chatId);
        if (chat) setActiveChat(chat);
        else pendingHitRef.current = null;
      }
    },
    [selectedSessionId, chats],
  );

  // After a session switch the chats list reloads — pick up the pending chat once it appears.
  useEffect(() => {
    const pending = pendingHitRef.current;
    if (!pending || activeChat?.id === pending.chatId) return;
    const chat = chats.find(c => c.id === pending.chatId);
    if (chat) setActiveChat(chat);
  }, [chats, activeChat]);

  // Best-effort scroll to the hit message. Runs as a layout effect (after useChatScrollPosition's
  // own restore on the same commit) so it overrides the bottom/saved jump with no visible flash.
  // Degrades silently to session+chat selection when the element isn't present — the message is
  // still visible in the conversation.
  useLayoutEffect(() => {
    const pending = pendingHitRef.current;
    if (!pending || !activeChat || activeChat.id !== pending.chatId) return;
    if (loadingMessages || messages.length === 0) return;
    const container = messagesContainerRef.current;
    if (container) {
      try {
        const el = container.querySelector(`[data-wa-message-id="${pending.waMessageId}"]`);
        if (el instanceof HTMLElement) el.scrollIntoView({ block: 'center' });
      } catch {
        // Unexpected chars in the id made the selector invalid — ignore.
      }
    }
    pendingHitRef.current = null;
  }, [activeChat, loadingMessages, messages, messagesContainerRef]);

  // 5. Handle file selection & base64 conversion
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type.startsWith('image/')) {
      setPreviewUrl(URL.createObjectURL(file));
    } else {
      setPreviewUrl(null);
    }

    const reader = new FileReader();
    reader.onload = event => {
      const dataUrl = event.target?.result as string;
      const base64Data = dataUrl.split(',')[1];
      setAttachment({ file, base64: base64Data, mimetype: file.type, filename: file.name });
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveAttachment = () => {
    setAttachment(null);
    setPreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const triggerFileSelect = () => {
    fileInputRef.current?.click();
  };

  const handleEmojiClick = (emoji: string) => {
    setMessageInput(prev => prev + emoji);
    setShowEmojiPicker(false);
  };

  // 7. Handle sending a message / media
  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!selectedSessionId || !activeChat || sending) return;

    const textToSend = messageInput.trim();
    if (!textToSend && !attachment) return;

    setMessageInput('');
    setSending(true);

    const tempId = `temp_${Date.now()}`;
    const tempMessage: ChatMessageView = {
      id: tempId,
      chatId: activeChat.id,
      from: 'me',
      to: activeChat.id,
      body: attachment
        ? attachment.mimetype.startsWith('image/') ||
          attachment.mimetype.startsWith('video/') ||
          attachment.mimetype.startsWith('audio/')
          ? textToSend
          : attachment.filename
        : textToSend,
      type: attachment ? messageTypeFromMime(attachment.mimetype) : 'text',
      direction: 'outgoing',
      status: 'pending',
      createdAt: new Date().toISOString(),
      metadata: attachment
        ? {
            media: {
              mimetype: attachment.mimetype,
              filename: attachment.filename,
              data: attachment.base64,
            },
          }
        : replyingTo
          ? {
              quotedMessage: {
                id: replyingTo.waMessageId || replyingTo.id,
                body: replyingTo.type !== 'text' ? `[${replyingTo.type}]` : replyingTo.body,
              },
            }
          : undefined,
    };

    appendMessage(selectedSessionId, activeChat.id, tempMessage);
    onMessageAppended('outgoing');

    const currentAttachment = attachment;
    const currentReplyingTo = replyingTo;
    handleRemoveAttachment();
    setReplyingTo(null);

    try {
      let result;

      if (currentAttachment) {
        let mediaType: 'image' | 'video' | 'audio' | 'document' = 'document';
        const mime = currentAttachment.mimetype;
        if (mime.startsWith('image/')) mediaType = 'image';
        else if (mime.startsWith('video/')) mediaType = 'video';
        else if (mime.startsWith('audio/')) mediaType = 'audio';

        result = await messageApi.sendMedia(selectedSessionId, activeChat.id, mediaType, {
          base64: currentAttachment.base64,
          mimetype: currentAttachment.mimetype,
          filename: currentAttachment.filename,
          caption: mediaType !== 'audio' ? textToSend : undefined,
        });
      } else if (currentReplyingTo) {
        result = await messageApi.reply(selectedSessionId, {
          chatId: activeChat.id,
          quotedMessageId: currentReplyingTo.waMessageId || currentReplyingTo.id,
          text: textToSend,
        });
      } else {
        result = await messageApi.sendText(selectedSessionId, activeChat.id, textToSend);
      }

      // Race guard: the realtime `message.sent` echo can arrive before this response and already
      // append the message by its real WA id (the dedup at receive time misses because the
      // optimistic placeholder still carries the temp id). If so, drop the placeholder instead of
      // renaming it — otherwise both the echo and the renamed temp render as duplicate bubbles.
      const sendKey = messagesQueryKey(selectedSessionId, activeChat.id);
      queryClient.setQueryData<ChatMessageView[]>(sendKey, (prev = []) => {
        const echoAlreadyAdded = prev.some(
          m => m.id === result.messageId || m.waMessageId === result.messageId,
        );
        if (echoAlreadyAdded) {
          return prev.filter(m => m.id !== tempId);
        }
        return prev.map(m =>
          m.id === tempId
            ? { ...m, id: result.messageId, waMessageId: result.messageId, status: 'sent' }
            : m,
        );
      });

      // Update sidebar chat list (move active chat to the top with the new snippet)
      setChats(prevChats => {
        const chatIndex = prevChats.findIndex(c => c.id === activeChat.id);
        if (chatIndex === -1) return prevChats;
        const updatedChats = [...prevChats];
        const target = { ...updatedChats[chatIndex] };
        target.lastMessage = currentAttachment
          ? `[${currentAttachment.mimetype.split('/')[0]}]`
          : textToSend;
        target.timestamp = Math.floor(Date.now() / 1000);
        updatedChats.splice(chatIndex, 1);
        updatedChats.unshift(target);
        return updatedChats;
      });
    } catch (err) {
      showErrorToast(t('chats.errors.send'), err instanceof Error ? err.message : undefined);
      updateMessage(selectedSessionId, activeChat.id, tempId, { status: 'failed' });
    } finally {
      setSending(false);
    }
  };

  // Helper formats
  const formatTime = (timestamp?: number) => {
    if (!timestamp) return '';
    return new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

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
          <main className="chats-room">
            {activeChat ? (
              <div className="room-container">
                {/* Room header */}
                <header className="room-header">
                  <button className="room-back" onClick={() => setActiveChat(null)} aria-label={t('common.back')}>
                    <ArrowLeft size={20} />
                  </button>
                  <div className="room-avatar">
                    {activeChat.isGroup ? <Users size={20} /> : <User size={20} />}
                  </div>
                  <div className="room-contact-info">
                    <h3>{activeChat.name || activeChat.id.split('@')[0]}</h3>
                    <span>{activeChat.id}</span>
                  </div>
                </header>

                {/* Messages body */}
                <div
                  className="room-messages"
                  ref={messagesContainerRef}
                  onScroll={e => {
                    const el = e.currentTarget;
                    setShowScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 200);
                  }}
                >
                  {loadingMessages ? (
                    <div className="messages-loading">
                      <Loader2 className="animate-spin" size={32} />
                      <span>{t('chats.loadingMessages')}</span>
                    </div>
                  ) : messagesError ? (
                    <div className="messages-empty">
                      <MessageSquare size={32} />
                      <span>{t('chats.loadMessagesError')}</span>
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="messages-empty">
                      <MessageSquare size={32} />
                      <span>{t('chats.noMessagesInChat')}</span>
                    </div>
                  ) : (
                    messages.map((msg, i) => {
                      const isMe = msg.direction === 'outgoing';
                      const formattedTime = formatTime(
                        msg.timestamp || Math.floor(new Date(msg.createdAt).getTime() / 1000),
                      );

                      // WhatsApp-style group sender label: show the name only on the first message of a
                      // consecutive run from the same sender, colored per sender.
                      const senderName = msg.metadata?.senderName;
                      const prev = messages[i - 1];
                      const showSenderName =
                        !isMe &&
                        activeChat.isGroup &&
                        !!senderName &&
                        (prev?.direction !== 'incoming' || prev?.metadata?.senderName !== senderName);

                      return (
                        <MessageBubble
                          key={msg.id}
                          msg={msg}
                          isMe={isMe}
                          formattedTime={formattedTime}
                          showSenderName={showSenderName}
                          senderName={senderName}
                          onReply={setReplyingTo}
                          onReact={handleReactMessage}
                          onDelete={handleDeleteMessage}
                          onOpenLightbox={msgId => {
                            const idx = imageMedia.findIndex(x => x.id === msgId);
                            if (idx >= 0) setLightboxIndex(idx);
                          }}
                          t={t}
                        />
                      );
                    })
                  )}
                </div>

                {/* Jump to newest message */}
                {showScrollDown && (
                  <button
                    type="button"
                    className="scroll-to-bottom-btn"
                    aria-label={t('chats.scrollToBottom', { defaultValue: '捲到最新訊息' })}
                    onClick={() => {
                      const el = messagesContainerRef.current;
                      if (el) el.scrollTop = el.scrollHeight;
                    }}
                  >
                    <ChevronDown size={22} />
                  </button>
                )}

                <MessageComposer
                  attachment={attachment}
                  previewUrl={previewUrl}
                  onRemoveAttachment={handleRemoveAttachment}
                  showEmojiPicker={showEmojiPicker}
                  onToggleEmojiPicker={() => setShowEmojiPicker(!showEmojiPicker)}
                  popularEmojis={popularEmojis}
                  onEmojiClick={handleEmojiClick}
                  replyingTo={replyingTo}
                  onCancelReply={() => setReplyingTo(null)}
                  activeChat={activeChat}
                  fileInputRef={fileInputRef}
                  onFileChange={handleFileChange}
                  onTriggerFileSelect={triggerFileSelect}
                  messageInput={messageInput}
                  onMessageInputChange={setMessageInput}
                  onSubmit={handleSend}
                  canWrite={canWrite}
                  sending={sending}
                  t={t}
                />
              </div>
            ) : (
              <div className="chats-room-placeholder">
                <MessageSquare size={80} className="placeholder-icon" />
                <h2>{t('chats.placeholderTitle')}</h2>
                <p>{t('chats.placeholderDesc')}</p>
              </div>
            )}
          </main>
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
