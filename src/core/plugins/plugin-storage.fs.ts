import * as fs from 'fs';

// Filesystem primitives + storage-key encoding for PluginStorageService, split out so the service and
// the per-plugin storage factory share one atomic-write + base64url key-name implementation.

/** Unique-per-write counter so concurrent writes to the same key don't collide on the temp file. */
let tmpWriteSeq = 0;

/**
 * Write to a sibling temp file then atomically rename it into place. POSIX rename is atomic on the
 * same filesystem, so a crash (SIGKILL/OOM) mid-write can never leave a truncated/corrupt target —
 * a reader sees either the old complete file or the new complete file, never a partial one.
 */
export function atomicWriteFileSync(filePath: string, data: string, options?: { mode?: number }): void {
  const tmp = `${filePath}.${process.pid}.${tmpWriteSeq++}.tmp`;
  try {
    fs.writeFileSync(tmp, data, options);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort temp cleanup */
    }
    throw err;
  }
}

const ENCODED_KEY_PREFIX = 'key-';

export function encodeStorageKey(key: string): string {
  return (
    ENCODED_KEY_PREFIX +
    Buffer.from(key, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  );
}

export function decodeStorageFileName(stem: string): string | null {
  if (!stem.startsWith(ENCODED_KEY_PREFIX)) return null;
  const encoded = stem.slice(ENCODED_KEY_PREFIX.length);
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (encoded.length % 4)) % 4);
  try {
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    // Only accept it as one of our base64url-encoded names if it round-trips exactly. A literal legacy
    // filename that merely starts with `key-` would otherwise be mis-decoded into a garbage key.
    return encodeStorageKey(decoded) === stem ? decoded : null;
  } catch {
    return null;
  }
}
