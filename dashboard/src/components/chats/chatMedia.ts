import { type MessageType } from '../../services/api';

export type MessageMedia = { mimetype: string; filename?: string; data?: string; omitted?: boolean; sizeBytes?: number };

// Map an attachment MIME type to the neutral MessageType for the optimistic outgoing bubble, so the
// placeholder matches what the backend will persist (e.g. a PDF is `document`, not `application`).
export const messageTypeFromMime = (mimetype: string): MessageType => {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'document';
};

// Stable per-sender color bucket (0-7) for the WhatsApp-style group name label. Simple string hash so
// the same sender always gets the same color; the 8 colors are defined as .sender-color-N in Chats.css.
export const senderColorIndex = (name: string): number => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 8;
};

export const getMediaSrc = (media?: MessageMedia): string => {
  if (!media || !media.data) return '';
  if (media.data.startsWith('data:') || media.data.startsWith('http://') || media.data.startsWith('https://')) {
    return media.data;
  }
  return `data:${media.mimetype};base64,${media.data}`;
};
