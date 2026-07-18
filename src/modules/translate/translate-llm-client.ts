import { stripThinking } from './translate-lang';

export type LlmProvider = 'ollama' | 'openai' | 'groq' | 'azure' | 'gemini';
export const LLM_PROVIDERS: LlmProvider[] = ['ollama', 'openai', 'groq', 'azure', 'gemini'];

/** The subset needed to make one LLM call — used by translate + the test/models probes. */
export interface LlmParams {
  provider: LlmProvider;
  endpoint: string;
  model: string;
  apiKey: string;
  temperature: number;
}

/** Single LLM call, provider-dispatched. Stateless (all inputs in `p`) so the probes can reuse it. */
export async function callLlm(p: LlmParams, prompt: string): Promise<string> {
  const raw =
    p.provider === 'gemini'
      ? await callGemini(p, prompt)
      : p.provider === 'ollama'
        ? await callOllama(p, prompt)
        : // openai, groq, azure all speak the OpenAI /chat/completions shape (auth header differs for azure).
          await callOpenAiCompatible(p, prompt);
  // Reasoning models (qwen3, deepseek-r1, ...) prepend <think>...</think>; keep only the answer so the
  // group never sees the chain-of-thought. Empty after stripping = all reasoning → fail so translate()
  // tries the next fallback model.
  const out = stripThinking(raw);
  if (!out) throw new Error(`${p.provider} produced only reasoning, no answer`);
  return out;
}

async function callOllama(p: LlmParams, prompt: string): Promise<string> {
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
async function callOpenAiCompatible(p: LlmParams, prompt: string): Promise<string> {
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
async function callGemini(p: LlmParams, prompt: string): Promise<string> {
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
export async function testConnection(p: LlmParams): Promise<{ ok: boolean; message: string }> {
  try {
    if (p.provider !== 'azure') {
      const models = await listModels(p);
      return { ok: true, message: models.length ? `${models.length} model(s)` : 'ok' };
    }
    const out = await callLlm({ ...p, temperature: 0 }, 'ping');
    return { ok: true, message: out.slice(0, 40) || 'ok' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// Swap just the PATH of a URL (keeps scheme/host/port), like TypeTwo's _replacePath — robust for a
// LAN Ollama or any host, unlike a suffix regex that only matches the default path.
function replacePath(endpoint: string, path: string): string {
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
function modelsUrl(endpoint: string, fallback: string): string {
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
export async function listModels(p: Pick<LlmParams, 'provider' | 'endpoint' | 'apiKey'>): Promise<string[]> {
  if (p.provider === 'ollama') {
    const res = await fetch(replacePath(p.endpoint, '/api/tags'));
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = (await res.json()) as { models?: { name?: string }[] };
    return (data.models ?? []).map(m => m.name ?? '').filter(Boolean);
  }
  if (p.provider === 'openai' || p.provider === 'groq') {
    const fallback =
      p.provider === 'groq'
        ? 'https://api.groq.com/openai/v1/models'
        : 'https://api.openai.com/v1/models';
    const res = await fetch(modelsUrl(p.endpoint, fallback), {
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
