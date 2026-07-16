import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { BadRequestException, HttpException } from '@nestjs/common';
import { writeSecretFile } from '../../common/utils/secret-file';
import { EngineFactory } from '../../engine/engine.factory';
import type { SavedConfigResponse, SaveConfigDto, SaveConfigResult } from './infra.types';

interface InfraConfigLogger {
  log(message: string, meta?: Record<string, unknown>): void;
}

/** Collaborators for reading/writing the generated env config. Both constructor-stable on
 *  InfraController; this path only touches data/.env.generated. */
export interface InfraConfigCtx {
  engineFactory: EngineFactory;
  logger: InfraConfigLogger;
}

export function readSavedBuiltinFlags(): { database: boolean; cache: boolean; storage: boolean } {
  try {
    const envPath = path.resolve(process.cwd(), 'data', '.env.generated');
    const saved: Record<string, string> = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath, 'utf8')) : {};
    return {
      database: saved.POSTGRES_BUILTIN === 'true',
      cache: saved.REDIS_BUILTIN === 'true',
      storage: saved.MINIO_BUILTIN === 'true',
    };
  } catch {
    return { database: false, cache: false, storage: false };
  }
}

export function readSavedConfig(): SavedConfigResponse {
  const envPath = path.resolve(process.cwd(), 'data', '.env.generated');
  const saved: Record<string, string> = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath, 'utf8')) : {};

  // Secrets (passwords, S3 keys) are never returned; the form shows a "set" indicator
  // and an empty submission preserves the stored value (see saveConfig). This lets the
  // dashboard hydrate the form so a save no longer overwrites unseen fields (#226).
  return {
    database: {
      type: saved.DATABASE_TYPE === 'postgres' ? 'postgres' : 'sqlite',
      builtIn: saved.POSTGRES_BUILTIN === 'true',
      host: saved.DATABASE_HOST || '',
      port: saved.DATABASE_PORT || '',
      username: saved.DATABASE_USERNAME || '',
      database: saved.DATABASE_NAME || '',
      schema: saved.POSTGRES_SCHEMA || 'public',
      poolSize: Number(saved.DATABASE_POOL_SIZE) || 10,
      sslEnabled: saved.DATABASE_SSL === 'true',
      sslRejectUnauthorized: saved.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
      passwordSet: Boolean(saved.DATABASE_PASSWORD),
    },
    redis: {
      enabled: saved.REDIS_ENABLED === 'true',
      builtIn: saved.REDIS_BUILTIN === 'true',
      host: saved.REDIS_HOST || '',
      port: saved.REDIS_PORT || '',
      passwordSet: Boolean(saved.REDIS_PASSWORD),
    },
    queue: { enabled: saved.QUEUE_ENABLED === 'true' },
    storage: {
      type: saved.STORAGE_TYPE === 's3' ? 's3' : 'local',
      builtIn: saved.MINIO_BUILTIN === 'true',
      localPath: saved.STORAGE_LOCAL_PATH || '',
      s3Bucket: saved.S3_BUCKET || '',
      s3Region: saved.S3_REGION || '',
      s3Endpoint: saved.S3_ENDPOINT || '',
      s3CredentialsSet: Boolean(saved.S3_ACCESS_KEY_ID && saved.S3_SECRET_ACCESS_KEY),
    },
    engine: {
      type: saved.ENGINE_TYPE || 'whatsapp-web.js',
      headless: saved.PUPPETEER_HEADLESS !== 'false',
      sessionDataPath: saved.SESSION_DATA_PATH || '',
      browserArgs: saved.PUPPETEER_ARGS || '',
    },
  };
}

