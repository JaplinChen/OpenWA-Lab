import * as fs from 'fs';
import type * as BaileysLib from '@whiskeysockets/baileys';
import type { WASocket } from '@whiskeysockets/baileys';

// Connection/lifecycle decisions + config for BaileysAdapter. Deliberately excludes the socket
// assignment and the connection.update state machine: those mutate the adapter's live `sock`/`status`/
// timer fields with load-bearing ordering, so they stay in the adapter.

interface ConnectionLogger {
  log(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** Every `sock.ev` event the adapter subscribes to — the teardown must detach exactly these. */
const BAILEYS_SOCK_EVENTS = [
  'connection.update',
  'creds.update',
  'messages.upsert',
  'messages.update',
  'contacts.upsert',
  'contacts.update',
  'chats.upsert',
  'chats.update',
  'messaging-history.set',
  'lid-mapping.update',
] as const;

/**
 * Tear down a superseded socket before a reconnect overwrites it. An internal reconnect replaces the
 * socket WITHOUT going through disconnect/logout/destroy, so the previous WebSocket and its listeners
 * would leak on every reconnect. Detach `connection.update` (and the rest) BEFORE end(): Baileys' own
 * end() synchronously emits a synthetic connection.update {connection:'close'}, which — if still wired —
 * would re-enter the handler and schedule a spurious second reconnect.
 */
export function detachAndEndSocket(previous: WASocket | null | undefined): void {
  if (!previous) {
    return;
  }
  try {
    for (const event of BAILEYS_SOCK_EVENTS) {
      previous.ev.removeAllListeners(event);
    }
    previous.end(undefined);
  } catch {
    // end() may already have run from Baileys' own close handler — a safe no-op.
  }
}

/** Capped exponential backoff for reconnect attempt `attempt` (1-based). */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** (attempt - 1));
}

/** What the adapter should do about a `connection: 'close'` update. */
export type CloseDecision =
  | { kind: 'intentional' }
  | { kind: 'logged-out' }
  | { kind: 'exhausted' }
  | { kind: 'reconnect'; attempt: number; delayMs: number };

/**
 * Classify a connection close. Pure: the caller applies the state changes.
 * - intentional  -> just mark DISCONNECTED.
 * - logged-out   -> terminal; credentials are dead, so the auth dir must be wiped or the next connect
 *                   silently retries stale creds instead of emitting a fresh QR.
 * - exhausted    -> reconnect budget spent; fail.
 * - reconnect    -> transient drop; retry after `delayMs` as attempt `attempt`.
 *
 * `loggedOutCode` is Baileys' DisconnectReason.loggedOut. It is compared with `===` and NOT
 * undefined-guarded, preserving the original semantics exactly (in practice the lib is always loaded by
 * the time a connection.update can fire, so an undefined-vs-undefined match is unreachable).
 */
export function classifyClose(opts: {
  intentionalClose: boolean;
  statusCode?: number;
  loggedOutCode?: number;
  reconnectAttempts: number;
  maxAttempts: number;
}): CloseDecision {
  if (opts.intentionalClose) {
    return { kind: 'intentional' };
  }
  if (opts.statusCode === opts.loggedOutCode) {
    return { kind: 'logged-out' };
  }
  if (opts.reconnectAttempts >= opts.maxAttempts) {
    return { kind: 'exhausted' };
  }
  const attempt = opts.reconnectAttempts + 1;
  return { kind: 'reconnect', attempt, delayMs: reconnectDelayMs(attempt) };
}

/**
 * Wipe the multi-file auth dir after a logout. Best-effort: a failure is logged, never thrown, since it
 * runs off the connection.update path. `force` makes a missing dir a no-op.
 */
export async function clearAuthState(authPath: string, logger: ConnectionLogger): Promise<void> {
  try {
    await fs.promises.rm(authPath, { recursive: true, force: true });
    logger.log('Cleared Baileys auth state', { authPath });
  } catch (err) {
    logger.warn('Failed to clear Baileys auth state', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Build the Baileys socket config. Split out as pure config so the adapter's connect path is just
 * lifecycle: load lib -> auth state -> build options -> create -> assign -> wire listeners.
 */
export function buildSocketOptions(opts: {
  state: Awaited<ReturnType<typeof BaileysLib.useMultiFileAuthState>>['state'];
  version: Awaited<ReturnType<typeof BaileysLib.fetchLatestBaileysVersion>>['version'];
  browser: [string, string, string];
  logger: Parameters<typeof BaileysLib.default>[0]['logger'];
  getMessage: NonNullable<Parameters<typeof BaileysLib.default>[0]['getMessage']>;
}): Parameters<typeof BaileysLib.default>[0] {
  return {
    auth: opts.state,
    version: opts.version,
    browser: opts.browser,
    printQRInTerminal: false,
    // Enable the initial sync. Baileys defaults `shouldSyncHistoryMessage` to `() => !!syncFullHistory`,
    // so leaving both unset disables ALL history + app-state sync - no contacts, chats, recent history,
    // or lid->phone mappings ever arrive (the address-book app-state sync only runs once history sync is
    // enabled; see WhiskeySockets/Baileys Socket/index.js + Socket/chats.js). Returning true enables it
    // while keeping the full-archive download opt-in: with syncFullHistory false WhatsApp sends the
    // RECENT window + the full contact/app-state snapshot, not the entire message history.
    shouldSyncHistoryMessage: () => true,
    syncFullHistory: process.env.BAILEYS_SYNC_FULL_HISTORY === 'true',
    // Baileys defaults this to `async () => undefined` (Defaults/index.js). Without a real
    // implementation, WhatsApp's message-retry protocol — triggered whenever a recipient's client
    // fails to decrypt on the first attempt — has nothing to resend, so the recipient is stuck on
    // "waiting for this message" indefinitely instead of the retry resolving it within seconds.
    getMessage: opts.getMessage,
    logger: opts.logger,
  };
}
