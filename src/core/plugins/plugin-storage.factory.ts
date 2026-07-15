import * as fs from 'fs';
import * as path from 'path';
import { isPathWithin, isSafeStorageKey } from '../../common/utils/path-safety';
import { PluginStorage } from './plugin.interfaces';
import { atomicWriteFileSync, encodeStorageKey, decodeStorageFileName } from './plugin-storage.fs';

interface StorageLogger {
  warn(message: string): void;
  error(message: string, error?: string): void;
}

/**
 * Build the sandboxed per-plugin PluginStorage (get/set/delete/list) rooted at `dataDir/plugins/<id>`.
 * Keys are containment-validated then base64url-encoded to a filesystem-safe filename (so JID-style
 * keys stay portable on Windows); a pre-encoding legacy `<key>.json` file is read/deleted for back-compat
 * but never written. Owner-only (0o700 dir / 0o600 files) since plugin storage can hold secrets.
 */
export function createPluginStorage(pluginId: string, dataDir: string, logger: StorageLogger): PluginStorage {
  const pluginDataDir = path.join(dataDir, 'plugins', pluginId);

  // Ensure directory exists. 0o700 (owner-only) because plugin storage holds the same class of
  // secret as the registry (OAuth/refresh tokens, webhook secrets a plugin persists) — mirror the
  // hardening saveRegistry already applies rather than inherit a group/other-readable umask default.
  if (!fs.existsSync(pluginDataDir)) {
    fs.mkdirSync(pluginDataDir, { recursive: true, mode: 0o700 });
  }

  // Containment: validate the logical key, then encode it to a filesystem-safe filename. This keeps
  // JID-style keys (`group:sess-1:12345@g.us`) portable on Windows while still rejecting traversal.
  const resolveKeyPath = (key: string): string | null => {
    if (!isSafeStorageKey(key)) return null;
    const fileName = `${encodeStorageKey(key)}.json`;
    return isPathWithin(pluginDataDir, fileName) ? path.join(pluginDataDir, fileName) : null;
  };

  // Backward compatibility for pre-encoded storage files (`state.json`). Reads/deletes consult it,
  // but new writes always use the encoded filename above.
  const resolveLegacyKeyPath = (key: string): string | null => {
    if (!isSafeStorageKey(key)) return null;
    const fileName = `${key}.json`;
    return isPathWithin(pluginDataDir, fileName) ? path.join(pluginDataDir, fileName) : null;
  };

  return {
    get: <T = unknown>(key: string): Promise<T | null> => {
      const filePath = resolveKeyPath(key);
      if (!filePath) {
        logger.warn(`Refusing to read plugin data with an unsafe key: ${pluginId}/${key}`);
        return Promise.resolve(null);
      }
      try {
        const legacyPath = resolveLegacyKeyPath(key);
        const candidates = legacyPath && legacyPath !== filePath ? [filePath, legacyPath] : [filePath];
        for (const candidate of candidates) {
          if (fs.existsSync(candidate)) {
            const content = fs.readFileSync(candidate, 'utf-8');
            return Promise.resolve(JSON.parse(content) as T);
          }
        }
      } catch (error) {
        logger.error(`Failed to read plugin data: ${pluginId}/${key}`, String(error));
      }
      return Promise.resolve(null);
    },

    set: <T = unknown>(key: string, value: T): Promise<void> => {
      const filePath = resolveKeyPath(key);
      if (!filePath) {
        return Promise.reject(new Error(`Unsafe plugin storage key: ${key}`));
      }
      try {
        // 0o600 (owner-only): a plugin-persisted secret must not land in a group/other-readable file.
        // The mode on the temp write carries through the rename; chmod is a backstop if the target
        // pre-existed (writeFileSync mode only applies on create). Mirrors saveRegistry's hardening.
        atomicWriteFileSync(filePath, JSON.stringify(value, null, 2), { mode: 0o600 });
        fs.chmodSync(filePath, 0o600);
        // Migrate off any pre-encoding legacy file for this key so a stale copy can't shadow reads/lists.
        const legacyPath = resolveLegacyKeyPath(key);
        if (legacyPath && legacyPath !== filePath && fs.existsSync(legacyPath)) {
          fs.unlinkSync(legacyPath);
        }
        return Promise.resolve();
      } catch (error) {
        logger.error(`Failed to write plugin data: ${pluginId}/${key}`, String(error));
        return Promise.reject(new Error(error instanceof Error ? error.message : String(error)));
      }
    },

    delete: (key: string): Promise<void> => {
      const filePath = resolveKeyPath(key);
      if (!filePath) {
        return Promise.reject(new Error(`Unsafe plugin storage key: ${key}`));
      }
      try {
        const legacyPath = resolveLegacyKeyPath(key);
        const candidates = legacyPath && legacyPath !== filePath ? [filePath, legacyPath] : [filePath];
        for (const candidate of candidates) {
          if (fs.existsSync(candidate)) {
            fs.unlinkSync(candidate);
          }
        }
        return Promise.resolve();
      } catch (error) {
        logger.error(`Failed to delete plugin data: ${pluginId}/${key}`, String(error));
        return Promise.reject(new Error(error instanceof Error ? error.message : String(error)));
      }
    },

    list: (prefix?: string): Promise<string[]> => {
      try {
        const files = fs.readdirSync(pluginDataDir);
        let keys = Array.from(
          new Set(
            files
              .filter(f => f.endsWith('.json'))
              .map(f => f.slice(0, -'.json'.length))
              .map(stem => decodeStorageFileName(stem) ?? stem),
          ),
        );

        if (prefix) {
          keys = keys.filter(k => k.startsWith(prefix));
        }

        return Promise.resolve(keys);
      } catch (error) {
        logger.error(`Failed to list plugin data: ${pluginId}`, String(error));
        return Promise.resolve([]);
      }
    },
  };
}
