import { Webhook } from './entities/webhook.entity';
import { generateIdempotencyKey, generateDeliveryId } from './utils/idempotency.util';
import { withSafeFetch, isSsrfProtectionEnabled, redactSsrfError } from '../../common/security/ssrf-guard';
import { WebhookPayload, WebhookJobData } from './webhook.types';
import {
  WebhookDeliveryDeps,
  deliverWebhookDirect,
  sanitizeCustomHeaders,
  generateSignature,
} from './webhook-delivery';

export type { WebhookDeliveryDeps } from './webhook-delivery';
export { sanitizeCustomHeaders, generateSignature } from './webhook-delivery';

/** Deliver one matching webhook: run the before-hook, then queue (with direct fallback) or deliver
 *  directly. Behavior-identical extraction of WebhookService.dispatch's per-webhook inner unit. */
export async function deliverToWebhook(
  deps: WebhookDeliveryDeps,
  webhook: Webhook,
  ctx: { event: string; sessionId: string; baseIdempotencyKey: string; data: Record<string, unknown> },
): Promise<void> {
  const { event, sessionId, baseIdempotencyKey, data } = ctx;
  const { hookManager, logger } = deps;

  // Generate unique delivery ID for each webhook
  const deliveryId = generateDeliveryId();

  // Salt the base key with webhook.id so two DISTINCT webhooks subscribed to the same event (e.g.
  // duplicate URLs) get DISTINCT idempotency keys — otherwise a receiver dedup'ing purely on the
  // header would drop the sibling delivery as a replay. webhook.id is constant across retries of
  // THIS webhook (incl. the queue-add→direct fallback), so its key stays stable.
  const idempotencyKey = `${baseIdempotencyKey}_${webhook.id}`;

  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    sessionId,
    idempotencyKey,
    deliveryId,
    // Give each webhook its own copy of the event data: a webhook:before hook that mutates
    // payload.data in place would otherwise bleed that change into every later webhook for this
    // event (they all shared one object reference).
    data: structuredClone(data),
  };

  // Execute hook before webhook dispatch - plugins can modify payload
  const { continue: shouldContinue, data: hookResult } = await hookManager.execute(
    'webhook:before',
    { sessionId, event, payload },
    { sessionId, source: 'WebhookService' },
  );

  if (!shouldContinue) {
    logger.debug(`Webhook dispatch cancelled by plugin for ${event}`, {
      webhookId: webhook.id,
      action: 'webhook_cancelled_by_plugin',
    });
    return;
  }

  // Use the plugin-modified payload, falling back to the original if a before-hook returned a
  // result without a `payload` key — otherwise we'd POST an `undefined` body.
  const finalPayload = (hookResult as { payload?: WebhookPayload }).payload ?? payload;

  // The idempotency + delivery ids are server-generated and are the documented dedup key
  // (receivers dedupe on the X-OpenWA-Idempotency-Key header). Re-assert them onto the post-hook
  // payload so a webhook:before plugin can't desync the signed body field from the header.
  finalPayload.idempotencyKey = idempotencyKey;
  finalPayload.deliveryId = deliveryId;

  // Build headers — custom headers FIRST so the system headers below always win.
  const headers: Record<string, string> = {
    ...sanitizeCustomHeaders(webhook.headers),
    'Content-Type': 'application/json',
    'User-Agent': 'OpenWA-Webhook/1.0.0',
    'X-OpenWA-Event': event,
    'X-OpenWA-Idempotency-Key': idempotencyKey,
    'X-OpenWA-Delivery-Id': deliveryId,
    'X-OpenWA-Retry-Count': '0',
  };

  // Use queue if available, otherwise fallback to direct delivery
  if (deps.queueEnabled && deps.webhookQueue) {
    try {
      // finalPayload comes from the (untrusted) webhook:before hook result, so JSON.stringify can
      // throw (BigInt / circular). Keep serialization + signing INSIDE the try so a poisoned payload
      // is caught here (one webhook dropped + logged) instead of aborting the whole dispatch loop
      // and rejecting the fire-and-forget dispatch() promise.
      const signature = webhook.secret ? generateSignature(JSON.stringify(finalPayload), webhook.secret) : '';

      if (webhook.secret) {
        headers['X-OpenWA-Signature'] = signature;
      }

      const jobData: WebhookJobData = {
        webhookId: webhook.id,
        url: webhook.url,
        event,
        payload: finalPayload,
        headers,
        attempt: 1,
        maxRetries: webhook.retryCount,
      };

      await deps.webhookQueue.add(`webhook-${webhook.id}`, jobData, {
        attempts: webhook.retryCount,
        backoff: {
          type: 'exponential',
          delay: deps.configService.get<number>('webhook.retryDelay', 5000),
        },
      });

      // Execute hook after successful queue (NOT delivery - that happens in processor)
      await hookManager.execute(
        'webhook:queued',
        { sessionId, event, webhookId: webhook.id, deliveryId },
        { sessionId, source: 'WebhookService' },
      );

      logger.debug(`Webhook job queued for ${webhook.id}`, {
        webhookId: webhook.id,
        event,
        idempotencyKey,
        deliveryId,
        action: 'webhook_queued',
      });
    } catch (error) {
      // Execute hook on queue error (not delivery error - that happens in processor)
      await hookManager.execute(
        'webhook:error',
        { sessionId, event, webhookId: webhook.id, error: `Queue failed: ${String(error)}` },
        { sessionId, source: 'WebhookService' },
      );

      logger.error(`Failed to queue webhook ${webhook.id}`, String(error), {
        webhookId: webhook.id,
        action: 'webhook_queue_failed',
      });

      // Fallback: deliver directly when the queue add failed (e.g. Redis unreachable with the
      // producer's enableOfflineQueue:false). This is at-least-once — if add() actually reached
      // Redis before rejecting, the queued job AND this fallback may both POST. Both paths carry the
      // same X-OpenWA-Idempotency-Key / X-OpenWA-Delivery-Id, so a conformant receiver dedupes.
      try {
        await deliverWebhookDirect(deps, webhook, finalPayload, headers);

        await hookManager.execute(
          'webhook:delivered',
          { sessionId, event, webhookId: webhook.id, deliveryId, fallback: 'queue_failed' },
          { sessionId, source: 'WebhookService' },
        );

        await hookManager.execute(
          'webhook:after',
          { sessionId, event, webhookId: webhook.id, success: true, fallback: 'queue_failed' },
          { sessionId, source: 'WebhookService' },
        );
      } catch (fallbackError) {
        await hookManager.execute(
          'webhook:error',
          {
            sessionId,
            event,
            webhookId: webhook.id,
            error: `Queue fallback delivery failed: ${redactSsrfError(fallbackError, logger, 'webhook fallback delivery')}`,
          },
          { sessionId, source: 'WebhookService' },
        );

        logger.error(`Queue fallback delivery failed for webhook ${webhook.id}`, String(fallbackError), {
          webhookId: webhook.id,
          action: 'webhook_queue_fallback_failed',
        });
      }
    }
  } else {
    // Direct delivery when queue is disabled
    try {
      await deliverWebhookDirect(deps, webhook, finalPayload, headers);

      // Execute hook after successful delivery
      await hookManager.execute(
        'webhook:delivered',
        { sessionId, event, webhookId: webhook.id, deliveryId },
        { sessionId, source: 'WebhookService' },
      );

      // Legacy hook for backward compatibility
      await hookManager.execute(
        'webhook:after',
        { sessionId, event, webhookId: webhook.id, success: true },
        { sessionId, source: 'WebhookService' },
      );
    } catch (error) {
      // Execute hook on error
      await hookManager.execute(
        'webhook:error',
        { sessionId, event, webhookId: webhook.id, error: redactSsrfError(error, logger, 'webhook delivery') },
        { sessionId, source: 'WebhookService' },
      );

      logger.error(`Failed to deliver webhook ${webhook.id}`, String(error), {
        webhookId: webhook.id,
        action: 'webhook_delivery_failed',
      });
    }
  }
}

