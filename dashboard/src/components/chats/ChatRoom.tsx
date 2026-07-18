import { useState } from 'react';
import { Loader2, User, Users, MessageSquare, ArrowLeft, ChevronDown } from 'lucide-react';
import { type Chat } from '../../services/api';
import { type ChatMessageView } from '../../utils/chatMessages';
import { MessageBubble } from './MessageBubble';
import { MessageComposer } from './MessageComposer';
import { type LightboxItem } from './MediaLightbox';
import type { useMessageSender } from '../../hooks/useMessageSender';

// Popular emojis
const popularEmojis = ['😀', '😂', '👍', '❤️', '🔥', '👏', '🙏', '🎉', '💡', '🤔', '😅', '😍', '😊', '😭', '😎', '😜', '🚀', '✨'];

interface ChatRoomProps {
  activeChat: Chat | null;
  onBack: () => void;
  messages: ChatMessageView[];
  loadingMessages: boolean;
  messagesError: boolean;
  messagesContainerRef: React.RefObject<HTMLDivElement | null>;
  imageMedia: LightboxItem[];
  onOpenLightbox: (index: number) => void;
  onReact: (msg: ChatMessageView, emoji: string) => void;
  onDelete: (msg: ChatMessageView) => void;
  sender: ReturnType<typeof useMessageSender>;
  canWrite: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}

const formatTime = (timestamp?: number) => {
  if (!timestamp) return '';
  return new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export function ChatRoom({
  activeChat,
  onBack,
  messages,
  loadingMessages,
  messagesError,
  messagesContainerRef,
  imageMedia,
  onOpenLightbox,
  onReact,
  onDelete,
  sender,
  canWrite,
  t,
}: ChatRoomProps) {
  // Show the "scroll to newest" button only when scrolled up away from the bottom.
  const [showScrollDown, setShowScrollDown] = useState<boolean>(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState<boolean>(false);

  const handleEmojiClick = (emoji: string) => {
    sender.setMessageInput(prev => prev + emoji);
    setShowEmojiPicker(false);
  };

  return (
    <main className="chats-room">
      {activeChat ? (
        <div className="room-container">
          {/* Room header */}
          <header className="room-header">
            <button className="room-back" onClick={onBack} aria-label={t('common.back')}>
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
                    onReply={sender.setReplyingTo}
                    onReact={onReact}
                    onDelete={onDelete}
                    onOpenLightbox={msgId => {
                      const idx = imageMedia.findIndex(x => x.id === msgId);
                      if (idx >= 0) onOpenLightbox(idx);
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
            attachment={sender.attachment}
            previewUrl={sender.previewUrl}
            onRemoveAttachment={sender.handleRemoveAttachment}
            showEmojiPicker={showEmojiPicker}
            onToggleEmojiPicker={() => setShowEmojiPicker(!showEmojiPicker)}
            popularEmojis={popularEmojis}
            onEmojiClick={handleEmojiClick}
            replyingTo={sender.replyingTo}
            onCancelReply={() => sender.setReplyingTo(null)}
            activeChat={activeChat}
            fileInputRef={sender.fileInputRef}
            onFileChange={sender.handleFileChange}
            onTriggerFileSelect={sender.triggerFileSelect}
            messageInput={sender.messageInput}
            onMessageInputChange={sender.setMessageInput}
            onSubmit={sender.handleSend}
            canWrite={canWrite}
            sending={sender.sending}
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
  );
}
