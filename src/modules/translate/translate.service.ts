import { Injectable, OnModuleInit } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HookManager, HookContext, HookResult } from '../../core/hooks';
import { MessageService } from '../message/message.service';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { Glossary } from './translate-glossary';

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

const CONFIG_PATH = 'data/translate-config.json';

export interface TranslateConfig {
  enabled: boolean;
  groupIds: string[];
  includeFromMe: boolean;
  minSendIntervalMs: number;
}

@Injectable()
export class TranslateService implements OnModuleInit {
  private readonly logger = createLogger('TranslateService');

  private enabled = false;
  private groupIds = new Set<string>();
  private endpoint = 'http://127.0.0.1:11434/api/chat';
  private model = 'translategemma-12b-cline-32768:latest';
  // zh<->vi term overrides injected into the prompt (see Glossary).
  private glossary!: Glossary;
  private glossaryPath = 'secrets/glossary.json';
  // Author WIDs allowed to mutate the glossary via /glossary commands. Empty = anyone in the group.
  private adminIds = new Set<string>();
  // Also translate the account's OWN outgoing messages (message:sent). Needed when the operator IS
  // the controlled number and types in Chinese for Vietnamese members to read. Echo is prevented by
  // the invisible marker: the bot's own translation is fromMe+marker and skipped on the sent path.
  private includeFromMe = false;

  // Anti-ban: minimum gap between outbound translation sends (ms). 0 = no extra pacing.
  private minSendIntervalMs = 0;
  private nextSendAt = 0;

  // hookId for the dynamically (un)registered message:sent hook — null when not registered.
  private sentHookId: string | null = null;

  // Serialize translations behind one chain — a local Ollama model handles one request at a time.
  private queue: Promise<unknown> = Promise.resolve();

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
    this.endpoint = process.env.OLLAMA_ENDPOINT || this.endpoint;
    this.model = process.env.OLLAMA_MODEL || this.model;
    this.glossaryPath = process.env.TRANSLATE_GLOSSARY_PATH || this.glossaryPath;
    this.includeFromMe = process.env.TRANSLATE_INCLUDE_FROM_ME === 'true';
    const si = Number(process.env.TRANSLATE_MIN_SEND_INTERVAL_MS);
    if (Number.isFinite(si) && si >= 0) this.minSendIntervalMs = si;
    this.adminIds = new Set(
      (process.env.TRANSLATE_ADMIN_IDS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
    );
    this.glossary = new Glossary(this.glossaryPath);
    const terms = this.glossary.load();
    if (terms > 0) this.logger.log(`Glossary loaded: ${terms} term(s) from ${this.glossaryPath}`);

    // Persisted runtime config takes precedence over .env; .env values seed the file on first run.
    this.loadConfig();

    // Received hook is always registered; enable/disable is enforced at the top of onMessage so
    // toggling `enabled` at runtime takes effect without re-registration.
    this.hookManager.register(
      'translate',
      'message:received',
      ctx => this.onMessage(ctx as HookContext<IncomingMessage>, false),
      50,
    );
    if (this.includeFromMe) this.registerSentHook();

    this.logger.log(
      `Translate loaded: enabled=${this.enabled}, ${this.groupIds.size} group(s), ` +
        `model=${this.model}, includeFromMe=${this.includeFromMe}`,
    );
  }

  getConfig(): TranslateConfig {
    return {
      enabled: this.enabled,
      groupIds: [...this.groupIds],
      includeFromMe: this.includeFromMe,
      minSendIntervalMs: this.minSendIntervalMs,
    };
  }

  updateConfig(partial: Partial<TranslateConfig>): TranslateConfig {
    if (partial.enabled !== undefined) this.enabled = partial.enabled;
    if (partial.groupIds !== undefined) {
      this.groupIds = new Set(partial.groupIds.map(s => s.trim()).filter(Boolean));
    }
    if (partial.minSendIntervalMs !== undefined && partial.minSendIntervalMs >= 0) {
      this.minSendIntervalMs = partial.minSendIntervalMs;
    }
    if (partial.includeFromMe !== undefined && partial.includeFromMe !== this.includeFromMe) {
      this.includeFromMe = partial.includeFromMe;
      if (this.includeFromMe) this.registerSentHook();
      else this.unregisterSentHook();
    }
    this.saveConfig();
    return this.getConfig();
  }

