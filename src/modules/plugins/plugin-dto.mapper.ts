import type { PluginLoaderService, PluginInstance } from '../../core/plugins';
import type { PluginConfigSchema } from '../../core/plugins';
import { PluginDto } from './dto/plugin.dto';
import { redactSecretConfig } from './redact-config';

/** A plugin can host provisioned instances iff it declares an ingress route AND the webhook:ingress
 *  permission — mirrors IntegrationInstanceController.assertIngressCapable. */
export function isIngressCapable(manifest: { ingress?: unknown[]; permissions?: string[] }): boolean {
  return (manifest.ingress?.length ?? 0) > 0 && (manifest.permissions ?? []).includes('webhook:ingress');
}

/** Redact secrets in every per-session config slice for the DTO (mirrors the base config redaction). */
export function redactSessionConfig(
  sessionConfig: Record<string, Record<string, unknown>> | undefined,
  schema: PluginConfigSchema | undefined,
): Record<string, Record<string, unknown>> | undefined {
  if (!sessionConfig) return undefined;
  return Object.fromEntries(Object.entries(sessionConfig).map(([sid, cfg]) => [sid, redactSecretConfig(cfg, schema)]));
}

/** Build the API-facing PluginDto for one plugin instance (secrets redacted, timestamps ISO-encoded). */
export function toPluginDto(plugin: PluginInstance, pluginLoader: PluginLoaderService): PluginDto {
  return {
    id: plugin.manifest.id,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    type: plugin.manifest.type,
    description: plugin.manifest.description,
    author: plugin.manifest.author,
    status: plugin.status,
    config: redactSecretConfig(plugin.config, plugin.manifest.configSchema),
    builtIn: pluginLoader.isBuiltIn(plugin.manifest.id),
    provides: plugin.manifest.provides ?? [],
    ingressCapable: isIngressCapable(plugin.manifest),
    configSchema: plugin.manifest.configSchema,
    configUi: plugin.manifest.configUi,
    i18n: plugin.manifest.i18n,
    sessionConfig: redactSessionConfig(plugin.sessionConfig, plugin.manifest.configSchema),
    sessionScoped: plugin.manifest.sessionScoped !== false,
    activeSessions: plugin.activeSessions ?? ['*'],
    loadedAt: plugin.loadedAt?.toISOString(),
    enabledAt: plugin.enabledAt?.toISOString(),
    error: plugin.error,
  };
}
