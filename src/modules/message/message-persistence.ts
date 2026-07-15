import { Repository } from 'typeorm';
import { SessionService } from '../session/session.service';
import { HookManager } from '../../core/hooks';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { MessageResult } from '../../engine/interfaces/whatsapp-engine.interface';
import { MessageResponseDto } from './dto';

interface PersistenceLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** Collaborators the message-persistence helpers need, threaded from MessageService. */
export interface MessagePersistenceDeps {
  messageRepository: Repository<Message>;
  sessionService: SessionService;
  hookManager: HookManager;
  logger: PersistenceLogger;
}

/** Save an incoming message (called from session webhook dispatch). */
export function saveIncomingMessage(
  deps: MessagePersistenceDeps,
  sessionId: string,
  data: Partial<Message>,
): Promise<Message> {
  const message = deps.messageRepository.create({
    ...data,
    sessionId,
    direction: MessageDirection.INCOMING,
  });
  return deps.messageRepository.save(message);
}

/**
 * Save outgoing message to database. When called before sending, creates a record with PENDING status;
 * bulk send reuses this after a successful send (status SENT) so batch messages are persisted like single sends.
 */
export async function saveOutgoingMessage(
  deps: MessagePersistenceDeps,
  sessionId: string,
  data: {
    waMessageId?: string;
    chatId: string;
    body?: string;
    type: string;
    timestamp?: number;
    status?: MessageStatus;
    metadata?: Record<string, unknown>;
  },
): Promise<Message> {
  const session = await deps.sessionService.findOne(sessionId);
  const message = deps.messageRepository.create({
    sessionId,
    waMessageId: data.waMessageId,
    chatId: data.chatId,
    from: session?.phone || 'me',
    to: data.chatId,
    body: data.body,
    type: data.type,
    direction: MessageDirection.OUTGOING,
    timestamp: data.timestamp,
    status: data.status ?? MessageStatus.PENDING,
    metadata: data.metadata,
  });
  const saved = await deps.messageRepository.save(message);
  // Fire-and-forget: a plugin handler must never break the send path. The built-in FTS search provider
  // is DB-synced and does NOT consume this; it exists for plugin providers (Spec 2) + general use.
  void deps.hookManager
    .execute('message:persisted', { sessionId, message: saved }, { sessionId, source: 'MessageService' })
    .catch(() => undefined);
  return saved;
}

/**
 * Persist a send as FAILED, dropping any outbound media payload first. A failed row's media base64
 * (often multi-MB) is never displayed or retried, so keeping it only bloats the messages table; the
 * mimetype/filename are kept so the row still describes what was attempted.
 */
export async function saveFailedMessage(deps: MessagePersistenceDeps, message: Message): Promise<void> {
  const media = (message.metadata as { media?: { data?: unknown } } | undefined)?.media;
  if (media) {
    delete media.data;
  }
  message.status = MessageStatus.FAILED;
  await deps.messageRepository.save(message);
}

/**
 * Persist the SENT state AFTER the engine has already accepted the message. The send already
 * succeeded, so a failure to write the SENT row must NOT be surfaced as a send failure — a transient
 * DB fault would otherwise mark a delivered message permanently FAILED and (for text) fire
 * `message:failed`. Log and return success instead.
 */
export async function persistSentState(
  deps: MessagePersistenceDeps,
  message: Message,
  result: MessageResult,
): Promise<MessageResponseDto> {
  // A forward whose engine couldn't recover the sent copy's id returns an empty id — leave waMessageId
  // unset (NULL) so no ack mis-matches it. Every other send path carries a real id.
  if (result.id) message.waMessageId = result.id;
  message.status = MessageStatus.SENT;
  message.timestamp = result.timestamp;
  try {
    await deps.messageRepository.save(message);
  } catch (persistError) {
    deps.logger.warn(`Persisting SENT state failed after a successful send (id=${result.id})`, {
      error: persistError instanceof Error ? persistError.message : String(persistError),
    });
  }
  return { messageId: result.id, timestamp: result.timestamp };
}
