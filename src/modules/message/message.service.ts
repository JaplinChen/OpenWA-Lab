import { Injectable, BadRequestException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SessionService } from '../session/session.service';
import { SendTextMessageDto, SendMediaMessageDto, SendAudioMessageDto, MessageResponseDto } from './dto';
import { SendTemplateMessageDto } from './dto/send-template.dto';
import { Message } from './entities/message.entity';
import { HookManager } from '../../core/hooks';
import { TemplateService } from '../template/template.service';
import { createLogger } from '../../common/services/logger.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { MessagePersistenceDeps, saveIncomingMessage, saveOutgoingMessage } from './message-persistence';
import { GetMessagesOptions, getMessages } from './message-query';
import * as senders from './message-senders';
import type { SendContext } from './message-senders';

export type { GetMessagesOptions } from './message-query';

type SaveData = Parameters<typeof saveOutgoingMessage>[2];

/**
 * Outbound sends are executed directly against the WhatsApp engine, not via a BullMQ queue: the engine
 * is single-threaded per session and is itself the serialization point for that session's outbound
 * traffic, so a queue would add latency + a Redis hard dependency for no throughput benefit. BullMQ is
 * reserved for durable-retry side-effects (webhook delivery, ingress); there is no MESSAGE queue.
 *
 * The send pipeline (gate → persist → send → persist) lives in message-senders.ts; this service is the
 * DI facade that threads its collaborators in via {@link sendCtx} and exposes the public API.
 */
@Injectable()
export class MessageService {
  private readonly logger = createLogger('MessageService');

  constructor(
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    private readonly sessionService: SessionService,
    private readonly hookManager: HookManager,
    private readonly templateService: TemplateService,
    private readonly lidMappingStore: LidMappingStoreService,
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  private get sendCtx(): SendContext {
    return {
      messageRepository: this.messageRepository,
      sessionService: this.sessionService,
      hookManager: this.hookManager,
      templateService: this.templateService,
      configService: this.configService,
      logger: this.logger,
    };
  }

  private get persistenceDeps(): MessagePersistenceDeps {
    return {
      messageRepository: this.messageRepository,
      sessionService: this.sessionService,
      hookManager: this.hookManager,
      logger: this.logger,
    };
  }

  sendText(sessionId: string, dto: SendTextMessageDto): Promise<MessageResponseDto> {
    return senders.sendText(this.sendCtx, sessionId, dto);
  }

  sendTemplate(sessionId: string, dto: SendTemplateMessageDto): Promise<MessageResponseDto> {
    return senders.sendTemplate(this.sendCtx, sessionId, dto);
  }

  sendImage(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    return senders.sendImage(this.sendCtx, sessionId, dto);
  }

  sendVideo(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    return senders.sendVideo(this.sendCtx, sessionId, dto);
  }

  sendAudio(sessionId: string, dto: SendAudioMessageDto): Promise<MessageResponseDto> {
    return senders.sendAudio(this.sendCtx, sessionId, dto);
  }

  sendDocument(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    return senders.sendDocument(this.sendCtx, sessionId, dto);
  }

  sendSticker(sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
    return senders.sendSticker(this.sendCtx, sessionId, dto);
  }

  sendLocation(
    sessionId: string,
    dto: { chatId: string; latitude: number; longitude: number; description?: string; address?: string },
  ): Promise<MessageResponseDto> {
    return senders.sendLocation(this.sendCtx, sessionId, dto);
  }

  sendContact(
    sessionId: string,
    dto: { chatId: string; contactName: string; contactNumber: string },
  ): Promise<MessageResponseDto> {
    return senders.sendContact(this.sendCtx, sessionId, dto);
  }

  sendPoll(
    sessionId: string,
    dto: { chatId: string; name: string; options: string[]; allowMultipleAnswers?: boolean },
  ): Promise<MessageResponseDto> {
    return senders.sendPoll(this.sendCtx, sessionId, dto);
  }

  reply(
    sessionId: string,
    dto: { chatId: string; quotedMessageId: string; text: string },
  ): Promise<MessageResponseDto> {
    return senders.reply(this.sendCtx, sessionId, dto);
  }

  forward(
    sessionId: string,
    dto: { fromChatId: string; toChatId: string; messageId: string },
  ): Promise<MessageResponseDto> {
    return senders.forward(this.sendCtx, sessionId, dto);
  }

  getMessages(sessionId: string, options: GetMessagesOptions = {}): Promise<{ messages: Message[]; total: number }> {
    return getMessages(
      { messageRepository: this.messageRepository, lidMappingStore: this.lidMappingStore },
      sessionId,
      options,
    );
  }

  /** Save incoming message (called from session webhook dispatch). */
  saveIncomingMessage(sessionId: string, data: Partial<Message>): Promise<Message> {
    return saveIncomingMessage(this.persistenceDeps, sessionId, data);
  }

  /** Save outgoing message (PENDING before send; reused by bulk send after a successful send). */
  saveOutgoingMessage(sessionId: string, data: SaveData): Promise<Message> {
    return saveOutgoingMessage(this.persistenceDeps, sessionId, data);
  }

  // ========== Reactions / history / delete (engine reads/ops) ==========

  async reactToMessage(sessionId: string, dto: { chatId: string; messageId: string; emoji: string }): Promise<void> {
    const engine = this.getEngine(sessionId);
    await engine.reactToMessage(dto.chatId, dto.messageId, dto.emoji);
  }

  async getMessageReactions(sessionId: string, chatId: string, messageId: string) {
    const engine = this.getEngine(sessionId);
    return engine.getMessageReactions(chatId, messageId);
  }

  /** Maximum messages a single getChatHistory call may request from the engine. */
  private static readonly MAX_CHAT_HISTORY_LIMIT = 100;
  /** Higher ceiling for opt-in deep history (`deep=true`). Bounded so a caller still can't ask unbounded. */
  private static readonly MAX_DEEP_CHAT_HISTORY_LIMIT = 2000;

  /**
   * Fetch chat history live from WhatsApp (bypasses local DB). `limit` is clamped to [1, 100] (falling
   * back to 50 for non-finite input); when `deep` is true the ceiling is raised to 2000 and media is
   * forced off (downloading base64 for up to 2000 messages would be an enormous, slow payload).
   */
  async getChatHistory(sessionId: string, chatId: string, limit = 50, includeMedia = false, deep = false) {
    const engine = this.getEngine(sessionId);
    const ceiling = deep ? MessageService.MAX_DEEP_CHAT_HISTORY_LIMIT : MessageService.MAX_CHAT_HISTORY_LIMIT;
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), ceiling) : 50;
    return engine.getChatHistory(chatId, safeLimit, deep ? false : includeMedia);
  }

  async deleteMessage(
    sessionId: string,
    dto: { chatId: string; messageId: string; forEveryone?: boolean },
  ): Promise<void> {
    const engine = this.getEngine(sessionId);
    await engine.deleteMessage(dto.chatId, dto.messageId, dto.forEveryone ?? true);

    // Flag the stored message as revoked. No localized display string is persisted here;
    // the dashboard renders the localized "message deleted" text.
    try {
      await this.messageRepository.update({ sessionId, waMessageId: dto.messageId }, { body: '', type: 'revoked' });
    } catch (err) {
      this.logger.warn(`Failed to flag deleted message ${dto.messageId} as revoked`, { error: String(err) });
    }
  }

  private getEngine(sessionId: string) {
    const engine = this.sessionService.getEngine(sessionId);
    if (!engine) {
      throw new BadRequestException(`Session '${sessionId}' is not active. Start the session first.`);
    }
    return engine;
  }
}
