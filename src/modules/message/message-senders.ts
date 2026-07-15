import { renderTemplate } from '../../common/utils/template-render';
import { SendTextMessageDto, SendMediaMessageDto, SendAudioMessageDto, MessageResponseDto } from './dto';
import { SendTemplateMessageDto } from './dto/send-template.dto';
import { MediaInput } from '../../engine/interfaces/whatsapp-engine.interface';
import { buildMediaInput, simulateTypingIfEnabled } from './message-send.helpers';
import { SendContext, runSend, mediaMetadata, resolveQuotedBody } from './message-send.pipeline';

export type { SendContext } from './message-send.pipeline';

export function sendText(ctx: SendContext, sessionId: string, dto: SendTextMessageDto): Promise<MessageResponseDto> {
  return runSend(ctx, sessionId, 'text', dto, {
    saveData: d => ({ chatId: d.chatId, body: d.text, type: 'text' }),
    // Opt-in humanising "typing…" pause before the actual send (anti-automation signal).
    beforeSend: (engine, d) => simulateTypingIfEnabled(engine, d.chatId, d.text, ctx.configService, ctx.logger),
    // Keep the 2-arg call shape for plain sends; only pass mentions when the caller supplied any.
    send: (engine, d) =>
      d.mentions?.length
        ? engine.sendTextMessage(d.chatId, d.text, d.mentions)
        : engine.sendTextMessage(d.chatId, d.text),
  });
}

/**
 * Resolve a stored template, render its body (header/footer flattened with newlines), and delegate to
 * {@link sendText} so plugin hooks, persistence, and status tracking are reused.
 */
export async function sendTemplate(
  ctx: SendContext,
  sessionId: string,
  dto: SendTemplateMessageDto,
): Promise<MessageResponseDto> {
  const template = await ctx.templateService.resolve(sessionId, {
    templateId: dto.templateId,
    templateName: dto.templateName,
  });

  const vars = dto.vars ?? {};
  const text = [template.header, template.body, template.footer]
    .filter((segment): segment is string => segment != null && segment.length > 0)
    .map(segment => renderTemplate(segment, vars))
    .join('\n\n');

  return sendText(ctx, sessionId, { chatId: dto.chatId, text });
}

export function sendImage(ctx: SendContext, sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
  return runSend<SendMediaMessageDto, MediaInput>(ctx, sessionId, 'image', dto, {
    prepare: d => buildMediaInput(d),
    saveData: d => ({ chatId: d.chatId, body: d.caption || '', type: 'image', metadata: mediaMetadata(d) }),
    send: (engine, d, media) => engine.sendImageMessage(d.chatId, media),
  });
}

export function sendVideo(ctx: SendContext, sessionId: string, dto: SendMediaMessageDto): Promise<MessageResponseDto> {
  return runSend<SendMediaMessageDto, MediaInput>(ctx, sessionId, 'video', dto, {
    prepare: d => buildMediaInput(d),
    saveData: d => ({ chatId: d.chatId, body: d.caption || '', type: 'video', metadata: mediaMetadata(d) }),
    send: (engine, d, media) => engine.sendVideoMessage(d.chatId, media),
  });
}

export function sendAudio(ctx: SendContext, sessionId: string, dto: SendAudioMessageDto): Promise<MessageResponseDto> {
  // Label a PTT send 'voice' (not 'audio') so the gate, the failure hook, and the persisted row all
  // carry the same type for one outbound voice note.
  const type = dto.ptt ? 'voice' : 'audio';
  return runSend<SendAudioMessageDto, MediaInput>(ctx, sessionId, type, dto, {
    prepare: d => {
      // Voice notes need a real audio codec; default to ogg/opus when the caller omits a mimetype so the
      // wire message and the persisted record agree. Resolved BEFORE buildMediaInput so its base64
      // mimetype guard sees the effective type.
      const audioDto = d.ptt && !d.mimetype ? { ...d, mimetype: 'audio/ogg; codecs=opus' } : d;
      const media = buildMediaInput(audioDto);
      media.ptt = d.ptt;
      return media;
    },
    saveData: d => ({
      chatId: d.chatId,
      type,
      metadata: {
        media: {
          mimetype: d.ptt && !d.mimetype ? 'audio/ogg; codecs=opus' : d.mimetype,
          filename: d.filename,
          data: d.base64 || d.url,
        },
      },
    }),
    send: (engine, d, media) => engine.sendAudioMessage(d.chatId, media),
  });
}

