import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HookManager, HookContext, HookResult } from '../../core/hooks';
import { MessageService } from '../message/message.service';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { Glossary, PendingSuggestion } from './translate-glossary';
import { SenderDirectory } from './translate-senders';
import { BOT_MARKER, DEFAULT_PROMPT_TEMPLATE, Pair, detectPair, buildPrompt, sleep, stripThinking } from './translate-lang';

const CONFIG_PATH = 'data/translate-config.json';

// Media captions land in `body` (see baileys-inbound-mapper: "text first, then media caption"), so a
// photo/video/document posted with a caption carries translatable text despite not being type 'text'.
// Group reports are routinely a screenshot plus a caption; gating on 'text' alone silently dropped them.
// Types with no caption (audio/voice/sticker/location/contact/poll/call/revoked) stay excluded.
const TRANSLATABLE_TYPES = new Set<IncomingMessage['type']>(['text', 'image', 'video', 'document']);

export type LlmProvider = 'ollama' | 'openai' | 'groq' | 'azure' | 'gemini';
export const LLM_PROVIDERS: LlmProvider[] = ['ollama', 'openai', 'groq', 'azure', 'gemini'];

export interface TranslateConfig {
  enabled: boolean;
  groupIds: string[];
  includeFromMe: boolean;
  minSendIntervalMs: number;
  llmProvider: LlmProvider;
  llmEndpoint: string;
  llmModel: string;
  llmApiKey: string;
  llmTemperature: number;
  llmFallbackModels: string[];
  // Custom prompt template ({source}/{target}/{glossary}/{text} placeholders). '' = built-in default.
  llmPromptTemplate: string;
  // Per-provider saved settings so switching engines in the UI restores each one's endpoint/model/key
  // (like TypeTwo's providerConfigs). Opaque to the backend — only the flat active fields above drive
  // translate(); this is storage the dashboard reads back.
  llmProviderConfigs: Record<string, Record<string, unknown>>;
}

/** The subset needed to make one LLM call — used by translate + the test/models probes. */
export interface LlmParams {
  provider: LlmProvider;
  endpoint: string;
  model: string;
  apiKey: string;
  temperature: number;
}

@Injectable()
export class TranslateService implements OnModuleInit {
  private readonly logger = createLogger('TranslateService');

