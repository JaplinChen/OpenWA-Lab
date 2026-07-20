import * as fs from 'node:fs';
import { atomicWriteJson } from './translate-fs';

/**
 * Manual `@mention` overrides: JID user-part (digits) -> display name, persisted as flat JSON.
 * Fills the gap when the session store can't resolve a mentioned JID (unsaved contact, no pushName)
 * and the translated message would otherwise show a raw `@200859128434777` instead of a name.
 */
export class SenderDirectory {
  private data: Record<string, string> = {};
  private usage: Record<string, number> = {};
  private readonly usagePath: string;

  constructor(private readonly filePath: string) {
    this.usagePath = filePath.replace(/\.json$/, '-usage.json');
  }

  /** Load from disk; returns the entry count (0 if absent/unreadable — fine, translate without it). */
  load(): number {
    try {
      this.usage = JSON.parse(fs.readFileSync(this.usagePath, 'utf8')) as Record<string, number>;
    } catch {
      this.usage = {};
    }
    try {
      this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, string>;
      return Object.keys(this.data).length;
    } catch {
      this.data = {};
      return 0;
    }
  }

  private save(): void {
    atomicWriteJson(this.filePath, this.data);
  }

  /** Accept "200859...@c.us", "@200859...", or bare digits — store just the digits. */
  private normalize(jid: string): string {
    const m = jid.match(/\d+/);
    return m ? m[0] : jid.trim();
  }

  entries(): { jid: string; name: string; count: number }[] {
    return Object.entries(this.data).map(([jid, name]) => ({ jid, name, count: this.usage[jid] ?? 0 }));
  }

  add(jid: string, name: string): void {
    this.data[this.normalize(jid)] = name;
    this.save();
  }

  /** Passive learn: record jid->name only if the jid is unknown (manual/earlier entries win). Returns true if stored. */
  learn(jid: string, name: string): boolean {
    const key = this.normalize(jid);
    const n = name.trim();
    if (!key || !n || this.data[key]) return false; // empty-name pending entries may be filled
    this.data[key] = n;
    this.save();
    return true;
  }

  /** Bulk-add from a contact list; skips JIDs already present so manual edits win. Returns count added. */
  importEntries(items: { jid: string; name: string }[]): number {
    let added = 0;
    for (const { jid, name } of items) {
      const key = this.normalize(jid);
      if (!key || this.data[key] || !name.trim()) continue;
      this.data[key] = name.trim();
      added++;
    }
    if (added) this.save();
    return added;
  }

  remove(jid: string): boolean {
    const key = this.normalize(jid);
    if (!(key in this.data)) return false;
    delete this.data[key];
    this.save();
    return true;
  }

  /**
   * Queue unresolved mentioned jids as empty-name entries so the dashboard lists them for an admin
   * to fill in. Only jids whose raw `@<digits>` token actually leaked into the body qualify — a
   * resolved mention was already replaced by the adapter. Empty names are skipped by apply().
   */
  notePending(jids: string[], body: string): void {
    let added = false;
    for (const jid of jids) {
      const key = this.normalize(jid);
      if (!key || key in this.data || !body.includes(`@${key}`)) continue;
      this.data[key] = '';
      added = true;
    }
    if (added) this.save();
  }

  /**
   * Count a usage hit for each mentioned jid present in the table. The adapter already swaps the
   * `@<digits>` token for the name at receive time (session-store senderOverride reads the same file),
   * so apply() below never sees the raw token anymore — mentionedIds is the reliable usage signal.
   */
  markUsed(jids: string[] = []): void {
    let hit = false;
    for (const jid of jids) {
      const key = this.normalize(jid);
      if (!(key in this.data)) continue;
      this.usage[key] = (this.usage[key] ?? 0) + 1;
      hit = true;
    }
    if (hit) this.saveUsage();
  }

  // Best-effort: a sidecar write failure must never break a translation in flight.
  private saveUsage(): void {
    try {
      atomicWriteJson(this.usagePath, this.usage);
    } catch {
      // ignore
    }
  }

  /** Replace every known `@<jid>` token in the text with `@<name>` (counting lives in markUsed). */
  apply(text: string): string {
    if (!text) return text;
    let out = text;
    for (const [jid, name] of Object.entries(this.data)) {
      if (!name || !out.includes(`@${jid}`)) continue; // empty name = pending entry, don't replace
      out = out.split(`@${jid}`).join(`@${name}`);
    }
    return out;
  }

}
