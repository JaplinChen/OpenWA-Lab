import { Injectable, OnModuleInit } from '@nestjs/common';
import { HookManager, HookContext, HookResult } from '../../core/hooks';
import { MessageService } from '../message/message.service';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { Glossary } from './translate-glossary';
import { SenderDirectory } from './translate-senders';
import { BOT_MARKER, DEFAULT_PROMPT_TEMPLATE, Pair, detectPair, buildPrompt, sleep } from './translate-lang';
import * as llm from './translate-llm-client';
import { LlmProvider, LlmParams } from './translate-llm-client';
import {
  configPath,
  TranslateConfig,
  TranslateConfigStore,
  defaultRuntimeConfig,
  envSeedConfig,
  sanitizeConfig,
  normalizeConfigPatch,
  maskProviderConfigs,
  splitList,
} from './translate-config.store';
import { parseCommand, handleGlossaryCommand, handleHelpCommand } from './translate-commands';

export { LLM_PROVIDERS } from './translate-llm-client';
export type { LlmProvider, LlmParams } from './translate-llm-client';
export type { TranslateConfig } from './translate-config.store';

// Media captions land in `body` (see baileys-inbound-mapper), so image/video/document carry translatable text.
const TRANSLATABLE_TYPES = new Set<IncomingMessage['type']>(['text', 'image', 'video', 'document']);

@Injectable()
export class TranslateService implements OnModuleInit {
  private readonly logger = createLogger('TranslateService');
  private readonly configStore = new TranslateConfigStore();

  private cfg = defaultRuntimeConfig();

  // zh<->vi term overrides; default paths live under the writable data dir (read-only rootfs Docker).
  private glossary!: Glossary;
  private glossaryPath = 'data/glossary.json';
  // Manual @mention JID->name overrides applied to the body before translation.
  private senders!: SenderDirectory;
  private sendersPath = 'data/senders.json';
  // Author WIDs allowed to mutate the glossary via /glossary commands. Empty = anyone in the group.
  private adminIds = new Set<string>();

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
    this.applyConfig(envSeedConfig());
    this.glossaryPath = process.env.TRANSLATE_GLOSSARY_PATH || this.glossaryPath;
    this.adminIds = new Set(splitList(process.env.TRANSLATE_ADMIN_IDS || ''));
    this.glossary = new Glossary(this.glossaryPath);
    const terms = this.glossary.load();
    if (terms > 0) this.logger.log(`Glossary loaded: ${terms} term(s) from ${this.glossaryPath}`);

    this.sendersPath = process.env.TRANSLATE_SENDERS_PATH || this.sendersPath;
    this.senders = new SenderDirectory(this.sendersPath);
    const senderCount = this.senders.load();
    if (senderCount > 0) this.logger.log(`Senders loaded: ${senderCount} override(s) from ${this.sendersPath}`);

    // Persisted runtime config takes precedence over .env; .env values seed the file on first run.
    this.loadConfig();

    // Always registered; enable/disable is enforced in onMessage so runtime toggles need no re-registration.
    this.hookManager.register(
      'translate',
      'message:received',
      ctx => this.onMessage(ctx as HookContext<IncomingMessage>, false),
      50,
    );
    if (this.cfg.includeFromMe) this.registerSentHook();

