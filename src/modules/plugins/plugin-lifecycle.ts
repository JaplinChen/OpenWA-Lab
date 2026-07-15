import { BadRequestException, ConflictException, NotFoundException, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { PluginLoaderService, PluginStatus, resolvePluginMainPath } from '../../core/plugins';
import { parsePluginPackage } from './plugin-installer';
import { fetchSafeBuffer } from './plugin-download';
import { annotateCatalog, CatalogEntry, CatalogPlugin } from './catalog';
import { redactSsrfError } from '../../common/security/ssrf-guard';
import { createLogger } from '../../common/services/logger.service';

/** Cap on the catalog JSON download (the catalog is small; this bounds a hostile response). */
const CATALOG_MAX_BYTES = 1 * 1024 * 1024;
const DEFAULT_DOWNLOAD_MAX_BYTES = 5 * 1024 * 1024;

const logger = createLogger('PluginsService');

/** Download a plugin/catalog buffer through the SSRF guard, mapping a block to a client-safe 400. */
export async function downloadPackage(configService: ConfigService, url: string): Promise<Buffer> {
  const maxBytes = configService.get<number>('plugins.downloadMaxBytes') ?? DEFAULT_DOWNLOAD_MAX_BYTES;
  try {
    return await fetchSafeBuffer(url, { maxBytes });
  } catch (error) {
    throw new BadRequestException(
      `Failed to download plugin from URL: ${redactSsrfError(error, logger, 'plugin download')}`,
    );
  }
}

/**
 * Install a plugin from a validated .zip buffer: validate the package, write it to the plugins dir, and
 * load it. Rolls the directory back on any failure. Returns the installed plugin id.
 */
export function installPackage(pluginLoader: PluginLoaderService, file?: { buffer?: Buffer }): string {
  if (!file?.buffer?.length) {
    throw new BadRequestException('No plugin file uploaded');
  }

  const { manifest, entries } = parsePluginPackage(file.buffer);

  if (pluginLoader.getPlugin(manifest.id)) {
    throw new ConflictException(`Plugin "${manifest.id}" is already installed`);
  }
  const dir = path.join(pluginLoader.getPluginsDir(), manifest.id);
  if (fs.existsSync(dir)) {
    throw new ConflictException(`A plugin directory "${manifest.id}" already exists`);
  }

  // Write the validated entries then load; roll back the directory on any failure so a bad
  // package never leaves a half-installed plugin behind.
  try {
    for (const entry of entries) {
      const dest = path.join(dir, entry.relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.data);
    }
    pluginLoader.loadPlugin(dir);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (error instanceof HttpException) throw error;
    throw new BadRequestException(
      `Failed to install plugin: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return manifest.id;
}

/**
 * Update an installed plugin in place from a validated package buffer, preserving operator config and
 * the enabled state. The old directory is backed up and restored if the swap/reload fails.
 */
export async function updatePackageInPlace(
  pluginLoader: PluginLoaderService,
  id: string,
  buffer: Buffer,
): Promise<void> {
  const plugin = pluginLoader.getPlugin(id);
  if (!plugin) {
    throw new NotFoundException(`Plugin ${id} not found`);
  }
  if (pluginLoader.isBuiltIn(id)) {
    throw new BadRequestException(`Cannot update built-in plugin ${id}`);
  }

  // Validate the new package BEFORE touching the running plugin. An update must be the same plugin.
  const { manifest, entries } = parsePluginPackage(buffer);
  if (manifest.id !== id) {
    throw new BadRequestException(`Package id "${manifest.id}" does not match the plugin being updated ("${id}")`);
  }

  const wasEnabled = plugin.status === PluginStatus.ENABLED;
  const dir = path.join(pluginLoader.getPluginsDir(), id);
  // Dot-prefixed sibling inside pluginsDir: same filesystem (so the rename stays EXDEV-safe) but
  // skipped by the loader's directory scan, so a crash mid-update can't leave it loaded as a duplicate.
  const backup = path.join(pluginLoader.getPluginsDir(), `.${id}.bak`);

  // Stop the running plugin (terminates its sandbox worker) but keep its registry entry so config survives.
  await pluginLoader.unloadPlugin(id);

  fs.rmSync(backup, { recursive: true, force: true });
  fs.renameSync(dir, backup);

  try {
    for (const entry of entries) {
      const dest = path.join(dir, entry.relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.data);
    }
    pluginLoader.loadPlugin(dir);
    if (wasEnabled) {
      await pluginLoader.enablePlugin(id);
    }
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    // Roll back to the previous version: restore the backed-up directory and reload it.
    // The failed forward path may have left the NEW version in the loader map (loadPlugin
    // succeeded; enablePlugin failed with status=ERROR but did NOT remove it), so drop it first —
    // otherwise the restore's loadPlugin() hits the "already loaded" guard and the runtime stays
    // desynced from disk (new manifest in memory, old files on disk). unloadPlugin throws when
    // nothing is loaded (the loadPlugin-itself-failed case), hence the catch.
    await pluginLoader.unloadPlugin(id).catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(backup, dir);
    try {
      pluginLoader.loadPlugin(dir);
      if (wasEnabled) await pluginLoader.enablePlugin(id);
    } catch {
      /* best-effort restore; surface the original failure below */
    }
    if (error instanceof HttpException) throw error;
    throw new BadRequestException(`Failed to update plugin: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Fetch the configured remote catalog (a plugins.json array) through the SSRF guard and annotate each
 * entry with this instance's install state (installed / installedVersion / updateAvailable).
 */
export async function fetchCatalog(
  pluginLoader: PluginLoaderService,
  configService: ConfigService,
): Promise<CatalogPlugin[]> {
  const url = configService.get<string>('plugins.catalogUrl');
  if (!url) return [];

  let raw: Buffer;
  try {
    raw = await fetchSafeBuffer(url, { maxBytes: CATALOG_MAX_BYTES });
  } catch (error) {
    throw new BadRequestException(
      `Failed to fetch plugin catalog: ${redactSsrfError(error, logger, 'plugin catalog download')}`,
    );
  }

  let entries: CatalogEntry[];
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (!Array.isArray(parsed)) throw new Error('catalog is not a JSON array');
    entries = parsed as CatalogEntry[];
  } catch (error) {
    throw new BadRequestException(
      `Invalid plugin catalog JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const installed = pluginLoader.getAllPlugins().map(p => ({ id: p.manifest.id, version: p.manifest.version }));
  return annotateCatalog(entries, installed);
}

/**
 * Read a plugin's sandboxed config-UI entry HTML (manifest `configUi.entry`). Path is escape-guarded
 * (lexical + symlink-resolved) against the plugin directory; the entry is plugin-author-supplied.
 */
export function readConfigUiHtml(pluginLoader: PluginLoaderService, id: string): string {
  const plugin = pluginLoader.getPlugin(id);
  if (!plugin) {
    throw new NotFoundException(`Plugin ${id} not found`);
  }
  const entry = plugin.manifest.configUi?.entry;
  // `entry` is untrusted manifest JSON — a non-string (or escaping) value is treated as "no config
  // UI" (404), never a raw 500.
  if (!entry || typeof entry !== 'string') {
    throw new NotFoundException(`Plugin ${id} has no config UI`);
  }
  const base = path.resolve(pluginLoader.getPluginsDir(), id);
  let file: string;
  try {
    file = resolvePluginMainPath(pluginLoader.getPluginsDir(), id, entry);
  } catch {
    throw new NotFoundException(`Config UI entry not found for plugin ${id}`);
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new NotFoundException(`Config UI entry not found for plugin ${id}`);
  }
  // Defense-in-depth: the lexical guard above is symlink-blind; resolve links on BOTH the file and
  // the plugin dir (so a symlinked tmp root like macOS /var→/private/var doesn't false-positive) and
  // re-check containment before reading an arbitrary host file into the main process and serving it.
  const real = fs.realpathSync(file);
  const realBase = fs.realpathSync(base);
  if (real !== realBase && !real.startsWith(realBase + path.sep)) {
    throw new NotFoundException(`Config UI entry not found for plugin ${id}`);
  }
  return fs.readFileSync(real, 'utf-8');
}
