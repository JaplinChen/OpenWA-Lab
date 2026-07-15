import { BatchStatus, BatchProgress, MessageBatch } from './entities/message-batch.entity';
import { SsrfBlockedError, SSRF_BLOCKED_CLIENT_MESSAGE } from '../../common/security/ssrf-guard';
import { renderTemplate } from '../../common/utils/template-render';
import { IWhatsAppEngine, MessageResult } from '../../engine/interfaces/whatsapp-engine.interface';

// Type definitions for bulk message content
export interface BulkMessageContent {
  text?: string;
  caption?: string;
  image?: { url?: string; base64?: string; mimetype?: string; filename?: string };
  video?: { url?: string; base64?: string; mimetype?: string; filename?: string };
  audio?: { url?: string; base64?: string; mimetype?: string; filename?: string; ptt?: boolean };
  document?: { url?: string; base64?: string; mimetype?: string; filename?: string };
}

/**
 * Resolve a batch's terminal status, in precedence order:
 *  - cancelled (cancelBatch flipped the flag) → CANCELLED. Must win over the in-memory PROCESSING
 *    status set at the start of processBatch, which would otherwise be saved back over the cancellation.
 *  - stopped on the first error (stopOnError) → FAILED, even if some messages were already sent.
 *  - otherwise → COMPLETED, or FAILED only when every attempt failed.
 */
export function resolveFinalBatchStatus(
  cancelled: boolean,
  stoppedOnError: boolean,
  progress: Pick<BatchProgress, 'sent' | 'failed'>,
): BatchStatus {
  if (cancelled) return BatchStatus.CANCELLED;
  if (stoppedOnError) return BatchStatus.FAILED;
  return progress.failed > 0 && progress.sent === 0 ? BatchStatus.FAILED : BatchStatus.COMPLETED;
}

/**
 * Build the error stored on a batch result. An SSRF block names the internal host/IP it refused, so
 * it must never be persisted/returned verbatim — it would be readable via GET batch status. Map it to
 * a generic, code-tagged message; ordinary errors keep their (non-sensitive) message.
 */
export function sanitizeBatchError(error: unknown): { code: string; message: string } {
  if (error instanceof SsrfBlockedError) {
    return { code: 'SEND_BLOCKED', message: SSRF_BLOCKED_CLIENT_MESSAGE };
  }
  return { code: 'SEND_FAILED', message: error instanceof Error ? error.message : String(error) };
}

/**
 * Per-process cap on concurrently-processing bulk batches. Each in-flight batch holds its full message
 * set (with base64 media) in memory and is dispatched fire-and-forget, so without a ceiling a burst of
 * batches can exhaust host memory. Env-overridable; 0 disables the cap. Default is generous — it only
 * trips a genuine runaway, not normal use. Per-process (not cluster-wide).
 */
const DEFAULT_MAX_CONCURRENT_BATCHES = 50;
export function resolveMaxConcurrentBatches(): number {
  const raw = Number(process.env.BULK_MAX_CONCURRENT_BATCHES);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MAX_CONCURRENT_BATCHES;
  return Math.floor(raw); // 0 = unlimited
}

/** Recursively substitute `{{name}}`/`{name}` template variables through a bulk message's content. */
export function applyVariables(content: BulkMessageContent, variables?: Record<string, string>): BulkMessageContent {
  if (!variables) return content;

  // Delegate to the shared renderer so the gateway exposes one templating syntax (#69). It
  // substitutes canonical `{{name}}` placeholders and still honors the legacy single-brace
  // `{name}` this endpoint historically used (deprecated — prefer `{{name}}`).
  const replaceVars = (str: string): string => renderTemplate(str, variables);

  const processValue = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return replaceVars(value);
    }
    if (Array.isArray(value)) {
      return value.map(processValue);
    }
    if (typeof value === 'object' && value !== null) {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = processValue(v);
      }
      return result;
    }
    return value;
  };

  return processValue(content) as BulkMessageContent;
}

/** Dispatch one bulk message to the engine by type, applying per-type mimetype defaults. */
export function sendBulkMessage(
  engine: IWhatsAppEngine,
  chatId: string,
  type: string,
  content: BulkMessageContent,
): Promise<MessageResult> {
  switch (type) {
    case 'text':
      return engine.sendTextMessage(chatId, content.text || '');
    case 'image':
      return engine.sendImageMessage(chatId, {
        mimetype: content.image?.mimetype || 'image/jpeg',
        data: content.image?.url || content.image?.base64 || '',
        caption: content.caption,
      });
    case 'video':
      return engine.sendVideoMessage(chatId, {
        mimetype: content.video?.mimetype || 'video/mp4',
        data: content.video?.url || content.video?.base64 || '',
        caption: content.caption,
      });
    case 'audio':
      return engine.sendAudioMessage(chatId, {
        mimetype: content.audio?.mimetype || (content.audio?.ptt ? 'audio/ogg; codecs=opus' : 'audio/mpeg'),
        data: content.audio?.url || content.audio?.base64 || '',
        ptt: content.audio?.ptt,
      });
    case 'document':
      return engine.sendDocumentMessage(chatId, {
        mimetype: content.document?.mimetype || 'application/octet-stream',
        data: content.document?.url || content.document?.base64 || '',
        filename: content.document?.filename,
        caption: content.caption,
      });
    default:
      return Promise.reject(new Error(`Unsupported message type: ${type}`));
  }
}

export function calculateDelay(options: { delayBetweenMessages: number; randomizeDelay: boolean }): number {
  let delay = options.delayBetweenMessages;
  if (options.randomizeDelay) {
    delay += Math.random() * 2000; // Add 0-2 seconds random
  }
  return delay;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Drop base64 payloads from a finished batch's stored message list. A completed/cancelled batch is
 * terminal (never resumed), so the (often multi-MB) base64 in `message_batches.messages` is dead
 * weight; the descriptive fields (mimetype/filename/caption/url) are kept.
 */
export function stripBatchMediaPayloads(messages: MessageBatch['messages']): void {
  for (const m of messages) {
    for (const key of ['image', 'video', 'audio', 'document']) {
      const media = m.content[key] as { base64?: unknown } | undefined;
      if (media && typeof media === 'object' && 'base64' in media) {
        delete media.base64;
      }
    }
  }
}
