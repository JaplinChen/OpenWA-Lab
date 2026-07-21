import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../../core/plugins/plugin-storage.fs';

// The llm-key-proxy container reads its keys from this .env at startup (PROVIDER_API_KEY_N lines).
// Mounted into openwa-lab-api at /app/keyproxy (see docker-compose.yml); overridable for tests.
export const keyproxyEnvPath = (): string => process.env.KEYPROXY_ENV_PATH || 'keyproxy/.env';

export interface KeyEntry {
  provider: string; // lowercase, e.g. 'gemini'
  index: number; // 1-based position within its provider (assigned on serialize)
  key: string; // full secret — never leaves the backend
}

export interface ParsedEnv {
  keys: KeyEntry[];
  // Every non-key line (PROXY_API_KEY, comments, blanks) preserved verbatim so a rewrite never
  // clobbers the proxy's own settings.
  otherLines: string[];
  proxyApiKey: string;
}

// `GEMINI_API_KEY_1=...`. PROXY_API_KEY has no _<n> suffix so it deliberately does NOT match here.
const KEY_LINE = /^([A-Z0-9_]+)_API_KEY_(\d+)\s*=\s*(.*)$/;
const PROXY_KEY_LINE = /^PROXY_API_KEY\s*=\s*(.*)$/;

function unquote(v: string): string {
  const t = v.trim();
  const q = t[0];
  return t.length >= 2 && (q === '"' || q === "'") && t[t.length - 1] === q ? t.slice(1, -1) : t;
}

export function parseEnv(content: string): ParsedEnv {
  const keys: KeyEntry[] = [];
  const otherLines: string[] = [];
  let proxyApiKey = '';
  for (const line of content.split(/\r?\n/)) {
    const m = KEY_LINE.exec(line.trim());
    if (m) {
      const key = unquote(m[3]);
      if (key) keys.push({ provider: m[1].toLowerCase(), index: Number(m[2]), key });
      continue;
    }
    const pm = PROXY_KEY_LINE.exec(line.trim());
    if (pm) proxyApiKey = unquote(pm[1]);
    otherLines.push(line);
  }
  return { keys, otherLines, proxyApiKey };
}

// Re-number each provider's keys contiguously (1..n): the proxy scans _1, _2, ... and a gap would
// silently drop later keys, so deletion must never leave a hole.
export function serializeEnv(parsed: ParsedEnv): string {
  const byProvider = new Map<string, string[]>();
  for (const k of parsed.keys) {
    const list = byProvider.get(k.provider) ?? [];
    list.push(k.key);
    byProvider.set(k.provider, list);
  }
  const keyLines: string[] = [];
  for (const [provider, list] of byProvider) {
    list.forEach((key, i) => keyLines.push(`${provider.toUpperCase()}_API_KEY_${i + 1}="${key}"`));
  }
  const other = parsed.otherLines.filter(l => l.trim() !== '');
  return [...other, ...keyLines, ''].join('\n');
}

export class KeyProxyEnvStore {
  read(): ParsedEnv {
    let content = '';
    try {
      content = fs.readFileSync(keyproxyEnvPath(), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return parseEnv(content);
  }

  private write(parsed: ParsedEnv): void {
    const file = keyproxyEnvPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteFileSync(file, serializeEnv(parsed), { mode: 0o600 });
  }

  addKey(provider: string, key: string): void {
    const parsed = this.read();
    parsed.keys.push({ provider, index: 0, key }); // index reassigned on serialize
    this.write(parsed);
  }

  deleteKey(provider: string, index: number): boolean {
    const parsed = this.read();
    const before = parsed.keys.length;
    parsed.keys = parsed.keys.filter(k => !(k.provider === provider && k.index === index));
    if (parsed.keys.length === before) return false;
    this.write(parsed);
    return true;
  }
}
