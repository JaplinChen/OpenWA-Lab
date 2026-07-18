import type { LlmProvider } from '../../services/api';

export interface ProviderMeta {
  label: string;
  endpoint: string;
  showEndpoint: boolean; // Ollama/OpenAI/Azure expose a server URL; Groq/Gemini have a fixed one.
  needsKey: boolean;
  apiKeyUrl?: string;
}

export const PROVIDERS: { value: LlmProvider; meta: ProviderMeta }[] = [
  { value: 'ollama', meta: { label: 'Ollama', endpoint: 'http://127.0.0.1:11434/api/chat', showEndpoint: true, needsKey: false } },
  { value: 'groq', meta: { label: 'Groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', showEndpoint: false, needsKey: true, apiKeyUrl: 'https://console.groq.com/keys' } },
  { value: 'openai', meta: { label: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', showEndpoint: true, needsKey: true, apiKeyUrl: 'https://platform.openai.com/api-keys' } },
  { value: 'azure', meta: { label: 'Azure OpenAI', endpoint: 'https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=2024-02-15-preview', showEndpoint: true, needsKey: true, apiKeyUrl: 'https://portal.azure.com' } },
  { value: 'gemini', meta: { label: 'Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', showEndpoint: false, needsKey: true, apiKeyUrl: 'https://aistudio.google.com/apikey' } },
];

export const metaOf = (p: LlmProvider): ProviderMeta => PROVIDERS.find(x => x.value === p)!.meta;
