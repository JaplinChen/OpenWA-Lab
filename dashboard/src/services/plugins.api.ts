import { request, requestText } from './http';

// =============================================================================
// Plugin Types
// =============================================================================

/** Field definition within a plugin's config schema (mirrors the backend PluginConfigField). */
export interface PluginConfigField {
  // 'textarea' is a multi-line string; a field with `enum` renders as a <select>.
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'textarea';
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  required?: boolean;
  secret?: boolean;
  min?: number;
  max?: number;
  pattern?: string;
  items?: PluginConfigField; // array element schema; array-of-rows when items.type === 'object'
  properties?: Record<string, PluginConfigField>; // nested-object fields
}

export interface PluginConfigSchema {
  type: 'object';
  properties: Record<string, PluginConfigField>;
}

export interface PluginI18nText { title?: string; description?: string }
export interface PluginI18nLocale {
  name?: string;
  description?: string;
  config?: Record<string, PluginI18nText>;
}
export type PluginI18n = Record<string, PluginI18nLocale>;

export interface Plugin {
  id: string;
  name: string;
  version: string;
  type: 'engine' | 'storage' | 'queue' | 'auth' | 'extension';
  description?: string;
  author?: string;
  status: 'installed' | 'enabled' | 'disabled' | 'error';
  config: Record<string, unknown>;
  builtIn: boolean;
  provides: string[];
  /** Whether this plugin can host provisioned ingress instances (drives the Instances tab). */
  ingressCapable: boolean;
  /** Declared config fields, when the plugin exposes a schema (drives the dashboard config form). */
  configSchema?: PluginConfigSchema;
  /** When set, the plugin ships a sandboxed-iframe config editor (preferred over configSchema). */
  configUi?: { entry: string; height?: number };
  /** Whether the plugin is scoped to specific sessions (false = global, always runs). */
  sessionScoped: boolean;
  /** Sessions the plugin is activated for; ['*'] = all numbers. */
  activeSessions: string[];
  /** Per-session config overrides, keyed by sessionId (secrets redacted per slice). */
  sessionConfig?: Record<string, Record<string, unknown>>;
  loadedAt?: string;
  enabledAt?: string;
  error?: string;
  i18n?: PluginI18n;
}

export interface Engine {
  id: string;
  name: string;
  enabled: boolean;
  features: string[];
  /** Underlying engine library (e.g. whatsapp-web.js 1.34.7), distinct from the adapter version. */
  library?: { name: string; version: string };
}

/** A remote catalog entry annotated with this instance's install state. */
export interface CatalogPlugin {
  id: string;
  name: string;
  version: string;
  type?: string;
  status?: string;
  description?: string;
  author?: string;
  license?: string;
  keywords?: string[];
  minOpenWAVersion?: string;
  testedOpenWAVersion?: string;
  homepage?: string;
  download?: string;
  installed: boolean;
  installedVersion: string | null;
  updateAvailable: boolean;
  i18n?: PluginI18n;
}

// =============================================================================
// Plugins API
// =============================================================================

