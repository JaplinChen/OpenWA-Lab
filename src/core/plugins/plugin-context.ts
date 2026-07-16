import { AsyncLocalStorage } from 'async_hooks';
import { toNeutralJid, userPart } from '../../engine/identity/wa-id';
import type { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { HookManager, HookEvent } from '../hooks';
import {
  PluginCapabilityError,
  PluginCapabilityPermission,
  PluginEngineReadCapability,
  PluginMessagingCapability,
  PluginNetCapability,
  PluginConversationsCapability,
  PluginHandoverCapability,
  PluginMappingsCapability,
  PluginInstance,
  PluginContext,
  PluginLogger,
} from './plugin.interfaces';
import { effectiveNetAllow, isNetHostAllowed, performPluginFetch } from './plugin-net';
import { PluginStorageService } from './plugin-storage.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { resolvePluginConfig } from './plugin-activation';
import { buildConversationSendFacade } from './conversation-send-facade';
import { dispatchConversationMedia } from './plugin-loader.helpers';
import {
  assertPermission,
  assertSessionActive,
  isHookActive,
  resolveEngine,
  resolveEngineRead,
} from './plugin-capability-guards';
import type { MessageService } from '../../modules/message/message.service';
import type { ConversationMappingService } from '../../modules/integration/conversation-mapping.service';

/**
 * What the plugin capability surface needs from the loader. MessageService and
 * ConversationMappingService are CLOSURES, not instances: the loader resolves them lazily through
 * ModuleRef to break the provider cycle (PluginLoaderService -> SessionService -> EngineFactory ->
 * PluginLoaderService), so they must be resolved at call time, not at context-build time. Same for
 * `getEngineFor` — a session's engine appears and disappears as it starts and stops.
 */
export interface PluginContextDeps {
  logger: {
    log(message: string, meta?: Record<string, unknown>): void;
    debug(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, error?: string, meta?: Record<string, unknown>): void;
  };
  hookSession: AsyncLocalStorage<{ sessionId?: string }>;
  hookManager: HookManager;
  pluginStorage: PluginStorageService;
  getEngineFor: (sessionId: string) => IWhatsAppEngine | undefined;
  getMessageService: () => MessageService;
  getConversationMappingService: () => ConversationMappingService;
  lidMappingStore?: LidMappingStoreService;
}

export function buildPluginContext(deps: PluginContextDeps, plugin: PluginInstance): PluginContext {
  const pluginLogger: PluginLogger = {
    log: (message, meta) =>
      deps.logger.log(`[${plugin.manifest.id}] ${message}`, { ...meta, pluginId: plugin.manifest.id }),
    debug: (message, meta) =>
      deps.logger.debug(`[${plugin.manifest.id}] ${message}`, { ...meta, pluginId: plugin.manifest.id }),
    warn: (message, meta) =>
      deps.logger.warn(`[${plugin.manifest.id}] ${message}`, { ...meta, pluginId: plugin.manifest.id }),
    error: (message, error, meta) =>
      deps.logger.error(`[${plugin.manifest.id}] ${message}`, error instanceof Error ? error.message : String(error), {
        ...meta,
        pluginId: plugin.manifest.id,
      }),
  };

  const hookSession = deps.hookSession;
  return {
    pluginId: plugin.manifest.id,
    manifest: plugin.manifest,
    // Per-session: inside a hook, returns the override merged over the base for the firing session;
    // outside a hook (lifecycle), the base config. A getter so it reflects live config edits too.
    get config() {
      return resolvePluginConfig(
        plugin.config,
        plugin.sessionConfig,
        hookSession.getStore()?.sessionId,
        plugin.manifest.sessionScoped !== false,
      );
    },
    hookManager: deps.hookManager,
    logger: pluginLogger,
    storage: deps.pluginStorage.createPluginStorage(plugin.manifest.id),
    registerHook: (event, handler, priority) => {
      // Wrap with the per-session activation gate so an in-process plugin only handles events for
      // the sessions it is activated for (mirrors the sandboxed shim), and scope the firing
      // sessionId so ctx.config resolves the right per-session slice for the handler.
      deps.hookManager.register(
        plugin.manifest.id,
        event,
        async hookCtx => {
          if (!isHookActive(plugin, hookCtx.sessionId)) return { continue: true };
          return deps.hookSession.run({ sessionId: hookCtx.sessionId }, () => handler(hookCtx));
        },
        priority,
      );
    },
    // In-process built-ins are not reached by the ingress pipeline (it dispatches to sandbox hosts),
    // so fail loud rather than silently never firing. Sandboxed plugins get a real registerWebhook
    // from the worker bootstrap.
    registerWebhook: () => {
      throw new PluginCapabilityError(
        `Plugin ${plugin.manifest.id}: registerWebhook (ingress) is only available to sandboxed plugins`,
      );
    },
    messages: {
      sendText: async (sessionId, chatId, text) => {
        // Validate permission + scope + that the session has a live engine BEFORE MessageService
        // persists a pending row: a missing grant / dead session must fail with
        // PluginCapabilityError, not a raw TypeError + orphaned row. resolveEngine also runs
        // assertSessionActive.
        assertPermission(plugin.manifest, PluginCapabilityPermission.MESSAGES_SEND);
        resolveEngine(deps.getEngineFor, plugin, sessionId);
        return deps.getMessageService().sendText(sessionId, { chatId, text });
      },
      reply: async (sessionId, chatId, quotedMessageId, text) => {
        assertPermission(plugin.manifest, PluginCapabilityPermission.MESSAGES_SEND);
        resolveEngine(deps.getEngineFor, plugin, sessionId);
        return deps.getMessageService().reply(sessionId, { chatId, quotedMessageId, text });
      },
    } satisfies PluginMessagingCapability,
    engine: {
      getGroupInfo: async (sessionId, groupId) =>
        resolveEngineRead(deps.getEngineFor, plugin, sessionId).getGroupInfo(groupId),
      getContacts: async sessionId => resolveEngineRead(deps.getEngineFor, plugin, sessionId).getContacts(),
      getContactById: async (sessionId, contactId) =>
        resolveEngineRead(deps.getEngineFor, plugin, sessionId).getContactById(contactId),
      checkNumberExists: async (sessionId, phone) =>
        resolveEngineRead(deps.getEngineFor, plugin, sessionId).checkNumberExists(phone),
      getChats: async sessionId => resolveEngineRead(deps.getEngineFor, plugin, sessionId).getChats(),
      getChatHistory: async (sessionId, chatId, limit, includeMedia) =>
        resolveEngineRead(deps.getEngineFor, plugin, sessionId).getChatHistory(
          chatId,
          // Clamp to the REST non-deep ceiling (MessageService.MAX_CHAT_HISTORY_LIMIT = 100) so an
          // untrusted plugin can't request an unbounded history fetch.
          Math.min(Math.max(Math.trunc(limit ?? 50), 1), 100),
          includeMedia ?? false,
        ),
      canonicalChatId: (sessionId, chatId) => {
        // resolveEngineRead is the gate only (engine:read permission + live session); the resolution
        // itself is a synchronous host lid->phone lookup, not an engine call, mirroring the webhook
        // from-filter. Not `async` (nothing to await) — a resolved promise satisfies the signature.
        resolveEngineRead(deps.getEngineFor, plugin, sessionId);
        return Promise.resolve(toNeutralJid(chatId, jid => deps.lidMappingStore?.getCached(userPart(jid)) ?? null));
      },
    } satisfies PluginEngineReadCapability,
    net: {
      fetch: async (url, init) => {
        // Two gates: the declared permission, then the effective host allowlist = manifest net.allow
        // UNION the hosts of net.allowConfigHosts keys across the base config AND every per-session
        // override. The host gate has no firing-session context for a sandboxed plugin's cap round-trip,
        // so admit every operator-configured tenant host (all public + still SSRF-guarded at connect)
        // rather than resolving a single, possibly wrong (base-only), one. The SSRF guard inside
        // performPluginFetch still blocks internal IPs even when the host is allowlisted.
        assertPermission(plugin.manifest, PluginCapabilityPermission.NET_FETCH);
        const netConfigs = [plugin.config ?? {}, ...Object.values(plugin.sessionConfig ?? {})];
        const allow = [
          ...new Set(
            netConfigs.flatMap(cfg =>
              effectiveNetAllow(plugin.manifest.net?.allow, plugin.manifest.net?.allowConfigHosts, cfg),
            ),
          ),
        ];
        if (!isNetHostAllowed(allow, url)) {
          throw new PluginCapabilityError(
            `Plugin ${plugin.manifest.id} may not fetch ${url} — add its host to net.allow or net.allowConfigHosts`,
          );
        }
        return performPluginFetch(url, init);
      },
    } satisfies PluginNetCapability,
    conversations: buildConversationSendFacade({
      manifest: plugin.manifest,
      assertPermission,
      assertSessionActive: (sessionId: string) => assertSessionActive(plugin, sessionId),
      resolveChatId: async env => {
        if (!env.instanceId || !env.source) {
          throw new PluginCapabilityError(
            `Plugin ${plugin.manifest.id}: conversation.send requires chatId, or both instanceId and source to resolve one`,
          );
        }
        const mapping = await deps
          .getConversationMappingService()
          .getByProvider(plugin.manifest.id, env.instanceId, env.source.externalConversationId);
        if (!mapping) {
          throw new PluginCapabilityError(
            `Plugin ${plugin.manifest.id}: no conversation mapping for instance ${env.instanceId} / ${env.source.externalConversationId}`,
          );
        }
        return mapping.chatId;
      },
      // Re-establish the in-flight hook context around the downstream send so an adapter that calls
      // conversation.send from within its own ingress handling can't echo-loop back into itself via
      // its own outbound message:sending hook. Gate on an ALREADY-in-flight event (mirrors the
      // worker-cap wrap's `inFlight.length > 0` check): a plain top-level send must NOT suppress
      // message:sending for unrelated observers (audit/moderation) — only genuine re-entrancy does.
      runGuarded: (events, run) =>
        (events as HookEvent[]).some(e => deps.hookManager.isInFlight(e))
          ? deps.hookManager.runInFlight(events as HookEvent[], run)
          : run(),
      sendText: (sessionId, opts) => deps.getMessageService().sendText(sessionId, opts),
      reply: (sessionId, opts) => deps.getMessageService().reply(sessionId, opts),
      sendMedia: (sessionId, opts) => dispatchConversationMedia(deps.getMessageService(), sessionId, opts),
    } satisfies Parameters<typeof buildConversationSendFacade>[0]) satisfies PluginConversationsCapability,
    handover: {
      set: async (key, state) => {
        // Same gate as conversation.send: flipping handover is part of owning the conversation, so
        // it reuses CONVERSATION_SEND rather than adding a new permission.
        assertPermission(plugin.manifest, PluginCapabilityPermission.CONVERSATION_SEND);
        assertSessionActive(plugin, key.sessionId);
        const mapping = await deps.getConversationMappingService().get({
          sessionId: key.sessionId,
          chatId: key.chatId,
          pluginId: plugin.manifest.id,
          instanceId: key.instanceId,
        });
        if (!mapping) {
          throw new PluginCapabilityError(
            `Plugin ${plugin.manifest.id}: no conversation mapping for session ${key.sessionId} / chat ${key.chatId} / instance ${key.instanceId}`,
          );
        }
        await deps.getConversationMappingService().setHandover(mapping.id, state);
      },
    } satisfies PluginHandoverCapability,
    mappings: {
      upsert: async (key, providerConversationId) => {
        assertPermission(plugin.manifest, PluginCapabilityPermission.CONVERSATION_SEND);
        assertSessionActive(plugin, key.sessionId);
        await deps
          .getConversationMappingService()
          .upsert(
            { sessionId: key.sessionId, chatId: key.chatId, pluginId: plugin.manifest.id, instanceId: key.instanceId },
            providerConversationId,
          );
      },
      get: async key => {
        assertPermission(plugin.manifest, PluginCapabilityPermission.CONVERSATION_SEND);
        assertSessionActive(plugin, key.sessionId);
        const m = await deps.getConversationMappingService().get({
          sessionId: key.sessionId,
          chatId: key.chatId,
          pluginId: plugin.manifest.id,
          instanceId: key.instanceId,
        });
        return m ? { providerConversationId: m.providerConversationId, handoverState: m.handoverState } : null;
      },
      getByProvider: async (instanceId, providerConversationId) => {
        assertPermission(plugin.manifest, PluginCapabilityPermission.CONVERSATION_SEND);
        const m = await deps
          .getConversationMappingService()
          .getByProvider(plugin.manifest.id, instanceId, providerConversationId);
        // Parity with get/upsert: a plugin may only read a mapping for a session it is activated for.
        if (m) assertSessionActive(plugin, m.sessionId);
        return m ? { sessionId: m.sessionId, chatId: m.chatId, handoverState: m.handoverState } : null;
      },
    } satisfies PluginMappingsCapability,
  };
}
