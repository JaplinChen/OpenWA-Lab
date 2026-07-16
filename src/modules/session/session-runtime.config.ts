import { ConfigService } from '@nestjs/config';

// Session runtime config + bounds: the coerce/clamp layer over the OPERATOR-supplied session.config,
// plus the init-timeout marker error. Split out of session.service.ts; re-exported from there so
// importers and both specs (session.service.spec, reconnect-config.spec) resolve unchanged.

// Reconnect-backoff bounds. An OPERATOR-supplied session.config feeds this math, so the values
// are coerced + clamped: a non-numeric value would otherwise make the delay NaN (setTimeout fires
// at 0 — relaunch storm) and the terminal guard `attempts >= NaN` always false (unbounded loop).
const RECONNECT_BASE_DELAY_MIN_MS = 1000;
const RECONNECT_BASE_DELAY_MAX_MS = 300_000;
const RECONNECT_MAX_ATTEMPTS_CAP = 20;
const RECONNECT_DELAY_CAP_MS = 3_600_000;
/**
 * Delay before retrying an ack UPDATE that matched 0 rows. A fast delivered/read ack can arrive before
 * the send's 2nd save (which writes waMessageId) has committed, so the first UPDATE finds no row. One
 * retry after this delay closes that race; the forward-only transition guard keeps it idempotent.
 */
export const ACK_RECONCILE_DELAY_MS = 750;

const clampNumber = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max);

/** Coerce + clamp the untyped session.config reconnect knobs to finite, bounded values. Defaults
 *  (5000ms / 5 attempts) are preserved; a legitimate `maxReconnectAttempts: 0` (disable) is kept. */
export function resolveReconnectConfig(
  config: { maxReconnectAttempts?: unknown; reconnectBaseDelay?: unknown } | null,
): { maxAttempts: number; baseDelay: number } {
  const baseRaw = Number(config?.reconnectBaseDelay);
  const baseDelay = clampNumber(
    Number.isFinite(baseRaw) ? baseRaw : 5000,
    RECONNECT_BASE_DELAY_MIN_MS,
    RECONNECT_BASE_DELAY_MAX_MS,
  );
  const attemptsRaw = Number(config?.maxReconnectAttempts);
  const maxAttempts = Math.floor(
    clampNumber(Number.isFinite(attemptsRaw) ? attemptsRaw : 5, 0, RECONNECT_MAX_ATTEMPTS_CAP),
  );
  return { maxAttempts, baseDelay };
}

/** Clamp a computed backoff delay finite and within setTimeout's safe range (a huge value would
 *  overflow its 32-bit ms field and fire immediately). */
export function clampReconnectDelay(rawDelay: number, baseDelay: number): number {
  return clampNumber(Number.isFinite(rawDelay) ? rawDelay : baseDelay, 0, RECONNECT_DELAY_CAP_MS);
}

export function resolveMaxConcurrentSessions(configService?: Pick<ConfigService, 'get'>): number | null {
  const configured = configService?.get<number>('sessions.maxConcurrent', 0) ?? 0;
  if (!Number.isFinite(configured) || configured <= 0) return null;
  return Math.floor(configured);
}

/**
 * Distinguishes a wedged-initialization timeout from a real engine.initialize() rejection. Only the
 * timeout case is handled inside initializeEngine(); real rejections must propagate untouched so the
 * caller's catch (start() → FAILED+reason, executeReconnect() → retry) keeps the behavior #600/#631
 * established. See initializeEngine().
 */
export class EngineInitTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`engine.initialize() timed out after ${timeoutMs}ms`);
    this.name = 'EngineInitTimeoutError';
  }
}
