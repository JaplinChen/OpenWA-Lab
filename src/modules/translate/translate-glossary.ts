import * as fs from 'node:fs';

/**
 * zh<->vi term overrides, persisted as JSON keyed by pair (e.g. "zh-tw:vi") -> { source: target }.
 * Format is compatible with WA-Translate's glossary.json.
 */
export interface PendingSuggestion {
  id: number;
  zh: string;
  vi: string;
  suggestedBy: string;
  at: string;
}

export class Glossary {
  private data: Record<string, Record<string, string>> = {};
  private pendingData: PendingSuggestion[] = [];
  private usage: Record<string, number> = {};
  private readonly pendingPath: string;
  private readonly usagePath: string;

  constructor(private readonly filePath: string, pendingPath?: string) {
    this.pendingPath = pendingPath || filePath.replace(/\.json$/, '-pending.json');
    this.usagePath = filePath.replace(/\.json$/, '-usage.json');
  }

  private static readonly CJK = /[一-鿿]/;

  /** Users type pairs in either direction; put the CJK term on the zh side (no-op when ambiguous). */
  private static orient(a: string, b: string): [string, string] {
    return !Glossary.CJK.test(a) && Glossary.CJK.test(b) ? [b, a] : [a, b];
  }

  /** Load from disk; returns the total term count (0 if absent/unreadable — fine, translate without it). */
  load(): number {
    try {
      this.pendingData = JSON.parse(fs.readFileSync(this.pendingPath, 'utf8')) as PendingSuggestion[];
    } catch {
      this.pendingData = [];
    }
    try {
      this.usage = JSON.parse(fs.readFileSync(this.usagePath, 'utf8')) as Record<string, number>;
    } catch {
      this.usage = {};
    }
    try {
      this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, Record<string, string>>;
      this.migrateReversed();
      return Object.values(this.data).reduce((n, m) => n + Object.keys(m).length, 0);
    } catch {
      this.data = {};
      return 0;
    }
  }

