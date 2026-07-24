import * as fs from 'node:fs';
import { atomicWriteJson } from './translate-fs';

/**
 * Per-user keyword alerts: a watcher registers keywords via `/watch`; when any later group message
 * contains one, the caller DMs that watcher. Persisted as flat JSON `{ watcherJid: [keyword...] }`,
 * keywords stored lowercased for case-insensitive substring matching.
 */
export class WatchwordStore {
  private data: Record<string, string[]> = {};

  constructor(private readonly filePath: string) {}

  /** Load from disk; returns the watcher count (0 if absent/unreadable — fine, run without alerts). */
  load(): number {
    try {
      this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, string[]>;
      return Object.keys(this.data).length;
    } catch {
      this.data = {};
      return 0;
    }
  }

  private save(): void {
    atomicWriteJson(this.filePath, this.data);
  }

  list(watcher: string): string[] {
    return [...(this.data[watcher] ?? [])];
  }

  add(watcher: string, keyword: string): boolean {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return false;
    const arr = (this.data[watcher] ??= []);
    if (arr.includes(kw)) return false;
    arr.push(kw);
    this.save();
    return true;
  }

  remove(watcher: string, keyword: string): boolean {
    const kw = keyword.trim().toLowerCase();
    const arr = this.data[watcher];
    if (!arr) return false;
    const i = arr.indexOf(kw);
    if (i < 0) return false;
    arr.splice(i, 1);
    if (arr.length === 0) delete this.data[watcher];
    this.save();
    return true;
  }

  /** Watchers (excluding the author) with a keyword occurring in `text`. One hit per watcher. */
  matches(text: string, author?: string): { watcher: string; keyword: string }[] {
    const lower = text.toLowerCase();
    const out: { watcher: string; keyword: string }[] = [];
    for (const [watcher, kws] of Object.entries(this.data)) {
      if (watcher === author) continue; // don't ping you about your own message
      const hit = kws.find(k => lower.includes(k));
      if (hit) out.push({ watcher, keyword: hit });
    }
    return out;
  }

  /**
   * Handle a `/watch ...` body (prefix already stripped). Keywords are per-watcher, so there is no
   * admin gate — everyone manages their own list.
   *   /watch                 list your keywords
   *   /watch add <關鍵字>     add one
   *   /watch del <關鍵字>     remove one
   */
  command(rest: string, watcher: string): string {
    const trimmed = rest.trim();
    if (!trimmed || /^list$/i.test(trimmed)) {
      const kws = this.list(watcher);
      return kws.length
        ? ['你的關鍵字提醒：', ...kws.map(k => `- ${k}`)].join('\n')
        : '你尚未設定關鍵字提醒。用 /watch add 關鍵字 新增。';
    }
    const add = trimmed.match(/^add\s+(.+)$/i);
    if (add) {
      const kw = add[1].trim();
      return this.add(watcher, kw) ? `已新增提醒：${kw}` : `關鍵字已存在或無效：${kw}`;
    }
    const del = trimmed.match(/^del(?:ete)?\s+(.+)$/i);
    if (del) {
      const kw = del[1].trim();
      return this.remove(watcher, kw) ? `已移除提醒：${kw}` : `找不到關鍵字：${kw}`;
    }
    return ['指令：', '/watch          列出你的關鍵字', '/watch add 關鍵字', '/watch del 關鍵字'].join('\n');
  }
}

// ponytail: assert-based self-check — run `node -r ts-node/register translate-watchwords.ts`
if (require.main === module) {
  const os = require('node:os');
  const path = require('node:path');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-')), 'watchwords.json');
  const w = new WatchwordStore(tmp);
  w.load();
  if (!w.add('u1@c.us', '緊急')) throw new Error('add failed');
  if (w.add('u1@c.us', '緊急')) throw new Error('dupe should not re-add');
  if (w.matches('這個很緊急', 'u1@c.us').length !== 0) throw new Error('author should be skipped');
  const m = w.matches('這個很緊急', 'u2@c.us');
  if (m.length !== 1 || m[0].keyword !== '緊急') throw new Error(`match failed: ${JSON.stringify(m)}`);
  if (!w.remove('u1@c.us', '緊急')) throw new Error('remove failed');
  if (new WatchwordStore(tmp).load() !== 0) throw new Error('empty watcher not pruned/persisted');
  // eslint-disable-next-line no-console
  console.log('WatchwordStore self-check ok');
}
