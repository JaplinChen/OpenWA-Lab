import { Injectable, OnModuleInit, BadRequestException } from '@nestjs/common';
import { HookManager, HookContext, HookResult } from '../../core/hooks';
import { MessageService } from '../message/message.service';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { Glossary } from './translate-glossary';
import { SenderDirectory } from './translate-senders';
import { CategoryStore } from './translate-categories';
import { TranslationMemory, type Candidate } from './translate-memory';
import { PhraseCandidates, type PhraseCandidate } from './translate-phrase-candidates';
import { minePhrases } from './translate-phrase-miner';
import { BOT_MARKER, DEFAULT_PROMPT_TEMPLATE, Pair, ZH_TO_VI, detectPair, buildPrompt, fixViCasing, sleep } from './translate-lang';
import * as llm from './translate-llm-client';
import { LlmProvider, LlmParams, LLM_PROVIDERS } from './translate-llm-client';
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
  // Admin-managed glossary category list backing the dashboard dropdown.
  private categories!: CategoryStore;
  private categoriesPath = 'data/categories.json';
  // Translation memory: logs every LLM translation as a future glossary candidate.
  private memory!: TranslationMemory;
  // High-frequency phrase candidates mined from translation memory (dashboard-triggered scan).
  private phrases!: PhraseCandidates;
  // Author WIDs allowed to mutate the glossary via /glossary commands. Empty = anyone in the group.
  private adminIds = new Set<string>();

  private nextSendAt = 0;
  // Running count of translations where every model failed — surfaced in logs for observability.
  private failureCount = 0;
  // Per-chat send timestamps (ms) for the rolling-minute rate limit; pruned on each check.
  private rateHits = new Map<string, number[]>();
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

    this.categoriesPath = process.env.TRANSLATE_CATEGORIES_PATH || this.categoriesPath;
    this.categories = new CategoryStore(this.categoriesPath);
    const categoryCount = this.categories.load();
    if (categoryCount > 0) this.logger.log(`Categories loaded: ${categoryCount} from ${this.categoriesPath}`);

    this.memory = new TranslationMemory();
    this.memory.init();
    this.phrases = new PhraseCandidates();
    this.phrases.init();

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
  get categoryStore(): CategoryStore { return this.categories; }

  /** Top translation-memory candidates to promote into the glossary. */
  async memoryCandidates(limit?: number, offset?: number): Promise<{ items: Candidate[]; total: number }> {
    const [items, total] = await Promise.all([
      this.memory.candidates(limit, offset),
      this.memory.candidatesCount(),
    ]);
    return { items, total };
  }

  /** Promote a candidate into the glossary (both directions handled by Glossary.add's orient). */
  async approveMemoryCandidate(id: number): Promise<Candidate[]> {
    const row = await this.memory.takeForApproval(id);
    if (row) this.glossary.add(row.source, row.translated);
    return this.memory.candidates();
  }

  async dismissMemoryCandidate(id: number): Promise<Candidate[]> {
    await this.memory.dismiss(id);
    return this.memory.candidates();
  }

  /** Current high-frequency phrase candidates awaiting review. */
  phraseCandidates(limit?: number): Promise<PhraseCandidate[]> {
    return this.phrases.list(limit);
  }

  /**
   * Mine translation memory for high-frequency Chinese phrases not yet in the glossary, ask the LLM
   * for a Vietnamese term for each (non-terms come back blank and are skipped), and upsert the rest as
   * candidates. Dashboard-triggered — reads the whole memory table + one LLM call, so it's not on the
   * translation hot path. Returns the refreshed candidate list.
   */
  async scanPhrases(): Promise<PhraseCandidate[]> {
    const sources = await this.memory.allSources();
    const exclude = new Set(this.glossary.entries().map(e => e.source));
    const minCount = Math.max(1, Number(process.env.TRANSLATE_PHRASE_MIN_COUNT) || 3);
    const mined = minePhrases(sources, { minCount, limit: 30, exclude });
    if (mined.length) {
      const translations = await this.translatePhrases(mined.map(m => m.phrase));
      for (const m of mined) {
        const vi = (translations[m.phrase] || '').trim();
        if (vi) await this.phrases.upsert(m.phrase, vi, m.count);
      }
    }
    return this.phrases.list();
  }

  // Batch-translate mined phrases in one LLM call. Asks for strict JSON {phrase: vi}; a phrase the
  // model deems a non-term (fragment/noise) it returns as "" and we skip it. Failure → empty map
  // (scan just upserts nothing), never throws into the controller.
  private async translatePhrases(phrases: string[]): Promise<Record<string, string>> {
    const params = this.resolveModel(this.cfg.llmModel);
    if (!params) return {};
    const list = phrases.map(p => `- ${p}`).join('\n');
    const prompt =
      '你是中越術語翻譯助手。以下是從聊天記錄擷取的中文片段，請判斷哪些是有意義的詞彙或術語，' +
      '並給出越南文翻譯。無意義的片段（斷詞雜訊、非完整詞）翻譯留空字串。\n' +
      '只回 JSON 物件，key 是中文片段，value 是越南文（或空字串），不要任何其他文字。\n\n' +
      list;
    try {
      const out = await llm.callLlm(params, prompt);
      const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') result[k] = v;
      return result;
    } catch (err) {
      this.logger.warn(`Phrase batch translate failed: ${String(err)}`);
      return {};
    }
  }

  /** Promote a phrase candidate into the glossary. */
  async approvePhraseCandidate(id: number): Promise<PhraseCandidate[]> {
    const row = await this.phrases.takeForApproval(id);
    if (row && row.translated) this.glossary.add(row.phrase, row.translated);
    return this.phrases.list();
  }

  async dismissPhraseCandidate(id: number): Promise<PhraseCandidate[]> {
    await this.phrases.dismiss(id);
    return this.phrases.list();
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

      // markUsed(mentionedIds) is the sole usage counter: the adapter already replaced the raw
      // @<digits> token with a name before this hook runs, so apply() can't see mentions reliably.
      // Unresolved mentions get queued as empty-name entries for an admin to name (notePending).
      if (msg.mentionedIds?.length) {
        this.senders.markUsed(msg.mentionedIds);
        this.senders.notePending(msg.mentionedIds, body);
      }

      // Fire-and-forget off the receive pipeline: decide + translate in the shared core, then send.
      void this.translateAndSend(sessionId, msg.chatId, body).catch(err =>
        this.onTranslateFailure(sessionId, msg.chatId, err),
      );
    } catch (err) {
      this.logger.error('Translate hook error', String(err));
    }
    return pass;
  }

  /**
   * Platform-agnostic translate decision: given inbound text and a chat key (rate-limit bucket),
   * return the bot reply (BOT_MARKER + translation) or null to stay silent. Serialized on the shared
   * queue so a single-request Ollama isn't hit concurrently. Shared by the WhatsApp hook and any other
   * adapter (e.g. Teams) injecting this same service — glossary/sender/memory/config all shared.
   */
  async translateInbound(
    text: string,
    chatKey: string,
    send?: (reply: string) => Promise<void>,
  ): Promise<string | null> {
    const body = text || '';
    if (!body.trim() || body.startsWith(BOT_MARKER)) return null;
    const pair = this.detectPair(body);
    if (!pair) return null; // not zh/vi — leave it alone

    // Cost guards: skip over-long messages and throttle per chat so a flood can't run up the cloud
    // LLM bill. Both default to off (0). Checked before the LLM call, after cheap filters.
    if (this.cfg.maxMessageLength > 0 && body.length > this.cfg.maxMessageLength) {
      this.logger.warn(`Skipped (too long: ${body.length} > ${this.cfg.maxMessageLength}) chat=${chatKey}`);
      return null;
    }
    if (!this.allowByRate(chatKey)) {
      this.logger.warn(`Skipped (rate limit ${this.cfg.maxTranslationsPerMinute}/min) chat=${chatKey}`);
      return null;
    }

    return this.enqueue(async () => {
      const translated = await this.translate(body, pair);
      // The model can echo the source when it's not translatable natural language — don't spam a
      // verbatim copy. Only path that discards a successful LLM response, so log it or the bot looks
      // like it randomly stopped translating.
      if (!translated || translated.trim() === body.trim()) {
        this.logger.warn(`Skipped (echo/empty) pair=${pair.key} in="${body.slice(0, 60)}"`);
        return null;
      }
      const reply = BOT_MARKER + translated;
      // In-queue send keeps sends serialized behind translations (race-free pacing). Adapters that
      // don't need in-queue delivery (e.g. Teams) omit send and dispatch the returned reply themselves.
      if (send) await send(reply);
      return reply;
    });
  }

  // WhatsApp send path: translate off the receive pipeline, then pace + send back (in-queue). Typing
  // simulation runs inside MessageService.sendText (SIMULATE_TYPING).
  private translateAndSend(sessionId: string, chatId: string, body: string): Promise<string | null> {
    return this.translateInbound(body, chatId, async reply => {
      const wait = this.nextSendAt - Date.now();
      if (wait > 0) await sleep(wait);
      await this.messageService.sendText(sessionId, { chatId, text: reply });
      this.nextSendAt = Date.now() + this.cfg.minSendIntervalMs;
    });
  }

  // Rolling 60s window per chat. Records a hit when allowed; returns false once the group hits the cap.
  private allowByRate(chatId: string): boolean {
    const limit = this.cfg.maxTranslationsPerMinute;
    if (limit <= 0) return true;
    const now = Date.now();
    const recent = (this.rateHits.get(chatId) ?? []).filter(t => now - t < 60_000);
    if (recent.length >= limit) {
      this.rateHits.set(chatId, recent);
      return false;
    }
    recent.push(now);
    this.rateHits.set(chatId, recent);
    return true;
  }

  // Every model failed: log with a running total (so a broken bot is visible in logs), and optionally
  // tell the group so users aren't left wondering why translation silently stopped.
  private onTranslateFailure(sessionId: string, chatId: string, err: unknown): void {
    this.failureCount += 1;
    this.logger.error(`Translate task failed (total failures=${this.failureCount})`, String(err));
    if (this.cfg.notifyOnFailure) {
      void this.messageService
        .sendText(sessionId, { chatId, text: BOT_MARKER + '⚠️ 翻譯暫時失敗，請稍後再試' })
        .catch(e => this.logger.error('Failure-notice send failed', String(e)));
    }
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
    // Resolve unknown @mention JIDs to names.
    const applied = this.senders.apply(text);

    // Whole-message exact glossary hit (short conversational phrases like 明白/好/收到): answer
    // directly and skip the LLM, which weak models otherwise reply to conversationally ("請提供
    // 您需要翻譯的內容。"). Substring matches still go through the LLM via section() below.
    const exact = this.glossary.exact(pair.key, applied);
    if (exact) return pair.key === ZH_TO_VI.key ? fixViCasing(exact) : exact;

    // Inject only the glossary terms that actually appear in this message (see Glossary.section).
    const prompt = buildPrompt(applied, pair, this.glossary.section(pair.key, applied), this.cfg.llmPromptTemplate);

    // Try the primary model, then each fallback in order — covers "model not loaded"/timeout on a
    // local Ollama or a rate-limited cloud model without dropping the translation. A fallback entry
    // may cross providers via a "provider:model" prefix (e.g. groq:llama-3.3-70b-versatile).
    const entries = [this.cfg.llmModel, ...this.cfg.llmFallbackModels].filter(Boolean);
    let lastErr: unknown;
    for (const entry of entries) {
      const params = this.resolveModel(entry);
      if (!params) {
        lastErr = new Error(`No saved config for cross-provider fallback "${entry}"`);
        this.logger.warn(`Skipping fallback "${entry}": ${String(lastErr)}`);
        continue;
      }
      try {
        const out = await llm.callLlm(params, prompt);
        const result = pair.key === ZH_TO_VI.key ? fixViCasing(out) : out;
        // Log for later glossary curation (best-effort). Exact glossary hits returned above, so this
        // only captures genuine LLM output — not terms already in the glossary.
        this.memory.record(pair.key, applied, result);
        return result;
      } catch (err) {
        lastErr = err;
        this.logger.warn(`Model "${entry}" failed, trying next fallback: ${String(err)}`);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('All models failed');
  }

  /**
   * Resolve a fallback entry to call params. Bare "model" uses the active provider/endpoint/key.
   * A "provider:model" prefix (provider ∈ LLM_PROVIDERS) crosses providers, pulling that provider's
   * saved endpoint/key from llmProviderConfigs — returns null when it has no saved config yet.
   * Guard: an Ollama tag colon (qwen3:8b) isn't a provider prefix, so it stays a bare model name.
   */
  private resolveModel(entry: string): LlmParams | null {
    const colon = entry.indexOf(':');
    const maybeProvider = colon > 0 ? entry.slice(0, colon) : '';
    if (!LLM_PROVIDERS.includes(maybeProvider as LlmProvider)) {
      return { ...this.llmParams(), model: entry };
    }
    const provider = maybeProvider as LlmProvider;
    const model = entry.slice(colon + 1);
    if (!model) return { ...this.llmParams(), model: entry };
    if (provider === this.cfg.llmProvider) return { ...this.llmParams(), model };
    const pc = this.cfg.llmProviderConfigs[provider];
    const endpoint = typeof pc?.endpoint === 'string' ? pc.endpoint : '';
    if (!endpoint) return null; // no saved config for this provider — can't call it
    const apiKey = typeof pc?.apiKey === 'string' ? pc.apiKey : '';
    const temperature = typeof pc?.temperature === 'number' ? pc.temperature : this.cfg.llmTemperature;
    return { provider, endpoint, model, apiKey, temperature };
  }

  // Dashboard preview: run the real pipeline (sender/glossary substitution + fixViCasing) on ad-hoc text so
  // an operator can verify translation quality after changing prompt/model without posting to a group.
  // pair='' when the text isn't detectable zh/vi — the controller maps that to a 400. An optional
  // provider runs that configured engine instead of the active one, so providers can be A/B compared.
  async preview(text: string, provider?: LlmProvider): Promise<{ pair: string; translated: string }> {
    const pair = this.detectPair(text);
    if (!pair) return { pair: '', translated: '' };
    const params = this.previewParams(provider);
    return { pair: pair.key, translated: await this.translateWith(text, pair, params) };
  }

  // Resolve the LlmParams for a preview: the active engine by default, or a configured provider's saved
  // settings (from llmProviderConfigs) when comparing. Throws if the requested provider isn't set up.
  private previewParams(provider?: LlmProvider): LlmParams {
    if (!provider || provider === this.cfg.llmProvider) return this.llmParams();
    const pc = this.cfg.llmProviderConfigs[provider];
    const endpoint = typeof pc?.endpoint === 'string' ? pc.endpoint : '';
    const model = typeof pc?.model === 'string' ? pc.model : '';
    if (!endpoint || !model) throw new BadRequestException(`Provider "${provider}" is not configured`);
    const apiKey = typeof pc?.apiKey === 'string' ? pc.apiKey : '';
    const temperature = typeof pc?.temperature === 'number' ? pc.temperature : this.cfg.llmTemperature;
    return { provider, endpoint, model, apiKey, temperature };
  }

  // Single-engine translate (no fallback loop) — used by preview to test one provider deterministically.
  private async translateWith(text: string, pair: Pair, params: LlmParams): Promise<string> {
    const applied = this.senders.apply(text);
    const prompt = buildPrompt(applied, pair, this.glossary.section(pair.key, applied), this.cfg.llmPromptTemplate);
    const out = await llm.callLlm(params, prompt);
    return pair.key === ZH_TO_VI.key ? fixViCasing(out) : out;
  }

  private llmParams(): LlmParams {
    const c = this.cfg;
    return { provider: c.llmProvider, endpoint: c.llmEndpoint, model: c.llmModel, apiKey: c.llmApiKey, temperature: c.llmTemperature };
  }

  // Dashboard probes send apiKey:'' (getConfig masks it) — fall back to the stored key so
  // Test Connection / Fetch Models keep working without re-entering the secret. Endpoint-bound: only
  // backfill when the probe targets the SAME endpoint the key was saved against, so an admin can't
  // point the endpoint at their own server and exfiltrate the stored key (it also blocks SSRF-with-key).
  private storedKey(provider: LlmProvider, endpoint: string): string {
    if (endpoint.trim() !== this.cfg.llmEndpoint) return '';
    if (provider === this.cfg.llmProvider && this.cfg.llmApiKey) return this.cfg.llmApiKey;
    const k = this.cfg.llmProviderConfigs[provider]?.apiKey;
    return typeof k === 'string' ? k : '';
  }

  async testConnection(raw: LlmParams): Promise<{ ok: boolean; message: string }> {
    const p = raw.apiKey ? raw : { ...raw, apiKey: this.storedKey(raw.provider, raw.endpoint) };
    return llm.testConnection(p);
  }

  /** List model names for the endpoint (Ollama /api/tags, OpenAI/Groq /models, Gemini /v1beta/models). */
  async listModels(raw: Pick<LlmParams, 'provider' | 'endpoint' | 'apiKey'>): Promise<string[]> {
    const p = raw.apiKey ? raw : { ...raw, apiKey: this.storedKey(raw.provider, raw.endpoint) };
    return llm.listModels(p);
  }
}