    this.logger.log(
      `Translate loaded: enabled=${this.cfg.enabled}, ${this.cfg.groupIds.size} group(s), ` +
        `model=${this.cfg.llmModel}, includeFromMe=${this.cfg.includeFromMe}`,
    );
  }

  // Keys never leave the server: apiKeys are masked to '' + apiKeySet; '' round-trips the PUT as "keep stored key".
  getConfig(): TranslateConfig & { llmPromptTemplateDefault: string; apiKeySet: boolean } {
    return {
      ...this.persistedConfig(),
      llmApiKey: '',
      apiKeySet: this.cfg.llmApiKey !== '',
      llmProviderConfigs: maskProviderConfigs(this.cfg.llmProviderConfigs),
      llmPromptTemplateDefault: DEFAULT_PROMPT_TEMPLATE,
    };
  }

  private persistedConfig(): TranslateConfig {
    return { ...this.cfg, groupIds: [...this.cfg.groupIds], llmFallbackModels: [...this.cfg.llmFallbackModels] };
  }

  /** Apply an already-sanitized partial config to the live state (no hook side effects). */
  private applyConfig(p: Partial<TranslateConfig>): void {
    const { groupIds, ...rest } = p;
    Object.assign(this.cfg, rest);
    if (groupIds !== undefined) this.cfg.groupIds = new Set(groupIds);
  }

  updateConfig(partial: Partial<TranslateConfig>): TranslateConfig {
    const prevFromMe = this.cfg.includeFromMe;
    this.applyConfig(normalizeConfigPatch(partial, this.cfg.llmProviderConfigs));
    if (this.cfg.includeFromMe !== prevFromMe) {
      if (this.cfg.includeFromMe) this.registerSentHook();
      else this.unregisterSentHook();
    }
    this.saveConfig();
    return this.getConfig();
  }

  // REST CRUD on the glossary/sender stores lives in the controller (boundary validation there).
  get glossaryStore(): Glossary { return this.glossary; }
  get senderStore(): SenderDirectory { return this.senders; }

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
    const read = this.configStore.read();
    // Missing = first run: seed from .env values. Unreadable/corrupt: keep the file, don't clobber it.
    if (read.status === 'missing') return this.saveConfig();
    if (read.status === 'unreadable') {
      this.logger.warn(`Config unreadable, keeping ${configPath()} untouched: ${String(read.error)}`);
      return;
    }
    this.applyConfig(sanitizeConfig(read.raw));
  }

  private saveConfig(): void {
    this.configStore.write(this.persistedConfig());
  }

  // Fire-and-forget: never block the receive pipeline — kick off async and return continue:true immediately.
  private async onMessage(
    ctx: HookContext<IncomingMessage>,
    isSentPath: boolean,
  ): Promise<HookResult<IncomingMessage>> {
    const msg = ctx.data;
    const pass: HookResult<IncomingMessage> = { continue: true };
    try {
      if (!this.cfg.enabled) return pass;
      if (!TRANSLATABLE_TYPES.has(msg.type)) return pass;
      // received-path fromMe shouldn't occur (adapter routes fromMe to message:sent); guard anyway.
      if (msg.fromMe && !isSentPath) return pass;
      if (!msg.isGroup || !this.cfg.groupIds.has(msg.chatId)) return pass;

      // Passive learn: the sender's JID + name only coexist here (live message). Remember it so a
      // later @mention of this person resolves to a name without any manual entry. Skips known JIDs.
      if (!isSentPath && msg.author) {
        const nm =
          msg.contact?.pushName || msg.contact?.name || msg.contact?.verifiedName || msg.contact?.shortName;
        if (nm) {
          this.senders.learn(msg.author, nm);
          if (msg.senderPhone) this.senders.learn(msg.senderPhone, nm);
        }
      }

      const body = msg.body || '';
      // marker skip is load-bearing on the sent path: the bot's own translation is fromMe+marker,
      // so this is what stops an infinite translate→send→translate loop.
      if (!body.trim() || body.startsWith(BOT_MARKER)) return pass;

      const sessionId = ctx.sessionId;
      if (!sessionId) return pass;

      const trimmed = body.trim();
      const command = parseCommand(trimmed);
      if (command) {
        const run =
          command.cmd === 'glossary'
            ? this.handleGlossaryCommand(sessionId, msg, trimmed)
            : this.handleHelpCommand(sessionId, msg);
        const label = command.cmd === 'glossary' ? 'Glossary' : 'Help';
        void run.catch(err => this.logger.error(`${label} command failed`, String(err)));
        return pass; // command, not content to translate
      }

      const pair = this.detectPair(body);
      if (!pair) return pass; // not zh/vi — leave it alone

      // markUsed(mentionedIds) is the sole usage counter: the adapter already replaced the raw
      // @<digits> token with a name before this hook runs, so apply() can't see mentions reliably.
      // Unresolved mentions get queued as empty-name entries for an admin to name (notePending).
      if (msg.mentionedIds?.length) {
        this.senders.markUsed(msg.mentionedIds);
        this.senders.notePending(msg.mentionedIds, body);
      }

      void this.enqueue(async () => {
        const translated = await this.translate(body, pair);
        // The model can echo the source when it's not translatable natural language — don't spam the
        // group with a verbatim copy. This is the only path that discards a successful LLM response,
        // so log it or it looks like the bot randomly stopped translating.
        if (!translated || translated.trim() === body.trim()) {
          this.logger.warn(`Skipped (echo/empty) pair=${pair.key} in="${body.slice(0, 60)}"`);
          return;
        }
        // Anti-ban pacing (race-free: sends are serialized on the queue). Typing simulation runs
        // inside MessageService.sendText (SIMULATE_TYPING).
        const wait = this.nextSendAt - Date.now();
        if (wait > 0) await sleep(wait);
        await this.messageService.sendText(sessionId, {
          chatId: msg.chatId,
          text: BOT_MARKER + translated,
        });
        this.nextSendAt = Date.now() + this.cfg.minSendIntervalMs;
      }).catch(err => this.logger.error('Translate task failed', String(err)));
    } catch (err) {
      this.logger.error('Translate hook error', String(err));
    }
    return pass;
  }

  private handleGlossaryCommand(sessionId: string, msg: IncomingMessage, raw: string): Promise<void> {
    const deps = { glossary: this.glossary, adminIds: this.adminIds, messageService: this.messageService };
    return handleGlossaryCommand(deps, sessionId, msg, raw);
  }

  private handleHelpCommand(sessionId: string, msg: IncomingMessage): Promise<void> { return handleHelpCommand(this.messageService, sessionId, msg); }

  // Thin instance wrapper over the pure detector (kept a method so the spec's private-method poke works).
  private detectPair(text: string): Pair | null { return detectPair(text); }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async translate(text: string, pair: Pair): Promise<string> {
    // Resolve unknown @mention JIDs to names, then inject only the glossary terms that actually
    // appear in this message (see Glossary.section).
    const applied = this.senders.apply(text);
    const prompt = buildPrompt(applied, pair, this.glossary.section(pair.key, applied), this.cfg.llmPromptTemplate);

    // Try the primary model, then each fallback in order — covers "model not loaded"/timeout on a
    // local Ollama or a rate-limited cloud model without dropping the translation.
    const models = [this.cfg.llmModel, ...this.cfg.llmFallbackModels].filter(Boolean);
    let lastErr: unknown;
    for (const model of models) {
      try {
        return await llm.callLlm({ ...this.llmParams(), model }, prompt);
      } catch (err) {
        lastErr = err;
        this.logger.warn(`Model "${model}" failed, trying next fallback: ${String(err)}`);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('All models failed');
  }

  private llmParams(): LlmParams {
    const c = this.cfg;
    return { provider: c.llmProvider, endpoint: c.llmEndpoint, model: c.llmModel, apiKey: c.llmApiKey, temperature: c.llmTemperature };
  }

  // Dashboard probes send apiKey:'' (getConfig masks it) — fall back to the stored key so
  // Test Connection / Fetch Models keep working without re-entering the secret.
  private storedKey(provider: LlmProvider): string {
    if (provider === this.cfg.llmProvider && this.cfg.llmApiKey) return this.cfg.llmApiKey;
    const k = this.cfg.llmProviderConfigs[provider]?.apiKey;
    return typeof k === 'string' ? k : '';
  }

  async testConnection(raw: LlmParams): Promise<{ ok: boolean; message: string }> {
    const p = raw.apiKey ? raw : { ...raw, apiKey: this.storedKey(raw.provider) };
    return llm.testConnection(p);
  }

  /** List model names for the endpoint (Ollama /api/tags, OpenAI/Groq /models, Gemini /v1beta/models). */
  async listModels(raw: Pick<LlmParams, 'provider' | 'endpoint' | 'apiKey'>): Promise<string[]> {
    const p = raw.apiKey ? raw : { ...raw, apiKey: this.storedKey(raw.provider) };
    return llm.listModels(p);
  }
}
