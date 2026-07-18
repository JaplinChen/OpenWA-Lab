import { TarArchive } from 'archiver';
import * as tar from 'tar-stream';
import { createGunzip } from 'zlib';
import { Readable, PassThrough } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

/** Per-entry buffer cap for an import (200 MiB — 4× the inbound media cap). Bounds a decompression bomb. */
const DEFAULT_IMPORT_MAX_BYTES = 200 * 1024 * 1024;
/** Max number of entries an import archive may contain. Bounds an entry-count DoS. */
const DEFAULT_IMPORT_MAX_ENTRIES = 100_000;

/** Parse a positive-integer env override, falling back when unset/invalid. Shared by storage caps. */
export function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Minimal storage surface the archive stream needs — satisfied by StorageService. */
export interface StorageArchiveIO {
  listFiles(): Promise<string[]>;
  getFile(filePath: string): Promise<Buffer>;
  putFile(filePath: string, data: Buffer): Promise<void>;
}

interface ArchiveLogger {
  log(message: string): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: string): void;
}

/** Build a tar.gz stream of every file in the current storage. Archive-level failures surface on the
 *  returned stream instead of becoming an unhandled rejection or a silently truncated download. */
export async function createExportStream(io: StorageArchiveIO, logger: ArchiveLogger): Promise<PassThrough> {
  const files = await io.listFiles();
  const output = new PassThrough();

  const archive = new TarArchive({
    gzip: true,
    gzipOptions: { level: 6 },
  });

  archive.on('error', (err: Error) => {
    logger.error('Export archive failed', String(err));
    output.destroy(err);
  });

  archive.pipe(output);

  for (const file of files) {
    try {
      const data = await io.getFile(file);
      archive.append(data, { name: file });
    } catch (error) {
      logger.warn(`Failed to export file: ${file}`, { error: String(error) });
    }
  }

  // finalize() rejections also emit via the 'error' handler above; catch the promise so it
  // never surfaces as an unhandled rejection.
  archive.finalize().catch(() => undefined);
  return output;
}

/**
 * Persist an export stream to a collision-proof file under data/exports and TTL-sweep it.
 * Keep the export INSIDE data/ (under data/exports/): the import handler only accepts paths under
 * data/, and the documented backend-migration flow re-imports this file AFTER a container restart,
 * so it must live on the persistent volume — the OS temp dir is wiped on restart. The original
 * unbounded-accumulation leak is addressed by the TTL sweep + a collision-proof filename
 * (a per-call UUID), not by relocating off the volume. Returns the cwd-relative path: doesn't leak
 * the filesystem layout, and the import round-trip still works because importStorage's
 * existsSync/createReadStream resolve a relative filePath against the same cwd.
 */
export async function exportArchiveToDataDir(stream: Readable): Promise<string> {
  const exportDir = path.join(process.cwd(), 'data', 'exports');
  await fs.promises.mkdir(exportDir, { recursive: true });
  const exportPath = path.join(exportDir, `storage-export-${Date.now()}-${randomUUID()}.tar.gz`);

  const writeStream = fs.createWriteStream(exportPath);
  stream.pipe(writeStream);

  await new Promise<void>((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  // Sweep the throwaway archive so repeated exports don't accumulate on the data volume.
  const ttlMs = positiveIntFromEnv('STORAGE_EXPORT_TTL_MS', 60 * 60 * 1000); // default 1h
  setTimeout(() => {
    fs.promises.unlink(exportPath).catch(() => undefined);
  }, ttlMs).unref();

  return path.relative(process.cwd(), exportPath);
}

/**
 * Extract a tar.gz stream into the current storage. Best-effort, NOT atomic: a single bad/traversing
 * entry is skipped and the rest still import (putFile guards the key), and a resource-cap breach aborts
 * the rest but KEEPS the entries already written (no rollback). Re-running an import is safe (overwrite).
 */
export async function importFromStream(
  io: StorageArchiveIO,
  inputStream: Readable,
  logger: ArchiveLogger,
): Promise<number> {
  let importedCount = 0;
  let entryCount = 0;
  const maxEntryBytes = positiveIntFromEnv('STORAGE_IMPORT_MAX_BYTES', DEFAULT_IMPORT_MAX_BYTES);
  const maxEntries = positiveIntFromEnv('STORAGE_IMPORT_MAX_ENTRIES', DEFAULT_IMPORT_MAX_ENTRIES);

  const extract = tar.extract();
  const gunzip = createGunzip();

  return new Promise<number>((resolve, reject) => {
    let settled = false;
    // Abort the whole import: a per-entry overflow or too many entries is a (zip-bomb) attack, not
    // a per-file skip — tear down the pipeline and reject so nothing further is buffered or written.
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      extract.destroy();
      reject(err);
    };

    extract.on('entry', (header, stream, next) => {
      if (settled) {
        stream.resume();
        return;
      }
      if (++entryCount > maxEntries) {
        stream.resume();
        fail(new Error(`Import aborted: archive exceeds the ${maxEntries}-entry limit`));
        return;
      }

      const chunks: Buffer[] = [];
      let entryBytes = 0;
      let entryAborted = false;

      stream.on('data', (chunk: Buffer) => {
        if (entryAborted || settled) return;
        entryBytes += chunk.length;
        if (entryBytes > maxEntryBytes) {
          entryAborted = true;
          stream.resume(); // drain the remainder so the source can end
          fail(new Error(`Import aborted: entry "${header.name}" exceeds the ${maxEntryBytes}-byte per-entry cap`));
        } else {
          chunks.push(chunk);
        }
      });

      stream.on('end', () => {
        if (entryAborted || settled) return;
        const data = Buffer.concat(chunks);
        io.putFile(header.name, data)
          .then(() => {
            importedCount++;
            logger.debug(`Imported file: ${header.name}`);
            next();
          })
          .catch((error: unknown) => {
            logger.error(`Failed to import file: ${header.name}`, String(error));
            next();
          });
      });
      stream.resume();
    });

    extract.on('finish', () => {
      if (settled) return;
      settled = true;
      logger.log(`Import completed: ${importedCount} files`);
      resolve(importedCount);
    });

    extract.on('error', (err: Error) => {
      logger.error('Import failed', String(err));
      fail(err);
    });

    inputStream.pipe(gunzip).pipe(extract);
  });
}
