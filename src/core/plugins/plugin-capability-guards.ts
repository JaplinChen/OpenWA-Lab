import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { isPluginActiveForSession } from './plugin-activation';
import { PluginCapabilityError, PluginCapabilityPermission } from './plugin-capabilities';
import type { PluginInstance, PluginManifest } from './plugin.interfaces';

// The plugin capability guards: the security boundary for plugin-supplied sessionIds. Extracted from
// plugin-loader.service.ts so the permission / session-scope rules are readable and testable on their
// own. `resolveEngine` takes a `getEngine` CLOSURE rather than a snapshot: the loader resolves the
// SessionService lazily through ModuleRef, and engines come and go as sessions start/stop, so the
// lookup must run at call time.

/**
 * Enforce a plugin's declared manifest permissions at the capability boundary. A plugin may only
 * use a capability whose permission string it declares in `manifest.permissions`; anything else
 * (including a manifest with no permissions) is denied. Runs first in each capability verb so a
 * missing grant fails fast and uniformly as a PluginCapabilityError.
 */
export function assertPermission(manifest: PluginManifest, permission: PluginCapabilityPermission): void {
  if (!(manifest.permissions ?? []).includes(permission)) {
    throw new PluginCapabilityError(
      `Plugin ${manifest.id} is missing the '${permission}' permission required for this capability`,
    );
  }
}

/**
 * Enforce a plugin's manifest session scope. Runs BEFORE any engine/message resolution —
 * sessionId is supplied by the plugin, so this is the security boundary. Absent = ['*'].
 */
export function assertSessionAllowed(manifest: PluginManifest, sessionId: string): void {
  const allowed = manifest.sessions ?? ['*'];
  if (!allowed.includes('*') && !allowed.includes(sessionId)) {
    throw new PluginCapabilityError(`Plugin ${manifest.id} is not permitted to act on session ${sessionId}`);
  }
}

/** Per-session activation gate: is this plugin currently activated for `sessionId`'s event? */
export function isHookActive(plugin: PluginInstance, sessionId: string | undefined): boolean {
  return isPluginActiveForSession(plugin.manifest.sessionScoped ?? true, plugin.activeSessions ?? ['*'], sessionId);
}

/**
 * The capability session gate. A plugin may act on `sessionId` only if BOTH hold: its manifest scope
 * allows the session (the static author boundary, assertSessionAllowed) AND the operator has activated
 * the plugin for that session (the dynamic boundary, the same gate hook dispatch uses). manifest.sessions
 * alone is not enough — a general adapter ships `['*']` and is scoped by operator activation, so without
 * the activeSessions check a plugin activated for one session could reach another's engine/mappings/
 * handover. Defaults (`activeSessions ?? ['*']`, `sessionScoped:false`) preserve every unrestricted flow.
 */
export function assertSessionActive(plugin: PluginInstance, sessionId: string): void {
  assertSessionAllowed(plugin.manifest, sessionId);
  if (!isHookActive(plugin, sessionId)) {
    throw new PluginCapabilityError(`Plugin ${plugin.manifest.id} is not activated for session ${sessionId}`);
  }
}

/**
 * Scope-check, then resolve the live engine for a session. getEngine returns undefined for an
 * unknown OR unstarted session (no throw), so guard it into a defined PluginCapabilityError.
 * A present-but-not-READY engine throws EngineNotReadyError from the adapter on use (→ 409).
 */
export function resolveEngine(
  getEngine: (sessionId: string) => IWhatsAppEngine | undefined,
  plugin: PluginInstance,
  sessionId: string,
): IWhatsAppEngine {
  assertSessionActive(plugin, sessionId);
  const engine = getEngine(sessionId);
  if (!engine) {
    throw new PluginCapabilityError(`Session ${sessionId} has no active engine (unknown or not started)`);
  }
  return engine;
}

/** Engine read capabilities: require the `engine:read` permission, then resolve the live engine. */
export function resolveEngineRead(
  getEngine: (sessionId: string) => IWhatsAppEngine | undefined,
  plugin: PluginInstance,
  sessionId: string,
): IWhatsAppEngine {
  assertPermission(plugin.manifest, PluginCapabilityPermission.ENGINE_READ);
  return resolveEngine(getEngine, plugin, sessionId);
}
