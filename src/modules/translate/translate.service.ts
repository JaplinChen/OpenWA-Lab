import { Injectable, OnModuleInit } from '@nestjs/common';
import * as fs from 'node:fs';
import { HookManager, HookContext, HookResult } from '../../core/hooks';
import { MessageService } from '../message/message.service';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';

// Invisible marker (ported from WA-Translate) prepended to bot output so the bot never re-translates
// its own messages. U+2063 is a zero-width invisible separator — it does not alter the visible text.
const BOT_MARKER = '⁣⁣';

const ZH_RE = /[㐀-鿿豈-﫿]/;
const VI_RE = /[ăâđêôơưĂÂĐÊÔƠƯáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;

interface Pair {
  key: string; // glossary lookup key, matches WA-Translate glossary.json (e.g. "zh-tw:vi")
  source: string;
  targetLabel: string;
}
const ZH_TO_VI: Pair = { key: 'zh-tw:vi', source: '繁體中文', targetLabel: '越南文 (Tiếng Việt)' };
const VI_TO_ZH: Pair = { key: 'vi:zh-tw', source: '越南文', targetLabel: '繁體中文' };

@Injectable()
export class TranslateService implements OnModuleInit {
  private readonly logger = createLogger('TranslateService');

  private enabled = false;
  private groupIds = new Set<string>();
  private apiKeys: string[] = [];
  private model = 'gemini-2.5-flash';
  private minIntervalMs = 12000;
  // pairKey -> { source: target } term overrides, injected into the prompt (ported from WA-Translate).
  private glossary: Record<string, Record<string, string>> = {};
  private glossaryPath = 'secrets/glossary.json';
  // Author WIDs allowed to mutate the glossary via /glossary commands. Empty = anyone in the group.
  private adminIds = new Set<string>();

  // Serialize translations behind one chain so we honour Gemini's rate limit (ported queue+throttle).
  private queue: Promise<unknown> = Promise.resolve();
  private keyIndex = 0;
  private nextAt = 0;

  constructor(
    private readonly hookManager: HookManager,
    private readonly messageService: MessageService,
  ) {}

  onModuleInit(): void {
    this.enabled = process.env.TRANSLATE_ENABLED === 'true';
    this.groupIds = new Set(
      (process.env.TRANSLATE_GROUP_IDS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
    );
    this.apiKeys = (process.env.GEMINI_API_KEYS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    this.model = process.env.GEMINI_MODEL || this.model;
    const iv = Number(process.env.GEMINI_MIN_INTERVAL_MS);
    if (Number.isFinite(iv) && iv >= 0) this.minIntervalMs = iv;
    this.glossaryPath = process.env.TRANSLATE_GLOSSARY_PATH || this.glossaryPath;
    this.adminIds = new Set(
      (process.env.TRANSLATE_ADMIN_IDS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
    );
    this.loadGlossary(this.glossaryPath);

    if (!this.enabled) return;
    if (this.apiKeys.length === 0 || this.groupIds.size === 0) {
      this.logger.warn('Translate enabled but GEMINI_API_KEYS or TRANSLATE_GROUP_IDS is empty — disabling');
      this.enabled = false;
      return;
    }
    this.hookManager.register(
      'translate',
      'message:received',
      ctx => this.onMessage(ctx as HookContext<IncomingMessage>),
      50,
    );
    this.logger.log(`Translate active for ${this.groupIds.size} group(s), model=${this.model}`);
  }

  // Fire-and-forget: never block the receive pipeline (SessionService awaits the hook chain before
  // persisting). We kick off translation async and return continue:true immediately.
  private async onMessage(ctx: HookContext<IncomingMessage>): Promise<HookResult<IncomingMessage>> {
    const msg = ctx.data;
    const pass: HookResult<IncomingMessage> = { continue: true };
    try {
      if (msg.fromMe || msg.type !== 'text') return pass;
      if (!msg.isGroup || !this.groupIds.has(msg.chatId)) return pass;
      const body = msg.body || '';
      if (!body.trim() || body.startsWith(BOT_MARKER)) return pass;

      const sessionId = ctx.sessionId;
      if (!sessionId) return pass;

      const trimmed = body.trim();
      const lower = trimmed.toLowerCase();
      if (lower === '/glossary' || lower.startsWith('/glossary ')) {
        void this.handleGlossaryCommand(sessionId, msg, trimmed).catch(err =>
          this.logger.error('Glossary command failed', String(err)),
        );
        return pass; // command, not content to translate
      }

      const pair = this.detectPair(body);
      if (!pair) return pass; // not zh/vi — leave it alone

      void this.enqueue(async () => {
        const translated = await this.translate(body, pair);
        // Gemini rule 3 can echo the source when it's not translatable natural language — don't
        // spam the group with a verbatim copy.
        if (!translated || translated.trim() === body.trim()) return;
        await this.messageService.sendText(sessionId, {
          chatId: msg.chatId,
          text: BOT_MARKER + translated,
        });
      }).catch(err => this.logger.error('Translate task failed', String(err)));
    } catch (err) {
      this.logger.error('Translate hook error', String(err));
    }
    return pass;
  }

  private loadGlossary(path: string): void {
    try {
      this.glossary = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, Record<string, string>>;
      const terms = Object.values(this.glossary).reduce((n, m) => n + Object.keys(m).length, 0);
      if (terms > 0) this.logger.log(`Glossary loaded: ${terms} term(s) from ${path}`);
    } catch {
      this.glossary = {}; // absent/unreadable glossary is fine — translate without term overrides
    }
  }

  private saveGlossary(): void {
    fs.mkdirSync(this.glossaryPath.replace(/[/\\][^/\\]*$/, '') || '.', { recursive: true });
    fs.writeFileSync(this.glossaryPath, JSON.stringify(this.glossary, null, 2), 'utf8');
  }

  // Group commands (marker-prefixed replies so the bot never re-translates its own output):
  //   /glossary                       list all terms
  //   /glossary add <中文> = <越南文>   add both directions
  //   /glossary del <詞>               remove any pairing where the term appears on either side
  private async handleGlossaryCommand(sessionId: string, msg: IncomingMessage, raw: string): Promise<void> {
    const reply = (text: string): Promise<unknown> =>
      this.messageService.sendText(sessionId, { chatId: msg.chatId, text: BOT_MARKER + text });

    const rest = raw.replace(/^\/glossary\s*/i, '').trim();

    if (!rest || /^list$/i.test(rest)) {
      const lines: string[] = [];
      for (const [key, terms] of Object.entries(this.glossary)) {
        const entries = Object.entries(terms);
        if (entries.length) lines.push(`[${key}]`, ...entries.map(([s, t]) => `- ${s} → ${t}`));
      }
      await reply(lines.length ? ['術語表：', ...lines].join('\n') : '術語表目前為空。');
      return;
    }

    const author = msg.author || msg.from;
    if (this.adminIds.size > 0 && !this.adminIds.has(author)) {
      await reply('此指令僅限管理員使用。');
      return;
    }

    const addMatch = rest.match(/^add\s+(.+?)\s*(?:=|→|->)\s*(.+)$/i);
    if (addMatch) {
      const zh = addMatch[1].trim();
      const vi = addMatch[2].trim();
      if (!zh || !vi) {
        await reply('格式錯誤，請用：/glossary add 中文 = tiếng Việt');
        return;
      }
      (this.glossary['zh-tw:vi'] ??= {})[zh] = vi;
      (this.glossary['vi:zh-tw'] ??= {})[vi] = zh;
      this.saveGlossary();
      await reply(`已新增術語：${zh} ⇄ ${vi}`);
      return;
    }

    const delMatch = rest.match(/^del(?:ete)?\s+(.+)$/i);
    if (delMatch) {
      const term = delMatch[1].trim();
      let removed = false;
      for (const terms of Object.values(this.glossary)) {
        for (const [s, t] of Object.entries(terms)) {
          if (s === term || t === term) {
            delete terms[s];
            removed = true;
          }
        }
      }
      if (removed) this.saveGlossary();
      await reply(removed ? `已移除術語：${term}` : `找不到術語：${term}`);
      return;
    }

    await reply(
      ['指令：', '/glossary  列出術語', '/glossary add 中文 = tiếng Việt', '/glossary del <詞>'].join('\n'),
    );
  }

  private detectPair(text: string): Pair | null {
    if (ZH_RE.test(text)) return ZH_TO_VI;
    if (VI_RE.test(text)) return VI_TO_ZH;
    return null;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private buildPrompt(text: string, pair: Pair): string {
    const entries = Object.entries(this.glossary[pair.key] || {});
    const glossarySection =
      entries.length > 0
        ? ['', '術語表（必須使用以下對照翻譯）：', ...entries.map(([s, t]) => `- ${s} → ${t}`), ''].join('\n')
        : '';
    return [
      '你是專業翻譯引擎，只做翻譯。',
      `請把以下內容從 ${pair.source} 翻譯成 ${pair.targetLabel}。`,
      '規則：',
      '1) 僅輸出翻譯結果，不要解釋。',
      '2) 保留人名、網址、程式碼、數字與專有名詞（術語表另有指定者除外）。',
      '3) 若原文主要不是可翻譯自然語言，回傳原文。',
      glossarySection,
      text,
    ].join('\n');
  }

  private async translate(text: string, pair: Pair): Promise<string> {
    const prompt = this.buildPrompt(text, pair);
    let lastErr: unknown = null;
    for (let i = 0; i < this.apiKeys.length; i += 1) {
      const idx = (this.keyIndex + i) % this.apiKeys.length;
      try {
        const now = Date.now();
        if (this.nextAt > now) await sleep(this.nextAt - now);
        const out = await this.callGemini(this.apiKeys[idx], prompt);
        this.nextAt = Date.now() + this.minIntervalMs;
        this.keyIndex = (idx + 1) % this.apiKeys.length;
        return out;
      } catch (err) {
        lastErr = err;
        if (isRateLimit(err)) {
          this.logger.warn('Gemini rate-limited, rotating key');
          continue;
        }
      }
    }
    throw lastErr || new Error('translate failed');
  }

  private async callGemini(key: string, prompt: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${key}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!res.ok) {
      const err = new Error(`Gemini HTTP ${res.status}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const out = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!out) throw new Error('Gemini empty response');
    return out;
  }
}

function isRateLimit(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 429 || status === 503;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
