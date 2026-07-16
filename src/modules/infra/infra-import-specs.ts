import { isSafeSessionName } from '../../common/utils/path-safety';
import type { MigrationTables } from './infra.types';

/**
 * How to restore one table: which backup key it reads, the INSERT, and how to turn a row into bind
 * params. Declarative on purpose — the twelve tables differed only in table/columns/warning noun,
 * so they are data here and infra-data-import.ts holds the one loop that runs them.
 */
export interface ImportSpec<K extends keyof MigrationTables> {
  key: K;
  /** Noun used in the per-row warning: `Failed to import <noun> <id>: <err>`. */
  noun: string;
  /** Row identifier for that warning. Not always `id` — lid_mappings reports its `lid`. */
  id: (row: MigrationTables[K][number]) => unknown;
  sql: string;
  values: (row: MigrationTables[K][number]) => unknown[];
  /** Returns a warning to skip the row instead of inserting it, or null to import it. */
  skip?: (row: MigrationTables[K][number]) => string | null;
}

export type AnyImportSpec = { [K in keyof MigrationTables]: ImportSpec<K> }[keyof MigrationTables];

/** Identity helper: pins K per spec so each `values` mapping is type-checked against its own row type. */
const spec = <K extends keyof MigrationTables>(s: ImportSpec<K>): ImportSpec<K> => s;

/** `null`/`undefined` stays NULL, a string passes through, anything else is stringified. */
const jsonOrNull = (v: unknown): string | null => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));
/** String passes through, else stringify — falling back on FALSY (`||`), as the original did. */
const jsonOr = (v: unknown, fallback: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v || fallback));
/** String passes through, else stringify — falling back on NULLISH (`??`), as the original did. */
const jsonOrNullish = (v: unknown, fallback: unknown): string =>
  typeof v === 'string' ? v : JSON.stringify(v ?? fallback);

/**
 * Ordered: sessions MUST come first — templates and baileys_stored_messages carry an FK to it. The
 * rest are order-independent, but the sequence is kept as-is so the returned counts object keeps its
 * original key order.
 */
