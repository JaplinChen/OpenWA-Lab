import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PluginLoaderService, PluginStatus } from '../../core/plugins';
import { PluginDto } from './dto/plugin.dto';
import { restoreSecretConfig } from './redact-config';
import { parsePluginPackage } from './plugin-installer';
import { CatalogPlugin } from './catalog';
import { toPluginDto } from './plugin-dto.mapper';
import {
  downloadPackage,
  installPackage,
  updatePackageInPlace,
  fetchCatalog,
  readConfigUiHtml,
} from './plugin-lifecycle';

// Re-exported so existing importers (and plugins.service.spec.ts) keep resolving this from
// './plugins.service' after the split into plugin-dto.mapper.ts.
export { isIngressCapable } from './plugin-dto.mapper';

@Injectable()
export class PluginsService {
  constructor(
    private readonly pluginLoader: PluginLoaderService,
    private readonly configService: ConfigService,
  ) {}

  // Serialize the directory/lifecycle-mutating operations (enable/disable/uninstall/update/install) for a
  // given plugin id so two of them on the SAME id can't interleave (e.g. enable racing uninstall, or two
  // updates racing on the backup dir). Mirrors the promise-chain serializer in session.service.ts.
  private readonly opChains = new Map<string, Promise<unknown>>();

  private serialize<T>(id: string, op: () => Promise<T>): Promise<T> {
    const prior = this.opChains.get(id) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(op);
    this.opChains.set(id, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.opChains.get(id) === next) this.opChains.delete(id);
      });
    return next;
  }

  findAll(): PluginDto[] {
    return this.pluginLoader.getAllPlugins().map(plugin => toPluginDto(plugin, this.pluginLoader));
  }

  findOne(id: string): PluginDto {
    const plugin = this.pluginLoader.getPlugin(id);
    if (!plugin) {
      throw new NotFoundException(`Plugin ${id} not found`);
    }
    return toPluginDto(plugin, this.pluginLoader);
  }

  enable(id: string): Promise<{ success: boolean; message: string }> {
    return this.serialize(id, () => this.enableInner(id));
  }

  private async enableInner(id: string): Promise<{ success: boolean; message: string }> {
    const plugin = this.pluginLoader.getPlugin(id);

    if (!plugin) {
      throw new NotFoundException(`Plugin ${id} not found`);
    }

    if (plugin.status === PluginStatus.ENABLED) {
      return { success: true, message: `Plugin ${id} is already enabled` };
    }

    try {
      await this.pluginLoader.enablePlugin(id);
      return { success: true, message: `Plugin ${id} enabled successfully` };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  disable(id: string): Promise<{ success: boolean; message: string }> {
    return this.serialize(id, () => this.disableInner(id));
  }

  private async disableInner(id: string): Promise<{ success: boolean; message: string }> {
    const plugin = this.pluginLoader.getPlugin(id);

    if (!plugin) {
      throw new NotFoundException(`Plugin ${id} not found`);
    }

    if (plugin.status !== PluginStatus.ENABLED) {
      return { success: true, message: `Plugin ${id} is not enabled` };
    }

    try {
      await this.pluginLoader.disablePlugin(id);
      return { success: true, message: `Plugin ${id} disabled successfully` };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  updateSessions(id: string, sessions: string[], allowedSessions?: string[] | null): PluginDto {
    const plugin = this.pluginLoader.getPlugin(id);
    if (!plugin) {
      throw new NotFoundException(`Plugin ${id} not found`);
    }
    // A session-restricted key (non-empty allowedSessions) may only activate the plugin for sessions
    // in its own scope — never '*' (all) or another tenant's session. An unrestricted key (null/empty)
    // is the normal dashboard/admin path and may activate for any session, including '*'.
    if (allowedSessions && allowedSessions.length > 0) {
      const outOfScope = sessions.filter(s => s === '*' || !allowedSessions.includes(s));
      if (outOfScope.length > 0) {
        throw new ForbiddenException(`API key not authorized for session(s): ${outOfScope.join(', ')}`);
      }
    }
    try {
      this.pluginLoader.setPluginSessions(id, sessions);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    return this.findOne(id);
  }

  updateConfig(id: string, config: Record<string, unknown>): { success: boolean; message: string } {
    const plugin = this.pluginLoader.getPlugin(id);

    if (!plugin) {
      throw new NotFoundException(`Plugin ${id} not found`);
    }

    try {
      // The dashboard PUTs the whole (redacted) config back, so a sentinel secret means "unchanged":
      // restore the stored value instead of overwriting the real secret with the mask.
      const merged = restoreSecretConfig(config, plugin.config, plugin.manifest.configSchema);
      this.pluginLoader.updatePluginConfig(id, merged);
      return { success: true, message: `Plugin ${id} configuration updated` };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Set a plugin's per-session config override for `sessionId`. Like updateConfig, the dashboard PUTs
   * the whole (redacted) slice back, so a sentinel secret restores the stored per-session value. An
   * empty slice clears the override (the session falls back to the base config).
   */
  updateSessionConfig(
    id: string,
    sessionId: string,
    config: Record<string, unknown>,
  ): { success: boolean; message: string } {
    const plugin = this.pluginLoader.getPlugin(id);

    if (!plugin) {
      throw new NotFoundException(`Plugin ${id} not found`);
    }
    if (plugin.manifest.sessionScoped === false) {
      // A global plugin has no per-session config — reject with 400 (mirrors PUT /:id/sessions).
      throw new BadRequestException(`Plugin ${id} is global (not session-scoped) and has no per-session config`);
    }

    try {
      const existing = plugin.sessionConfig?.[sessionId];
      const merged = restoreSecretConfig(config, existing, plugin.manifest.configSchema);
      this.pluginLoader.setPluginSessionConfig(id, sessionId, merged);
      return { success: true, message: `Plugin ${id} configuration for session ${sessionId} updated` };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Read a plugin's sandboxed config-UI entry HTML (manifest `configUi.entry`). The dashboard fetches
   * this with the API key and injects it as an iframe `srcdoc`, so the file must be self-contained.
   */
  getConfigUiHtml(id: string): string {
    return readConfigUiHtml(this.pluginLoader, id);
  }

  /** Install a plugin from an uploaded .zip: validate the package, write it to the plugins dir, and load it. */
  install(file?: { buffer?: Buffer }): PluginDto {
    return this.findOne(installPackage(this.pluginLoader, file));
  }

  /**
   * Install a plugin from an HTTP(S) URL: download the .zip through the SSRF guard, then run the exact
   * same validate-write-load pipeline as an uploaded package (untrusted buffer, identical to an upload).
   */
  async installFromUrl(url: string): Promise<PluginDto> {
    const buffer = await downloadPackage(this.configService, url);
    // Peek the id (the SSRF download stays outside the lock) so the install — which writes the plugin
    // directory — is serialized against any concurrent uninstall/update of the same id.
    const { manifest } = parsePluginPackage(buffer);
    return this.serialize(manifest.id, () => Promise.resolve(this.install({ buffer })));
  }

  /** Fetch the configured remote catalog (SSRF-guarded), annotated with this instance's install state. */
  getCatalog(): Promise<CatalogPlugin[]> {
    return fetchCatalog(this.pluginLoader, this.configService);
  }

  /**
   * Update an installed plugin in place from a validated package buffer, preserving operator config and
   * the enabled state. The package id must match the installed id; a bad update rolls back to the prior version.
   */
  updatePackage(id: string, buffer: Buffer): Promise<PluginDto> {
    return this.serialize(id, async () => {
      await updatePackageInPlace(this.pluginLoader, id, buffer);
      return this.findOne(id);
    });
  }

  /** Update an installed plugin by downloading the new package from a URL (SSRF-guarded), then in place. */
  async updateFromUrl(id: string, url: string): Promise<PluginDto> {
    const buffer = await downloadPackage(this.configService, url);
    return this.updatePackage(id, buffer);
  }

  /** Uninstall an installed user plugin: disable, unload, and delete its files. Built-ins are protected. */
  uninstall(id: string): Promise<{ success: boolean; message: string }> {
    return this.serialize(id, () => this.uninstallInner(id));
  }

  private async uninstallInner(id: string): Promise<{ success: boolean; message: string }> {
    const plugin = this.pluginLoader.getPlugin(id);
    if (!plugin) {
      throw new NotFoundException(`Plugin ${id} not found`);
    }

    try {
      await this.pluginLoader.uninstallPlugin(id);
      return { success: true, message: `Plugin ${id} uninstalled successfully` };
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  async healthCheck(id: string): Promise<{ healthy: boolean; message?: string }> {
    const plugin = this.pluginLoader.getPlugin(id);

    if (!plugin) {
      throw new NotFoundException(`Plugin ${id} not found`);
    }

    try {
      // Delegate to the loader so a sandboxed plugin's healthCheck (which runs in the worker, where
      // plugin.instance is null) is reached too — the old plugin.instance check always returned the
      // default "healthy" for sandboxed plugins, blinding health monitoring.
      return await this.pluginLoader.checkPluginHealth(id);
    } catch (error) {
      return {
        healthy: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
