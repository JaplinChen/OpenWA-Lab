import { request } from './http';

// =============================================================================
// Types
// =============================================================================

export type WebhookFilterOperator = 'is' | 'isNot' | 'contains' | 'equals';

export interface WebhookFilterCondition {
  field: string;
  operator: WebhookFilterOperator;
  value: string | string[] | boolean;
  caseSensitive?: boolean;
}

export interface WebhookFilters {
  conditions: WebhookFilterCondition[];
}

export interface Webhook {
  id: string;
  sessionId: string;
  url: string;
  events: string[];
  filters?: WebhookFilters | null;
  active: boolean;
  secret?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageTemplate {
  id: string;
  sessionId: string;
  name: string;
  body: string;
  header?: string | null;
  footer?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TemplatePayload {
  name: string;
  body: string;
  header?: string | null;
  footer?: string | null;
}

// Global message search (mirrors the backend GET /search contract from #664).
// `timestamp` is epoch-seconds (the messages column is seconds, not ms); `dateFrom`/`dateTo`
// are epoch-ms on the wire — see `dateFrom`/`dateTo` JSDoc below.
export interface SearchParams {
  q: string;
  sessionId?: string;
  chatId?: string;
  direction?: string;
  type?: string;
  from?: string;
  /** Epoch-ms lower bound (inclusive) — the backend binds against messages.timestamp (/1000). */
  dateFrom?: number;
  /** Epoch-ms upper bound (inclusive). */
  dateTo?: number;
  limit?: number;
  offset?: number;
}

export interface SearchHit {
  messageId: string;
  waMessageId: string;
  sessionId: string;
  chatId: string;
  body: string;
  /** Provider-generated excerpt with `<mark>` highlight markers — render as text, never as HTML. */
  snippet: string;
  /** Epoch-seconds (mirrors the persisted messages.timestamp column). */
  timestamp: number;
  type: string;
  direction: string;
  from: string;
  score?: number;
}

export interface SearchResults {
  hits: SearchHit[];
  total: number;
  tookMs: number;
  provider: string;
}

// =============================================================================
// Webhook API
// =============================================================================

export const webhookApi = {
  listBySession: (sessionId: string) => request<Webhook[]>(`/sessions/${sessionId}/webhooks`),
  listAll: () => request<Webhook[]>('/webhooks'),
  get: (sessionId: string, id: string) => request<Webhook>(`/sessions/${sessionId}/webhooks/${id}`),
  create: (sessionId: string, data: { url: string; events: string[]; filters?: WebhookFilters | null }) =>
    request<Webhook>(`/sessions/${sessionId}/webhooks`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (sessionId: string, id: string, data: Partial<Webhook>) =>
    request<Webhook>(`/sessions/${sessionId}/webhooks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (sessionId: string, id: string) =>
    request<void>(`/sessions/${sessionId}/webhooks/${id}`, { method: 'DELETE' }),
  test: (sessionId: string, id: string) =>
    request<{ success: boolean; statusCode?: number; error?: string }>(`/sessions/${sessionId}/webhooks/${id}/test`, {
      method: 'POST',
    }),
};

// =============================================================================
// Template API
// =============================================================================

export const templateApi = {
  list: (sessionId: string) => request<MessageTemplate[]>(`/sessions/${sessionId}/templates`),
  get: (sessionId: string, id: string) => request<MessageTemplate>(`/sessions/${sessionId}/templates/${id}`),
  create: (sessionId: string, data: TemplatePayload) =>
    request<MessageTemplate>(`/sessions/${sessionId}/templates`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (sessionId: string, id: string, data: Partial<TemplatePayload>) =>
    request<MessageTemplate>(`/sessions/${sessionId}/templates/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  delete: (sessionId: string, id: string) =>
    request<void>(`/sessions/${sessionId}/templates/${id}`, { method: 'DELETE' }),
};

// =============================================================================
// Contact API
// =============================================================================

export interface CheckNumberResponse {
  number: string;
  exists: boolean;
  /** Engine-canonical WhatsApp id for the number (e.g. `…@c.us` or `…@lid`), or null if unregistered. */
  whatsappId: string | null;
}

export const contactApi = {
  checkNumber: (sessionId: string, number: string) =>
    request<CheckNumberResponse>(`/sessions/${sessionId}/contacts/check/${encodeURIComponent(number)}`),
};

// =============================================================================
// Search API
// =============================================================================

export const searchApi = {
  search: (params: SearchParams) => {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== '') query.set(key, String(value));
    });
    return request<SearchResults>(`/search?${query.toString()}`);
  },
};
