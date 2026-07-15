import { Paperclip, Smile, X, Loader2, Send } from 'lucide-react';
import { type Chat } from '../../services/api';
import { type ChatMessageView } from '../../utils/chatMessages';

interface Attachment {
  file: File;
  base64: string;
  mimetype: string;
  filename: string;
}

interface MessageComposerProps {
  attachment: Attachment | null;
  previewUrl: string | null;
  onRemoveAttachment: () => void;
  showEmojiPicker: boolean;
  onToggleEmojiPicker: () => void;
  popularEmojis: string[];
  onEmojiClick: (emoji: string) => void;
  replyingTo: ChatMessageView | null;
  onCancelReply: () => void;
  activeChat: Chat;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onTriggerFileSelect: () => void;
  messageInput: string;
  onMessageInputChange: (value: string) => void;
  onSubmit: (e?: React.FormEvent) => void;
  canWrite: boolean;
  sending: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function MessageComposer({
  attachment,
  previewUrl,
  onRemoveAttachment,
  showEmojiPicker,
  onToggleEmojiPicker,
  popularEmojis,
  onEmojiClick,
  replyingTo,
  onCancelReply,
  activeChat,
  fileInputRef,
  onFileChange,
  onTriggerFileSelect,
  messageInput,
  onMessageInputChange,
  onSubmit,
  canWrite,
  sending,
  t,
}: MessageComposerProps) {
  return (
    <>
      {/* Attachment preview banner */}
      {attachment && (
        <div className="attachment-preview-banner">
          {previewUrl ? (
            <img src={previewUrl} alt={attachment.filename} className="preview-thumbnail" />
          ) : (
            <div className="preview-file-icon">📎</div>
          )}
          <div className="preview-file-info">
            <span className="preview-filename">{attachment.filename}</span>
            <span className="preview-filesize">({(attachment.file.size / 1024).toFixed(1)} KB)</span>
          </div>
          <button className="btn-remove-attachment" onClick={onRemoveAttachment}>
            <X size={18} />
          </button>
        </div>
      )}

      {/* Popular emojis panel */}
      {showEmojiPicker && (
        <div className="chats-emoji-picker">
          <div className="emoji-grid">
            {popularEmojis.map(emoji => (
              <button
                key={emoji}
                type="button"
                className="emoji-btn"
                onClick={() => onEmojiClick(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Replying preview banner */}
      {replyingTo && (
        <div className="replying-preview-banner">
          <div className="replying-preview-content">
            <div className="replying-to-title">
              {t('chats.replyingTo', {
                name:
                  replyingTo.direction === 'outgoing'
                    ? t('chats.you')
                    : activeChat.name || activeChat.id.split('@')[0],
              })}
            </div>
            <div className="replying-to-body">
              {replyingTo.type !== 'text' ? `[${replyingTo.type}]` : replyingTo.body}
            </div>
          </div>
          <button className="btn-close-reply" onClick={onCancelReply}>
            <X size={18} />
          </button>
        </div>
      )}

      {/* Message input bar */}
      <footer className="room-input-footer">
        <form onSubmit={onSubmit} className="input-form">
          <input type="file" ref={fileInputRef} onChange={onFileChange} style={{ display: 'none' }} />

          <button
            type="button"
            onClick={onTriggerFileSelect}
            disabled={!canWrite || sending}
            className="btn-input-accessory"
            title={t('chats.attachTitle')}
          >
            <Paperclip size={20} />
          </button>

          <button
            type="button"
            onClick={onToggleEmojiPicker}
            disabled={!canWrite || sending}
            className={`btn-input-accessory ${showEmojiPicker ? 'active' : ''}`}
            title={t('chats.emojiTitle')}
          >
            <Smile size={20} />
          </button>

          <input
            type="text"
            placeholder={
              canWrite
                ? attachment
                  ? t('chats.captionPlaceholder')
                  : t('chats.messagePlaceholder')
                : t('chats.noPermission')
            }
            value={messageInput}
            onChange={e => onMessageInputChange(e.target.value)}
            disabled={!canWrite || sending}
            className="message-text-input"
          />
          <button
            type="submit"
            disabled={!canWrite || (!messageInput.trim() && !attachment) || sending}
            className="btn-send-message"
            aria-label={t('chats.send')}
          >
            {sending ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
          </button>
        </form>
      </footer>
    </>
  );
}