export const IMPORT_SPECS: readonly AnyImportSpec[] = [
  spec<'sessions'>({
    key: 'sessions',
    noun: 'session',
    id: s => s.id,
    // A session name becomes the engine auth-directory key, so an unvalidated imported name (this path
    // bypasses CreateSessionDto) could traverse the filesystem. Skip + warn instead of throwing, so one
    // bad row doesn't 500 the whole restore.
    skip: s => (isSafeSessionName(s.name) ? null : `Skipped session ${s.id}: unsafe name ${JSON.stringify(s.name)}`),
    sql: `INSERT INTO sessions (id, name, status, phone, "pushName", config, "proxyUrl", "proxyType", "connectedAt", "lastActiveAt", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    values: s => [
      s.id,
      s.name,
      s.status,
      s.phone,
      s.pushName,
      jsonOr(s.config, {}),
      s.proxyUrl,
      s.proxyType,
      s.connectedAt,
      s.lastActiveAt,
      s.createdAt,
      s.updatedAt,
    ],
  }),
  spec<'webhooks'>({
    key: 'webhooks',
    noun: 'webhook',
    id: w => w.id,
    sql: `INSERT INTO webhooks (id, "sessionId", url, events, secret, headers, filters, active, "retryCount", "lastTriggeredAt", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    values: w => [
      w.id,
      w.sessionId,
      w.url,
      jsonOr(w.events, []),
      w.secret,
      jsonOr(w.headers, {}),
      jsonOrNull(w.filters),
      w.active,
      w.retryCount,
      w.lastTriggeredAt,
      w.createdAt,
      w.updatedAt,
    ],
  }),
  spec<'messages'>({
    key: 'messages',
    noun: 'message',
    id: m => m.id,
    sql: `INSERT INTO messages (id, "sessionId", "waMessageId", "chatId", "from", "to", body, type, direction, "timestamp", metadata, status, "createdAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    values: m => [
      m.id,
      m.sessionId,
      m.waMessageId ?? null,
      m.chatId,
      m.from,
      m.to,
      m.body ?? null,
      m.type,
      m.direction,
      m.timestamp ?? null,
      jsonOrNull(m.metadata),
      m.status,
      m.createdAt,
    ],
  }),
  spec<'messageBatches'>({
    key: 'messageBatches',
    noun: 'message batch',
    id: b => b.id,
    sql: `INSERT INTO message_batches (id, batch_id, session_id, status, messages, options, progress, results, current_index, created_at, updated_at, started_at, completed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    values: b => [
      b.id,
      b.batch_id,
      b.session_id,
      b.status,
      jsonOrNullish(b.messages, []),
      jsonOrNull(b.options),
      jsonOrNull(b.progress),
      jsonOrNull(b.results),
      b.current_index,
      b.created_at,
      b.updated_at,
      b.started_at,
      b.completed_at,
    ],
  }),
  spec<'templates'>({
    key: 'templates',
    noun: 'template',
    id: t => t.id,
    sql: `INSERT INTO templates (id, "sessionId", name, body, header, footer, "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    values: t => [t.id, t.sessionId, t.name, t.body, t.header ?? null, t.footer ?? null, t.createdAt, t.updatedAt],
  }),
  spec<'baileysStoredMessages'>({
    key: 'baileysStoredMessages',
    noun: 'baileys stored message',
    id: b => b.id,
    sql: `INSERT INTO baileys_stored_messages (id, "sessionId", "waMessageId", "serializedMessage", "createdAt")
             VALUES ($1, $2, $3, $4, $5)`,
    values: b => [b.id, b.sessionId, b.waMessageId, b.serializedMessage, b.createdAt],
  }),
  spec<'lidMappings'>({
    key: 'lidMappings',
    noun: 'lid mapping',
    id: l => l.lid,
    sql: `INSERT INTO lid_mappings (lid, phone, "sessionId", "updatedAt") VALUES ($1, $2, $3, $4)`,
    values: l => [l.lid, l.phone ?? null, l.sessionId ?? null, l.updatedAt],
  }),
  spec<'pluginInstances'>({
    key: 'pluginInstances',
    noun: 'plugin instance',
    id: p => p.id,
    sql: `INSERT INTO plugin_instances (id, "pluginId", "instanceId", "sessionScope", secret, "verifyToken", config, enabled, "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    values: p => [
      p.id,
      p.pluginId,
      p.instanceId,
      p.sessionScope,
      p.secret,
      p.verifyToken,
      jsonOrNull(p.config),
      p.enabled,
      p.createdAt,
      p.updatedAt,
    ],
  }),
  spec<'conversationMappings'>({
    key: 'conversationMappings',
    noun: 'conversation mapping',
    id: c => c.id,
    sql: `INSERT INTO conversation_mappings (id, "sessionId", "chatId", "pluginId", "instanceId", "providerConversationId", "handoverState", metadata, "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    values: c => [
      c.id,
      c.sessionId,
      c.chatId,
      c.pluginId,
      c.instanceId,
      c.providerConversationId,
      c.handoverState,
      jsonOrNull(c.metadata),
      c.updatedAt,
    ],
  }),
  spec<'ingressEvents'>({
    key: 'ingressEvents',
    noun: 'ingress event',
    id: i => i.id,
    sql: `INSERT INTO ingress_events (id, "instanceId", "pluginId", "providerDeliveryId", route, payload, "sessionId", "createdAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    values: i => [
      i.id,
      i.instanceId,
      i.pluginId,
      i.providerDeliveryId,
      i.route,
      jsonOrNullish(i.payload, {}),
      i.sessionId,
      i.createdAt,
    ],
  }),
  spec<'webhookDeliveryFailures'>({
    key: 'webhookDeliveryFailures',
    noun: 'webhook delivery failure',
    id: w => w.id,
    sql: `INSERT INTO webhook_delivery_failures (id, "webhookId", "sessionId", event, url, "idempotencyKey", "deliveryId", attempts, "lastStatusCode", "lastError", "createdAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    values: w => [
      w.id,
      w.webhookId,
      w.sessionId,
      w.event,
      w.url,
      w.idempotencyKey,
      w.deliveryId,
      w.attempts,
      w.lastStatusCode,
      w.lastError,
      w.createdAt,
    ],
  }),
  spec<'integrationDeliveryFailures'>({
    key: 'integrationDeliveryFailures',
    noun: 'integration delivery failure',
    id: d => d.id,
    sql: `INSERT INTO integration_delivery_failures (id, direction, "pluginId", "instanceId", "sessionId", "deliveryId", attempts, "lastError", payload, redriven, "createdAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    values: d => [
      d.id,
      d.direction,
      d.pluginId,
      d.instanceId,
      d.sessionId,
      d.deliveryId,
      d.attempts,
      d.lastError,
      jsonOrNull(d.payload),
      d.redriven,
      d.createdAt,
    ],
  }),
];
