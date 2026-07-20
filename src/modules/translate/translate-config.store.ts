import * as fs from 'node:fs';
import * as path from 'node:path';
import { LlmProvider, LLM_PROVIDERS } from './translate-llm-client';

// Overridable so tests point at an isolated tmp path instead of the real data dir.
export const configPath = (): string => process.env.TRANSLATE_CONFIG_PATH || 'data/translate-config.json';

export interface TranslateConfig {
  enabled: boolean;
  groupIds: string[];
  includeFromMe: boolean;
  minSendIntervalMs: number;
  // Reply a short notice to the group when every model fails, so a silently-broken bot is visible.
  notifyOnFailure: boolean;
  llmProvider: LlmProvider;
  llmEndpoint: string;
  llmModel: string;
  llmApiKey: string;
  llmTemperature: number;
  llmFallbackModels: string[];
  // Custom prompt template ({source}/{target}/{glossary}/{text} placeholders). '' = built-in default.
  llmPromptTemplate: string;
  // Per-provider saved settings so switching engines in the UI restores each one's endpoint/model/key
  // (like TypeTwo's providerConfigs). Opaque to the backend — only the flat active fields drive
  // translate(); this is storage the dashboard reads back.
  llmProviderConfigs: Record<string, Record<string, unknown>>;
}

// Runtime shape of TranslateConfig: groupIds as a Set for O(1) chat lookups.
export type RuntimeConfig = Omit<TranslateConfig, 'groupIds'> & { groupIds: Set<string> };

export function defaultRuntimeConfig(): RuntimeConfig {
  return {
    enabled: false,
    groupIds: new Set<string>(),
    // Also translate the account's OWN outgoing messages (message:sent) — needed when the operator IS
    // the controlled number. Echo is prevented by the invisible marker skip in onMessage.
    includeFromMe: false,
    // Anti-ban: minimum gap between outbound translation sends (ms). 0 = no extra pacing.
    minSendIntervalMs: 0,
    notifyOnFailure: false,
    llmProvider: 'ollama',
    llmEndpoint: 'http://127.0.0.1:11434/api/chat',
    llmModel: 'translategemma-12b-cline-32768:latest',
    llmApiKey: '',
    // 0 = deterministic; kept low for stable translations.
    llmTemperature: 0,
    // Tried in order when the primary model call throws (e.g. model not loaded, timeout).
    llmFallbackModels: [],
    // Custom prompt template; '' = use DEFAULT_PROMPT_TEMPLATE.
    llmPromptTemplate: '',
    // Per-provider saved settings (opaque passthrough for the dashboard; see TranslateConfig).
    llmProviderConfigs: {},
  };
}

export type ConfigRead =
  | { status: 'ok'; raw: Partial<TranslateConfig> }
  | { status: 'missing' }
  | { status: 'unreadable'; error: unknown };

export class TranslateConfigStore {
  read(): ConfigRead {
    try {
      return { status: 'ok', raw: JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Partial<TranslateConfig> };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
      return { status: 'unreadable', error: err };
    }
  }

  // Atomic tmp+rename so a crash mid-write never leaves a truncated config.
  write(cfg: TranslateConfig): void {
    const file = configPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }
}

export const splitList = (s: string): string[] =>
  s
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);

/** .env-derived seed values (applied first; the persisted config file takes precedence). */
export function envSeedConfig(): Partial<TranslateConfig> {
  const out: Partial<TranslateConfig> = {
    enabled: process.env.TRANSLATE_ENABLED === 'true',
    groupIds: splitList(process.env.TRANSLATE_GROUP_IDS || ''),
    includeFromMe: process.env.TRANSLATE_INCLUDE_FROM_ME === 'true',
    llmFallbackModels: splitList(process.env.LLM_FALLBACK_MODELS || ''),
  };
  if (LLM_PROVIDERS.includes(process.env.LLM_PROVIDER as LlmProvider)) {
    out.llmProvider = process.env.LLM_PROVIDER as LlmProvider;
  }
  const endpoint = process.env.LLM_ENDPOINT || process.env.OLLAMA_ENDPOINT;
  if (endpoint) out.llmEndpoint = endpoint;
  const model = process.env.LLM_MODEL || process.env.OLLAMA_MODEL;
  if (model) out.llmModel = model;
  if (process.env.LLM_API_KEY) out.llmApiKey = process.env.LLM_API_KEY;
  const temp = Number(process.env.LLM_TEMPERATURE);
  if (Number.isFinite(temp) && temp >= 0) out.llmTemperature = temp;
  const si = Number(process.env.TRANSLATE_MIN_SEND_INTERVAL_MS);
  if (Number.isFinite(si) && si >= 0) out.minSendIntervalMs = si;
  return out;
}