  /** Self-heal entries stored on the wrong side by pre-orient versions (e.g. "sếp ơi" under zh). */
  private migrateReversed(): void {
    let changed = false;
    const pairs: [string, string][] = [
      ...Object.entries(this.data['zh-tw:vi'] || {}).map(([zh, vi]): [string, string] => [zh, vi]),
      ...Object.entries(this.data['vi:zh-tw'] || {}).map(([vi, zh]): [string, string] => [zh, vi]),
    ];
    for (const [zh, vi] of pairs) {
      const [z, v] = Glossary.orient(zh, vi);
      if (z !== zh) {
        delete this.data['zh-tw:vi']?.[zh];
        delete this.data['vi:zh-tw']?.[vi];
        (this.data['zh-tw:vi'] ??= {})[z] = v;
        (this.data['vi:zh-tw'] ??= {})[v] = z;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private save(): void {
    fs.mkdirSync(this.filePath.replace(/[/\\][^/\\]*$/, '') || '.', { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  private savePending(): void {
    fs.mkdirSync(this.pendingPath.replace(/[/\\][^/\\]*$/, '') || '.', { recursive: true });
    fs.writeFileSync(this.pendingPath, JSON.stringify(this.pendingData, null, 2), 'utf8');
  }

  /** Usage counters keyed by the zh term, persisted beside the glossary so its format stays WA-Translate compatible. */
  private bump(zh: string): void {
    this.usage[zh] = (this.usage[zh] ?? 0) + 1;
    fs.writeFileSync(this.usagePath, JSON.stringify(this.usage, null, 2), 'utf8');
  }

  /** zh->vi terms as a flat list for the dashboard/API (source = 中文, target = 越南文). */
  entries(): { source: string; target: string; count: number }[] {
    return Object.entries(this.data['zh-tw:vi'] || {}).map(([source, target]) => ({
      source,
      target,
      count: this.usage[source] ?? 0,
    }));
  }

  /** Add/overwrite a zh<->vi term in both directions, persisting immediately. */
  add(zh: string, vi: string): void {
    [zh, vi] = Glossary.orient(zh, vi);
    (this.data['zh-tw:vi'] ??= {})[zh] = vi;
    (this.data['vi:zh-tw'] ??= {})[vi] = zh;
    this.save();
  }

  /** Remove any pairing where `term` appears on either side; returns whether anything was removed. */
  remove(term: string): boolean {
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
    return removed;
  }

  has(zh: string, vi: string): boolean {
    return (this.data['zh-tw:vi'] || {})[zh] === vi;
  }

  pending(): PendingSuggestion[] {
    return [...this.pendingData];
  }

  /** Queue a suggestion; returns the assigned id, or null when the pair already exists (glossary or pending). */
  suggest(zh: string, vi: string, suggestedBy: string): number | null {
    [zh, vi] = Glossary.orient(zh, vi);
    if (this.has(zh, vi) || this.pendingData.some(p => p.zh === zh && p.vi === vi)) return null;
    const id = this.pendingData.reduce((m, p) => Math.max(m, p.id), 0) + 1;
    this.pendingData.push({ id, zh, vi, suggestedBy, at: new Date().toISOString() });
    this.savePending();
    return id;
  }

  /** Move a pending suggestion into the glossary; returns it, or null when the id is unknown. */
  approve(id: number): PendingSuggestion | null {
    const entry = this.pendingData.find(p => p.id === id);
    if (!entry) return null;
    this.pendingData = this.pendingData.filter(p => p.id !== id);
    this.savePending();
    this.add(entry.zh, entry.vi);
    return entry;
  }

  /** Drop a pending suggestion; returns it, or null when the id is unknown. */
  reject(id: number): PendingSuggestion | null {
    const entry = this.pendingData.find(p => p.id === id);
    if (!entry) return null;
    this.pendingData = this.pendingData.filter(p => p.id !== id);
    this.savePending();
    return entry;
  }

  /**
   * Prompt section injecting ONLY the terms whose source actually appears in `text` (empty when none).
   * Injecting the whole table (hundreds of entries) bloats the prompt and makes weak models echo the
   * term list back as their "translation" — so filter to what this message really uses.
   */
  section(pairKey: string, text = ''): string {
    const entries = Object.entries(this.data[pairKey] || {}).filter(([source]) => text.includes(source));
    if (!entries.length) return '';
    for (const [s, t] of entries) this.bump(pairKey.startsWith('vi') ? t : s);
    return ['', '術語表（必須使用以下對照翻譯）：', ...entries.map(([s, t]) => `- ${s} → ${t}`), ''].join('\n');
  }

  /**
   * Handle a `/glossary ...` command body (already stripped of the leading token). `canMutate` gates
   * add/del (admin allowlist). Returns the reply text; mutations persist immediately.
   *   /glossary                       list all terms
   *   /glossary add <中文> = <越南文>   add both directions
   *   /glossary del <詞>               remove any pairing where the term appears on either side
   *   /glossary suggest 中文 = vi       queue a suggestion (anyone; `sender` is recorded)
   *   /glossary pending|approve|reject  admin review of queued suggestions
   */
  command(rest: string, canMutate: boolean, sender = ''): string {
    if (!rest || /^list$/i.test(rest)) {
      const lines: string[] = [];
      for (const [key, terms] of Object.entries(this.data)) {
        const entries = Object.entries(terms);
        if (entries.length) lines.push(`[${key}]`, ...entries.map(([s, t]) => `- ${s} → ${t}`));
      }
      return lines.length ? ['術語表：', ...lines].join('\n') : '術語表目前為空。';
    }

    const suggest = rest.match(/^suggest\s+(.+?)\s*(?:=|→|->)\s*(.+)$/i);
    if (suggest) {
      const zh = suggest[1].trim();
      const vi = suggest[2].trim();
      if (!zh || !vi) return '格式錯誤，請用：/glossary suggest 中文 = tiếng Việt';
      const id = this.suggest(zh, vi, sender);
      if (id === null) return `此術語已存在或已在待審清單：${zh} ⇄ ${vi}`;
      return `已收到建議 #${id}：${zh} ⇄ ${vi}，待管理員審核。`;
    }
    if (/^suggest\b/i.test(rest)) return '格式錯誤，請用：/glossary suggest 中文 = tiếng Việt';

    const bare = /^(?:add|del(?:ete)?|pending|approve|reject|ok|no|list)\b/i.test(rest)
      ? null
      : rest.match(/^(.+?)\s*(?:=|→|->)\s*(.+)$/);
    if (bare) {
      const zh = bare[1].trim();
      const vi = bare[2].trim();
      if (zh && vi) {
        if (canMutate) {
          this.add(zh, vi);
          return `已新增術語：${zh} ⇄ ${vi}`;
        }
        const id = this.suggest(zh, vi, sender);
        if (id === null) return `此術語已存在或已在待審清單：${zh} ⇄ ${vi}`;
        return `已收到建議 #${id}：${zh} ⇄ ${vi}，待管理員審核。`;
      }
    }

    if (!canMutate) return '此指令僅限管理員使用。';

    if (/^pending$/i.test(rest)) {
      if (!this.pendingData.length) return '目前沒有待審建議。';
      return ['待審建議：', ...this.pendingData.map(p => `#${p.id} ${p.zh} = ${p.vi}（${p.suggestedBy}）`)].join('\n');
    }

    const approve = rest.match(/^(?:approve|ok)\s+(\d+)$/i);
    if (approve) {
      const entry = this.approve(Number(approve[1]));
      return entry ? `已核准 #${entry.id}：${entry.zh} ⇄ ${entry.vi}` : `找不到建議 #${approve[1]}`;
    }

    const reject = rest.match(/^(?:reject|no)\s+(\d+)$/i);
    if (reject) {
      const entry = this.reject(Number(reject[1]));
      return entry ? `已拒絕 #${entry.id}：${entry.zh} ⇄ ${entry.vi}` : `找不到建議 #${reject[1]}`;
    }

    const add = rest.match(/^add\s+(.+?)\s*(?:=|→|->)\s*(.+)$/i);
    if (add) {
      const zh = add[1].trim();
      const vi = add[2].trim();
      if (!zh || !vi) return '格式錯誤，請用：/glossary add 中文 = tiếng Việt';
      this.add(zh, vi);
      return `已新增術語：${zh} ⇄ ${vi}`;
    }

    const del = rest.match(/^del(?:ete)?\s+(.+)$/i);
    if (del) {
      const term = del[1].trim();
      const removed = this.remove(term);
      return removed ? `已移除術語：${term}` : `找不到術語：${term}`;
    }

    return [
      '指令：',
      '/g  列出術語',
      '/g 詞 = nghĩa',
      '/g pending',
      '/g ok|no <id>',
      '/g del <詞>',
    ].join('\n');
  }
}
