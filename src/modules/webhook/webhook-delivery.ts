import * as crypto from 'crypto';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Webhook } from './entities/webhook.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { recordWebhookDeliveryFailure, statusCodeFromError } from './utils/record-delivery-failure';
import { incrementWebhookDeliveryFailures } from '../../common/metrics/webhook-delivery-metrics';
import { HookManager } from '../../core/hooks';
import { withSafeFetch, isSsrfProtectionEnabled, redactSsrfError } from '../../common/security/ssrf-guard';
import { WebhookPayload, WebhookJobData } from './webhook.types';

export interface DispatchLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string): void;
  error(message: string, error?: string, meta?: Record<string, unknown>): void;
}

/** Everything the delivery engine needs, threaded from WebhookService so `queueEnabled` and the
 *  optional queue are read live (a test toggling service.queueEnabled still steers the path). */
export interface WebhookDeliveryDeps {
  queueEnabled: boolean;
  webhookQueue?: Queue<WebhookJobData>;
  webhookRepository: Repository<Webhook>;
  failureRepository: Repository<WebhookDeliveryFailure>;
  hookManager: HookManager;
  configService: ConfigService;
  logger: DispatchLogger;
}

/**
 * Drop operator-supplied custom headers that target reserved names (Content-Type or any X-OpenWA-*
 * header) so a webhook config cannot forge the signature/event/idempotency headers. Spread the result
 * BEFORE the system headers so system always wins.
 */
export function sanitizeCustomHeaders(custom: Record<string, string> | null | undefined): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(custom ?? {})) {
    if (!/^(content-type|x-openwa-)/i.test(key)) {
      safe[key] = value;
    }
  }
  return safe;
}

export function generateSignature(payload: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  return `sha256=${hmac.digest('hex')}`;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * @deprecated Use job queue dispatch instead. This is kept for fallback.
 * Direct HTTP delivery with in-process retry/backoff; persists a durable failure record when the
 * direct-path retries are exhausted (mirrors the queued processor's final-attempt path).
 */
export async function deliverWebhookDirect(
  deps: WebhookDeliveryDeps,
  webhook: Webhook,
  payload: WebhookPayload,
  headers: Record<string, string>,
  attempt = 1,
): Promise<void> {
  const { configService, webhookRepository, failureRepository, logger } = deps;
  const body = JSON.stringify(payload);

  // Update retry count header
  headers['X-OpenWA-Retry-Count'] = String(attempt - 1);

  // Add signature if secret is configured and not already present
  if (webhook.secret && !headers['X-OpenWA-Signature']) {
    headers['X-OpenWA-Signature'] = generateSignature(body, webhook.secret);
  }

  try {
    const { ok, status, statusText } = await withSafeFetch(
      webhook.url,
      {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(configService.get<number>('webhook.timeout', 10000)),
      },
      response => ({ ok: response.ok, status: response.status, statusText: response.statusText }),
      { guard: isSsrfProtectionEnabled() },
    );

    if (!ok) {
      throw new Error(`HTTP ${status}: ${statusText}`);
    }

    // Update last triggered timestamp
    await webhookRepository.update(webhook.id, {
      lastTriggeredAt: new Date(),
    });

    logger.debug(`Webhook delivered to ${webhook.id}`, {
      webhookId: webhook.id,
      deliveryId: payload.deliveryId,
      action: 'webhook_delivered',
    });
  } catch (error) {
    logger.error(`Webhook delivery failed for ${webhook.id}`, String(error), {
      webhookId: webhook.id,
      attempt,
      deliveryId: payload.deliveryId,
      action: 'webhook_delivery_failed',
    });

    if (attempt < webhook.retryCount) {
      const delayMs = configService.get<number>('webhook.retryDelay', 5000);
      await delay(delayMs * attempt);
      return deliverWebhookDirect(deps, webhook, payload, headers, attempt + 1);
    }
    // All direct-path retries exhausted — persist a durable failure record before giving up, mirroring
    // the queued processor's final-attempt path so the queue-disabled path isn't a blind spot.
    const errMessage = redactSsrfError(error);
    await recordWebhookDeliveryFailure(failureRepository, logger, {
      webhookId: webhook.id,
      sessionId: payload.sessionId,
      event: payload.event,
      url: webhook.url,
      idempotencyKey: payload.idempotencyKey,
      deliveryId: payload.deliveryId,
      attempts: attempt,
      lastStatusCode: statusCodeFromError(errMessage),
      lastError: errMessage,
    });
    incrementWebhookDeliveryFailures();
    throw error;
  }
}
