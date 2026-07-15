import { CornerUpLeft, Smile, Trash2 } from 'lucide-react';
import { type ChatMessageView } from '../../utils/chatMessages';
import { getMediaSrc, senderColorIndex } from './chatMedia';
import MessageBody from './MessageBody';

interface MessageBubbleProps {
  msg: ChatMessageView;
  isMe: boolean;
  formattedTime: string;
  showSenderName: boolean;
  senderName?: string;
  onReply: (msg: ChatMessageView) => void;
  onReact: (msg: ChatMessageView, emoji: string) => void;
  onDelete: (msg: ChatMessageView) => void;
  onOpenLightbox: (msgId: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function MessageBubble({
  msg,
  isMe,
  formattedTime,
  showSenderName,
  senderName,
  onReply,
  onReact,
  onDelete,
  onOpenLightbox,
  t,
}: MessageBubbleProps) {
  const isMediaMessage = msg.type !== 'text';
  const mediaInfo = msg.metadata?.media;

  const renderMedia = () => {
    if (msg.type === 'revoked') return null;
    // location/call have no downloadable media payload — render them before the
    // mediaInfo gate. The raw body (a base64 thumbnail / empty token) is suppressed below.
    if (msg.type === 'location') {
      // WhatsApp location messages carry a base64 JPEG map-preview thumbnail in `body`.
      const thumb = msg.body && msg.body.length > 100 ? `data:image/jpeg;base64,${msg.body}` : '';
      return (
        <div className="message-location">
          {thumb && (
            <img
              src={thumb}
              alt=""
              style={{ maxWidth: 220, borderRadius: 8, display: 'block', marginBottom: 4 }}
            />
          )}
          <span className="message-media-omitted">📍 {t('chats.media.location')}</span>
        </div>
      );
    }
    if (msg.type === 'call') {
      const call = msg.metadata?.call;
      const callKey = call?.video
        ? call.missed
          ? 'callVideoMissed'
          : 'callVideo'
        : call?.missed
          ? 'callMissed'
          : 'call';
      return (
        <div className="message-media-omitted">
          {`${call?.video ? '📹' : '📞'} ${t(`chats.media.${callKey}`)}`}
        </div>
      );
    }
    if (!mediaInfo) return null;
    if (mediaInfo.omitted) {
      return <div className="message-media-omitted">📎 {t('chats.media.omitted')}</div>;
    }
    const mediaSrc = getMediaSrc(mediaInfo);
    if (!mediaSrc) return null;

    switch (msg.type) {
      case 'image':
      case 'sticker':
        return (
          <div className="message-media-image">
            <img
              src={mediaSrc}
              alt={mediaInfo.filename || t('chats.media.image')}
              className="chat-image-media"
              onClick={() => {
                onOpenLightbox(msg.id);
              }}
            />
          </div>
        );
      case 'video':
        return (
          <div className="message-media-video">
            <video src={mediaSrc} controls className="chat-video-media" />
          </div>
        );
      case 'audio':
      case 'voice':
        return (
          <div className="message-media-audio">
            <audio src={mediaSrc} controls className="chat-audio-media" />
          </div>
        );
      case 'document':
      default:
        return (
          <div className="message-media-document">
            <a
              href={mediaSrc}
              download={mediaInfo.filename || 'document'}
              className="chat-document-media"
            >
              📎 {mediaInfo.filename || t('chats.downloadDocument')}
            </a>
          </div>
        );
    }
  };

  const reactions = msg.metadata?.reactions || {};
  const hasReactions = Object.keys(reactions).length > 0;
  const isRevoked = msg.type === 'revoked';
  const isMasked = msg.type === 'masked';

  return (
    <div
      key={msg.id}
      className={`message-bubble-wrapper ${isMe ? 'outgoing' : 'incoming'}`}
      data-wa-message-id={msg.waMessageId}
    >
      <div className="message-bubble-container">
        <div
          className={`message-bubble ${isMe ? 'outgoing' : 'incoming'} ${msg.status} ${
            isMediaMessage ? 'media-type' : ''
          } ${isRevoked ? 'revoked-type' : ''}`}
        >
          {/* Group sender label — first of a consecutive run, colored per sender */}
          {showSenderName && (
            <div className={`message-sender sender-color-${senderColorIndex(senderName!)}`}>
              {senderName}
            </div>
          )}

          {/* Quoted message display */}
          {msg.metadata?.quotedMessage && (
            <div className="message-quote-box">
              <MessageBody
                text={msg.metadata.quotedMessage.body}
                className="quote-body"
              />
            </div>
          )}

          {renderMedia()}

          {isRevoked ? (
            <div className="message-text">{t('chats.messageDeleted')}</div>
          ) : isMasked ? (
            <div className="message-text message-masked">{t('chats.messageMasked')}</div>
          ) : (
            msg.body &&
            (!mediaInfo || msg.body !== mediaInfo.filename) &&
            msg.type !== 'location' &&
            msg.type !== 'call' && (
              <MessageBody text={msg.body} className="message-text" />
            )
          )}

          <div className="message-meta">
            <span className="message-time">{formattedTime}</span>
            {isMe && (
              <span className={`message-status-icon ${msg.status}`}>
                {msg.status === 'pending' && '🕒'}
                {msg.status === 'sent' && '✓'}
                {msg.status === 'delivered' && '✓✓'}
                {msg.status === 'read' && '✓✓'}
                {msg.status === 'failed' && '⚠️'}
              </span>
            )}
          </div>

          {/* Reactions display */}
          {hasReactions && (
            <div className="message-reactions-badge">
              {Object.values(reactions)
                .slice(0, 3)
                .map((emoji, idx) => (
                  <span key={idx} className="reaction-emoji-span">
                    {emoji}
                  </span>
                ))}
              {Object.keys(reactions).length > 1 && (
                <span className="reactions-count-span">
                  {Object.keys(reactions).length}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Message actions menu (hover) */}
        {!isRevoked && (
          <div className="message-actions-menu">
            <button
              type="button"
              className="action-btn"
              onClick={() => onReply(msg)}
              title={t('chats.actions.reply')}
            >
              <CornerUpLeft size={14} />
            </button>

            <div className="reaction-trigger-wrapper">
              <button
                type="button"
                className="action-btn reaction-btn"
                title={t('chats.actions.react')}
              >
                <Smile size={14} />
              </button>
              <div className="reaction-quick-popover">
                {['👍', '❤️', '😂', '😮', '😢', '🙏'].map(emoji => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => onReact(msg, emoji)}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>

            {isMe && msg.status !== 'pending' && (
              <button
                type="button"
                className="action-btn delete-btn"
                onClick={() => onDelete(msg)}
                title={t('chats.actions.delete')}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
