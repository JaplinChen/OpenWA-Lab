import { HookEvent, HookManager, KNOWN_HOOK_EVENTS, isKnownHookEvent } from '../hooks';
import { PluginCapabilityPermission, PluginContext, PluginInstance, PluginStatus } from './plugin.interfaces';
import { PluginStorageService } from './plugin-storage.service';
import { PluginWorkerHost } from './sandbox/plugin-worker-host';
import { PluginLogLevel } from './sandbox/protocol';
import { resolvePluginConfig } from './plugin-activation';
import { isHookActive } from './plugin-capability-guards';
import { shouldDispatchToPlugin } from './handover-gate';
import { makeOnWebhookSubscribe } from './webhook-subscribe.util';
import { registerPluginSearchProvider, unregisterPluginSearchProvider } from './search-provider-registration.util';
import type { ConversationMappingService } from '../../modules/integration/conversation-mapping.service';
import type { SearchProviderRegistry } from '../../modules/search/search-provider.registry';

/** Time budget for a sandboxed plugin's hook handler before the chain proceeds without it. */
const SANDBOX_HOOK_TIMEOUT_MS = 5000;
/** A sandboxed plugin's search handler must answer within this, else /search fails fast (not hung). */
const SANDBOX_SEARCH_TIMEOUT_MS = 10000;

/**
 * What the host-side handlers for worker-initiated events need from the loader.
 *
 * `sandboxHosts` and `plugins` are the loader's live Maps passed BY REFERENCE, and every handler looks
 * its entry up at FIRE time, never at build time: the host is only inserted into `sandboxHosts` after
 * these callbacks are built (registration fires during onLoad/onEnable), and disable/crash removes it —
 * so a captured host would keep dispatching into a dead worker. Same reasoning for the lazy
 * ConversationMappingService / SearchProviderRegistry getters.
 */