export const pluginsApi = {
  list: () => request<Plugin[]>('/plugins'),
  get: (id: string) => request<Plugin>(`/plugins/${id}`),
  enable: (id: string) =>
    request<{ success: boolean; message: string }>(`/plugins/${id}/enable`, {
      method: 'POST',
    }),
  disable: (id: string) =>
    request<{ success: boolean; message: string }>(`/plugins/${id}/disable`, {
      method: 'POST',
    }),
  updateConfig: (id: string, config: Record<string, unknown>) =>
    request<{ success: boolean; message: string }>(`/plugins/${id}/config`, {
      method: 'PUT',
      body: JSON.stringify({ config }),
    }),
  /** Set which sessions a session-scoped plugin is activated for (['*'] = all). */
  setSessions: (id: string, sessions: string[]) =>
    request<Plugin>(`/plugins/${id}/sessions`, { method: 'PUT', body: JSON.stringify({ sessions }) }),
  /** Set (or clear, with an empty object) a plugin's config override for one session. */
  updateSessionConfig: (id: string, sessionId: string, config: Record<string, unknown>) =>
    request<{ success: boolean; message: string }>(`/plugins/${id}/config/${encodeURIComponent(sessionId)}`, {
      method: 'PUT',
      body: JSON.stringify({ config }),
    }),
  healthCheck: (id: string) => request<{ healthy: boolean; message?: string }>(`/plugins/${id}/health`),
  install: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<Plugin>('/plugins/install', { method: 'POST', body: form });
  },
  installFromUrl: (url: string) =>
    request<Plugin>('/plugins/install-url', { method: 'POST', body: JSON.stringify({ url }) }),
  updateFromUrl: (id: string, url: string) =>
    request<Plugin>(`/plugins/${id}/update`, { method: 'POST', body: JSON.stringify({ url }) }),
  catalog: () => request<CatalogPlugin[]>('/plugins/catalog'),
  /** Fetch a plugin's sandboxed config-UI entry HTML (the API key stays here, in the parent). */
  getConfigUi: (id: string) => requestText(`/plugins/${id}/config-ui`),
  uninstall: (id: string) => request<{ success: boolean; message: string }>(`/plugins/${id}`, { method: 'DELETE' }),
  getEngines: () => request<Engine[]>('/infra/engines'),
  getCurrentEngine: () => request<{ engineType: string }>('/infra/engines/current'),
};

// =============================================================================
// Plugin instances API (Integration Fabric provisioning; mirrors src/modules/integration)
// =============================================================================

export interface IngressUrl {
  route: string;
  url: string;
}

export interface InstanceView {
  id: string;
  pluginId: string;
  instanceId: string;
  sessionScope: string | null;
  secret: string; // '***' on reads; plaintext once on create/regenerate
  verifyToken: string | null;
  config: Record<string, unknown> | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  ingressUrls: IngressUrl[];
}

export type MintedInstance = InstanceView; // same shape; `secret` carries the plaintext once

export interface CreateInstanceInput {
  instanceId: string;
  sessionScope?: string;
  verifyToken?: string;
  config?: Record<string, unknown>;
}

export interface UpdateInstanceInput {
  enabled?: boolean;
  sessionScope?: string;
  config?: Record<string, unknown>;
}

export const pluginInstancesApi = {
  list: (pluginId: string) => request<InstanceView[]>(`/integration/plugins/${pluginId}/instances`),
  create: (pluginId: string, body: CreateInstanceInput) =>
    request<MintedInstance>(`/integration/plugins/${pluginId}/instances`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  regenerateSecret: (pluginId: string, instanceId: string) =>
    request<MintedInstance>(`/integration/plugins/${pluginId}/instances/${instanceId}/regenerate-secret`, {
      method: 'POST',
    }),
  update: (pluginId: string, instanceId: string, body: UpdateInstanceInput) =>
    request<InstanceView>(`/integration/plugins/${pluginId}/instances/${instanceId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  remove: (pluginId: string, instanceId: string) =>
    request<void>(`/integration/plugins/${pluginId}/instances/${instanceId}`, { method: 'DELETE' }),
};

// =============================================================================
// Statistics API (mirrors src/modules/stats)
// =============================================================================

export type StatsPeriod = '24h' | '7d' | '30d';

export interface OverviewStats {
  sessions: { active: number; total: number; byStatus: Record<string, number> };
  messages: { sent: number; received: number; failed: number; today: { sent: number; received: number } };
}

export interface MessageTimeSeriesPoint {
  timestamp: string;
  sent: number;
  received: number;
}

export interface MessageStats {
  timeSeries: MessageTimeSeriesPoint[];
  byType: Record<string, number>;
  bySession: Array<{ sessionId: string; name: string; sent: number; received: number }>;
  topChats: Array<{ chatId: string; chatName?: string | null; messageCount: number }>;
}

export const statsApi = {
  getOverview: () => request<OverviewStats>('/stats/overview'),
  getMessages: (period: StatsPeriod) => request<MessageStats>(`/stats/messages?period=${period}`),
};