export function sendDocument(
  ctx: SendContext,
  sessionId: string,
  dto: SendMediaMessageDto,
): Promise<MessageResponseDto> {
  return runSend<SendMediaMessageDto, MediaInput>(ctx, sessionId, 'document', dto, {
    prepare: d => buildMediaInput(d),
    saveData: d => ({
      chatId: d.chatId,
      body: d.caption || d.filename || '',
      type: 'document',
      metadata: mediaMetadata(d),
    }),
    send: (engine, d, media) => engine.sendDocumentMessage(d.chatId, media),
  });
}

export function sendSticker(
  ctx: SendContext,
  sessionId: string,
  dto: SendMediaMessageDto,
): Promise<MessageResponseDto> {
  return runSend<SendMediaMessageDto, MediaInput>(ctx, sessionId, 'sticker', dto, {
    prepare: d => buildMediaInput(d),
    saveData: d => ({ chatId: d.chatId, type: 'sticker', metadata: mediaMetadata(d) }),
    send: (engine, d, media) => engine.sendStickerMessage(d.chatId, media),
  });
}

export function sendLocation(
  ctx: SendContext,
  sessionId: string,
  dto: { chatId: string; latitude: number; longitude: number; description?: string; address?: string },
): Promise<MessageResponseDto> {
  return runSend(ctx, sessionId, 'location', dto, {
    saveData: d => ({ chatId: d.chatId, body: `📍 ${d.description || 'Location'}`, type: 'location' }),
    send: (engine, d) =>
      engine.sendLocationMessage(d.chatId, {
        latitude: d.latitude,
        longitude: d.longitude,
        description: d.description,
        address: d.address,
      }),
  });
}

export function sendContact(
  ctx: SendContext,
  sessionId: string,
  dto: { chatId: string; contactName: string; contactNumber: string },
): Promise<MessageResponseDto> {
  return runSend(ctx, sessionId, 'contact', dto, {
    saveData: d => ({ chatId: d.chatId, body: `📇 ${d.contactName}`, type: 'contact' }),
    send: (engine, d) => engine.sendContactMessage(d.chatId, { name: d.contactName, number: d.contactNumber }),
  });
}

export function sendPoll(
  ctx: SendContext,
  sessionId: string,
  dto: { chatId: string; name: string; options: string[]; allowMultipleAnswers?: boolean },
): Promise<MessageResponseDto> {
  // A poll has no plain-text body, so store the question — that keeps the message history readable.
  return runSend(ctx, sessionId, 'poll', dto, {
    saveData: d => ({ chatId: d.chatId, body: `📊 ${d.name}`, type: 'poll' }),
    send: (engine, d) =>
      engine.sendPollMessage(d.chatId, {
        name: d.name,
        options: d.options,
        allowMultipleAnswers: d.allowMultipleAnswers === true,
      }),
  });
}

export function reply(
  ctx: SendContext,
  sessionId: string,
  dto: { chatId: string; quotedMessageId: string; text: string },
): Promise<MessageResponseDto> {
  return runSend(ctx, sessionId, 'reply', dto, {
    saveData: async d => ({
      chatId: d.chatId,
      body: d.text,
      type: 'text',
      metadata: {
        quotedMessage: { id: d.quotedMessageId, body: await resolveQuotedBody(ctx, sessionId, d.quotedMessageId) },
      },
    }),
    send: (engine, d) => engine.replyToMessage(d.chatId, d.quotedMessageId, d.text),
  });
}

export function forward(
  ctx: SendContext,
  sessionId: string,
  dto: { fromChatId: string; toChatId: string; messageId: string },
): Promise<MessageResponseDto> {
  return runSend(ctx, sessionId, 'forward', dto, {
    saveData: d => ({ chatId: d.toChatId, body: '[Forwarded]', type: 'forward' }),
    // persistSentState preserves the empty-id rule: a forward whose engine couldn't recover the sent
    // copy's id leaves waMessageId NULL so no ack mis-matches it.
    send: (engine, d) => engine.forwardMessage(d.fromChatId, d.toChatId, d.messageId),
  });
}
