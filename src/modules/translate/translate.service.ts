import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HookManager, HookContext, HookResult } from '../../core/hooks';
import { MessageService } from '../message/message.service';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { Glossary } from './translate-glossary';
import { SenderDirectory } from './translate-senders';
import { BOT_MARKER, Pair, detectPair, buildPrompt, sleep } from './translate-lang';

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
  // Defaults to the writable data dir (like CONFIG_PATH) so the glossary persists on the read-only
  // rootfs Docker setup; the old 'secrets/' default was unwritable there and silently lost writes.
  private glossaryPath = 'data/glossary.json';
  // Manual @mention JID->name overrides applied to the body before translation (see SenderDirectory).
  private senders!: SenderDirectory;
  private sendersPath = 'data/senders.json';
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

    this.sendersPath = process.env.TRANSLATE_SENDERS_PATH || this.sendersPath;
    this.senders = new SenderDirectory(this.sendersPath);
    const senderCount = this.senders.load();
    if (senderCount > 0) this.logger.log(`Senders loaded: ${senderCount} override(s) from ${this.sendersPath}`);

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

  getGlossary(): { source: string; target: string }[] {
    return this.glossary.entries();
  }

  addGlossaryTerm(zh: string, vi: string): { source: string; target: string }[] {
    const source = zh.trim();
    const target = vi.trim();
    if (!source || !target) throw new BadRequestException('zh and vi are required');
    this.glossary.add(source, target);
    return this.glossary.entries();
  }

  removeGlossaryTerm(term: string): { source: string; target: string }[] {
    const trimmed = term.trim();
    if (!trimmed) throw new BadRequestException('term is required');
    this.glossary.remove(trimmed);
    return this.glossary.entries();
  }

  getSenders(): { jid: string; name: string }[] {
    return this.senders.entries();
  }

  addSender(jid: string, name: string): { jid: string; name: string }[] {
    const j = jid.trim();
    const n = name.trim();
    if (!j || !n) throw new BadRequestException('jid and name are required');
    this.senders.add(j, n);
    return this.senders.entries();
  }

  removeSender(jid: string): { jid: string; name: string }[] {
    const trimmed = jid.trim();
    if (!trimmed) throw new BadRequestException('jid is required');
    this.senders.remove(trimmed);
    return this.senders.entries();
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
      if (lower === '/sender' || lower.startsWith('/sender ')) {
        void this.handleSenderCommand(sessionId, msg, trimmed).catch(err =>
          this.logger.error('Sender command failed', String(err)),
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
    // ponytail: reply in DM so the term list doesn't flood the group
    const target = msg.isGroup ? author : msg.chatId;
    if (!target) return;
    await this.messageService.sendText(sessionId, { chatId: target, text: BOT_MARKER + reply });
  }

  private async handleSenderCommand(sessionId: string, msg: IncomingMessage, raw: string): Promise<void> {
    const rest = raw.replace(/^\/sender\s*/i, '').trim();
    const author = msg.author || msg.from;
    const canMutate = this.adminIds.size === 0 || this.adminIds.has(author);
    const reply = this.senders.command(rest, canMutate);
    const target = msg.isGroup ? author : msg.chatId;
    if (!target) return;
    await this.messageService.sendText(sessionId, { chatId: target, text: BOT_MARKER + reply });
  }

  // Thin instance wrapper over the pure detector (kept a method so the spec's private-method poke works).
  private detectPair(text: string): Pair | null {
    return detectPair(text);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async translate(text: string, pair: Pair): Promise<string> {
    // Resolve unknown @mention JIDs (e.g. @200859128434777) to names before the model sees them.
    const prompt = buildPrompt(this.senders.apply(text), pair, this.glossary.section(pair.key));
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
