import { MessageMedia, type Message } from 'whatsapp-web.js';
import { DeliveryStatus } from '../interfaces/whatsapp-engine.interface';
import { GroupMetadataRaw } from '../types/whatsapp-web-js.types';
import { loadRemoteMediaBuffer } from '../../common/media/load-remote-media';

// Pure helpers for WhatsAppWebJsAdapter — no adapter/client state. Split out of
// whatsapp-web-js.adapter.ts and re-exported from there so importers/spec resolve unchanged.

/**
 * Map a whatsapp-web.js MessageAck integer to the neutral DeliveryStatus.
 * wwebjs: -1 ERROR, 0 PENDING, 1 SERVER (sent), 2 DEVICE (delivered), 3 READ, 4 PLAYED.
 * PLAYED collapses to `read` (preserving prior behaviour, which treated ack>=3 as read).
 */
export function wwebjsAckToDeliveryStatus(ack: number): DeliveryStatus {
  if (ack < 0) return 'failed';
  if (ack >= 3) return 'read';
  if (ack === 2) return 'delivered';
  if (ack === 1) return 'sent';
  return 'pending';
}

/**
 * Extract call detail from a whatsapp-web.js `call_log` message, or `undefined` for any other type.
 * The public Message wrapper doesn't expose call fields, so we read them off the raw `_data`. An
 * incoming call (`!fromMe`) with no recorded `callDuration` was never answered → missed; an outgoing
 * call is never "missed". Used by getChatHistory, where `call_log` entries actually appear.
 */
export function extractWwebjsCall(msg: Message): { video: boolean; missed: boolean } | undefined {
  if ((msg.type as string) !== 'call_log') return undefined;
  const d = (msg as unknown as { _data?: { isVideoCall?: boolean; callDuration?: number } })._data ?? {};
  return { video: Boolean(d.isVideoCall), missed: !msg.fromMe && !d.callDuration };
}

/**
 * Whether a per-session proxy URL parses to a supported scheme — defense-in-depth for a stored proxy
 * that bypassed DTO validation (e.g. loaded from the DB on restart). The host is NOT SSRF-blocked: a
 * per-session proxy is operator-chosen egress, and a loopback proxy sidecar is a legitimate setup.
 */
