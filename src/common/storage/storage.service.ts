import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { Readable, PassThrough } from 'stream';
import { S3Client, HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3';
import { createLogger } from '../services/logger.service';
import { isPathWithin, isSafeStorageKey } from '../utils/path-safety';
import { createExportStream, importFromStream, positiveIntFromEnv } from './storage-archive';
import { listS3Files, getS3File, putS3File, getS3CountAndSize } from './s3-storage';

interface S3Config {
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  bucket?: string;
}

/** Max number of local files a single traversal enumerates. Bounds a count DoS on a huge media dir. */
const DEFAULT_LIST_MAX_FILES = 100_000;
/** Max directory depth a local traversal descends. Prevents a pathological tree from running unbounded. */
const LOCAL_TRAVERSAL_MAX_DEPTH = 20;

@Injectable()
export class StorageService {
  private readonly logger = createLogger('StorageService');
  private readonly storageType: string;
  private readonly localPath: string;
  private s3Client: S3Client | null = null;
  private s3Bucket = 'openwa';
  private s3Available = false;

  constructor(private readonly configService: ConfigService) {
    this.storageType = this.configService.get<string>('storage.type') || 'local';
    this.localPath = this.configService.get<string>('storage.localPath') || './data/media';

    // Initialize S3 client if storage type is s3
    if (this.storageType === 's3') {
      const s3Config = this.configService.get<S3Config>('storage.s3') || {};
      const endpoint = process.env.S3_ENDPOINT || s3Config.endpoint;
      // Canonical names are S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY (what configuration.ts
      // and the dashboard write). The legacy S3_ACCESS_KEY / S3_SECRET_KEY are still read as
      // a fallback so existing .env files keep working.
      const accessKeyId = process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || s3Config.accessKeyId;
      const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || s3Config.secretAccessKey;
      const region = process.env.S3_REGION || s3Config.region || 'us-east-1';

      if (endpoint && accessKeyId && secretAccessKey) {
        this.s3Client = new S3Client({
          endpoint,
          region,
          credentials: {
            accessKeyId,
            secretAccessKey,
          },
          forcePathStyle: true, // Required for MinIO
        });
        this.s3Bucket = process.env.S3_BUCKET || s3Config.bucket || 'openwa';
        void this.initializeS3Bucket();
      }
    }

    // Ensure local directory exists
    if (!fs.existsSync(this.localPath)) {
      fs.mkdirSync(this.localPath, { recursive: true });
    }
  }

  private async initializeS3Bucket(): Promise<void> {
    if (!this.s3Client) return;

    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: this.s3Bucket }));
      this.s3Available = true;
      this.logger.log(`S3 bucket '${this.s3Bucket}' is available`);
    } catch (error: unknown) {
      const err = error as { name?: string };
      if (err.name === 'NotFound' || err.name === 'NoSuchBucket') {
        // Create bucket
        try {
          await this.s3Client.send(new CreateBucketCommand({ Bucket: this.s3Bucket }));
          this.s3Available = true;
          this.logger.log(`Created S3 bucket '${this.s3Bucket}'`);
        } catch (createError) {
          this.logger.error('Failed to create S3 bucket', String(createError));
        }
      } else {
        this.logger.error('S3 bucket check failed', String(error));
      }
    }
  }

  // ============================================================================
  // Current Storage Operations
  // ============================================================================

  getCurrentStorageType(): string {
    return this.storageType;
  }

  isS3Available(): boolean {
    return this.s3Available;
  }

  private lastS3Check = 0;
  private s3CheckInFlight: Promise<void> | null = null;

  /**
   * Re-probe S3/MinIO reachability when it's currently marked unavailable — e.g. a bundled MinIO that
   * came up AFTER the app booted (the init HeadBucket raced and latched false). Throttled (10s) and
   * in-flight-deduped so the status endpoint can call it on every poll cheaply. Once available it
   * stays available (no need to re-probe a healthy backend here).
   */
  async refreshS3Availability(): Promise<boolean> {
    if (this.storageType !== 's3' || !this.s3Client || this.s3Available) return this.s3Available;
    if (this.s3CheckInFlight) {
      await this.s3CheckInFlight;
      return this.s3Available;
    }
    const now = Date.now();
    if (now - this.lastS3Check < 10_000) return this.s3Available;
    this.lastS3Check = now;
    this.s3CheckInFlight = (async () => {
      try {
        await this.s3Client!.send(new HeadBucketCommand({ Bucket: this.s3Bucket }));
        this.s3Available = true;
        this.logger.log(`S3 bucket '${this.s3Bucket}' is now reachable`);
      } catch {
        // still unreachable — leave s3Available false; a later poll retries after the throttle window
      } finally {
        this.s3CheckInFlight = null;
      }
    })();
    await this.s3CheckInFlight;
    return this.s3Available;
  }

  async listFiles(): Promise<string[]> {
    if (this.storageType === 's3' && this.s3Client && this.s3Available) {
      return this.listS3Files();
    }
    return this.listLocalFiles();
  }

  async getFile(filePath: string): Promise<Buffer> {
    // Mirror putFile: getLocalFile has its own isPathWithin guard, but getS3File builds
    // `media/${filePath}` with none — contain both read backends at this boundary.
    if (!isSafeStorageKey(filePath)) {
      throw new Error(`Refusing to read an unsafe storage key: ${filePath}`);
    }
    if (this.storageType === 's3' && this.s3Client && this.s3Available) {
      return this.getS3File(filePath);
    }
    return this.getLocalFile(filePath);
  }

  async putFile(filePath: string, data: Buffer): Promise<void> {
    // Centralized containment so BOTH backends inherit it: putLocalFile has its own isPathWithin
    // guard, but putS3File builds `media/${filePath}` with none — reject a traversing key here.
    if (!isSafeStorageKey(filePath)) {
      throw new Error(`Refusing to store an unsafe storage key: ${filePath}`);
    }
    if (this.storageType === 's3' && this.s3Client && this.s3Available) {
      return this.putS3File(filePath, data);
    }
    return this.putLocalFile(filePath, data);
  }

  async getFileCount(): Promise<{ count: number; sizeBytes: number }> {
    if (this.storageType === 's3' && this.s3Client && this.s3Available) {
      // ListObjectsV2 already returns each object's Size, so report the real total instead of a
      // 100KB-per-file estimate — no extra API calls beyond the listing we'd do anyway.
      return getS3CountAndSize(this.s3Client, this.s3Bucket);
    }

    const files = await this.listFiles();
    let sizeBytes = 0;
    for (const file of files) {
      try {
        const fullPath = path.join(this.localPath, file);
        const stats = fs.statSync(fullPath);
        sizeBytes += stats.size;
      } catch (error) {
        this.logger.debug(`Failed to stat file: ${file}`, { error: String(error) });
      }
    }

    return { count: files.length, sizeBytes };
  }

  // ============================================================================
  // Export / Import — tar.gz stream over the current storage (see storage-archive.ts)
  // ============================================================================

  createExportStream(): Promise<PassThrough> {
    return createExportStream(this, this.logger);
  }

  importFromStream(inputStream: Readable): Promise<number> {
    return importFromStream(this, inputStream, this.logger);
  }

  // ============================================================================
  // Local Storage Operations
  // ============================================================================

  /**
   * Enumerate local files under the storage root. Async + iterative (a work queue, not recursion)
   * so a deep/wide media tree can't block the event loop or stack-overflow. Bounded by a max file
   * count and a max directory depth; a tree exceeding either is truncated rather than enumerated in
   * full (these are defense-in-depth caps — a healthy media store stays well under both).
   */
  private async listLocalFiles(): Promise<string[]> {
    const maxFiles = positiveIntFromEnv('STORAGE_LIST_MAX_FILES', DEFAULT_LIST_MAX_FILES);
    const files: string[] = [];
    // Iterative BFS: a queue of [relativeDir, depth] avoids unbounded call-stack growth.
    const queue: Array<{ dir: string; depth: number }> = [{ dir: '', depth: 0 }];

    while (queue.length > 0) {
      const { dir, depth } = queue.shift()!;
      if (depth >= LOCAL_TRAVERSAL_MAX_DEPTH) continue;

      const fullPath = path.join(this.localPath, dir);
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(fullPath, { withFileTypes: true });
      } catch {
        continue; // dir vanished or unreadable — skip rather than abort the whole traversal
      }

      for (const entry of entries) {
        const relativePath = dir ? path.join(dir, entry.name) : entry.name;
        if (entry.isDirectory()) {
          queue.push({ dir: relativePath, depth: depth + 1 });
        } else if (entry.isFile()) {
          // Storage keys are portable identifiers (also used as S3 object keys), so always emit
          // forward slashes rather than the OS separator — otherwise a nested key is `sub\b.txt` on
          // Windows. path.join above uses path.sep; split/join canonicalizes it (no-op on POSIX).
          files.push(relativePath.split(path.sep).join('/'));
          if (files.length >= maxFiles) return files; // cap reached — stop early
        }
      }
    }

    return files;
  }

  private getLocalFile(filePath: string): Promise<Buffer> {
    if (!isPathWithin(this.localPath, filePath)) {
      throw new Error(`Refusing to read outside storage root: ${filePath}`);
    }
    const fullPath = path.join(this.localPath, filePath);
    // Async read so the export loop (the only caller) yields the event loop per file instead of
    // blocking it with a synchronous read for every media file.
    return fs.promises.readFile(fullPath);
  }

  private async putLocalFile(filePath: string, data: Buffer): Promise<void> {
    if (!isPathWithin(this.localPath, filePath)) {
      throw new Error(`Refusing to write outside storage root: ${filePath}`);
    }
    const fullPath = path.join(this.localPath, filePath);

    // Async, non-blocking: a synchronous write here stalls the event loop during an import.
    // mkdir recursive is idempotent, so it doubles as the existsSync check.
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, data);
  }

  // ============================================================================
  // S3 Storage Operations
  // ============================================================================

  private listS3Files(): Promise<string[]> {
    if (!this.s3Client) return Promise.resolve([]);
    return listS3Files(this.s3Client, this.s3Bucket);
  }

  private getS3File(filePath: string): Promise<Buffer> {
    if (!this.s3Client) throw new Error('S3 client not initialized');
    return getS3File(this.s3Client, this.s3Bucket, filePath);
  }

  private putS3File(filePath: string, data: Buffer): Promise<void> {
    if (!this.s3Client) throw new Error('S3 client not initialized');
    return putS3File(this.s3Client, this.s3Bucket, filePath, data);
  }
}
