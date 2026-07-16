import { isMissingTableError } from '../../common/utils/db-errors';
import { isSafeSessionName } from '../../common/utils/path-safety';
import type { ImportDataResult, MigrationTables } from './infra.types';
import type { DataTransferCtx } from './infra-data-transfer.ctx';

export async function importData(
  ctx: DataTransferCtx,
  data: { tables: Partial<MigrationTables> },
): Promise<ImportDataResult> {
  const warnings: string[] = [];
  const queryRunner = ctx.dataDataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();

  try {
    // Clear existing data (in correct order due to foreign keys). templates and
    // baileys_stored_messages FK sessions ON DELETE CASCADE, so the sessions DELETE would clear
    // them too; clearing them explicitly first keeps the order correct on engines where the
    // cascade is not enforced. Tolerate a genuinely-absent table (isMissingTableError) but let any
    // OTHER failure (lock, I/O, aborted tx) propagate to the transaction rollback below — a blind
    // `.catch(() => {})` here could otherwise silently commit a MERGED (not replaced) restore on
    // SQLite, violating the endpoint's "replaces existing data" contract.
    const clearTable = async (table: string): Promise<void> => {
      try {
        await queryRunner.query(`DELETE FROM ${table}`);
      } catch (err) {
        if (!isMissingTableError(err)) throw err;
        ctx.logger.debug('Skipped clearing a table that does not exist during import', { table });
      }
    };
    await queryRunner.query('DELETE FROM webhooks');
    await clearTable('messages');
    await clearTable('message_batches');
    await clearTable('templates');
    await clearTable('baileys_stored_messages');
    // lid_mappings is not a FK to sessions, so the sessions DELETE below won't clear it; clear it
    // explicitly so a restore replaces the cache rather than colliding on existing lid PKs.
    await clearTable('lid_mappings');
    // Integration Fabric + both DLQs: none carry an FK constraint to sessions (sessionId is provenance),
    // so clearing them here before the sessions DELETE keeps the replace-semantics complete.
    await clearTable('plugin_instances');
    await clearTable('conversation_mappings');
    await clearTable('ingress_events');
    await clearTable('webhook_delivery_failures');
    await clearTable('integration_delivery_failures');
    await queryRunner.query('DELETE FROM sessions');

    // Import sessions first
    let sessionsCount = 0;
    if (data.tables.sessions?.length) {
      for (const session of data.tables.sessions) {
        // A session name becomes the engine auth-directory key, so an unvalidated imported name (this
        // path bypasses CreateSessionDto) could traverse the filesystem. Skip + warn instead of
        // throwing, so one bad row doesn't 500 the whole restore.
        if (!isSafeSessionName(session.name)) {
          warnings.push(`Skipped session ${session.id}: unsafe name ${JSON.stringify(session.name)}`);
          continue;
        }
        try {
          await queryRunner.query(
            `INSERT INTO sessions (id, name, status, phone, "pushName", config, "proxyUrl", "proxyType", "connectedAt", "lastActiveAt", "createdAt", "updatedAt") 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              session.id,
              session.name,
              session.status,
              session.phone,
              session.pushName,
              typeof session.config === 'string' ? session.config : JSON.stringify(session.config || {}),
              session.proxyUrl,
              session.proxyType,
              session.connectedAt,
              session.lastActiveAt,
              session.createdAt,
              session.updatedAt,
            ],
          );
          sessionsCount++;
        } catch (err) {
          warnings.push(`Failed to import session ${session.id}: ${err}`);
        }
      }
    }

    // Import webhooks
    let webhooksCount = 0;
    if (data.tables.webhooks?.length) {
      for (const webhook of data.tables.webhooks) {
        try {
          await queryRunner.query(
            `INSERT INTO webhooks (id, "sessionId", url, events, secret, headers, filters, active, "retryCount", "lastTriggeredAt", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              webhook.id,
              webhook.sessionId,
              webhook.url,
              typeof webhook.events === 'string' ? webhook.events : JSON.stringify(webhook.events || []),
              webhook.secret,
              typeof webhook.headers === 'string' ? webhook.headers : JSON.stringify(webhook.headers || {}),
              webhook.filters == null
                ? null
                : typeof webhook.filters === 'string'
                  ? webhook.filters
                  : JSON.stringify(webhook.filters),
              webhook.active,
              webhook.retryCount,
              webhook.lastTriggeredAt,
              webhook.createdAt,
              webhook.updatedAt,
            ],
          );
          webhooksCount++;
        } catch (err) {
          warnings.push(`Failed to import webhook ${webhook.id}: ${err}`);
        }
      }
    }

    // Import messages (optional)
    let messagesCount = 0;
    if (data.tables.messages?.length) {
      for (const msg of data.tables.messages) {
        try {
          await queryRunner.query(
            `INSERT INTO messages (id, "sessionId", "waMessageId", "chatId", "from", "to", body, type, direction, "timestamp", metadata, status, "createdAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
              msg.id,
              msg.sessionId,
              msg.waMessageId ?? null,
              msg.chatId,
              msg.from,
              msg.to,
              msg.body ?? null,
              msg.type,
              msg.direction,
              msg.timestamp ?? null,
              msg.metadata == null
                ? null
                : typeof msg.metadata === 'string'
                  ? msg.metadata
                  : JSON.stringify(msg.metadata),
              msg.status,
              msg.createdAt,
            ],
          );
          messagesCount++;
        } catch (err) {
          warnings.push(`Failed to import message ${msg.id}: ${err}`);
        }
      }
    }

    // Import message batches (optional)
    let messageBatchesCount = 0;
    if (data.tables.messageBatches?.length) {
      for (const batch of data.tables.messageBatches) {
        try {
          await queryRunner.query(
            `INSERT INTO message_batches (id, batch_id, session_id, status, messages, options, progress, results, current_index, created_at, updated_at, started_at, completed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
              batch.id,
              batch.batch_id,
              batch.session_id,
              batch.status,
              typeof batch.messages === 'string' ? batch.messages : JSON.stringify(batch.messages ?? []),
              batch.options == null
                ? null
                : typeof batch.options === 'string'
                  ? batch.options
                  : JSON.stringify(batch.options),
              batch.progress == null
                ? null
                : typeof batch.progress === 'string'
                  ? batch.progress
                  : JSON.stringify(batch.progress),
              batch.results == null
                ? null
                : typeof batch.results === 'string'
                  ? batch.results
                  : JSON.stringify(batch.results),
              batch.current_index,
              batch.created_at,
              batch.updated_at,
              batch.started_at,
              batch.completed_at,
            ],
          );
          messageBatchesCount++;
        } catch (err) {
          warnings.push(`Failed to import message batch ${batch.id}: ${err}`);
        }
      }
    }

    // Import templates (optional; FK -> sessions, restored above)
    let templatesCount = 0;
    if (data.tables.templates?.length) {
      for (const tpl of data.tables.templates) {
        try {
          await queryRunner.query(
            `INSERT INTO templates (id, "sessionId", name, body, header, footer, "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              tpl.id,
              tpl.sessionId,
              tpl.name,
              tpl.body,
              tpl.header ?? null,
              tpl.footer ?? null,
              tpl.createdAt,
              tpl.updatedAt,
            ],
          );
          templatesCount++;
        } catch (err) {
          warnings.push(`Failed to import template ${tpl.id}: ${err}`);
        }
      }
    }

    // Import baileys stored messages (optional; FK -> sessions, restored above)
    let baileysStoredMessagesCount = 0;
    if (data.tables.baileysStoredMessages?.length) {
      for (const bsm of data.tables.baileysStoredMessages) {
        try {
          await queryRunner.query(
            `INSERT INTO baileys_stored_messages (id, "sessionId", "waMessageId", "serializedMessage", "createdAt")
             VALUES ($1, $2, $3, $4, $5)`,
            [bsm.id, bsm.sessionId, bsm.waMessageId, bsm.serializedMessage, bsm.createdAt],
          );
          baileysStoredMessagesCount++;
        } catch (err) {
          warnings.push(`Failed to import baileys stored message ${bsm.id}: ${err}`);
        }
      }
    }

    // Import lid mappings (optional; not a FK, restored as a standalone cache table)
    let lidMappingsCount = 0;
    if (data.tables.lidMappings?.length) {
      for (const lm of data.tables.lidMappings) {
        try {
          await queryRunner.query(
            `INSERT INTO lid_mappings (lid, phone, "sessionId", "updatedAt") VALUES ($1, $2, $3, $4)`,
            [lm.lid, lm.phone ?? null, lm.sessionId ?? null, lm.updatedAt],
          );
          lidMappingsCount++;
        } catch (err) {
          warnings.push(`Failed to import lid mapping ${lm.lid}: ${err}`);
        }
      }
    }

    // Import plugin instances (Integration Fabric config + ingress HMAC secret)
    let pluginInstancesCount = 0;
    if (data.tables.pluginInstances?.length) {
      for (const pi of data.tables.pluginInstances) {
        try {
          await queryRunner.query(
            `INSERT INTO plugin_instances (id, "pluginId", "instanceId", "sessionScope", secret, "verifyToken", config, enabled, "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              pi.id,
              pi.pluginId,
              pi.instanceId,
              pi.sessionScope,
              pi.secret,
              pi.verifyToken,
              pi.config == null ? null : typeof pi.config === 'string' ? pi.config : JSON.stringify(pi.config),
              pi.enabled,
              pi.createdAt,
              pi.updatedAt,
            ],
          );
          pluginInstancesCount++;
        } catch (err) {
          warnings.push(`Failed to import plugin instance ${pi.id}: ${err}`);
        }
      }
    }

    // Import conversation mappings (handover state; sessionId is non-FK provenance)
    let conversationMappingsCount = 0;
    if (data.tables.conversationMappings?.length) {
      for (const cm of data.tables.conversationMappings) {
        try {
          await queryRunner.query(
            `INSERT INTO conversation_mappings (id, "sessionId", "chatId", "pluginId", "instanceId", "providerConversationId", "handoverState", metadata, "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              cm.id,
              cm.sessionId,
              cm.chatId,
              cm.pluginId,
              cm.instanceId,
              cm.providerConversationId,
              cm.handoverState,
              cm.metadata == null ? null : typeof cm.metadata === 'string' ? cm.metadata : JSON.stringify(cm.metadata),
              cm.updatedAt,
            ],
          );
          conversationMappingsCount++;
        } catch (err) {
          warnings.push(`Failed to import conversation mapping ${cm.id}: ${err}`);
        }
      }
    }

    // Import ingress events (durable inbound dedup oracle; payload is JSON)
    let ingressEventsCount = 0;
    if (data.tables.ingressEvents?.length) {
      for (const ie of data.tables.ingressEvents) {
        try {
          await queryRunner.query(
            `INSERT INTO ingress_events (id, "instanceId", "pluginId", "providerDeliveryId", route, payload, "sessionId", "createdAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              ie.id,
              ie.instanceId,
              ie.pluginId,
              ie.providerDeliveryId,
              ie.route,
              typeof ie.payload === 'string' ? ie.payload : JSON.stringify(ie.payload ?? {}),
              ie.sessionId,
              ie.createdAt,
            ],
          );
          ingressEventsCount++;
        } catch (err) {
          warnings.push(`Failed to import ingress event ${ie.id}: ${err}`);
        }
      }
    }

    // Import webhook delivery failures (webhook DLQ)
    let webhookDeliveryFailuresCount = 0;
    if (data.tables.webhookDeliveryFailures?.length) {
      for (const wf of data.tables.webhookDeliveryFailures) {
        try {
          await queryRunner.query(
            `INSERT INTO webhook_delivery_failures (id, "webhookId", "sessionId", event, url, "idempotencyKey", "deliveryId", attempts, "lastStatusCode", "lastError", "createdAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              wf.id,
              wf.webhookId,
              wf.sessionId,
              wf.event,
              wf.url,
              wf.idempotencyKey,
              wf.deliveryId,
              wf.attempts,
              wf.lastStatusCode,
              wf.lastError,
              wf.createdAt,
            ],
          );
          webhookDeliveryFailuresCount++;
        } catch (err) {
          warnings.push(`Failed to import webhook delivery failure ${wf.id}: ${err}`);
        }
      }
    }

    // Import integration delivery failures (inbound + outbound DLQ)
    let integrationDeliveryFailuresCount = 0;
    if (data.tables.integrationDeliveryFailures?.length) {
      for (const df of data.tables.integrationDeliveryFailures) {
        try {
          await queryRunner.query(
            `INSERT INTO integration_delivery_failures (id, direction, "pluginId", "instanceId", "sessionId", "deliveryId", attempts, "lastError", payload, redriven, "createdAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              df.id,
              df.direction,
              df.pluginId,
              df.instanceId,
              df.sessionId,
              df.deliveryId,
              df.attempts,
              df.lastError,
              df.payload == null ? null : typeof df.payload === 'string' ? df.payload : JSON.stringify(df.payload),
              df.redriven,
              df.createdAt,
            ],
          );
          integrationDeliveryFailuresCount++;
        } catch (err) {
          warnings.push(`Failed to import integration delivery failure ${df.id}: ${err}`);
        }
      }
    }

    const counts = {
      sessions: sessionsCount,
      webhooks: webhooksCount,
      messages: messagesCount,
      messageBatches: messageBatchesCount,
      templates: templatesCount,
      baileysStoredMessages: baileysStoredMessagesCount,
      lidMappings: lidMappingsCount,
      pluginInstances: pluginInstancesCount,
      conversationMappings: conversationMappingsCount,
      ingressEvents: ingressEventsCount,
      webhookDeliveryFailures: webhookDeliveryFailuresCount,
      integrationDeliveryFailures: integrationDeliveryFailuresCount,
    };

    // "Replace all data" must be all-or-nothing: the import already DELETEd every row, so if any
    // INSERT failed we must roll back (restoring the pre-import data) rather than commit a
    // half-wiped DB and report success. A partial restore reported as imported:true was how
    // message history could silently vanish on a SQLite->Postgres migration.
    if (warnings.length > 0) {
      await queryRunner.rollbackTransaction();
      return { imported: false, counts, warnings };
    }

    // A wrong/empty/garbage backup file restores zero rows but the DELETE already ran — committing
    // would silently WIPE the database and report success. Refuse it and roll back instead. (#488 review)
    const totalRestored = Object.values(counts).reduce((sum, n) => sum + n, 0);
    if (totalRestored === 0) {
      await queryRunner.rollbackTransaction();
      return {
        imported: false,
        counts,
        warnings: ['Backup contained no rows to restore; refused to replace existing data. Check the file.'],
      };
    }

    await queryRunner.commitTransaction();
    return { imported: true, counts, warnings };
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    await queryRunner.release();
  }
}

// ============================================================================
// STORAGE MIGRATION API
// ============================================================================