  private enabled = false;
  private groupIds = new Set<string>();
  private provider: LlmProvider = 'ollama';
  private endpoint = 'http://127.0.0.1:11434/api/chat';
  private model = 'translategemma-12b-cline-32768:latest';
  private apiKey = '';
  // 0 = deterministic; kept low for stable translations.
  private temperature = 0;
  // Tried in order when the primary model call throws (e.g. model not loaded, timeout).
  private fallbackModels: string[] = [];
  // Custom prompt template; '' = use DEFAULT_PROMPT_TEMPLATE.
  private promptTemplate = '';
  // Per-provider saved settings (opaque passthrough for the dashboard; see TranslateConfig).
  private providerConfigs: Record<string, Record<string, unknown>> = {};
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
    if (LLM_PROVIDERS.includes(process.env.LLM_PROVIDER as LlmProvider)) {
      this.provider = process.env.LLM_PROVIDER as LlmProvider;
    }
    this.endpoint = process.env.LLM_ENDPOINT || process.env.OLLAMA_ENDPOINT || this.endpoint;
    this.model = process.env.LLM_MODEL || process.env.OLLAMA_MODEL || this.model;
    this.apiKey = process.env.LLM_API_KEY || this.apiKey;
    const temp = Number(process.env.LLM_TEMPERATURE);
    if (Number.isFinite(temp) && temp >= 0) this.temperature = temp;
    this.fallbackModels = (process.env.LLM_FALLBACK_MODELS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
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

  getConfig(): TranslateConfig & { llmPromptTemplateDefault: string } {
    return {
      enabled: this.enabled,
      groupIds: [...this.groupIds],
      includeFromMe: this.includeFromMe,
      minSendIntervalMs: this.minSendIntervalMs,
      llmProvider: this.provider,
      llmEndpoint: this.endpoint,
      llmModel: this.model,
      llmApiKey: this.apiKey,
      llmTemperature: this.temperature,
      llmFallbackModels: [...this.fallbackModels],
      llmPromptTemplate: this.promptTemplate,
      llmPromptTemplateDefault: DEFAULT_PROMPT_TEMPLATE,
      llmProviderConfigs: this.providerConfigs,
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
    if (partial.llmProvider !== undefined && LLM_PROVIDERS.includes(partial.llmProvider)) {
      this.provider = partial.llmProvider;
    }
    if (partial.llmEndpoint !== undefined) this.endpoint = partial.llmEndpoint.trim();
    if (partial.llmModel !== undefined) this.model = partial.llmModel.trim();
    if (partial.llmApiKey !== undefined) this.apiKey = partial.llmApiKey.trim();
    if (partial.llmTemperature !== undefined && partial.llmTemperature >= 0) {
      this.temperature = partial.llmTemperature;
    }
    if (partial.llmFallbackModels !== undefined) {
      this.fallbackModels = partial.llmFallbackModels.map(s => s.trim()).filter(Boolean);
    }
    if (partial.llmPromptTemplate !== undefined) this.promptTemplate = partial.llmPromptTemplate;
    if (partial.llmProviderConfigs !== undefined && partial.llmProviderConfigs !== null) {
      this.providerConfigs = partial.llmProviderConfigs;
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

  getPendingGlossary(): PendingSuggestion[] {
    return this.glossary.pending();
  }

  approvePendingGlossary(id: number): PendingSuggestion[] {
    if (!this.glossary.approve(id)) throw new BadRequestException(`unknown pending id: ${id}`);
    return this.glossary.pending();
  }

  rejectPendingGlossary(id: number): PendingSuggestion[] {
    if (!this.glossary.reject(id)) throw new BadRequestException(`unknown pending id: ${id}`);
    return this.glossary.pending();
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

  importSenders(items: { jid: string; name: string }[]): {
    added: number;
    entries: { jid: string; name: string }[];
  } {
    const added = this.senders.importEntries(items);
    return { added, entries: this.senders.entries() };
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
      if (LLM_PROVIDERS.includes(raw.llmProvider as LlmProvider)) this.provider = raw.llmProvider as LlmProvider;
      if (typeof raw.llmEndpoint === 'string' && raw.llmEndpoint) this.endpoint = raw.llmEndpoint;
      if (typeof raw.llmModel === 'string' && raw.llmModel) this.model = raw.llmModel;
      if (typeof raw.llmApiKey === 'string') this.apiKey = raw.llmApiKey;
      if (typeof raw.llmTemperature === 'number' && raw.llmTemperature >= 0) this.temperature = raw.llmTemperature;
      if (Array.isArray(raw.llmFallbackModels)) {
        this.fallbackModels = raw.llmFallbackModels.map(s => String(s).trim()).filter(Boolean);
      }
      if (typeof raw.llmPromptTemplate === 'string') this.promptTemplate = raw.llmPromptTemplate;
      if (raw.llmProviderConfigs && typeof raw.llmProviderConfigs === 'object') {
        this.providerConfigs = raw.llmProviderConfigs;
      }
    } catch {
      // No file yet (or unreadable): keep the .env-seeded values and write out an initial file.
      this.saveConfig();
    }
  }

  private saveConfig(): void {
    const dir = path.dirname(CONFIG_PATH);
    fs.mkdirSync(dir, { recursive: true });
    const { llmPromptTemplateDefault: _default, ...persisted } = this.getConfig();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(persisted, null, 2), 'utf8');
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
      if (!TRANSLATABLE_TYPES.has(msg.type)) return pass;
      // received-path fromMe shouldn't occur (adapter routes fromMe to message:sent); guard anyway.
      if (msg.fromMe && !isSentPath) return pass;
      if (!msg.isGroup || !this.groupIds.has(msg.chatId)) return pass;

      // Passive learn: the sender's JID + name only coexist here (live message). Remember it so a later
      // @mention of this person resolves to a name without any manual entry. Skips known JIDs.
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
      const lower = trimmed.toLowerCase();
      if (lower === '/glossary' || lower.startsWith('/glossary ') || lower === '/g' || lower.startsWith('/g ')) {
        void this.handleGlossaryCommand(sessionId, msg, trimmed).catch(err =>
          this.logger.error('Glossary command failed', String(err)),
        );
        return pass; // command, not content to translate
      }
      if (lower === '/sender' || lower.startsWith('/sender ') || lower === '/s' || lower.startsWith('/s ')) {
        void this.handleSenderCommand(sessionId, msg, trimmed).catch(err =>
          this.logger.error('Sender command failed', String(err)),
        );
        return pass; // command, not content to translate
      }
      if (lower === '/help' || lower === '/h') {
        void this.handleHelpCommand(sessionId, msg).catch(err =>
          this.logger.error('Help command failed', String(err)),
        );
        return pass; // command, not content to translate
      }

      const pair = this.detectPair(body);
      if (!pair) return pass; // not zh/vi — leave it alone

      void this.enqueue(async () => {
        const translated = await this.translate(body, pair);
        // The model can echo the source when it's not translatable natural language — don't spam
        // the group with a verbatim copy. Every other failure path throws and is logged; this is the
        // only one that discards a successful LLM response, so log it or it looks like the bot
        // randomly stopped translating.
        if (!translated || translated.trim() === body.trim()) {
          this.logger.warn(`Skipped (echo/empty) pair=${pair.key} in="${body.slice(0, 60)}"`);
          return;
        }
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
    const rest = raw.replace(/^\/(?:glossary|g)(?=\s|$)\s*/i, '').trim();
    const author = msg.author || msg.from;
    const canMutate = this.adminIds.size === 0 || this.adminIds.has(author);
    const reply = this.glossary.command(rest, canMutate, author);
    // ponytail: long lists (full glossary / pending queue) DM the author so they don't flood the
    // group; short results (add/suggest/ok/no/del acks, usage) reply in place.
    const isList = rest === '' || /^pending(?=\s|$)/i.test(rest);
    const target = msg.isGroup && isList ? author : msg.chatId;
    if (!target) return;
    await this.messageService.sendText(sessionId, { chatId: target, text: BOT_MARKER + reply });
  }

  private async handleHelpCommand(sessionId: string, msg: IncomingMessage): Promise<void> {
    const target = msg.chatId;
    if (!target) return;
    const help = [
      '指令一覽：',
      '/g 詞 = nghĩa   建議詞彙（管理員=直接新增）',
      '/g              列出詞彙',
      '/g pending      待審清單（管理員）',
      '/g ok|no <id>   核准/退回建議（管理員）',
      '/g del <詞>     刪除詞彙（管理員）',
      '/s              列出發送者對照',
      '/s add <JID>=名稱   新增對照（管理員）',
      '/s del <JID>    刪除對照（管理員）',
      '/help           顯示本說明',
    ].join('\n');
    await this.messageService.sendText(sessionId, { chatId: target, text: BOT_MARKER + help });
  }

  private async handleSenderCommand(sessionId: string, msg: IncomingMessage, raw: string): Promise<void> {
    const rest = raw.replace(/^\/(?:sender|s)(?=\s|$)\s*/i, '').trim();
    const author = msg.author || msg.from;
    const canMutate = this.adminIds.size === 0 || this.adminIds.has(author);
    const reply = this.senders.command(rest, canMutate);
    const target = msg.isGroup && rest === '' ? author : msg.chatId;
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
    const applied = this.senders.apply(text);
    // Only inject glossary terms that actually appear in this message (see Glossary.section).
    const prompt = buildPrompt(applied, pair, this.glossary.section(pair.key, applied), this.promptTemplate);

    // Try the primary model, then each fallback in order — covers "model not loaded"/timeout on a
    // local Ollama or a rate-limited cloud model without dropping the translation.
    const models = [this.model, ...this.fallbackModels].filter(Boolean);
    let lastErr: unknown;
    for (const model of models) {
      try {
        return await this.callLlm({ ...this.baseParams(), model }, prompt);
      } catch (err) {
        lastErr = err;
        this.logger.warn(`Model "${model}" failed, trying next fallback: ${String(err)}`);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('All models failed');
  }

  private baseParams(): LlmParams {
    return {
      provider: this.provider,
      endpoint: this.endpoint,
      model: this.model,
      apiKey: this.apiKey,
      temperature: this.temperature,
    };
  }

  /** Single LLM call, provider-dispatched. Static-ish (all inputs in `p`) so the probes can reuse it. */
  private async callLlm(p: LlmParams, prompt: string): Promise<string> {
    const raw =
      p.provider === 'gemini'
        ? await this.callGemini(p, prompt)
        : p.provider === 'ollama'
          ? await this.callOllama(p, prompt)
          : // openai, groq, azure all speak the OpenAI /chat/completions shape (auth header differs for azure).
            await this.callOpenAiCompatible(p, prompt);
    // Reasoning models (qwen3, deepseek-r1, ...) prepend <think>...</think>; keep only the answer so the
    // group never sees the chain-of-thought. Empty after stripping = all reasoning → fail so translate()
    // tries the next fallback model.
    const out = stripThinking(raw);
    if (!out) throw new Error(`${p.provider} produced only reasoning, no answer`);
    return out;
  }

  private async callOllama(p: LlmParams, prompt: string): Promise<string> {
    const res = await fetch(p.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: p.model,
        stream: false,
        // Suppress chain-of-thought at the source for reasoning models (qwen3 etc.); harmless for models
        // that don't think. stripThinking() in callLlm is the belt-and-suspenders fallback.
        think: false,
        options: { temperature: p.temperature },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = (await res.json()) as { message?: { content?: string } };
    const out = data.message?.content?.trim();
    if (!out) throw new Error('Ollama empty response');
    return out;
  }

  // OpenAI / Groq (Bearer) and Azure OpenAI (api-key header; deployment in the endpoint URL).
  private async callOpenAiCompatible(p: LlmParams, prompt: string): Promise<string> {
    const auth: Record<string, string> = {};
    if (p.apiKey) {
      if (p.provider === 'azure') auth['api-key'] = p.apiKey;
      else auth.authorization = `Bearer ${p.apiKey}`;
    }
    const res = await fetch(p.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({
        model: p.model,
        temperature: p.temperature,
        messages: [{ role: 'user', content: prompt }],
        // Groq qwen3 models are reasoning models: without this they spend the reply on <think> blocks and
        // stripThinking() yields '' → constant fallback. Mirrors callOllama's think:false / Gemini's thinkingBudget:0.
        ...(p.provider === 'groq' && /qwen-?3/i.test(p.model) ? { reasoning_effort: 'none' } : {}),
      }),
    });
    if (!res.ok) throw new Error(`${p.provider} HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const out = data.choices?.[0]?.message?.content?.trim();
    if (!out) throw new Error(`${p.provider} empty response`);
    return out;
  }

  // Gemini generateContent. endpoint = API base (e.g. https://generativelanguage.googleapis.com/v1beta).
  private async callGemini(p: LlmParams, prompt: string): Promise<string> {
    const base = p.endpoint.replace(/\/+$/, '');
    const url = `${base}/models/${p.model}:generateContent?key=${encodeURIComponent(p.apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        // Translation needs no reasoning. Without this, thinking models (gemini-flash/2.5+) spend
        // the whole output budget on internal thinking, finish with MAX_TOKENS and return empty
        // parts — which reads as "translation randomly stops working". Mirrors callOllama's think:false.
        generationConfig: { temperature: p.temperature, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const out = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!out) throw new Error('Gemini empty response');
    return out;
  }

  /**
   * Validate endpoint + key. Prefer the model-agnostic list endpoint (Ollama /api/tags,
   * OpenAI/Groq /models) so a wrong/blank model name doesn't fail key validation; only azure/gemini
   * (no portable list endpoint) fall back to a tiny generation, which does need a valid model.
   */
  async testConnection(p: LlmParams): Promise<{ ok: boolean; message: string }> {
    try {
      // Model-agnostic providers validate via the list endpoint (key/endpoint only); azure has no
      // portable list, so it does a tiny generation which needs a valid deployment/model.
      if (p.provider !== 'azure') {
        const models = await this.listModels(p);
        return { ok: true, message: models.length ? `${models.length} model(s)` : 'ok' };
      }
      const out = await this.callLlm({ ...p, temperature: 0 }, 'ping');
      return { ok: true, message: out.slice(0, 40) || 'ok' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  // Swap just the PATH of a URL (keeps scheme/host/port), like TypeTwo's _replacePath — robust for a
  // LAN Ollama or any host, unlike a suffix regex that only matches the default path.
  private replacePath(endpoint: string, path: string): string {
    try {
      const u = new URL(endpoint);
      u.pathname = path;
      u.search = '';
      return u.toString();
    } catch {
      return endpoint;
    }
  }

  // OpenAI-compatible /models URL: swap a trailing /chat/completions in the path for /models (keeps a
  // prefix like Groq's /openai/v1); otherwise fall back to /v1/models. Mirrors TypeTwo exactly.
  private modelsUrl(endpoint: string, fallback: string): string {
    if (!endpoint.trim()) return fallback;
    try {
      const u = new URL(endpoint);
      const swapped = u.pathname.replace(/\/chat\/completions\/?$/, '/models');
      u.pathname = swapped !== u.pathname ? swapped : '/v1/models';
      u.search = '';
      return u.toString();
    } catch {
      return fallback;
    }
  }

  /** List model names for the endpoint (Ollama /api/tags, OpenAI/Groq /models, Gemini /v1beta/models). */
  async listModels(p: Pick<LlmParams, 'provider' | 'endpoint' | 'apiKey'>): Promise<string[]> {
    if (p.provider === 'ollama') {
      const res = await fetch(this.replacePath(p.endpoint, '/api/tags'));
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
      const data = (await res.json()) as { models?: { name?: string }[] };
      return (data.models ?? []).map(m => m.name ?? '').filter(Boolean);
    }
    if (p.provider === 'openai' || p.provider === 'groq') {
      const fallback =
        p.provider === 'groq'
          ? 'https://api.groq.com/openai/v1/models'
          : 'https://api.openai.com/v1/models';
      const res = await fetch(this.modelsUrl(p.endpoint, fallback), {
        headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {},
      });
      if (!res.ok) throw new Error(`${p.provider} HTTP ${res.status}`);
      const data = (await res.json()) as { data?: { id?: string }[] };
      return (data.data ?? []).map(m => m.id ?? '').filter(Boolean);
    }
    if (p.provider === 'gemini') {
      const base = (p.endpoint || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
      const res = await fetch(`${base}/models`, {
        headers: p.apiKey ? { 'x-goog-api-key': p.apiKey } : {},
      });
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
      const data = (await res.json()) as {
        models?: { name?: string; supportedGenerationMethods?: string[] }[];
      };
      return (data.models ?? [])
        .filter(m => (m.supportedGenerationMethods ?? []).includes('generateContent'))
        .map(m => (m.name ?? '').split('/').pop() ?? '')
        .filter(Boolean);
    }
    // azure has no portable list endpoint — enter the deployment/model manually.
    return [];
  }
}
