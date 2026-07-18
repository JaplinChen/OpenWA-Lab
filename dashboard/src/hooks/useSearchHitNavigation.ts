import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { type Chat, type SearchHit } from '../services/api';
import { type ChatMessageView } from '../utils/chatMessages';

interface UseSearchHitNavigationParams {
  selectedSessionId: string;
  setSelectedSessionId: (id: string) => void;
  chats: Chat[];
  activeChat: Chat | null;
  setActiveChat: (chat: Chat | null) => void;
  loadingMessages: boolean;
  messages: ChatMessageView[];
  messagesContainerRef: React.RefObject<HTMLDivElement | null>;
}

// Global search: jump to a hit's chat (and best-effort scroll to the message).
// A cross-session hit switches session, which asynchronously reloads the chats list — so the
// target chat may not be available at click time. pendingHitRef carries the intent across that
// async gap: the chat-select effect picks it up once the list lands, and the scroll effect runs
// once the messages have rendered.
export function useSearchHitNavigation({
  selectedSessionId,
  setSelectedSessionId,
  chats,
  activeChat,
  setActiveChat,
  loadingMessages,
  messages,
  messagesContainerRef,
}: UseSearchHitNavigationParams) {
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
    [selectedSessionId, chats, setSelectedSessionId, setActiveChat],
  );

  // After a session switch the chats list reloads — pick up the pending chat once it appears.
  useEffect(() => {
    const pending = pendingHitRef.current;
    if (!pending || activeChat?.id === pending.chatId) return;
    const chat = chats.find(c => c.id === pending.chatId);
    if (chat) setActiveChat(chat);
  }, [chats, activeChat, setActiveChat]);

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

  return { handleSearchHit };
}
