/**
 * Plugin capability surface — the curated, permission-gated APIs the host injects into `PluginContext`.
 * Split out of plugin.interfaces.ts; re-exported from there so the public SDK surface is unchanged.
 */

import type { MessageResponseDto } from '../../modules/message/dto';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import type { PluginNetRequestInit, PluginNetResponse } from './plugin-net';
import type { HandoverState } from '../../modules/integration/entities/conversation-mapping.entity';

/**
 * Capability permissions a plugin declares in its manifest `permissions` and that the loader
 * enforces at the capability boundary. A plugin may only use a capability whose permission it
 * declares; an undeclared (or missing-permission) plugin is denied with a PluginCapabilityError.
 */
export const PluginCapabilityPermission = {
  /** `ctx.messages.*` — send / reply on a session. */
  MESSAGES_SEND: 'messages:send',
  /** `ctx.engine.*` — read-only engine queries (group info, contacts, chats, number check). */
  ENGINE_READ: 'engine:read',
  /** `ctx.net.fetch` — SSRF-guarded outbound HTTP, scoped to the manifest `net.allow` host list. */
  NET_FETCH: 'net:fetch',
  /** `ctx.registerWebhook` — claim an inbound ingress route. Loader-enforced; cannot be widened by config. */
  WEBHOOK_INGRESS: 'webhook:ingress',
  /** `ctx.conversations.send` — normalized outbound send translated to MessageService. */
  CONVERSATION_SEND: 'conversation:send',
} as const;
export type PluginCapabilityPermission = (typeof PluginCapabilityPermission)[keyof typeof PluginCapabilityPermission];

// Normalized outbound envelope for ctx.conversations.send (POJO across the wire).
export interface ConversationSendEnvelope {
  sessionId?: string;
  instanceId?: string;
  chatId?: string;
  type: 'text' | 'image' | 'file' | 'audio' | 'video' | 'voice' | 'location';
  text?: string;
  mediaUrl?: string;
  replyTo?: string;
  source?: { provider: string; externalConversationId: string };
}

/**
 * Thrown by a plugin capability when a call is rejected (missing permission, out-of-scope session,
 * unstarted session, etc.). Gives plugins a predictable failure instead of a raw TypeError.
 */
export class PluginCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginCapabilityError';
  }
}

export interface PluginMessagingCapability {
  sendText(sessionId: string, chatId: string, text: string): Promise<MessageResponseDto>;
  reply(sessionId: string, chatId: string, quotedMessageId: string, text: string): Promise<MessageResponseDto>;
}

export interface PluginEngineReadCapability {
  getGroupInfo(sessionId: string, groupId: string): ReturnType<IWhatsAppEngine['getGroupInfo']>;
  getContacts(sessionId: string): ReturnType<IWhatsAppEngine['getContacts']>;
  getContactById(sessionId: string, contactId: string): ReturnType<IWhatsAppEngine['getContactById']>;
  checkNumberExists(sessionId: string, phone: string): ReturnType<IWhatsAppEngine['checkNumberExists']>;
  getChats(sessionId: string): ReturnType<IWhatsAppEngine['getChats']>;
  /** Recent messages for a chat (both directions), for history backfill. `limit` is clamped host-side. */
  getChatHistory(
    sessionId: string,
    chatId: string,
    limit?: number,
    includeMedia?: boolean,
  ): ReturnType<IWhatsAppEngine['getChatHistory']>;
  /**
   * Canonical (neutral) form of a chat id: resolves a `@lid` privacy id to its stable `<phone>@c.us`
   * when the lid->phone mapping is known, and otherwise returns the id unchanged. Lets a plugin key a
   * chat by one identity across WhatsApp's `@lid` migration (best-effort; an unresolved lid stays `@lid`).
   */
  canonicalChatId(sessionId: string, chatId: string): Promise<string>;
}

/** Outbound HTTP for a plugin — always through the host SSRF guard, scoped to `manifest.net.allow`. */
export interface PluginNetCapability {
  fetch(url: string, init?: PluginNetRequestInit): Promise<PluginNetResponse>;
}

/** Normalized outbound send for a plugin — translated host-side to MessageService.sendText/reply. */
export interface PluginConversationsCapability {
  send(env: ConversationSendEnvelope): Promise<unknown>;
}

/**
 * Flip a mapped conversation's handover state. Reuses the `conversation:send` permission — flipping
 * handover is part of owning the conversation, not a distinct capability grant.
 */
export interface PluginHandoverCapability {
  set(key: { sessionId: string; chatId: string; instanceId: string }, state: HandoverState): Promise<unknown>;
}

/**
 * Plugin-facing conversation mapping: create/read the WA-chat <-> provider-conversation link an adapter
 * needs so handover.set and conversation.send({source}) can resolve. Reuses the `conversation:send`
 * permission — owning the mapping is part of owning the conversation.
 */
export interface PluginMappingsCapability {
  upsert(key: { sessionId: string; chatId: string; instanceId: string }, providerConversationId: string): Promise<void>;
  get(key: {
    sessionId: string;
    chatId: string;
    instanceId: string;
  }): Promise<{ providerConversationId: string; handoverState: HandoverState } | null>;
  getByProvider(
    instanceId: string,
    providerConversationId: string,
  ): Promise<{ sessionId: string; chatId: string; handoverState: HandoverState } | null>;
}
