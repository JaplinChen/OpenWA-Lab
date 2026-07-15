import { Repository } from 'typeorm';
import { Message } from './entities/message.entity';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { resolveJidCandidates } from './message-send.helpers';

export interface GetMessagesOptions {
  chatId?: string;
  /** Filter by sender. A phone matches stored `@c.us`/`@s.whatsapp.net` ids AND any lid resolving to it. */
  from?: string;
  limit?: number;
  offset?: number;
}

/** Get message history for a session, filtered by chatId/sender (both resolved across JID dialects). */
export async function getMessages(
  deps: { messageRepository: Repository<Message>; lidMappingStore: LidMappingStoreService },
  sessionId: string,
  options: GetMessagesOptions = {},
): Promise<{ messages: Message[]; total: number }> {
  const { chatId, from } = options;
  // Sanitize pagination: a non-finite limit/offset — e.g. `?limit=abc` -> NaN —
  // must never reach TypeORM's take()/skip(). Clamp to sane bounds; fall back to defaults.
  const rawLimit = options.limit;
  const rawOffset = options.offset;
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 50;
  const offset = typeof rawOffset === 'number' && Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;

  const query = deps.messageRepository
    .createQueryBuilder('message')
    .where('message.sessionId = :sessionId', { sessionId })
    .orderBy('message.createdAt', 'DESC')
    .skip(offset)
    .take(limit);

  if (chatId) {
    // Match across dialects: a stored chatId may be `@s.whatsapp.net` (e.g. an outbound send addressed
    // by a raw engine id) while the caller filters by the neutral `@c.us` from the chat list - same
    // chat, different dialect. Resolving both sides through the table keeps them equal.
    query.andWhere('message.chatId IN (:...chatIds)', { chatIds: resolveJidCandidates(deps.lidMappingStore, chatId) });
  }

  if (from) {
    // Resolve the filter through the lid->phone table so a phone matches not just the stored
    // `<phone>@c.us` id but also any lid that resolves to the same person - turning the prior
    // silent miss (a lid-stored author vs a phone filter) into a hit.
    query.andWhere('message.from IN (:...froms)', { froms: resolveJidCandidates(deps.lidMappingStore, from) });
  }

  const [messages, total] = await query.getManyAndCount();
  return { messages, total };
}
