import { z } from 'zod';
import type { MessageService } from '../../../modules/message/message.service';
import type { ToolDescriptor } from '../tool-descriptor';
import { sessionId } from './message-tools.common';

export function messageReadTools(message: MessageService): ToolDescriptor[] {
  return [
    {
      name: 'MessageList',
      description:
        'List persisted messages for a session, optionally filtered by chatId or sender. Reads from the local DB.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().optional().describe('Filter to a specific chat JID'),
        from: z.string().optional().describe('Filter by sender phone or JID'),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      handler: (input: { sessionId: string; chatId?: string; from?: string; limit?: number; offset?: number }) =>
        message.getMessages(input.sessionId, {
          chatId: input.chatId,
          from: input.from,
          limit: input.limit,
          offset: input.offset,
        }),
    },
    {
      name: 'MessageHistory',
      description:
        'Fetch live chat history from WhatsApp for a specific chat. Bypasses the local DB — useful for messages that arrived before the gateway started.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID (e.g. 1234567890@c.us or groupId@g.us)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe('Number of messages to fetch; without deep:true the engine caps at 100'),
        includeMedia: z.boolean().optional().describe('Download media as base64 (slower)'),
        deep: z.boolean().optional().describe('Raise limit ceiling to 2000 for reaching further back in history'),
      }),
      handler: (input: { sessionId: string; chatId: string; limit?: number; includeMedia?: boolean; deep?: boolean }) =>
        message.getChatHistory(input.sessionId, input.chatId, input.limit, input.includeMedia, input.deep),
    },
    {
      name: 'MessageGetReactions',
      description: 'Get reactions for a specific message, including which contacts sent which emoji.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID containing the message'),
        messageId: z.string().describe('Message ID to get reactions for'),
      }),
      handler: (input: { sessionId: string; chatId: string; messageId: string }) =>
        message.getMessageReactions(input.sessionId, input.chatId, input.messageId),
    },
  ];
}
