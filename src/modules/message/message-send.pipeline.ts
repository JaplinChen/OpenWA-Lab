import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { SessionService } from '../session/session.service';
import { HookManager } from '../../core/hooks';
import { TemplateService } from '../template/template.service';
import { SsrfBlockedError, SSRF_BLOCKED_CLIENT_MESSAGE } from '../../common/security/ssrf-guard';
import { SendMediaMessageDto, MessageResponseDto } from './dto';
import { Message } from './entities/message.entity';
import { IWhatsAppEngine, MessageResult } from '../../engine/interfaces/whatsapp-engine.interface';
import {
  MessagePersistenceDeps,
  saveOutgoingMessage,
  saveFailedMessage,
  persistSentState,
} from './message-persistence';
import { toClientFacingError } from './message-send.helpers';

interface SenderLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** Collaborators the outbound-send pipeline needs, threaded from MessageService. */
export interface SendContext {
  messageRepository: Repository<Message>;
  sessionService: SessionService;
  hookManager: HookManager;
  templateService: TemplateService;
  configService?: ConfigService;
  logger: SenderLogger;
}

type SaveData = Parameters<typeof saveOutgoingMessage>[2];

/** Declarative spec for one outbound send, executed by {@link runSend}. */
export interface SendSpec<T, P> {
  /** Runs after the engine is resolved but BEFORE the pending row is saved; may throw (e.g. media
   *  validation) so an invalid payload never persists a PENDING row. Result is passed to `send`. */
  prepare?: (finalDto: T) => P;
  /** The pending-row data to persist before sending (may be async, e.g. a quoted-message lookup). */
  saveData: (finalDto: T) => SaveData | Promise<SaveData>;
  /** Runs after the pending row is saved, before the send (e.g. the typing simulation). */
  beforeSend?: (engine: IWhatsAppEngine, finalDto: T) => Promise<void>;
  send: (engine: IWhatsAppEngine, finalDto: T, prepared: P) => Promise<MessageResult>;
}

function persistenceDeps(ctx: SendContext): MessagePersistenceDeps {
  return {
    messageRepository: ctx.messageRepository,
    sessionService: ctx.sessionService,
    hookManager: ctx.hookManager,
    logger: ctx.logger,
  };
}

function getEngine(ctx: SendContext, sessionId: string): IWhatsAppEngine {
  const engine = ctx.sessionService.getEngine(sessionId);
  if (!engine) {
    throw new BadRequestException(`Session '${sessionId}' is not active. Start the session first.`);
  }
  return engine;
}

/**
 * Run the pre-send `message:sending` plugin gate and return the (possibly plugin-modified) input, or
 * throw BadRequestException if a plugin blocked the send. Centralised moderation chokepoint.
 */
async function applySendingGate<T extends object>(
  ctx: SendContext,
  sessionId: string,
  type: string,
  input: T,
): Promise<T> {
  const { continue: shouldContinue, data: hookData } = await ctx.hookManager.execute(
    'message:sending',
    { sessionId, input, type },
    { sessionId, source: 'MessageService' },
  );
  if (!shouldContinue) {
    throw new BadRequestException('Message sending blocked by plugin');
  }
  return (hookData as { input: T }).input;
}

/**
 * Mark a send as FAILED, fire the `message:failed` hook (SSRF detail sanitized out), then throw a
 * client-facing error. The post-send persistence-fault path never routes here.
 */
async function failSend(
  ctx: SendContext,
  sessionId: string,
  type: string,
  message: Message,
  input: unknown,
  error: unknown,
): Promise<never> {
  await saveFailedMessage(persistenceDeps(ctx), message);
  const hookError =
    error instanceof SsrfBlockedError
      ? SSRF_BLOCKED_CLIENT_MESSAGE
      : error instanceof Error
        ? error.message
        : String(error);
  await ctx.hookManager.execute(
    'message:failed',
    { sessionId, error: hookError, input, type },
    { sessionId, source: 'MessageService' },
  );
  throw toClientFacingError(error, ctx.logger);
}

/**
 * Shared outbound-send pipeline: moderation gate → resolve engine → (optional) prepare → persist a
 * PENDING row → (optional) pre-send step → send → persist SENT (routing failures through failSend). The
 * `message:sent` hook is emitted solely by SessionService.onMessageCreate, so it is not fired here.
 */
export async function runSend<T extends object, P = void>(
  ctx: SendContext,
  sessionId: string,
  type: string,
  input: T,
  spec: SendSpec<T, P>,
): Promise<MessageResponseDto> {
  const finalDto = await applySendingGate(ctx, sessionId, type, input);
  const engine = getEngine(ctx, sessionId);
  const prepared = (spec.prepare ? spec.prepare(finalDto) : undefined) as P;
  const message = await saveOutgoingMessage(persistenceDeps(ctx), sessionId, await spec.saveData(finalDto));
  if (spec.beforeSend) await spec.beforeSend(engine, finalDto);

  let result: MessageResult;
  try {
    result = await spec.send(engine, finalDto, prepared);
  } catch (error) {
    return failSend(ctx, sessionId, type, message, finalDto, error);
  }
  return persistSentState(persistenceDeps(ctx), message, result);
}

/** Standard media metadata block for the persisted row (base64 preferred over url, mirroring the send). */
export function mediaMetadata(dto: SendMediaMessageDto): Record<string, unknown> {
  return { media: { mimetype: dto.mimetype, filename: dto.filename, data: dto.base64 || dto.url } };
}

/** Best-effort resolution of a quoted message's body so the dashboard can render the reply preview. */
export async function resolveQuotedBody(ctx: SendContext, sessionId: string, quotedMessageId: string): Promise<string> {
  try {
    const quoted = await ctx.messageRepository.findOne({ where: { sessionId, waMessageId: quotedMessageId } });
    return quoted?.body || '';
  } catch (err) {
    ctx.logger.warn(`Failed to resolve quoted message ${quotedMessageId}`, { error: String(err) });
    return '';
  }
}
