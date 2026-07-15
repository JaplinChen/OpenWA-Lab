import { z } from 'zod';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import type { MessageService } from '../../../modules/message/message.service';
import type { ToolDescriptor } from '../tool-descriptor';
import { sessionId } from './message-tools.common';

export function messageActionTools(message: MessageService): ToolDescriptor[] {
  return [
    {
      name: 'MessageReply',
      description: 'Reply to a specific message (quoted reply). Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID'),
        quotedMessageId: z.string().describe('ID of the message to quote/reply to'),
        text: z.string().min(1).describe('Reply text content'),
      }),
      handler: (input: { sessionId: string; chatId: string; quotedMessageId: string; text: string }) =>
        message.reply(input.sessionId, {
          chatId: input.chatId,
          quotedMessageId: input.quotedMessageId,
          text: input.text,
        }),
    },
    {
      name: 'MessageForward',
      description: 'Forward a message from one chat to another. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        fromChatId: z.string().describe('Source chat JID'),
        toChatId: z.string().describe('Destination chat JID'),
        messageId: z.string().describe('ID of the message to forward'),
      }),
      handler: (input: { sessionId: string; fromChatId: string; toChatId: string; messageId: string }) =>
        message.forward(input.sessionId, {
          fromChatId: input.fromChatId,
          toChatId: input.toChatId,
          messageId: input.messageId,
        }),
    },
    {
      name: 'MessageReact',
      description:
        'Add or remove a reaction emoji on a message. Send empty string emoji to remove. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID containing the message'),
        messageId: z.string().describe('ID of the message to react to'),
        emoji: z.string().describe('Emoji to react with. Empty string removes the reaction.'),
      }),
      handler: (input: { sessionId: string; chatId: string; messageId: string; emoji: string }) =>
        message
          .reactToMessage(input.sessionId, { chatId: input.chatId, messageId: input.messageId, emoji: input.emoji })
          .then(() => ({ success: true })),
    },
  ];
}