  private registerSentHook(): void {
    if (this.sentHookId) return;
    // fromMe messages never reach message:received — the adapter routes them to message:sent.
    this.sentHookId = this.hookManager.register(
      'translate',
      'message:sent',
      ctx => this.onMessage(ctx as HookContext<IncomingMessage>, true),
      50,
    );
  }

  private unregisterSentHook(): void {
    if (!this.sentHookId) return;
    this.hookManager.unregister(this.sentHookId);
    this.sentHookId = null;
  }

  private loadConfig(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<TranslateConfig>;
      if (typeof raw.enabled === 'boolean') this.enabled = raw.enabled;
      if (Array.isArray(raw.groupIds)) {
        this.groupIds = new Set(raw.groupIds.map(s => String(s).trim()).filter(Boolean));
      }
      if (typeof raw.includeFromMe === 'boolean') this.includeFromMe = raw.includeFromMe;
      if (typeof raw.minSendIntervalMs === 'number' && raw.minSendIntervalMs >= 0) {
        this.minSendIntervalMs = raw.minSendIntervalMs;
      }
    } catch {
      // No file yet (or unreadable): keep the .env-seeded values and write out an initial file.
      this.saveConfig();
    }
  }

  private saveConfig(): void {
    const dir = path.dirname(CONFIG_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.getConfig(), null, 2), 'utf8');
  }

  // Fire-and-forget: never block the receive pipeline (SessionService awaits the hook chain before
  // persisting). We kick off translation async and return continue:true immediately.
  private async onMessage(
    ctx: HookContext<IncomingMessage>,
    isSentPath: boolean,
  ): Promise<HookResult<IncomingMessage>> {
    const msg = ctx.data;
    const pass: HookResult<IncomingMessage> = { continue: true };
    try {
      if (!this.enabled) return pass;
      if (msg.type !== 'text') return pass;
      // received-path fromMe shouldn't occur (adapter routes fromMe to message:sent); guard anyway.
      if (msg.fromMe && !isSentPath) return pass;
      if (!msg.isGroup || !this.groupIds.has(msg.chatId)) return pass;
      const body = msg.body || '';
      // marker skip is load-bearing on the sent path: the bot's own translation is fromMe+marker,
      // so this is what stops an infinite translate→send→translate loop.
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
        // The model can echo the source when it's not translatable natural language — don't spam
        // the group with a verbatim copy.
        if (!translated || translated.trim() === body.trim()) return;
        // Anti-ban pacing: enforce a minimum gap between outbound translations (serialized here, so
        // this is race-free). Typing simulation runs inside MessageService.sendText (SIMULATE_TYPING).
        const wait = this.nextSendAt - Date.now();
        if (wait > 0) await sleep(wait);
        await this.messageService.sendText(sessionId, {
          chatId: msg.chatId,
          text: BOT_MARKER + translated,
        });
        this.nextSendAt = Date.now() + this.minSendIntervalMs;
      }).catch(err => this.logger.error('Translate task failed', String(err)));
    } catch (err) {
      this.logger.error('Translate hook error', String(err));
    }
    return pass;
  }

  // Marker-prefixed reply so the bot never re-translates its own output. Admin allowlist (if set)
  // gates mutating subcommands; the parsing/persistence lives in Glossary.
  private async handleGlossaryCommand(sessionId: string, msg: IncomingMessage, raw: string): Promise<void> {
    const rest = raw.replace(/^\/glossary\s*/i, '').trim();
    const author = msg.author || msg.from;
    const canMutate = this.adminIds.size === 0 || this.adminIds.has(author);
    const reply = this.glossary.command(rest, canMutate);
    await this.messageService.sendText(sessionId, { chatId: msg.chatId, text: BOT_MARKER + reply });
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
    const glossarySection = this.glossary.section(pair.key);
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
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        options: { temperature: 0 },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = (await res.json()) as { message?: { content?: string } };
    const out = data.message?.content?.trim();
    if (!out) throw new Error('Ollama empty response');
    return out;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
