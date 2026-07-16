import type {
  ExportDataResult,
  SessionRow,
  WebhookRow,
  MessageRow,
  MessageBatchRow,
  TemplateRow,
  BaileysStoredMessageRow,
  LidMappingRow,
  PluginInstanceRow,
  ConversationMappingRow,
  IngressEventRow,
  WebhookDeliveryFailureRow,
  IntegrationDeliveryFailureRow,
} from './infra.types';
import type { DataTransferCtx } from './infra-data-transfer.ctx';

export async function exportData(ctx: DataTransferCtx): Promise<ExportDataResult> {
  // Get all entities from Data DB
  const sessions = await ctx.dataDataSource.query<SessionRow[]>('SELECT * FROM sessions');
  const webhooks = await ctx.dataDataSource.query<WebhookRow[]>('SELECT * FROM webhooks');

  // These tables may not exist yet (older DB) or be empty.
  let messages: MessageRow[] = [];
  let messageBatches: MessageBatchRow[] = [];
  let templates: TemplateRow[] = [];
  let baileysStoredMessages: BaileysStoredMessageRow[] = [];
  let lidMappings: LidMappingRow[] = [];
  let pluginInstances: PluginInstanceRow[] = [];
  let conversationMappings: ConversationMappingRow[] = [];
  let ingressEvents: IngressEventRow[] = [];
  let webhookDeliveryFailures: WebhookDeliveryFailureRow[] = [];
  let integrationDeliveryFailures: IntegrationDeliveryFailureRow[] = [];

  try {
    messages = await ctx.dataDataSource.query<MessageRow[]>('SELECT * FROM messages');
  } catch (error) {
    ctx.logger.debug('Messages table not available for export', { error: String(error) });
  }

  try {
    messageBatches = await ctx.dataDataSource.query<MessageBatchRow[]>('SELECT * FROM message_batches');
  } catch (error) {
    ctx.logger.debug('Message batches table not available for export', { error: String(error) });
  }

  try {
    templates = await ctx.dataDataSource.query<TemplateRow[]>('SELECT * FROM templates');
  } catch (error) {
    ctx.logger.debug('Templates table not available for export', { error: String(error) });
  }

  try {
    baileysStoredMessages = await ctx.dataDataSource.query<BaileysStoredMessageRow[]>(
      'SELECT * FROM baileys_stored_messages',
    );
  } catch (error) {
    ctx.logger.debug('Baileys stored messages table not available for export', { error: String(error) });
  }

  try {
    lidMappings = await ctx.dataDataSource.query<LidMappingRow[]>('SELECT * FROM lid_mappings');
  } catch (error) {
    ctx.logger.debug('Lid mappings table not available for export', { error: String(error) });
  }

  // Integration Fabric + both DLQs were added after the original migration set; tolerate a genuinely
  // absent table (older DB) like the tables above rather than 500-ing the whole export.
  try {
    pluginInstances = await ctx.dataDataSource.query<PluginInstanceRow[]>('SELECT * FROM plugin_instances');
  } catch (error) {
    ctx.logger.debug('plugin_instances table not available for export', { error: String(error) });
  }
  try {
    conversationMappings = await ctx.dataDataSource.query<ConversationMappingRow[]>(
      'SELECT * FROM conversation_mappings',
    );
  } catch (error) {
    ctx.logger.debug('conversation_mappings table not available for export', { error: String(error) });
  }
  try {
    ingressEvents = await ctx.dataDataSource.query<IngressEventRow[]>('SELECT * FROM ingress_events');
  } catch (error) {
    ctx.logger.debug('ingress_events table not available for export', { error: String(error) });
  }
  try {
    webhookDeliveryFailures = await ctx.dataDataSource.query<WebhookDeliveryFailureRow[]>(
      'SELECT * FROM webhook_delivery_failures',
    );
  } catch (error) {
    ctx.logger.debug('webhook_delivery_failures table not available for export', { error: String(error) });
  }
  try {
    integrationDeliveryFailures = await ctx.dataDataSource.query<IntegrationDeliveryFailureRow[]>(
      'SELECT * FROM integration_delivery_failures',
    );
  } catch (error) {
    ctx.logger.debug('integration_delivery_failures table not available for export', { error: String(error) });
  }

  return {
    exportedAt: new Date().toISOString(),
    dataDbType: ctx.configService.get<string>('dataDatabase.type', 'sqlite'),
    tables: {
      sessions,
      webhooks,
      messages,
      messageBatches,
      templates,
      baileysStoredMessages,
      lidMappings,
      pluginInstances,
      conversationMappings,
      ingressEvents,
      webhookDeliveryFailures,
      integrationDeliveryFailures,
    },
    counts: {
      sessions: sessions.length,
      webhooks: webhooks.length,
      messages: messages.length,
      messageBatches: messageBatches.length,
      templates: templates.length,
      baileysStoredMessages: baileysStoredMessages.length,
      lidMappings: lidMappings.length,
      pluginInstances: pluginInstances.length,
      conversationMappings: conversationMappings.length,
      ingressEvents: ingressEvents.length,
      webhookDeliveryFailures: webhookDeliveryFailures.length,
      integrationDeliveryFailures: integrationDeliveryFailures.length,
    },
  };
}
