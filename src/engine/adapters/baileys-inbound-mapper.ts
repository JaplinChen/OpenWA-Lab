import type * as BaileysLib from '@whiskeysockets/baileys';
import type { WAMessage } from '@whiskeysockets/baileys';
import { IncomingMessage } from '../interfaces/whatsapp-engine.interface';
import { buildIncomingMessageFromBaileys, extractBaileysBody } from './baileys-message-mapper';
import { userPart } from '../identity/wa-id';
import { BaileysSessionStore } from './baileys-session-store';
import { capInboundMedia, coerceDeclaredSize, inboundMediaMaxBytes, isMediaDownloadEnabled } from './inbound-media-cap';
import { extractMentionedJids, toUnixSeconds } from './baileys-adapter.helpers';

interface MapperLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Collaborators the inbound mappers need. `normalizedSelfJid` / `downloadMedia` / `loadLib` are passed as
 * CLOSURES, not snapshots: the adapter reassigns `sock` on every reconnect, so they must read it live at
 * call time — capturing the socket here would silently break inbound after a reconnect.
 */
export interface InboundMapperCtx {
  loadLib: () => Promise<typeof BaileysLib>;
  sessionStore: BaileysSessionStore;
  logger: MapperLogger;
  normalizedSelfJid: () => string;
  downloadMedia: (msg: WAMessage, maxBytes: number) => Promise<Buffer | null>;
}

/**
 * Replace `@<number>` mention tokens in a message body with the mentioned contact's display name, so
 * the dashboard shows `@Alice` instead of `@6894043275414`. Resolves each raw mentioned JID through the
 * session store (saved name → verifiedName → pushName); tokens with no known name are left untouched.
 */
export function resolveMentionNames(ctx: InboundMapperCtx, body: string, mentionedJids?: string[]): string {
  if (!body || !mentionedJids?.length) {
    return body;
  }
  let out = body;
  for (const jid of mentionedJids) {
    const digits = userPart(jid);
    if (!digits) {
      continue;
    }
    const name = ctx.sessionStore.displayName(jid);
    if (name && name !== digits) {
      out = out.split(`@${digits}`).join(`@${name}`);
    }
  }
  return out;
}

