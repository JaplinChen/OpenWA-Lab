/**
 * Integration SDK v1 — inbound webhook ingress declarations and their load-time validation.
 * Split out of plugin.interfaces.ts; re-exported from there so the public SDK surface is unchanged.
 */

import type { PluginManifest } from './plugin.interfaces';
import { PluginCapabilityPermission } from './plugin-capabilities';

/** How an inbound webhook's authenticity is established before the plugin sees it. */
export interface IngressSignatureSpec {
  /**
   * - `hmac-sha256`: HMAC over a `contentTemplate` (tokens `{rawBody}`/`{timestamp}`/`{id}`).
   * - `shared-secret`: constant-time compare of a header value against `instance.secret`.
   * - `standard-webhooks`: host-side [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks)
   *   verify. The wire format is fixed by the spec (headers `webhook-id`/`webhook-timestamp`/
   *   `webhook-signature`, signed content `${webhook-id}.${webhook-timestamp}.${rawBody}`, base64
   *   HMAC-SHA256 with the base64-decoded Svix key, `v1,` prefix, space-separated candidate list), so
   *   `header`/`contentTemplate`/`encoding`/`prefix`/`timestampHeader` are IGNORED — only
   *   `toleranceSec` (default 300) and `dedupHeader` apply. The operator pastes the Svix secret
   *   (`v1,whsec_<base64>`) as `instance.secret`.
   */
  scheme: 'hmac-sha256' | 'shared-secret' | 'standard-webhooks' | 'none';
  header?: string;
  // Template over which the HMAC is computed. `{rawBody}` `{timestamp}` `{id}` placeholders.
  contentTemplate?: string;
  encoding?: 'hex' | 'base64';
  prefix?: string;
  timestampHeader?: string;
  toleranceSec?: number; // when present, must be > 0 (see validateIngressManifest)
  dedupHeader?: string;
}

/** Provider webhook-verification challenge (e.g. a GET handshake on route registration). */
export interface IngressChallengeSpec {
  method: 'GET';
  tokenParam: string;
  echoParam: string;
}

/** A host-side preflight check on an inbound route, evaluated AFTER signature verify and BEFORE the
 *  dedup persist. First failure short-circuits to its mapped HTTP status. O(1), never initializes the
 *  engine, never mutates state. */
export type IngressPreflightCheck = {
  // Reject (503) when the route's concrete-scoped WhatsApp session is not alive (no live engine, or
  // EngineStatus.FAILED). Recoverable statuses (INITIALIZING/QR_READY/AUTHENTICATING/DISCONNECTED) and
  // READY pass through to a normal 202+enqueue so the worker can fail fast and the dedup row holds the
  // delivery. Skipped for wildcard (sessionScope null/'*') scopes — there is no single session to probe.
  type: 'session-alive';
};

/** Declares the synchronous HTTP response an inbound route returns to the provider, computed entirely
 *  host-side. The plugin ALWAYS runs async (enqueued, full DLQ/retry) regardless of this contract. */
export interface IngressResponseContract {
  preflight?: IngressPreflightCheck[];
  ack?: {
    status?: number; // default 202
    body?: string; // literal, or a '{rawBody}'/'{timestamp}'/'{id}' template rendered host-side
    headers?: Record<string, string>; // static; validated at load (HTTP-token name, no CR/LF value)
  };
  deadlineMs?: number; // documented provider ack budget (advisory; not enforced)
}

/** One inbound webhook route a plugin claims. Requires the `webhook:ingress` permission. */
export interface PluginIngressRoute {
  route: string; // host prefixes it; the plugin never binds a port
  /**
   * @deprecated 'sync-reply' is inert dead code since the P0 substrate (#568) and is NOT wired to the
   * HTTP response — the pipeline is always async + fast-ack. Declare synchronous response behavior via
   * `response` instead. Kept in the union only to preserve SDK v1 additive-only compatibility; do not
   * remove within major 1, and do not rely on either value at runtime.
   */
  mode: 'async' | 'sync-reply';
  signature: IngressSignatureSpec;
  challenge?: IngressChallengeSpec;
  verify: 'core' | 'self';
  maxBodyBytes: number;
  // Optional: where the provider's conversation id lives, so the host can compute a per-conversation
  // ordering key (P1). Absent => the P1 lock falls back to per-instance serialization. The host never
  // needs to understand the provider's schema beyond this one pointer.
  conversationId?: { header?: string; jsonPointer?: string };
  /** Optional synchronous-response contract (host-side preflight + ack). Additive; absent = today's
   *  default 202 fast-ack, byte-identical. Validated by validateIngressManifest. */
  response?: IngressResponseContract;
}