export function saveConfig(ctx: InfraConfigCtx, config: SaveConfigDto): SaveConfigResult {
  try {
    const profiles: string[] = [];

    // Merge into the existing saved config rather than rebuilding from scratch, so a
    // partial payload (the dashboard only sends the sections it renders) cannot wipe
    // keys it didn't include (#226).
    const envPath = path.resolve(process.cwd(), 'data', '.env.generated');
    const existing: Record<string, string> = fs.existsSync(envPath)
      ? dotenv.parse(fs.readFileSync(envPath, 'utf8'))
      : {};
    const updates: Record<string, string> = {};
    // Keys to remove from the merged result — used to drop stale settings when the
    // user switches mode (postgres->sqlite, s3->local) so a reload never sees the new
    // mode alongside leftover keys from the old one.
    const staleKeys = new Set<string>();

    // Secret values are never echoed back to the form, so an empty submission means
    // "unchanged" — keep whatever is already stored instead of blanking it.
    const setSecret = (key: string, value: string | undefined): void => {
      if (value) updates[key] = value;
    };

    // Database. NOTE: these keys must match what src/config/configuration.ts reads.
    if (config.database) {
      updates.DATABASE_TYPE = config.database.type || 'sqlite';
      updates.POSTGRES_BUILTIN = config.database.builtIn ? 'true' : 'false';
      if (config.database.type === 'postgres') {
        if (config.database.builtIn) {
          // Built-in PostgreSQL - use container name as host
          updates.DATABASE_HOST = 'postgres';
          updates.DATABASE_PORT = '5432';
          updates.DATABASE_USERNAME = 'openwa';
          updates.DATABASE_PASSWORD = 'openwa';
          updates.DATABASE_NAME = 'openwa';
          // Built-in Postgres is initialized with the default 'public' schema (see
          // scripts/postgres-init-schema.sh). Pin it so a later switch from a custom-schema
          // external DB to built-in doesn't carry a stale POSTGRES_SCHEMA forward.
          updates.POSTGRES_SCHEMA = 'public';
          profiles.push('postgres');
        } else {
          // External PostgreSQL
          updates.DATABASE_HOST = config.database.host || 'localhost';
          updates.DATABASE_PORT = config.database.port || '5432';
          updates.DATABASE_USERNAME = config.database.username || 'postgres';
          setSecret('DATABASE_PASSWORD', config.database.password);
          updates.DATABASE_NAME = config.database.database || 'openwa';
          updates.POSTGRES_SCHEMA = config.database.schema || 'public';
        }
        updates.DATABASE_POOL_SIZE = String(config.database.poolSize || 10);
        updates.DATABASE_SSL = config.database.sslEnabled ? 'true' : 'false';
        if (config.database.sslEnabled) {
          // Default to certificate verification; only relax it when the operator opts out
          // (managed Postgres with self-signed certs: Supabase, Heroku, Render, Railway).
          updates.DATABASE_SSL_REJECT_UNAUTHORIZED = config.database.sslRejectUnauthorized === false ? 'false' : 'true';
        }
      } else {
        // Switching to sqlite: drop stale postgres connection keys.
        for (const k of [
          'DATABASE_HOST',
          'DATABASE_PORT',
          'DATABASE_USERNAME',
          'DATABASE_PASSWORD',
          'DATABASE_NAME',
          'DATABASE_POOL_SIZE',
          'DATABASE_SSL',
          'DATABASE_SSL_REJECT_UNAUTHORIZED',
          'POSTGRES_SCHEMA',
        ]) {
          staleKeys.add(k);
        }
      }
    }

    // Redis / Queue
    if (config.redis || config.queue) {
      updates.REDIS_ENABLED = config.redis?.enabled ? 'true' : 'false';
      updates.REDIS_BUILTIN = config.redis?.builtIn ? 'true' : 'false';
      updates.QUEUE_ENABLED = config.queue?.enabled ? 'true' : 'false';
      if (config.redis?.enabled) {
        if (config.redis.builtIn) {
          // Built-in Redis - use container name as host
          updates.REDIS_HOST = 'redis';
          updates.REDIS_PORT = '6379';
          profiles.push('redis');
        } else {
          // External Redis
          updates.REDIS_HOST = config.redis.host || 'localhost';
          updates.REDIS_PORT = config.redis.port || '6379';
          setSecret('REDIS_PASSWORD', config.redis.password);
        }
      }
    }

    // Storage. NOTE: STORAGE_LOCAL_PATH / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are
    // the names configuration.ts reads (previously saved as STORAGE_PATH / S3_*_KEY and
    // silently ignored — #226).
    if (config.storage) {
      updates.STORAGE_TYPE = config.storage.type || 'local';
      updates.MINIO_BUILTIN = config.storage.builtIn ? 'true' : 'false';
      if (config.storage.type === 'local') {
        updates.STORAGE_LOCAL_PATH = config.storage.localPath || './data/media';
        // Switching to local: drop stale S3 keys.
        for (const k of ['S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET', 'S3_REGION']) {
          staleKeys.add(k);
        }
      } else if (config.storage.type === 's3') {
        staleKeys.add('STORAGE_LOCAL_PATH');
        if (config.storage.builtIn) {
          // Built-in MinIO - use container name as endpoint
          updates.S3_ENDPOINT = 'http://minio:9000';
          updates.S3_ACCESS_KEY_ID = 'minioadmin';
          updates.S3_SECRET_ACCESS_KEY = 'minioadmin';
          updates.S3_BUCKET = 'openwa';
          updates.S3_REGION = 'us-east-1';
          profiles.push('minio');
        } else {
          // External S3/MinIO
          updates.S3_BUCKET = config.storage.s3Bucket || '';
          updates.S3_REGION = config.storage.s3Region || 'ap-southeast-1';
          setSecret('S3_ACCESS_KEY_ID', config.storage.s3AccessKey);
          setSecret('S3_SECRET_ACCESS_KEY', config.storage.s3SecretKey);
          if (config.storage.s3Endpoint) {
            updates.S3_ENDPOINT = config.storage.s3Endpoint;
          }
        }
      }
    }

    // Engine. NOTE: PUPPETEER_HEADLESS / SESSION_DATA_PATH / PUPPETEER_ARGS are the names
    // configuration.ts reads (previously saved as ENGINE_* and silently ignored — #226).
    if (config.engine) {
      // Persist the selected engine so the Infrastructure tile can actually switch engines (the
      // active engine was previously only settable via the ENGINE_TYPE env, never from the UI).
      if (config.engine.type) {
        const validEngineIds = ctx.engineFactory.getAvailableEngines().map(e => e.id);
        if (!validEngineIds.includes(config.engine.type)) {
          throw new BadRequestException(`Unknown engine type: ${config.engine.type}`);
        }
        updates.ENGINE_TYPE = config.engine.type;
      }
      updates.PUPPETEER_HEADLESS = config.engine.headless !== false ? 'true' : 'false';
      updates.SESSION_DATA_PATH = config.engine.sessionDataPath || './data/sessions';
      // Must match configuration.ts's PUPPETEER_ARGS default (4 flags). Once compose blank-forwards
      // PUPPETEER_ARGS, this saved value wins at runtime — a 2-flag default here would silently drop
      // --disable-dev-shm-usage (the Docker /dev/shm tab-crash guard) after any Infrastructure save.
      updates.PUPPETEER_ARGS =
        config.engine.browserArgs || '--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu';
    }

    // .env.generated is one KEY=value per line, loaded on the next boot. A value carrying a
    // line break would write a second line and inject an arbitrary env var the operator never
    // set, so refuse any such value before writing anything.
    for (const [key, value] of Object.entries(updates)) {
      if (/[\r\n]/.test(value)) {
        throw new BadRequestException(`Invalid configuration value for ${key}: line breaks are not allowed`);
      }
    }

    // Existing values are the base; this payload's values win (secrets handled above).
    const merged: Record<string, string> = { ...existing, ...updates };
    // Drop keys made obsolete by a mode switch (postgres->sqlite, s3->local).
    for (const k of staleKeys) {
      delete merged[k];
    }
    const body = Object.keys(merged)
      .sort()
      .map(key => `${key}=${merged[key]}`);
    const contents = [
      '# OpenWA Configuration',
      `# Generated at ${new Date().toISOString()}`,
      '# Managed via Dashboard > Infrastructure. Values in process env or project .env take precedence.',
      '',
      ...body,
      '',
    ].join('\n');

    // Write to data/ so it persists across container restarts. Owner-only (0600): this file holds
    // the DB/S3/Redis credentials, so it must not be world-readable between save and next restart.
    writeSecretFile(envPath, contents);
    ctx.logger.log('Configuration saved', { envPath });

    const profileMsg = profiles.length > 0 ? ` Docker profiles required: ${profiles.join(', ')}.` : '';

    return {
      message: `Configuration saved successfully.${profileMsg} Server restart required to apply changes.`,
      saved: true,
      // Return a cwd-relative path so the response doesn't disclose the absolute host filesystem layout.
      envPath: path.relative(process.cwd(), envPath),
      profiles,
    };
  } catch (error) {
    // A validation rejection (unknown engine type, or a newline-injected value) is a BadRequestException
    // and MUST surface as its real 4xx status, not be masked as an HTTP 200 {saved:false} — a client
    // branching on HTTP status alone would otherwise treat rejected input as success. Re-throw any
    // HttpException so the Nest layer maps it. A non-HTTP failure (e.g. a writeSecretFile disk/permission
    // error) stays a {saved:false} 200, preserving the dashboard's body.saved handling for I/O faults.
    if (error instanceof HttpException) {
      throw error;
    }
    return {
      message: `Failed to save configuration: ${error instanceof Error ? error.message : 'Unknown error'}`,
      saved: false,
      envPath: '',
      profiles: [],
    };
  }
}
