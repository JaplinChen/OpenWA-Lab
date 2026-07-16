import { MessageMedia, type Message } from 'whatsapp-web.js';
import { IncomingMessage } from '../interfaces/whatsapp-engine.interface';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import {
  capInboundMedia,
  coerceDeclaredSize,
  inboundMediaMaxBytes,
  inboundMediaTimeoutMs,
  isMediaDownloadEnabled,
  withInboundDownloadTimeout,
} from './inbound-media-cap';

interface InboundMediaLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** Collaborators for the inbound media cap. Both are constructor-stable on the adapter (the limiter
 *  must be the SAME instance so its concurrency bound is shared across all inbound downloads). */
export interface InboundMediaCtx {
  logger: InboundMediaLogger;
  inboundLimiter: ConcurrencyLimiter;
}

/**
 * Download inbound media safely. downloadMedia() can't be size-bounded at the source, so (1) pre-gate
 * on the sender-declared size and skip the download entirely when it exceeds the cap, and (2) run the
 * download through the concurrency limiter for backpressure. Returns undefined when there's no media.
 */
export async function capInboundMediaFor(
  ctx: InboundMediaCtx,
  msg: Message,
): Promise<IncomingMessage['media'] | undefined> {
  if (!isMediaDownloadEnabled()) {
    const data = (msg as unknown as { _data?: { size?: number; mimetype?: string; filename?: string } })._data;
    return {
      mimetype: data?.mimetype ?? '',
      filename: data?.filename || undefined,
      omitted: true,
      sizeBytes: coerceDeclaredSize(data?.size),
    };
  }
  const maxBytes = inboundMediaMaxBytes();
  const data = (msg as unknown as { _data?: { size?: number; mimetype?: string; filename?: string } })._data;
  const declared = coerceDeclaredSize(data?.size);
  if (declared > maxBytes) {
    ctx.logger.warn('Inbound media declared size exceeds MEDIA_DOWNLOAD_MAX_BYTES; skipped download', {
      msgId: msg.id._serialized,
      sizeBytes: declared,
    });
    return {
      mimetype: data?.mimetype ?? '',
      filename: data?.filename || undefined,
      omitted: true,
      sizeBytes: declared,
    };
  }
  // msg.downloadMedia() can't be aborted, so freeing the slot the moment the wall-clock deadline fires
  // would admit a fresh download while the abandoned one is still materialising in heap — letting the
  // number of in-flight downloads exceed inboundMediaConcurrency(). Instead, HOLD the slot until the real
  // download settles; the caller still unblocks on the timeout race and emits the message without media.
  // boundedReady adopts the timeout-bounded race (a Promise resolving a Promise flattens), so awaiting it
  // unblocks the caller once the task is admitted AND the deadline-or-download settles — yielding the
  // media or null on timeout.
  let resolveBounded: (value: MessageMedia | null | PromiseLike<MessageMedia | null>) => void = () => undefined;
  const boundedReady = new Promise<MessageMedia | null>(resolve => {
    resolveBounded = resolve;
  });
  const slotHeld = ctx.inboundLimiter.run(() => {
    const download = msg.downloadMedia();
    resolveBounded(
      withInboundDownloadTimeout(download, inboundMediaTimeoutMs(), () =>
        ctx.logger.warn(
          'Inbound media download timed out (MEDIA_DOWNLOAD_TIMEOUT_MS); emitting message without media',
          {
            msgId: msg.id._serialized,
          },
        ),
      ),
    );
    // Keep the slot occupied until the underlying download truly settles, not the timeout race.
    return download.then(
      () => undefined,
      () => undefined,
    );
  });
  // The slot-holder runs in the background. It only rejects when the limiter's waiter queue is
  // saturated (queue full) — in which case the download task never ran and boundedReady would hang.
  // Resolve null so the caller unblocks and emits the message without media, matching the
  // timeout/byte-cap no-media path. Never let it surface as an unhandled rejection either.
  void slotHeld.catch(() => {
    ctx.logger.warn('Inbound media limiter saturated; emitting message without media', {
      msgId: msg.id._serialized,
    });
    resolveBounded(null);
  });
  const media = await boundedReady;
  if (!media) return undefined;
  const capped = capInboundMedia({
    mimetype: media.mimetype,
    filename: media.filename || undefined,
    sizeBytes: Buffer.byteLength(media.data, 'base64'),
    toBase64: () => media.data,
  });
  if (capped.omitted) {
    ctx.logger.warn('Inbound media exceeds MEDIA_DOWNLOAD_MAX_BYTES; dropped payload, kept envelope', {
      msgId: msg.id._serialized,
      sizeBytes: capped.sizeBytes,
    });
  }
  return capped;
}
