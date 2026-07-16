import type * as BaileysLib from '@whiskeysockets/baileys';
import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage, WASocket } from '@whiskeysockets/baileys';
import {
  EngineEventCallbacks,
  MessageResult,
  StatusPostOptions,
  StatusResult,
} from '../interfaces/whatsapp-engine.interface';
import { BaileysAdapterConfig } from '../types/baileys.types';
import { BaileysSessionStore } from './baileys-session-store';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';
import { toUnixSeconds, toStatusResult } from './baileys-adapter.helpers';
import { InboundMapperCtx, mapMessage } from './baileys-inbound-mapper';

interface SendLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Collaborators the outbound send pipeline needs. `sock` / `callbacks` / `mapperCtx` / `loadLib` are
 * CLOSURES, not snapshots: the adapter reassigns `sock` on every reconnect, so they must read it live at
 * call time — capturing the socket here would silently send on a dead socket after a reconnect.
 */
export interface AdapterSendCtx {
  sock: () => WASocket | null;
  sessionStore: BaileysSessionStore;
  config: BaileysAdapterConfig;
  logger: SendLogger;
  loadLib: () => Promise<typeof BaileysLib>;
  callbacks: () => EngineEventCallbacks;
  mapperCtx: () => InboundMapperCtx;
  ensureReady: () => void;
}

/**
 * Resolve a 1:1 phone-dialect chat id (`@c.us` / `@s.whatsapp.net`) to the contact's `@lid` when the
 * mapping is known. WhatsApp rejects PN-addressed 1:1 sends to LID-migrated accounts with ack error
 * 463 ("missing tctoken" — the privacy token is stored and honored under the LID), while the very
 * same send addressed to the LID delivers (verified live). Groups, broadcast, already-lid and
 * unmapped ids pass through unchanged, reproducing the previous behavior.
 */
export async function toDeliverableJid(ctx: AdapterSendCtx, chatId: string): Promise<string> {
  if (!chatId.endsWith('@c.us') && !chatId.endsWith('@s.whatsapp.net')) {
    return chatId;
  }
  try {
    const pn = ctx.sessionStore.toEngineJid(chatId);
    const lid = await ctx.sock()?.signalRepository?.lidMapping?.getLIDForPN(pn);
    return lid ?? chatId;
  } catch {
    return chatId; // resolution is best-effort; an unmapped contact sends to the PN as before
  }
}

/**
 * Fold the chat's known disappearing-messages timer into Baileys' send options so outbound messages
 * honor the chat's ephemeral setting (#473). Returns `options` unchanged when no positive timer is
 * cached: omitting `ephemeralExpiration` reproduces today's behavior (Baileys' send guard is truthy),
 * so an unknown / boot-window / stale-empty cache never forces a message to disappear. Returning
 * `undefined` keeps the send a 2-arg call, identical to before. React/delete/status do not route
 * through here, so they are excluded by construction (reactions are NOT excluded by Baileys' guard).
 */
export function withEphemeral(
  ctx: AdapterSendCtx,
  chatId: string,
  options?: MiscMessageGenerationOptions,
): MiscMessageGenerationOptions | undefined {
  const ephemeralExpiration = ctx.sessionStore.getEphemeralExpiration(chatId);
  if (ephemeralExpiration === undefined) {
    return options;
  }
  return { ...options, ephemeralExpiration };
}

/** Send a Baileys content object and shape the result like the other sends. */
export async function sendContent(
  ctx: AdapterSendCtx,
  chatId: string,
  content: AnyMessageContent,
  options?: MiscMessageGenerationOptions,
): Promise<MessageResult> {
  const jid = await toDeliverableJid(ctx, chatId);
  const merged = withEphemeral(ctx, jid, options);
  const sent = merged
    ? await ctx.sock()!.sendMessage(jid, content, merged)
    : await ctx.sock()!.sendMessage(jid, content);
  if (sent) {
    void ctx.config.messageStore?.put(ctx.config.dbSessionId, sent).catch(err =>
      ctx.logger.warn('Failed to persist sent message to store', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    // wwjs fires `message_create` for its own API sends, which SessionService turns into `message.sent`.
    // Baileys' own socket-sends echo back only as a `type:'append'` upsert (skipped as history sync), so
    // that event never fired for API sends. Emit the outbound "created" callback here for parity —
    // best-effort and off the response path, with no media re-download (matching the wwjs payload).
    void emitOwnSendEcho(ctx, sent);
  }
  return { id: sent?.key?.id ?? '', timestamp: toUnixSeconds(sent?.messageTimestamp) };
}

/**
 * Emit the engine-neutral "message created" callback for a message this session just sent via the API,
 * so downstream `message.sent` webhook/WS/hook delivery matches the whatsapp-web.js engine. Best-effort:
 * a mapping failure must never fail the send that already succeeded.
 */
export async function emitOwnSendEcho(ctx: AdapterSendCtx, sent: WAMessage): Promise<void> {
  const onMessageCreate = ctx.callbacks().onMessageCreate;
  if (!onMessageCreate) return;
  try {
    const b = await ctx.loadLib();
    if (!sent.message || !sent.key?.remoteJid) return;
    const normalizedRoot = b.normalizeMessageContent(sent.message) ?? sent.message;
    const contentType = b.getContentType(normalizedRoot);
    // protocol / reaction / empty own messages carry no neutral "sent" content.
    if (!contentType || contentType === 'protocolMessage' || contentType === 'reactionMessage') return;
    const neutral = await mapMessage(ctx.mapperCtx(), sent, contentType, { skipMediaDownload: true });
    onMessageCreate(neutral);
  } catch (err) {
    ctx.logger.warn('Failed to emit own-send echo', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Resolve a previously-seen message from the store, or throw a clear not-found error. */
export async function requireStored(ctx: AdapterSendCtx, messageId: string): Promise<WAMessage> {
  const found = await ctx.config.messageStore?.getMessage(ctx.config.dbSessionId, messageId);
  if (!found?.key) {
    throw new MessageNotFoundError(messageId);
  }
  return found;
}

/**
 * Post a status (story) to `status@broadcast` with a denormalized `statusJidList` (the allow-list of
 * neutral recipients folded back to the engine dialect). Image/video variants route through here too.
 * The outbound status echo is NOT persisted — status isn't a chat message (the inbound filter in
 * handleMessagesUpsert already skips `type:'append'` echoes).
 */
export async function postStatus(
  ctx: AdapterSendCtx,
  content: AnyMessageContent,
  options: StatusPostOptions,
): Promise<StatusResult> {
  ctx.ensureReady();
  const statusJidList = options.recipients.map(r => ctx.sessionStore.toEngineJid(r));
  const sent = await ctx.sock()!.sendMessage('status@broadcast', content, {
    statusJidList,
    backgroundColor: options.backgroundColor,
    font: options.font,
  });
  return toStatusResult(sent);
}