export function isSupportedProxyUrl(url: string): boolean {
  try {
    return ['http:', 'https:', 'socks4:', 'socks5:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

export interface ProxyLaunchConfig {
  /** Credential-less `--proxy-server` value — Chromium ignores credentials embedded in this flag. */
  serverArg: string;
  /** Username/password for whatsapp-web.js's `proxyAuthentication` (→ `page.authenticate`, HTTP/HTTPS only). */
  proxyAuthentication?: { username: string; password: string };
  /** The URL carries credentials for a SOCKS proxy, which Chromium cannot authenticate at all. */
  socksAuthUnsupported: boolean;
}

/**
 * Split a proxy URL into a credential-less `--proxy-server` value plus, for an HTTP/HTTPS proxy, the
 * username/password to hand to whatsapp-web.js's `proxyAuthentication` (which calls `page.authenticate`
 * — the only way Chromium authenticates a proxy). Credentials embedded in `--proxy-server` are ignored
 * by Chromium, and SOCKS proxies cannot be authenticated at all, so SOCKS credentials are surfaced via
 * `socksAuthUnsupported` for the caller to warn about instead of failing with an opaque nav timeout (#628).
 * Call only with a URL that already passed {@link isSupportedProxyUrl}.
 */
export function buildProxyLaunchConfig(url: string): ProxyLaunchConfig {
  const parsed = new URL(url);
  const serverArg = `${parsed.protocol}//${parsed.host}`;
  const username = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const hasCredentials = username !== '' || password !== '';
  const isSocks = parsed.protocol === 'socks4:' || parsed.protocol === 'socks5:';
  if (hasCredentials && !isSocks) {
    return { serverArg, proxyAuthentication: { username, password }, socksAuthUnsupported: false };
  }
  return { serverArg, socksAuthUnsupported: hasCredentials && isSocks };
}

/**
 * Whether a MediaInput's string `data` is an http(s) URL (to be fetched through the SSRF-guarded
 * loadRemoteMedia) rather than base64. Case-insensitive, matching the Baileys adapter — a mixed-case
 * scheme like `HTTPS://` must still route through the guarded fetch, not be treated as base64.
 */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Detect Puppeteer's "Execution context was destroyed" error. During `Client.inject()` this is most
 * often a persistent browser profile left stale by an OpenWA upgrade that changed the Chromium/Chrome
 * binary (e.g. the v0.8.12 amd64 Debian Chromium → Chrome for Testing switch, #663 / #708) — but it is
 * not exclusively that: Puppeteer also raises it on a page navigation or a renderer crash (see
 * puppeteer-core `ExecutionContext` / `IsolatedWorld`), so the caller advises rather than asserts.
 * Pure so the detection is unit-testable without mocking the whatsapp-web.js `Client`.
 */
export function isExecutionContextDestroyedError(reason: string): boolean {
  return /execution context was destroyed/i.test(reason);
}

/**
 * Fetch remote media for sending, with an SSRF host guard, a byte cap, and a timeout.
 * The guard runs BEFORE any network call, so an internal/reserved URL throws `SsrfBlockedError`
 * and no outbound socket is opened. The byte cap (node-fetch `size`) and `AbortSignal` timeout
 * bound memory use and hang time. `unsafeMime` is left at its default (false) to preserve the
 * existing MIME-detection behavior.
 */
export async function loadRemoteMedia(url: string): Promise<MessageMedia> {
  // Fetch through the SSRF-pinned path: it validates the host, pins the connection to the vetted IP
  // (so a DNS rebind can't redirect it to an internal target between check and connect), caps bytes,
  // and refuses redirects. We then build the MessageMedia from the returned bytes — NOT via
  // MessageMedia.fromUrl, whose bundled node-fetch performs its own unpinned DNS re-resolution.
  const { data, mimetype } = await loadRemoteMediaBuffer(url);
  const filename = new URL(url).pathname.split('/').pop() || undefined;
  return new MessageMedia(mimetype || 'application/octet-stream', data.toString('base64'), filename);
}

/**
 * Optional override for whatsapp-web.js's initial boot/inject wait (#353). On slow first boots
 * (e.g. WSL2 or low-resource containers) the default 30s `authTimeoutMs` can expire before WhatsApp
 * Web finishes loading, aborting QR generation. Set WWEBJS_AUTH_TIMEOUT_MS to a larger value in
 * milliseconds (e.g. 120000) to extend it. Unset, or a value that is not a positive safe integer,
 * keeps the whatsapp-web.js default (30000ms).
 */
export function resolveAuthTimeoutMs(): number | undefined {
  const raw = process.env.WWEBJS_AUTH_TIMEOUT_MS?.trim();
  if (!raw || !/^\d+$/.test(raw)) {
    return undefined;
  }
  const ms = Number(raw);
  // Number.isSafeInteger rejects Infinity (from huge digit strings) and >2^53 unsafe integers — both
  // pass the /^\d+$/ shape check but would make whatsapp-web.js's inject loop wait effectively forever.
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
}

/**
 * Extracts the JID of the parent community a group is linked to, if any.
 * The field name has varied across whatsapp-web.js/WA Web versions, so
 * known candidates are checked in order.
 */
export function extractLinkedParentJID(groupMetadata?: GroupMetadataRaw): string | null {
  const candidate =
    groupMetadata?.parentGroup ?? groupMetadata?.linkedParentGroup ?? groupMetadata?.linkedParent ?? null;

  if (!candidate) {
    return null;
  }

  if (typeof candidate === 'string') {
    return candidate;
  }

  return candidate._serialized ?? null;
}

/**
 * True when a send error is whatsapp-web.js's "recipient needs a LID we don't have" failure, raised
 * when sending to a `@c.us` for a contact WhatsApp has migrated to `@lid`.
 * ponytail: matched on the wwjs error text — there is no structured code; revisit if wwjs changes it.
 */
export function isNoLidForUserError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('No LID for user');
}
