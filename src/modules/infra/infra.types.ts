// Response/DTO shapes and the export/import DB row types for InfraController. Split out of
// infra.controller.ts — these were file-private interfaces, so nothing outside the module used them.

export interface InfraStatus {
  // `builtIn` reflects whether OpenWA's own bundled container is actually running and backing this
  // service (detected live from the labeled container), not merely the saved intent. Falls back to the
  // saved flag when Docker is unavailable. (#488)
  database: { connected: boolean; type: string; host: string; builtIn: boolean };
  redis: { enabled: boolean; connected: boolean; host: string; port: number; builtIn: boolean };
  queue: {
    enabled: boolean;
    webhooks: { pending: number; completed: number; failed: number };
  };
  storage: { type: 'local' | 's3'; path?: string; bucket?: string; builtIn: boolean; s3Available?: boolean };
  engine: {
    type: string;
    headless: boolean;
    sessionDataPath: string;
    browserArgs: string;
    // whatsapp-web.js only: the actual WhatsApp Web build in use (distinct from the library version),
    // and how it was chosen. Omitted for other engines (e.g. baileys). (#488)
    webVersion?: string | null;
    webVersionSource?: 'pinned' | 'auto' | 'native';
  };
}

export interface SaveConfigDto {
  database?: {
    type: 'sqlite' | 'postgres';
    builtIn?: boolean;
    host?: string;
    port?: string;
    username?: string;
    password?: string;
    database?: string;
    schema?: string;
    poolSize?: number;
    sslEnabled?: boolean;
    sslRejectUnauthorized?: boolean;
  };
  redis?: {
    enabled?: boolean;
    builtIn?: boolean;
    host?: string;
    port?: string;
    password?: string;
  };
  queue?: {
    enabled?: boolean;
  };
  storage?: {
    type: 'local' | 's3';
    builtIn?: boolean;
    localPath?: string;
    s3Bucket?: string;
    s3Region?: string;
    s3AccessKey?: string;
    s3SecretKey?: string;
    s3Endpoint?: string;
  };
  engine?: {
    type?: string;
    headless?: boolean;
    sessionDataPath?: string;
    browserArgs?: string;
  };
}

// Database migration types for export/import
export interface SessionRow {
  id: string;
  name: string;
  status: string;
  phone: string | null;
  pushName: string | null;
  config: string | Record<string, unknown>;
  proxyUrl: string | null;
  proxyType: string | null;
  connectedAt: string | null;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookRow {
  id: string;
  sessionId: string;
  url: string;
  events: string | string[];
  secret: string | null;
  headers: string | Record<string, string>;
  filters: string | Record<string, unknown> | null;
  active: boolean | number;
  retryCount: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Shapes mirror the REAL table columns as returned by `SELECT *` (export-data), not the
// camelCase TypeORM entity properties. `messages` columns are the property names; `message_batches`
// columns are snake_case (the entity maps them via `name:`). Keeping these accurate is what keeps
// the import column lists below from drifting back into "no such column" failures.
export interface MessageRow {
  id: string;
  sessionId: string;
  waMessageId: string | null;
  chatId: string;
  from: string;
  to: string;
  body: string | null;
  type: string;
  direction: string;
  timestamp: number | string | null;
  metadata: string | Record<string, unknown> | null;
  status: string;
  createdAt: string;
}

export interface MessageBatchRow {
  id: string;
  batch_id: string;
  session_id: string;
  status: string;
  messages: string | unknown[];
  options: string | Record<string, unknown> | null;
  progress: string | Record<string, unknown> | null;
  results: string | unknown[] | null;
  current_index: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// templates + baileys_stored_messages both FK sessions ON DELETE CASCADE, so import's
// `DELETE FROM sessions` wipes them; they must be exported and re-inserted or the documented
// backup flow loses them permanently.
export interface TemplateRow {
  id: string;
  sessionId: string;
  name: string;
  body: string;
  header: string | null;
  footer: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BaileysStoredMessageRow {
  id: string;
  sessionId: string;
  waMessageId: string;
  serializedMessage: string;
  createdAt: string;
}

// The persisted lid->phone resolution cache. Not a FK to sessions (provenance only), so the import's
// `DELETE FROM sessions` never clears it — it must be exported + re-inserted explicitly or a
// backup→restore into a fresh DB loses the whole cache (it self-heals via re-lookup, but lossily).
export interface LidMappingRow {
  lid: string;
  phone: string | null;
  sessionId: string | null;
  updatedAt: string;
}

export interface PluginInstanceRow {
  id: string;
  pluginId: string;
  instanceId: string;
  sessionScope: string | null;
  secret: string;
  verifyToken: string | null;
  config: string | Record<string, unknown> | null;
  enabled: boolean | number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMappingRow {
  id: string;
  sessionId: string;
  chatId: string;
  pluginId: string;
  instanceId: string;
  providerConversationId: string;
  handoverState: string;
  metadata: string | Record<string, unknown> | null;
  updatedAt: string;
}

export interface IngressEventRow {
  id: string;
  instanceId: string;
  pluginId: string;
  providerDeliveryId: string;
  route: string;
  payload: string | Record<string, unknown>;
  sessionId: string | null;
  createdAt: string;
}

export interface WebhookDeliveryFailureRow {
  id: string;
  webhookId: string;
  sessionId: string;
  event: string;
  url: string;
  idempotencyKey: string | null;
  deliveryId: string | null;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string;
  createdAt: string;
}

export interface IntegrationDeliveryFailureRow {
  id: string;
  direction: string;
  pluginId: string;
  instanceId: string;
  sessionId: string | null;
  deliveryId: string | null;
  attempts: number;
  lastError: string;
  payload: string | Record<string, unknown> | null;
  redriven: boolean | number;
  createdAt: string;
}

export interface MigrationTables {
  sessions: SessionRow[];
  webhooks: WebhookRow[];
  messages: MessageRow[];
  messageBatches: MessageBatchRow[];
  templates: TemplateRow[];
  baileysStoredMessages: BaileysStoredMessageRow[];
  lidMappings: LidMappingRow[];
  pluginInstances: PluginInstanceRow[];
  conversationMappings: ConversationMappingRow[];
  ingressEvents: IngressEventRow[];
  webhookDeliveryFailures: WebhookDeliveryFailureRow[];
  integrationDeliveryFailures: IntegrationDeliveryFailureRow[];
}

// Saved infrastructure config returned to the dashboard form for hydration. Secret
// values are never echoed back — a `*Set` boolean indicates whether one is stored.
export interface SavedConfigResponse {
  database: {
    type: 'sqlite' | 'postgres';
    builtIn: boolean;
    host: string;
    port: string;
    username: string;
    database: string;
    schema: string;
    poolSize: number;
    sslEnabled: boolean;
    sslRejectUnauthorized: boolean;
    passwordSet: boolean;
  };
  redis: { enabled: boolean; builtIn: boolean; host: string; port: string; passwordSet: boolean };
  queue: { enabled: boolean };
  storage: {
    type: 'local' | 's3';
    builtIn: boolean;
    localPath: string;
    s3Bucket: string;
    s3Region: string;
    s3Endpoint: string;
    s3CredentialsSet: boolean;
  };
  engine: { type: string; headless: boolean; sessionDataPath: string; browserArgs: string };
}