/** Type-guard a raw config file payload down to the fields that are actually usable. */
export function sanitizeConfig(raw: Partial<TranslateConfig>): Partial<TranslateConfig> {
  const out: Partial<TranslateConfig> = {};
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (Array.isArray(raw.groupIds)) out.groupIds = raw.groupIds.map(s => String(s).trim()).filter(Boolean);
  if (typeof raw.includeFromMe === 'boolean') out.includeFromMe = raw.includeFromMe;
  if (typeof raw.minSendIntervalMs === 'number' && raw.minSendIntervalMs >= 0) {
    out.minSendIntervalMs = raw.minSendIntervalMs;
  }
  if (typeof raw.notifyOnFailure === 'boolean') out.notifyOnFailure = raw.notifyOnFailure;
  if (LLM_PROVIDERS.includes(raw.llmProvider as LlmProvider)) out.llmProvider = raw.llmProvider as LlmProvider;
  if (typeof raw.llmEndpoint === 'string' && raw.llmEndpoint) out.llmEndpoint = raw.llmEndpoint;
  if (typeof raw.llmModel === 'string' && raw.llmModel) out.llmModel = raw.llmModel;
  if (typeof raw.llmApiKey === 'string') out.llmApiKey = raw.llmApiKey;
  if (typeof raw.llmTemperature === 'number' && raw.llmTemperature >= 0) out.llmTemperature = raw.llmTemperature;
  if (Array.isArray(raw.llmFallbackModels)) {
    out.llmFallbackModels = raw.llmFallbackModels.map(s => String(s).trim()).filter(Boolean);
  }
  if (typeof raw.llmPromptTemplate === 'string') out.llmPromptTemplate = raw.llmPromptTemplate;
  if (raw.llmProviderConfigs && typeof raw.llmProviderConfigs === 'object') {
    out.llmProviderConfigs = raw.llmProviderConfigs;
  }
  return out;
}

/**
 * Normalize a dashboard PUT payload: trim strings, drop invalid values, keep the stored API key when
 * the masked '' round-trips back, and merge per-provider configs against the stored ones.
 */
export function normalizeConfigPatch(
  partial: Partial<TranslateConfig>,
  storedProviderConfigs: Record<string, Record<string, unknown>>,
): Partial<TranslateConfig> {
  const out: Partial<TranslateConfig> = {};
  if (partial.enabled !== undefined) out.enabled = partial.enabled;
  if (partial.groupIds !== undefined) out.groupIds = partial.groupIds.map(s => s.trim()).filter(Boolean);
  if (partial.includeFromMe !== undefined) out.includeFromMe = partial.includeFromMe;
  if (partial.minSendIntervalMs !== undefined && partial.minSendIntervalMs >= 0) {
    out.minSendIntervalMs = partial.minSendIntervalMs;
  }
  if (partial.notifyOnFailure !== undefined) out.notifyOnFailure = partial.notifyOnFailure;
  if (partial.llmProvider !== undefined && LLM_PROVIDERS.includes(partial.llmProvider)) {
    out.llmProvider = partial.llmProvider;
  }
  if (partial.llmEndpoint !== undefined) out.llmEndpoint = partial.llmEndpoint.trim();
  if (partial.llmModel !== undefined) out.llmModel = partial.llmModel.trim();
  // '' = masked value round-tripped from getConfig(): keep the stored key (omit from the patch).
  if (partial.llmApiKey !== undefined && partial.llmApiKey.trim()) out.llmApiKey = partial.llmApiKey.trim();
  if (partial.llmTemperature !== undefined && partial.llmTemperature >= 0) {
    out.llmTemperature = partial.llmTemperature;
  }
  if (partial.llmFallbackModels !== undefined) {
    out.llmFallbackModels = partial.llmFallbackModels.map(s => s.trim()).filter(Boolean);
  }
  if (partial.llmPromptTemplate !== undefined) out.llmPromptTemplate = partial.llmPromptTemplate;
  if (partial.llmProviderConfigs !== undefined && partial.llmProviderConfigs !== null) {
    const merged: Record<string, Record<string, unknown>> = {};
    for (const [prov, cfg] of Object.entries(partial.llmProviderConfigs)) {
      const { apiKeySet: _set, ...rest } = cfg;
      const stored = storedProviderConfigs[prov]?.apiKey;
      if (!rest.apiKey && typeof stored === 'string' && stored) rest.apiKey = stored;
      merged[prov] = rest;
    }
    out.llmProviderConfigs = merged;
  }
  return out;
}

/** Mask each provider config's apiKey to '' + apiKeySet flag so keys never leave the server. */
export function maskProviderConfigs(
  configs: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const masked: Record<string, Record<string, unknown>> = {};
  for (const [prov, cfg] of Object.entries(configs)) {
    masked[prov] =
      typeof cfg.apiKey === 'string' && cfg.apiKey ? { ...cfg, apiKey: '', apiKeySet: true } : { ...cfg };
  }
  return masked;
}