export interface SandboxCallbacksDeps {
  pluginId: string;
  plugin: PluginInstance;
  context: PluginContext;
  logger: {
    debug(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  hookManager: HookManager;
  sandboxHosts: Map<string, PluginWorkerHost>;
  plugins: Map<string, PluginInstance>;
  pluginStorage: PluginStorageService;
  getConversationMappingService: () => ConversationMappingService;
  getSearchRegistry: () => SearchProviderRegistry | undefined;
  searchProviderMode: () => string;
}

export interface SandboxCallbacks {
  onHookSubscribe: (event: string, priority?: number) => void;
  onWebhookSubscribe: (route: string) => void;
  onLog: (level: PluginLogLevel, message: string, meta?: Record<string, unknown>) => void;
  onSearchProviderRegister: () => void;
  onWorkerExit: (code: number, intentional: boolean) => void;
}

/**
 * Build the host-side handlers for everything an untrusted worker can initiate: hook subscription,
 * ingress-route claims, logging, search-provider registration, and worker exit. This is the IPC trust
 * boundary — the wire payloads are arbitrary strings from an untrusted thread, so the subscribe
 * handlers reject unknown events/undeclared routes, dedup, and cap. The per-plugin `subscribedEvents` /
 * `subscribedRoutes` sets are local to one enable call and dropped on disable, exactly as before.
 */
export function buildSandboxCallbacks(deps: SandboxCallbacksDeps): SandboxCallbacks {
  const { pluginId, plugin, context } = deps;

  // When the worker subscribes to a hook, register a shim with the hook manager that dispatches the
  // event into the worker (time-bounded, so a wedged plugin can't stall the chain). The shim looks
  // the host up at fire time, so disabling the plugin (which removes it + unregisters hooks) stops it.
  // Harden the IPC boundary against an untrusted worker flooding the host hook registry. HookEvent is
  // a type-only union and the wire payload is an arbitrary string, so a hostile/buggy worker can post
  // 'hook-subscribe' with (a) the same event repeatedly and (b) unbounded fabricated event names
  // ('x:0','x:1',…). Without guards each call adds a live host-side registration (unbounded host-heap
  // growth + an O(n log n) re-sort). Three guards, all local to this enableSandboxed call (dropped on
  // disable): reject unknown events (bounds growth to the finite known set + drops events that can
  // never fire), dedup per event, and a belt-and-suspenders size cap.
  const subscribedEvents = new Set<HookEvent>();
  let unknownEventWarned = false;
  const onHookSubscribe = (event: string, priority?: number): void => {
    if (!isKnownHookEvent(event)) {
      if (!unknownEventWarned) {
        unknownEventWarned = true; // warn at most once per plugin so a flood isn't a log-flood vector
        deps.logger.warn(`Sandboxed plugin ${pluginId} subscribed to an unknown hook event; ignoring`, {
          pluginId,
          event,
          action: 'sandbox_unknown_hook_event',
        });
      }
      return;
    }
    if (subscribedEvents.has(event)) return;
    if (subscribedEvents.size >= KNOWN_HOOK_EVENTS.size) return; // can't exceed the known set
    subscribedEvents.add(event);
    deps.hookManager.register(
      pluginId,
      event,
      async hookCtx => {
        const liveHost = deps.sandboxHosts.get(pluginId);
        if (!liveHost) return { continue: true };
        // Per-session activation gate: a session-scoped plugin only sees events for the sessions
        // it is activated for. Pass-through (don't dispatch into the worker) otherwise.
        if (!isHookActive(plugin, hookCtx.sessionId)) return { continue: true };
        // Handover gate: once a human has taken over (or closed) a conversation, the bot stops
        // seeing its inbound messages. Scoped to message:received only — every other hook event is
        // unaffected. Best-effort + fail-open: a lookup failure (or an event/mapping shape the gate
        // can't resolve) must never block a normal message from reaching the adapter.
        if (event === 'message:received') {
          try {
            const chatId = (hookCtx.data as { chatId?: string } | undefined)?.chatId;
            if (chatId && hookCtx.sessionId) {
              const handover = await deps
                .getConversationMappingService()
                .findHandoverForChat(hookCtx.sessionId, chatId);
              if (!shouldDispatchToPlugin(handover, pluginId)) return { continue: true };
            }
          } catch (error) {
            deps.logger.debug(`Handover gate lookup failed for plugin ${pluginId}; dispatching normally`, {
              pluginId,
              event,
              error: error instanceof Error ? error.message : String(error),
              action: 'handover_gate_fail_open',
            });
          }
        }
        return liveHost
          .dispatchHook({
            event,
            data: hookCtx.data,
            sessionId: hookCtx.sessionId,
            source: hookCtx.source,
            // The host resolves the per-session slice (real secrets — the worker is the plugin's
            // trusted execution context) and ships it; the worker exposes it as ctx.config.
            config: resolvePluginConfig(
              plugin.config,
              plugin.sessionConfig,
              hookCtx.sessionId,
              plugin.manifest.sessionScoped !== false,
            ),
            timeoutMs: SANDBOX_HOOK_TIMEOUT_MS,
            onTimeout: () =>
              deps.logger.warn(`Sandboxed plugin ${pluginId} hook '${event}' timed out`, {
                pluginId,
                event,
                action: 'sandbox_hook_timeout',
              }),
          })
          .then(result => ({ continue: result.continue, data: result.data }));
      },
      priority,
    );
  };

  // When the worker claims an ingress route, record it against the manifest-declared routes so the
  // host knows which routes this worker will handle. Same hardening as onHookSubscribe (the wire
  // `route` is an arbitrary untrusted string): drop when the manifest lacks 'webhook:ingress', drop
  // an undeclared route (warn once), dedup, and cap. subscribedRoutes is local to this enable call,
  // so it is dropped on disable exactly as subscribedEvents is.
  const subscribedRoutes = new Set<string>();
  const declaredRoutes = new Set((plugin.manifest.ingress ?? []).map(r => r.route));
  const onWebhookSubscribe = makeOnWebhookSubscribe({
    pluginId,
    declaredRoutes,
    hasPermission: (plugin.manifest.permissions ?? []).includes(PluginCapabilityPermission.WEBHOOK_INGRESS),
    subscribed: subscribedRoutes,
    maxRoutes: declaredRoutes.size,
    warn: (message, meta) => deps.logger.warn(message, meta),
  });

  // Route the worker plugin's ctx.logger.* calls to the same per-plugin logger an in-process plugin
  // uses, so sandboxed plugins log identically (prefixed + structured) instead of bare stdout.
  const onLog = (level: PluginLogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (level === 'error') context.logger.error(message, undefined, meta);
    else context.logger[level](message, meta);
  };

  // When the worker declares itself a search provider (ctx.registerSearchProvider →
  // search-provider-register), register a PluginSearchProvider in the SearchProviderRegistry. The host
  // is in sandboxHosts by the time registration fires (during onLoad/onEnable), so look it up lazily
  // like onHookSubscribe. Search disabled (no registry, or SEARCH_PROVIDER=none) → the util skips.
  const onSearchProviderRegister = (): void => {
    const liveHost = deps.sandboxHosts.get(pluginId);
    if (!liveHost) return;
    registerPluginSearchProvider({
      pluginId,
      label: `${plugin.manifest.name} (plugin)`,
      transport: liveHost,
      timeoutMs: SANDBOX_SEARCH_TIMEOUT_MS,
      registry: deps.getSearchRegistry(),
      mode: deps.searchProviderMode(),
    });
  };

  // A worker that crashes AFTER a successful enable is otherwise invisible to the loader (handleExit only
  // drains in-flight calls). Drop the plugin's search-provider entry so the registry falls back to
  // builtin-fts instead of routing every /search to a dead worker (auto mode would otherwise pin the dead
  // provider ACTIVE). Mirrors the enable-failure cleanup. Broader crash-lifecycle cleanup (status, hooks)
  // is a pre-existing gap for all bridges and out of scope here.
  const onWorkerExit = (code: number, intentional: boolean): void => {
    // Always release the search-provider slot so the registry can fall back to builtin-fts. On a crash
    // this is the only cleanup; on a deliberate disable/enable-failure the explicit unregister already
    // ran, making this a harmless no-op.
    unregisterPluginSearchProvider(deps.getSearchRegistry(), pluginId);
    if (intentional) return; // routine disable/enable-failure already logged and expected
    // Unexpected crash after a successful enable: the worker is gone. Drop the dead host +
    // unregister the hook shims (so they don't keep dispatching into the dead worker) + mark the
    // plugin ERROR so the dashboard reflects reality. The dispatchHook/dispatchWebhook dead-checks
    // fail-fast; this cleanup is the root-cause fix (it also makes the shim's !liveHost guard fire).
    const crashed = deps.plugins.get(pluginId);
    if (crashed) {
      crashed.status = PluginStatus.ERROR;
      crashed.error = `worker exited unexpectedly (code ${code})`;
      deps.pluginStorage.setPluginStatus(pluginId, PluginStatus.ERROR);
    }
    deps.hookManager.unregisterPlugin(pluginId);
    deps.sandboxHosts.delete(pluginId);
    deps.logger.warn(`Sandboxed plugin ${pluginId} worker exited unexpectedly (code ${code})`, {
      pluginId,
      code,
      action: 'sandbox_worker_exit',
    });
  };

  return { onHookSubscribe, onWebhookSubscribe, onLog, onSearchProviderRegister, onWorkerExit };
}
