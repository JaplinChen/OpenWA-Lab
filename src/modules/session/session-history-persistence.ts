import { Repository, In } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { resolveFeatureFlags } from '../../config/feature-flags';

interface HistoryLogger {
  log(message: string, meta?: Record<string, unknown>): void;
}

/** Collaborators for history persistence. All constructor-stable on SessionService — this path touches
 *  no engine/lifecycle state, only the messages table. */
export interface HistoryPersistenceCtx {
  messageRepository: Repository<Message>;
  configService?: ConfigService;
  logger: HistoryLogger;
}

/**
 * Persist pre-connection history into the `messages` table for the chat view, without webhook/hook/ws
 * dispatch (it predates the live session). De-duplicated by `waMessageId` so re-syncs never duplicate.
 */
export async function persistHistoryMessages(
  ctx: HistoryPersistenceCtx,
  id: string,
  messages: IncomingMessage[],
): Promise<void> {
  const storeEphemeralMessages = resolveFeatureFlags(ctx.configService).storeEphemeralMessages;
  const byId = new Map<string, IncomingMessage>();
  for (const m of messages) {
    // Need an id to de-dup; chatId/from/to are NOT NULL; status/story posts aren't chats.
    if (!m.id || m.isStatusBroadcast || !m.chatId || !m.from || !m.to) {
      continue;
    }
    // Mirror the live onMessage guard: skip disappearing messages when the operator opted out, so a
    // history backfill can't bypass STORE_EPHEMERAL_MESSAGES=false. No-op when the flag is at its
    // default (true); only a message with a positive timer is dropped, never a regular one.
    if (!storeEphemeralMessages && (m.ephemeralDuration ?? 0) > 0) {
      continue;
    }
    byId.set(m.id, m);
  }
  if (byId.size === 0) {
    return;
  }
  // Chunk the dedup query: a batch can be thousands, past SQLite's bound-variable limit for IN (...).
  const ids = [...byId.keys()];
  const CHUNK = 400;
  let inserted = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunkIds = ids.slice(i, i + CHUNK);
    const existing = await ctx.messageRepository.find({
      where: { sessionId: id, waMessageId: In(chunkIds) },
      select: ['waMessageId'],
    });
    const seen = new Set(existing.map(r => r.waMessageId));
    const rows = chunkIds
      .filter(x => !seen.has(x))
      .map(x => {
        const m = byId.get(x)!;
        const metadata: Record<string, unknown> = {};
        if (m.media) metadata.media = m.media;
        if (m.quotedMessage) metadata.quotedMessage = m.quotedMessage;
        if (m.call) metadata.call = m.call;
        if (m.isGroup && !m.fromMe) {
          const senderName = m.contact?.name ?? m.contact?.pushName;
          if (senderName) metadata.senderName = senderName;
        }
        const row = ctx.messageRepository.create({
          sessionId: id,
          waMessageId: m.id,
          chatId: m.chatId,
          from: m.from,
          to: m.to,
          body: m.body,
          type: m.type,
          direction: m.fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
          timestamp: m.timestamp,
          status: MessageStatus.SENT,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });
        // The chat panel orders by createdAt; stamp the real time so history sorts correctly.
        if (m.timestamp) {
          row.createdAt = new Date(m.timestamp * 1000);
        }
        return row;
      });
    if (rows.length) {
      // Insert-or-ignore: a live onMessage insert can land between the `seen` SELECT above and this
      // write, colliding on UNIQUE(sessionId, waMessageId). orIgnore skips the collision instead of
      // throwing and aborting the whole batch (history is best-effort, persist-never-dispatch).
      await ctx.messageRepository
        .createQueryBuilder()
        .insert()
        .values(rows as unknown as QueryDeepPartialEntity<Message>[])
        .orIgnore()
        .execute();
      inserted += rows.length;
    }
  }
  if (inserted) {
    ctx.logger.log(`Persisted ${inserted} history message(s)`, {
      sessionId: id,
      inserted,
      action: 'history_messages_persisted',
    });
  }
}
