import * as fs from 'node:fs';

/**
 * zh<->vi term overrides, persisted as JSON keyed by pair (e.g. "zh-tw:vi") -> { source: target }.
 * Format is compatible with WA-Translate's glossary.json.
 */
export class Glossary {
  private data: Record<string, Record<string, string>> = {};

  constructor(private readonly filePath: string) {}

  /** Load from disk; returns the total term count (0 if absent/unreadable — fine, translate without it). */
  load(): number {
    try {
      this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, Record<string, string>>;
      return Object.values(this.data).reduce((n, m) => n + Object.keys(m).length, 0);
    } catch {
      this.data = {};
      return 0;
    }
  }

  private save(): void {
    fs.mkdirSync(this.filePath.replace(/[/\\][^/\\]*$/, '') || '.', { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  /** Prompt section injecting the terms for one direction (empty string when none). */
  section(pairKey: string): string {
    const entries = Object.entries(this.data[pairKey] || {});
    if (!entries.length) return '';
    return ['', '術語表（必須使用以下對照翻譯）：', ...entries.map(([s, t]) => `- ${s} → ${t}`), ''].join('\n');
  }

  /**
   * Handle a `/glossary ...` command body (already stripped of the leading token). `canMutate` gates
   * add/del (admin allowlist). Returns the reply text; mutations persist immediately.
   *   /glossary                       list all terms
   *   /glossary add <中文> = <越南文>   add both directions
   *   /glossary del <詞>               remove any pairing where the term appears on either side
   */
  command(rest: string, canMutate: boolean): string {
    if (!rest || /^list$/i.test(rest)) {
      const lines: string[] = [];
      for (const [key, terms] of Object.entries(this.data)) {
        const entries = Object.entries(terms);
        if (entries.length) lines.push(`[${key}]`, ...entries.map(([s, t]) => `- ${s} → ${t}`));
      }
      return lines.length ? ['術語表：', ...lines].join('\n') : '術語表目前為空。';
    }
    if (!canMutate) return '此指令僅限管理員使用。';

    const add = rest.match(/^add\s+(.+?)\s*(?:=|→|->)\s*(.+)$/i);
    if (add) {
      const zh = add[1].trim();
      const vi = add[2].trim();
      if (!zh || !vi) return '格式錯誤，請用：/glossary add 中文 = tiếng Việt';
      (this.data['zh-tw:vi'] ??= {})[zh] = vi;
      (this.data['vi:zh-tw'] ??= {})[vi] = zh;
      this.save();
      return `已新增術語：${zh} ⇄ ${vi}`;
    }

    const del = rest.match(/^del(?:ete)?\s+(.+)$/i);
    if (del) {
      const term = del[1].trim();
      let removed = false;
      for (const terms of Object.values(this.data)) {
        for (const [s, t] of Object.entries(terms)) {
          if (s === term || t === term) {
            delete terms[s];
            removed = true;
          }
        }
      }
      if (removed) this.save();
      return removed ? `已移除術語：${term}` : `找不到術語：${term}`;
    }

    return ['指令：', '/glossary  列出術語', '/glossary add 中文 = tiếng Việt', '/glossary del <詞>'].join('\n');
  }
}