/** Send a synthetic `test` payload to a webhook and report the outcome. Never persists a failure
 *  record; a delivery error is caught and returned as `{ success: false, error }`. */
export async function testWebhook(
  deps: Pick<WebhookDeliveryDeps, 'configService' | 'logger'>,
  webhook: Webhook,
  sessionId: string,
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  const testPayload: WebhookPayload = {
    event: 'test',
    timestamp: new Date().toISOString(),
    sessionId,
    idempotencyKey: generateIdempotencyKey('test', { webhookId: webhook.id }),
    deliveryId: generateDeliveryId(),
    data: {
      message: 'This is a test webhook from OpenWA',
      webhookId: webhook.id,
      url: webhook.url,
    },
  };

  const body = JSON.stringify(testPayload);
  const headers: Record<string, string> = {
    // Custom headers FIRST so the system headers below always win.
    ...sanitizeCustomHeaders(webhook.headers),
    'Content-Type': 'application/json',
    'User-Agent': 'OpenWA-Webhook/1.0.0',
    'X-OpenWA-Event': 'test',
    'X-OpenWA-Idempotency-Key': testPayload.idempotencyKey,
    'X-OpenWA-Delivery-Id': testPayload.deliveryId,
    'X-OpenWA-Retry-Count': '0',
  };

  if (webhook.secret) {
    headers['X-OpenWA-Signature'] = generateSignature(body, webhook.secret);
  }

  try {
    return await withSafeFetch(
      webhook.url,
      {
        method: 'POST',
        headers,
        body,
        // Use the configured WEBHOOK_TIMEOUT (single source of truth across queued/test/direct paths).
        signal: AbortSignal.timeout(deps.configService.get<number>('webhook.timeout', 10000)),
      },
      response => ({ success: response.ok, statusCode: response.status }),
      { guard: isSsrfProtectionEnabled() },
    );
  } catch (error) {
    return {
      success: false,
      error: redactSsrfError(error, deps.logger, 'webhook test'),
    };
  }
}
