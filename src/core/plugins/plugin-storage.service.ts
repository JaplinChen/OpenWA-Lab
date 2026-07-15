import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../common/services/logger.service';
import { PluginStatus, PluginStorage, PluginRegistryEntry } from './plugin.interfaces';
import { atomicWriteFileSync } from './plugin-storage.fs';
import { createPluginStorage } from './plugin-storage.factory';

@Injectable()
export class PluginStorageService {
  private readonly logger = createLogger('PluginStorageService');
  private readonly dataDir: string;
  private readonly registryPath: string;
  private registry: Map<string, PluginRegistryEntry> = new Map();

  constructor(private readonly configService: ConfigService) {
    this.dataDir = this.configService.get<string>('dataDir') ?? './data';
    this.registryPath = path.join(this.dataDir, 'plugins', 'registry.json');
    this.loadRegistry();
  }

  private loadRegistry(): void {
    try {
      if (fs.existsSync(this.registryPath)) {
        const content = fs.readFileSync(this.registryPath, 'utf-8');
        const entries = JSON.parse(content) as PluginRegistryEntry[];
        this.registry = new Map(entries.map(e => [e.id, e]));
        this.logger.debug(`Loaded ${this.registry.size} plugins from registry`, {
          action: 'registry_loaded',
        });
      }
    } catch (error) {
      this.logger.error('Failed to load plugin registry', String(error), {
        action: 'registry_load_failed',
      });
    }
  }

  private saveRegistry(): void {
    try {
      const dir = path.dirname(this.registryPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      const entries = Array.from(this.registry.values());
      // Owner-only: plugin config can hold secrets (e.g. an API key). writeFileSync's mode only
      // applies on CREATE, so chmod an already-existing, looser file too (best-effort).
      atomicWriteFileSync(this.registryPath, JSON.stringify(entries, null, 2), { mode: 0o600 });
      try {
        fs.chmodSync(this.registryPath, 0o600);
      } catch {
        /* best-effort hardening */
      }
    } catch (error) {
      this.logger.error('Failed to save plugin registry', String(error), {
        action: 'registry_save_failed',
      });
    }
  }

  // ============================================================================
  // Registry Methods
  // ============================================================================

  getPluginEntry(pluginId: string): PluginRegistryEntry | undefined {
    return this.registry.get(pluginId);
  }

  setPluginEntry(entry: PluginRegistryEntry): void {
    entry.updatedAt = new Date();
    this.registry.set(entry.id, entry);
    this.saveRegistry();
  }

  deletePluginEntry(pluginId: string): void {
    this.registry.delete(pluginId);
    this.saveRegistry();
  }

  getAllEntries(): PluginRegistryEntry[] {
    return Array.from(this.registry.values());
  }

  // ============================================================================
  // Status Management
  // ============================================================================

  getPluginStatus(pluginId: string): PluginStatus | null {
    const entry = this.registry.get(pluginId);
    return entry?.status ?? null;
  }

  setPluginStatus(pluginId: string, status: PluginStatus): void {
    const entry = this.registry.get(pluginId);
    if (entry) {
      entry.status = status;
      entry.updatedAt = new Date();
      this.saveRegistry();
    }
  }

  // ============================================================================
  // Config Management
  // ============================================================================

  getPluginConfig(pluginId: string): Record<string, unknown> | null {
    const entry = this.registry.get(pluginId);
    return entry?.config ?? null;
  }

  setPluginConfig(pluginId: string, config: Record<string, unknown>): void {
    const entry = this.registry.get(pluginId);
    if (entry) {
      entry.config = config;
      entry.updatedAt = new Date();
      this.saveRegistry();
    }
  }

  getPluginSessions(pluginId: string): string[] | null {
    const entry = this.registry.get(pluginId);
    return entry?.activeSessions ?? null;
  }

  setPluginSessions(pluginId: string, sessions: string[]): void {
    const entry = this.registry.get(pluginId);
    if (entry) {
      entry.activeSessions = sessions;
      entry.updatedAt = new Date();
      this.saveRegistry();
    }
  }

  getPluginSessionConfig(pluginId: string): Record<string, Record<string, unknown>> | null {
    const entry = this.registry.get(pluginId);
    return entry?.sessionConfig ?? null;
  }

  setPluginSessionConfig(pluginId: string, sessionConfig: Record<string, Record<string, unknown>>): void {
    const entry = this.registry.get(pluginId);
    if (entry) {
      entry.sessionConfig = sessionConfig;
      entry.updatedAt = new Date();
      this.saveRegistry();
    }
  }

  // ============================================================================
  // Plugin Data Storage (sandboxed per-plugin storage)
  // ============================================================================

  createPluginStorage(pluginId: string): PluginStorage {
    return createPluginStorage(pluginId, this.dataDir, this.logger);
  }
}
