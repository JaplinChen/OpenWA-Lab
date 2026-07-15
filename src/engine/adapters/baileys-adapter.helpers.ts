import type { WAMessage } from '@whiskeysockets/baileys';
import { MediaInput, StatusResult } from '../interfaces/whatsapp-engine.interface';
import { loadRemoteMediaBuffer } from '../../common/media/load-remote-media';

// Pure helpers for BaileysAdapter — no adapter/socket state. Split out of baileys.adapter.ts.

/** Read `contextInfo.mentionedJid` off any content sub-type (normalized content). */
export function extractMentionedJids(content: WAMessage['message']): string[] | undefined {
  const sub =
    content?.extendedTextMessage ?? content?.imageMessage ?? content?.videoMessage ?? content?.documentMessage;
  const jids = (sub as { contextInfo?: { mentionedJid?: string[] | null } } | undefined)?.contextInfo?.mentionedJid;
  return jids && jids.length > 0 ? jids : undefined;
}

/** Baileys timestamps are `number | Long`; normalize to unix seconds (defaults to now when absent). */
export function toUnixSeconds(ts: number | { toNumber(): number } | null | undefined): number {
  if (ts == null) {
    return Math.floor(Date.now() / 1000);
  }
  return typeof ts === 'number' ? ts : ts.toNumber();
}

/** `628999:12@s.whatsapp.net` / `628999@s.whatsapp.net` -> `628999`. */
export function extractPhone(id: string | undefined): string | null {
  if (!id) {
    return null;
  }
  return id.split(':')[0].split('@')[0] || null;
}

/** Resolve a MediaInput's data (Buffer | base64 string | http(s) URL) to bytes + mimetype. */
export async function resolveMediaBuffer(media: MediaInput): Promise<{ data: Buffer; mimetype: string }> {
  if (Buffer.isBuffer(media.data)) {
    return { data: media.data, mimetype: media.mimetype };
  }
  if (/^https?:\/\//i.test(media.data)) {
    const fetched = await loadRemoteMediaBuffer(media.data);
    // Caller's declared mimetype wins; fall back to the response content-type.
    return { data: fetched.data, mimetype: media.mimetype || fetched.mimetype };
  }
  return { data: Buffer.from(media.data, 'base64'), mimetype: media.mimetype };
}

/** Shape a Baileys send result into a StatusResult; expiresAt is timestamp + 24h (WhatsApp status TTL). */
export function toStatusResult(sent: WAMessage | undefined): StatusResult {
  const ts = sent?.messageTimestamp ? new Date(toUnixSeconds(sent.messageTimestamp) * 1000) : new Date();
  return {
    statusId: sent?.key?.id ?? '',
    timestamp: ts,
    expiresAt: new Date(ts.getTime() + 24 * 3_600_000),
  };
}
