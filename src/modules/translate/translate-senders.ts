import * as fs from 'node:fs';

/**
 * Manual `@mention` overrides: JID user-part (digits) -> display name, persisted as flat JSON.
 * Fills the gap when the session store can't resolve a mentioned JID (unsaved contact, no pushName)
 * and the translated message would otherwise show a raw `@200859128434777` instead of a name.
 */
export class SenderDirectory {
  private data: Record<string, string> = {};

  constructor(private readonly filePath: string) {}

  /** Load from disk; returns the entry count (0 if absent/unreadable — fine, translate without it). */
  load(): number {
    try {
      this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, string>;
      return Object.keys(this.data).length;
    } catch {
      this.data = {};
      return 0;
    }
  }

  private save(): void {
    fs.mkdirSync(this.filePath.replace(/[/\\][^/\\]*$/, '') || '.', { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  /** Accept "200859...@c.us", "@200859...", or bare digits — store just the digits. */
  private normalize(jid: string): string {
    const m = jid.match(/\d+/);
    return m ? m[0] : jid.trim();
  }

  entries(): { jid: string; name: string }[] {
    return Object.entries(this.data).map(([jid, name]) => ({ jid, name }));
  }

  add(jid: string, name: string): void {
    this.data[this.normalize(jid)] = name;
    this.save();
  }

  /** Passive learn: record jid->name only if the jid is unknown (manual/earlier entries win). Returns true if stored. */
  learn(jid: string, name: string): boolean {
    const key = this.normalize(jid);
    const n = name.trim();
    if (!key || !n || key in this.data) return false;
    this.data[key] = n;
    this.save();
    return true;
  }

  /** Bulk-add from a contact list; skips JIDs already present so manual edits win. Returns count added. */
  importEntries(items: { jid: string; name: string }[]): number {
    let added = 0;
    for (const { jid, name } of items) {
      const key = this.normalize(jid);
      if (!key || key in this.data || !name.trim()) continue;
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

  /** Replace every known `@<jid>` token in the text with `@<name>`. */
  apply(text: string): string {
    if (!text) return text;
    let out = text;
    for (const [jid, name] of Object.entries(this.data)) {
      out = out.split(`@${jid}`).join(`@${name}`);
    }
    return out;
  }

}