export async function mapMessage(
  ctx: InboundMapperCtx,
  msg: WAMessage,
  contentType: string | undefined,
  opts?: { skipMediaDownload?: boolean },
): Promise<IncomingMessage> {
  const b = await ctx.loadLib();
  const content = msg.message ?? {};
  // Read body/isPtt off the NORMALIZED content: a disappearing message (ephemeralMessage), a captioned
  // document (documentWithCaptionMessage) and viewOnce/edited wrappers nest the real text/caption under
  // an inner message, so the raw wrapper exposes none at top level. Identity no-op when unwrapped.
  const normalized = b.normalizeMessageContent(content) ?? content;

  // Body: text first, then media caption, then WhatsApp Business interactive shapes (#562).
  const body = extractBaileysBody(normalized);

  // --- location ---
  // ILocationMessage has name/address; ILiveLocationMessage does not — use the static variant only.
  let location: IncomingMessage['location'];
  if (contentType === 'locationMessage' || contentType === 'liveLocationMessage') {
    // Read off the NORMALIZED content: an ephemeral/disappearing-chat location nests under the wrapper,
    // so the raw `content.locationMessage` is undefined and the coordinates would be silently dropped.
    const lm = normalized.locationMessage ?? normalized.liveLocationMessage;
    if (lm) {
      const staticLm = normalized.locationMessage; // only ILocationMessage has name/address
      location = {
        latitude: lm.degreesLatitude ?? 0,
        longitude: lm.degreesLongitude ?? 0,
        description: staticLm?.name ?? undefined,
        address: staticLm?.address ?? undefined,
      };
    }
  }

  // --- media (image / video / audio / document / sticker) ---
  let media: IncomingMessage['media'];
  const isMediaType =
    contentType === 'imageMessage' ||
    contentType === 'videoMessage' ||
    contentType === 'audioMessage' ||
    contentType === 'documentMessage' ||
    contentType === 'documentWithCaptionMessage' ||
    contentType === 'stickerMessage';
  if (isMediaType) {
    // The outbound "sent" echo passes skipMediaDownload: the sender already holds the media, and for
    // parity with the wwjs message.sent (which carries no media buffer) we emit only the marker here.
    if (opts?.skipMediaDownload || !isMediaDownloadEnabled()) {
      // Emit the omitted marker so the media field is present (webhook/n8n/dashboard contract).
      // mimetype is available pre-download from the message content.
      const normalizedContent = b.normalizeMessageContent(content) ?? content;
      const subMessage =
        normalizedContent.imageMessage ??
        normalizedContent.videoMessage ??
        normalizedContent.audioMessage ??
        normalizedContent.documentMessage ??
        normalizedContent.stickerMessage;
      media = {
        mimetype: subMessage?.mimetype ?? '',
        filename: normalizedContent.documentMessage?.fileName ?? undefined,
        omitted: true,
        sizeBytes: coerceDeclaredSize(subMessage?.fileLength),
      };
    } else {
      // normalizeMessageContent unwraps documentWithCaptionMessage / viewOnceMessage / ephemeralMessage
      // so we reach the inner media sub-message — needed BEFORE download for the declared-size pre-gate.
      const normalizedContent = b.normalizeMessageContent(content) ?? content;
      const subMessage =
        normalizedContent.imageMessage ??
        normalizedContent.videoMessage ??
        normalizedContent.audioMessage ??
        normalizedContent.documentMessage ??
        normalizedContent.stickerMessage;
      const mimetype = subMessage?.mimetype ?? '';
      const filename = normalizedContent.documentMessage?.fileName ?? undefined;
      const maxBytes = inboundMediaMaxBytes();
      const declared = coerceDeclaredSize(subMessage?.fileLength);

      if (declared > maxBytes) {
        // Pre-download gate: an honest over-cap sender's media is never decrypted into heap at all
        // (Baileys integrity-checks content against the declared size, so this is a robust bound).
        media = { mimetype, filename, omitted: true, sizeBytes: declared };
        ctx.logger.warn('Inbound media declared size exceeds MEDIA_DOWNLOAD_MAX_BYTES; skipped download', {
          msgId: msg.key.id,
          sizeBytes: declared,
        });
      } else {
        try {
          // Stream-download with a running-total abort so a sender who understates fileLength still
          // can't materialise an over-cap blob. For under-cap media this yields the identical buffer.
          const buf = await ctx.downloadMedia(msg, maxBytes);
          if (buf === null) {
            media = { mimetype, filename, omitted: true, sizeBytes: maxBytes };
            ctx.logger.warn(
              'Inbound media download aborted (over MEDIA_DOWNLOAD_MAX_BYTES or past MEDIA_DOWNLOAD_TIMEOUT_MS); emitting omitted marker',
              { msgId: msg.key.id },
            );
          } else {
            // capInboundMedia is the last line (lazy base64, never persist/webhook/broadcast an over-cap
            // blob); the real heap bound is the pre-gate + streaming abort + concurrency limiter.
            media = capInboundMedia({
              mimetype,
              filename,
              sizeBytes: buf.byteLength,
              toBase64: () => buf.toString('base64'),
            });
          }
        } catch (err) {
          ctx.logger.debug('Failed to download inbound media; emitting message without media', {
            error: err instanceof Error ? err.message : String(err),
            msgId: msg.key.id,
          });
        }
      }
    }
  }

  // --- quoted message + disappearing-messages timer ---
  let quotedMessage: IncomingMessage['quotedMessage'];
  // Read context off the NORMALIZED content: a live disappearing message arrives wrapped in
  // `ephemeralMessage` (also viewOnce / documentWithCaption), whose inner content carries the
  // contextInfo. The raw wrapper exposes none at top level, so both the quote and the timer
  // (`contextInfo.expiration`) would be missed if we read the raw content here.
  const normalizedForContext = b.normalizeMessageContent(content) ?? content;
  const subForContext =
    normalizedForContext.extendedTextMessage ??
    normalizedForContext.imageMessage ??
    normalizedForContext.videoMessage ??
    normalizedForContext.audioMessage ??
    normalizedForContext.documentMessage ??
    normalizedForContext.stickerMessage ??
    normalizedForContext.locationMessage;
  const contextInfo = (
    subForContext as
      | {
          contextInfo?: {
            stanzaId?: string | null;
            quotedMessage?: Record<string, unknown> | null;
            expiration?: number | null;
            mentionedJid?: string[] | null;
          };
        }
      | undefined
  )?.contextInfo;
  if (contextInfo?.quotedMessage && contextInfo.stanzaId) {
    const qm = contextInfo.quotedMessage as {
      conversation?: string | null;
      extendedTextMessage?: { text?: string | null } | null;
      imageMessage?: { caption?: string | null } | null;
      videoMessage?: { caption?: string | null } | null;
      documentMessage?: { caption?: string | null } | null;
    };
    const qBody =
      qm.conversation ??
      qm.extendedTextMessage?.text ??
      qm.imageMessage?.caption ??
      qm.videoMessage?.caption ??
      qm.documentMessage?.caption ??
      '';
    quotedMessage = { id: contextInfo.stanzaId, body: qBody };
  }

  const incoming = buildIncomingMessageFromBaileys(
    {
      id: msg.key.id ?? '',
      remoteJid: msg.key.remoteJid!,
      fromMe: msg.key.fromMe === true,
      participant: msg.key.participant ?? undefined,
      body,
      contentType,
      isPtt: normalized.audioMessage?.ptt === true,
      timestamp: toUnixSeconds(msg.messageTimestamp),
      pushName: msg.pushName ?? undefined,
      selfJid: ctx.normalizedSelfJid(),
      media,
      location,
      quotedMessage,
      ephemeralDuration: contextInfo?.expiration ?? undefined,
      mentionedJids: contextInfo?.mentionedJid ?? undefined,
    },
    jid => ctx.sessionStore.toNeutralJid(jid),
  );
  incoming.body = resolveMentionNames(ctx, incoming.body, contextInfo?.mentionedJid ?? undefined);
  return incoming;
}

