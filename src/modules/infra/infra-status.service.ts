import { Injectable, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { QUEUE_NAMES } from '../queue/queue-names';
import { getEffectiveWebVersionInfo, resolveCurrentWebVersion } from '../../engine/wa-web-version';
import { DockerService } from '../docker';
import { CacheService } from '../../common/cache/cache.service';
import { StorageService } from '../../common/storage/storage.service';
import { createLogger } from '../../common/services/logger.service';
import { readSavedBuiltinFlags } from './infra-config';
import type { InfraStatus } from './infra.types';

@Injectable()
export class InfraStatusService {
  private readonly logger = createLogger('InfraStatusService');

  constructor(
    private readonly configService: ConfigService,
    @InjectDataSource('main')
    private readonly mainDataSource: DataSource,
    @InjectDataSource('data')
    private readonly dataDataSource: DataSource,
    private readonly dockerService: DockerService,
    private readonly cacheService: CacheService,
    private readonly storageService: StorageService,
    @Optional()
    @InjectQueue(QUEUE_NAMES.WEBHOOK)
    private readonly webhookQueue?: Queue,
  ) {}

  /** Bound the DB liveness probe so a hung connection can't stall the status read. */
  private static readonly DB_PROBE_TIMEOUT_MS = 3000;

  /**
   * Active DB liveness probe: run `SELECT 1`, not just read `DataSource.isInitialized`. A backend
   * (notably Postgres) that dies AFTER init keeps `isInitialized` true until an explicit `.destroy()`,
   * so the old check reported the tile green while the DB was actually down. Bounded by a short
   * timeout; any error or timeout resolves to `false`. Mirrors `/health/ready`'s authoritative probe.
   */
  private async probeDbConnected(ds: DataSource): Promise<boolean> {
    if (!ds.isInitialized) return false;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ds.query('SELECT 1'),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('db probe timeout')), InfraStatusService.DB_PROBE_TIMEOUT_MS);
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async getStatus(): Promise<InfraStatus> {
    // Active DB liveness probe (SELECT 1) on both connections in parallel — not just isInitialized,
    // which stays true after a Postgres backend dies until an explicit .destroy() (see probeDbConnected).
    const [mainDbConnected, dataDbConnected] = await Promise.all([
      this.probeDbConnected(this.mainDataSource),
      this.probeDbConnected(this.dataDataSource),
    ]);
    const dbConnected = mainDbConnected && dataDbConnected;
    const dbType = this.configService.get<string>('dataDatabase.type', 'sqlite');
    const dbHost = this.configService.get<string>('dataDatabase.host', 'localhost');

    const redisHost = process.env.REDIS_HOST || this.configService.get<string>('redis.host', 'localhost');
    const redisPort = parseInt(process.env.REDIS_PORT || '', 10) || this.configService.get<number>('redis.port', 6379);
    const redisEnabled = process.env.REDIS_ENABLED === 'true';
    const queueEnabled = this.configService.get<boolean>('queue.enabled', false);

    // Check actual Redis connectivity via CacheService
    const redisConnected = await this.cacheService.isAvailable();

    const storageType = this.configService.get<'local' | 's3'>('storage.type', 'local');
    // Read the key StorageService actually uses (`storage.localPath`, default `./data/media`).
    // The old `storage.path` key never existed, so status always reported the `./uploads` fallback.
    const storagePath = this.configService.get<string>('storage.localPath', './data/media');
    // In S3 mode the local path is unused; surface the bucket so the status panel shows the real
    // backend. `path` is kept (additive) so the dashboard's local-mode rendering is unchanged.
    const storageBucket = this.configService.get<string>('storage.s3.bucket');

    const engineType = this.configService.get<string>('engine.type', 'whatsapp-web.js');
    // whatsapp-web.js only: surface the actual WhatsApp Web build (not the library version) so the
    // dashboard shows which build is running. Trigger the auto-resolve so the panel is populated even
    // before a session starts; the result is cached, so this is a one-time fetch. (#488)
    let webVersion: string | null | undefined;
    let webVersionSource: 'pinned' | 'auto' | 'native' | undefined;
    if (engineType === 'whatsapp-web.js') {
      // Kick the auto-resolve but DON'T await it — /infra/status is polled frequently and the registry
      // fetch can take up to 5s on a firewalled host. Read whatever's cached now (null until the first
      // success); a later poll reflects the resolved build. (#488 review)
      if (getEffectiveWebVersionInfo().source === 'auto') {
        void resolveCurrentWebVersion().catch(() => undefined);
      }
      const info = getEffectiveWebVersionInfo();
      webVersion = info.version;
      webVersionSource = info.source;
    }
    // configuration.ts nests these under engine.puppeteer.{headless,args}; the old flat
    // engine.headless / engine.browserArgs keys never existed, so status always reported defaults.
    const engineHeadless = this.configService.get<boolean>('engine.puppeteer.headless', true) ?? true;
    const sessionDataPath = this.configService.get<string>('engine.sessionDataPath', './data/sessions');
    const browserArgs =
      this.configService.get<string[]>('engine.puppeteer.args')?.join(' ') || '--no-sandbox --disable-gpu';

    // Built-in detection: prefer the actually-running bundled container as truth (so a stopped/missing
    // container, or a host-pinned external host, reads as NOT built-in), and require the app to be
    // pointed at the bundled service. Fall back to the saved *_BUILTIN intent when Docker is
    // unreachable (bare-npm / socket-less) so the toggles don't spuriously flip off. (#488)
    const s3Endpoint = this.configService.get<string>('storage.s3.endpoint');
    const running = this.dockerService.isDockerAvailable()
      ? await this.dockerService.getRunningBuiltinServices()
      : null;
    const savedBuiltin = readSavedBuiltinFlags();
    const dbBuiltIn = running ? running.database && dbHost === 'postgres' : savedBuiltin.database;
    const redisBuiltIn = running ? running.cache && redisHost === 'redis' : savedBuiltin.cache;
    const storageBuiltIn = running ? running.storage && s3Endpoint === 'http://minio:9000' : savedBuiltin.storage;
    // Re-probe (throttled) so a MinIO/S3 that came up after boot is reflected, not latched unreachable.
    const s3Available = storageType === 's3' ? await this.storageService.refreshS3Availability() : undefined;

    // Live webhook-queue depth (the only real queue). pending = waiting + active + delayed. Degrades to
    // zeros when the queue is disabled or Redis is unreachable, so the panel never errors the status read.
    let webhooks = { pending: 0, completed: 0, failed: 0 };
    if (queueEnabled && this.webhookQueue) {
      try {
        const counts = await this.webhookQueue.getJobCounts('wait', 'active', 'delayed', 'completed', 'failed');
        webhooks = {
          pending: (counts.wait ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0),
          completed: counts.completed ?? 0,
          failed: counts.failed ?? 0,
        };
      } catch (error) {
        this.logger.warn('Failed to read webhook queue job counts', { error: String(error) });
      }
    }

    return {
      database: { connected: dbConnected, type: dbType, host: dbHost, builtIn: dbBuiltIn },
      redis: {
        enabled: redisEnabled,
        connected: redisConnected,
        host: redisHost,
        port: redisPort,
        builtIn: redisBuiltIn,
      },
      queue: {
        enabled: queueEnabled,
        webhooks,
      },
      storage: {
        type: storageType,
        path: storagePath,
        ...(storageType === 's3' && storageBucket ? { bucket: storageBucket } : {}),
        builtIn: storageBuiltIn,
        ...(storageType === 's3' ? { s3Available } : {}),
      },
      engine: {
        type: engineType,
        headless: engineHeadless,
        sessionDataPath,
        browserArgs,
        ...(engineType === 'whatsapp-web.js' ? { webVersion, webVersionSource } : {}),
      },
    };
  }
}