/** Integration SDK major version this host supports. A plugin whose `sdkVersion` major differs is refused. */
export const SUPPORTED_SDK_MAJOR = 1;

// ack header guards: name must be an RFC 7230 token (no spaces/separators), value must contain no
// CR/LF (header-injection guard). The header source is the static manifest, validated once at load.
const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HTTP_HEADER_VALUE_NO_CRLF = /^[^\r\n]*$/;

/**
 * Validates a manifest's `ingress` declarations: SDK major compatibility, the `webhook:ingress`
 * permission, route uniqueness, and that a declared `toleranceSec` is usable (> 0 — a replay window
 * of zero or less would make the tolerance check a no-op). A manifest with no `ingress` entries is a
 * no-op. Called from PluginLoaderService.loadPlugin, so a malformed declaration is rejected at load time.
 */
export function validateIngressManifest(manifest: PluginManifest): void {
  if (!manifest.ingress?.length) return; // no ingress declared → nothing to validate
  const declaredMajor = Number.parseInt((manifest.sdkVersion ?? '1').split('.')[0], 10);
  if (!Number.isFinite(declaredMajor) || declaredMajor !== SUPPORTED_SDK_MAJOR) {
    throw new Error(
      `Plugin ${manifest.id}: SDK major ${manifest.sdkVersion} is not supported by this host (supports ${SUPPORTED_SDK_MAJOR})`,
    );
  }
  const perms = manifest.permissions ?? [];
  if (!perms.includes(PluginCapabilityPermission.WEBHOOK_INGRESS)) {
    throw new Error(`Plugin ${manifest.id}: declares ingress routes but is missing the 'webhook:ingress' permission`);
  }
  const seen = new Set<string>();
  for (const r of manifest.ingress) {
    if (!r.route || seen.has(r.route)) {
      throw new Error(`Plugin ${manifest.id}: duplicate or empty ingress route '${r.route}'`);
    }
    seen.add(r.route);
    if (r.signature.toleranceSec !== undefined && r.signature.toleranceSec <= 0) {
      throw new Error(
        `Plugin ${manifest.id}: route '${r.route}' toleranceSec must be > 0 (a replay guard would be a no-op)`,
      );
    }
    if (r.response) {
      const ackStatus = r.response.ack?.status;
      if (ackStatus !== undefined && (!Number.isInteger(ackStatus) || ackStatus < 100 || ackStatus > 599)) {
        throw new Error(
          `Plugin ${manifest.id}: route '${r.route}' response.ack.status must be a valid HTTP status (100-599)`,
        );
      }
      if (r.response.ack?.headers) {
        for (const [name, value] of Object.entries(r.response.ack.headers)) {
          if (!HTTP_HEADER_NAME.test(name)) {
            throw new Error(
              `Plugin ${manifest.id}: route '${r.route}' response.ack header name '${name}' is not a valid HTTP token`,
            );
          }
          if (!HTTP_HEADER_VALUE_NO_CRLF.test(value)) {
            throw new Error(
              `Plugin ${manifest.id}: route '${r.route}' response.ack header '${name}' has invalid characters (CR/LF forbidden)`,
            );
          }
        }
      }
    }
  }
}

/**
 * Warns about each ingress route declared with `scheme: 'none'` — a fully-unauthenticated public endpoint
 * that anyone who can reach the host can use to trigger WhatsApp sends. Purely additive (a warning): a
 * deployment that legitimately relies on scheme:'none' (a provider that offers no HMAC) still boots; the
 * loud log surfaces the exposure so an operator can front the URL with a network/reverse-proxy guard.
 * Called from PluginLoaderService.loadPlugin at boot and on dynamic install.
 */
export function warnUnauthenticatedIngressRoutes(
  manifest: PluginManifest,
  logger: { warn: (message: string, context?: Record<string, unknown>) => void },
): void {
  for (const r of manifest.ingress ?? []) {
    if (r.signature.scheme === 'none') {
      logger.warn(
        `Ingress route '${r.route}' of plugin '${manifest.id}' uses signature scheme 'none' — it is an ` +
          `UNAUTHENTICATED public endpoint that can trigger WhatsApp sends. Only keep this if the provider ` +
          `offers no HMAC and the URL is guarded by a network/reverse-proxy ACL.`,
        { pluginId: manifest.id, route: r.route, action: 'ingress_unauthenticated_route' },
      );
    }
  }
}