/**
 * Media-free WAMessage -> IncomingMessage map for bulk history (downloading media for thousands of
 * messages would be ruinous; the type is kept, the payload dropped). Returns null for protocol /
 * reaction / key / empty messages, which carry nothing for the chat view.
 */
export function mapHistoryMessage(ctx: InboundMapperCtx, b: typeof BaileysLib, msg: WAMessage): IncomingMessage | null {
  const raw = msg.message;
  if (!raw || !msg.key?.remoteJid || !msg.key.id) {
    return null;
  }
  // Unwrap ephemeral/viewOnce/documentWithCaption/edited wrappers so the real type and body surface —
  // else a disappearing-chat message maps to type 'unknown' with an empty body. Identity no-op when
  // already unwrapped. Derive ONE contentType from the normalized content for both the skip-filter and
  // the type mapping, and reuse extractBaileysBody (the same body extraction the live path uses).
  const content = b.normalizeMessageContent(raw) ?? raw;
  const contentType = b.getContentType(content);
  if (
    !contentType ||
    contentType === 'protocolMessage' ||
    contentType === 'reactionMessage' ||
    contentType === 'senderKeyDistributionMessage'
  ) {
    return null;
  }
  const body = extractBaileysBody(content);
  const mentionedJids = extractMentionedJids(content);
  const incoming = buildIncomingMessageFromBaileys(
    {
      id: msg.key.id,
      remoteJid: msg.key.remoteJid,
      fromMe: msg.key.fromMe === true,
      participant: msg.key.participant ?? undefined,
      body,
      contentType,
      isPtt: content.audioMessage?.ptt === true,
      timestamp: toUnixSeconds(msg.messageTimestamp),
      pushName: msg.pushName ?? undefined,
      selfJid: ctx.normalizedSelfJid(),
      // Populate the disappearing-messages timer using the same extraction the live path and the
      // session-store cache share (`msg.ephemeralDuration` primary, `contextInfo.expiration` fallback),
      // so the history sink can apply the STORE_EPHEMERAL_MESSAGES opt-out symmetrically with onMessage.
      ephemeralDuration: ctx.sessionStore.extractEphemeralDuration(msg),
      mentionedJids,
    },
    jid => ctx.sessionStore.toNeutralJid(jid),
  );
  incoming.body = resolveMentionNames(ctx, incoming.body, mentionedJids);
  return incoming;
}
