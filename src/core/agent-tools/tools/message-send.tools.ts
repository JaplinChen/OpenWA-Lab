import { z } from 'zod';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import type { MessageService } from '../../../modules/message/message.service';
import type { ToolDescriptor } from '../tool-descriptor';
import { sessionId } from './message-tools.common';

export function messageSendTools(message: MessageService): ToolDescriptor[] {
  return [
    {
      name: 'MessageSendText',
      description: 'Send a plain text message to a chat or group. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID (e.g. 628123456789@c.us or groupId@g.us)'),
        text: z.string().min(1).max(4096).describe('Text message content'),
      }),
      handler: (input: { sessionId: string; chatId: string; text: string }) =>
        message.sendText(input.sessionId, { chatId: input.chatId, text: input.text }),
    },
    {
      name: 'MessageSendImage',
      description: 'Send an image message via URL or base64. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID'),
        url: z.string().url().optional().describe('Image URL (http/https)'),
        base64: z.string().optional().describe('Base64-encoded image data'),
        mimetype: z.string().optional().describe('MIME type (required when using base64)'),
        filename: z.string().max(255).optional(),
        caption: z.string().max(1024).optional(),
      }),
      handler: (input: {
        sessionId: string;
        chatId: string;
        url?: string;
        base64?: string;
        mimetype?: string;
        filename?: string;
        caption?: string;
      }) =>
        message.sendImage(input.sessionId, {
          chatId: input.chatId,
          url: input.url,
          base64: input.base64,
          mimetype: input.mimetype,
          filename: input.filename,
          caption: input.caption,
        }),
    },
    {
      name: 'MessageSendVideo',
      description: 'Send a video message via URL or base64. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID'),
        url: z.string().url().optional().describe('Video URL (http/https)'),
        base64: z.string().optional().describe('Base64-encoded video data'),
        mimetype: z.string().optional().describe('MIME type (required when using base64)'),
        filename: z.string().max(255).optional(),
        caption: z.string().max(1024).optional(),
      }),
      handler: (input: {
        sessionId: string;
        chatId: string;
        url?: string;
        base64?: string;
        mimetype?: string;
        filename?: string;
        caption?: string;
      }) =>
        message.sendVideo(input.sessionId, {
          chatId: input.chatId,
          url: input.url,
          base64: input.base64,
          mimetype: input.mimetype,
          filename: input.filename,
          caption: input.caption,
        }),
    },
    {
      name: 'MessageSendAudio',
      description: 'Send an audio/voice message via URL or base64. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID'),
        url: z.string().url().optional().describe('Audio URL (http/https)'),
        base64: z.string().optional().describe('Base64-encoded audio data'),
        mimetype: z.string().optional().describe('MIME type (required when using base64)'),
        filename: z.string().max(255).optional(),
        caption: z.string().max(1024).optional(),
        ptt: z.boolean().optional().describe('Send as a WhatsApp voice note (PTT)'),
      }),
      handler: (input: {
        sessionId: string;
        chatId: string;
        url?: string;
        base64?: string;
        mimetype?: string;
        filename?: string;
        caption?: string;
        ptt?: boolean;
      }) =>
        message.sendAudio(input.sessionId, {
          chatId: input.chatId,
          url: input.url,
          base64: input.base64,
          mimetype: input.mimetype,
          filename: input.filename,
          caption: input.caption,
          ptt: input.ptt,
        }),
    },
    {
      name: 'MessageSendDocument',
      description: 'Send a document/file message via URL or base64. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID'),
        url: z.string().url().optional().describe('Document URL (http/https)'),
        base64: z.string().optional().describe('Base64-encoded document data'),
        mimetype: z.string().optional().describe('MIME type (required when using base64)'),
        filename: z.string().max(255).optional(),
        caption: z.string().max(1024).optional(),
      }),
      handler: (input: {
        sessionId: string;
        chatId: string;
        url?: string;
        base64?: string;
        mimetype?: string;
        filename?: string;
        caption?: string;
      }) =>
        message.sendDocument(input.sessionId, {
          chatId: input.chatId,
          url: input.url,
          base64: input.base64,
          mimetype: input.mimetype,
          filename: input.filename,
          caption: input.caption,
        }),
    },
    {
      name: 'MessageSendLocation',
      description: 'Send a location pin message. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID'),
        latitude: z.number().min(-90).max(90).describe('Latitude coordinate'),
        longitude: z.number().min(-180).max(180).describe('Longitude coordinate'),
        description: z.string().optional().describe('Location label/description'),
        address: z.string().optional().describe('Street address'),
      }),
      handler: (input: {
        sessionId: string;
        chatId: string;
        latitude: number;
        longitude: number;
        description?: string;
        address?: string;
      }) =>
        message.sendLocation(input.sessionId, {
          chatId: input.chatId,
          latitude: input.latitude,
          longitude: input.longitude,
          description: input.description,
          address: input.address,
        }),
    },
    {
      name: 'MessageSendContact',
      description: 'Send a contact card message. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID'),
        contactName: z.string().min(1).describe('Display name of the contact to share'),
        contactNumber: z.string().min(1).describe('Phone number of the contact to share'),
      }),
      handler: (input: { sessionId: string; chatId: string; contactName: string; contactNumber: string }) =>
        message.sendContact(input.sessionId, {
          chatId: input.chatId,
          contactName: input.contactName,
          contactNumber: input.contactNumber,
        }),
    },
    {
      name: 'MessageSendSticker',
      description: 'Send a sticker message via URL or base64. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID'),
        url: z.string().url().optional().describe('Sticker URL (http/https)'),
        base64: z.string().optional().describe('Base64-encoded sticker data'),
        mimetype: z.string().optional().describe('MIME type (required when using base64)'),
        filename: z.string().max(255).optional(),
        caption: z.string().max(1024).optional(),
      }),
      handler: (input: {
        sessionId: string;
        chatId: string;
        url?: string;
        base64?: string;
        mimetype?: string;
        filename?: string;
        caption?: string;
      }) =>
        message.sendSticker(input.sessionId, {
          chatId: input.chatId,
          url: input.url,
          base64: input.base64,
          mimetype: input.mimetype,
          filename: input.filename,
          caption: input.caption,
        }),
    },
    {
      name: 'MessageSendTemplate',
      description:
        'Render a stored text template and send it as a text message. Provide either templateId or templateName. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID'),
        templateId: z.string().optional().describe('Template UUID'),
        templateName: z.string().optional().describe('Template name slug'),
        vars: z
          .record(z.string(), z.string())
          .optional()
          .describe('Variables to substitute into {{placeholder}} tokens'),
      }),
      handler: (input: {
        sessionId: string;
        chatId: string;
        templateId?: string;
        templateName?: string;
        vars?: Record<string, string>;
      }) =>
        message.sendTemplate(input.sessionId, {
          chatId: input.chatId,
          templateId: input.templateId,
          templateName: input.templateName,
          vars: input.vars,
        }),
    },
  ];
}
