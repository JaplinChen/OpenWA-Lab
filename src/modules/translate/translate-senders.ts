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

  /**
   * Handle a `/sender ...` command body (already stripped of the leading token). `canMutate` gates
   * add/del (admin allowlist). Returns the reply text; mutations persist immediately.
   *   /sender                            list all overrides
   *   /sender add <JID|@號碼> = <名稱>    add/overwrite
   *   /sender del <JID|@號碼>             remove
   */
  command(rest: string, canMutate: boolean): string {
    if (!rest || /^list$/i.test(rest)) {
      const entries = Object.entries(this.data);
      return entries.length
        ? ['發送者對照表：', ...entries.map(([j, n]) => `- @${j} → ${n}`)].join('\n')
        : '發送者對照表目前為空。';
    }
    if (!canMutate) return '此指令僅限管理員使用。';

    const add = rest.match(/^add\s+(.+?)\s*(?:=|→|->)\s*(.+)$/i);
    if (add) {
      const jid = add[1].trim();
      const name = add[2].trim();
      if (!jid || !name) return '格式錯誤，請用：/sender add <JID或@號碼> = 名稱';
      this.add(jid, name);
      return `已新增發送者：@${this.normalize(jid)} → ${name}`;
    }

    const del = rest.match(/^del(?:ete)?\s+(.+)$/i);
    if (del) {
      const jid = del[1].trim();
      return this.remove(jid) ? `已移除發送者：${jid}` : `找不到發送者：${jid}`;
    }

    return ['指令：', '/sender  列出對照', '/sender add <JID或@號碼> = 名稱', '/sender del <JID>'].join('\n');
  }
}
