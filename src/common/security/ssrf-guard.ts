import { isIPv4, isIPv6, type LookupFunction } from 'net';
import { lookup } from 'dns/promises';
import { type LookupAddress, type LookupOptions } from 'dns';
import { Agent, fetch as undiciFetch, type RequestInit, type Response } from 'undici';
import { isBlockedAddress } from './ssrf-address';

// Pure IP-literal classification lives in ./ssrf-address; re-exported so importers/spec resolve unchanged.
export { isBlockedAddress } from './ssrf-address';

/** Thrown when an outbound URL is blocked by the SSRF guard. */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * Generic, non-revealing message to return to an API caller when an outbound URL is SSRF-blocked. The
 * raw SsrfBlockedError message names the resolved internal IP ("… resolves to a blocked internal address:
 * 10.0.0.5"), which is a recon / DNS-rebind oracle, so it must never reach a client — log the detail
 * server-side and return this instead. Shared by the single-send, bulk, and webhook-registration paths.
 */
export const SSRF_BLOCKED_CLIENT_MESSAGE = 'Destination address is not allowed';

/**
 * Map an error to a client/surfaced message, redacting SSRF detail. An `SsrfBlockedError`'s message
 * names the resolved internal IP ("… resolves to a blocked internal address: 10.0.0.5") — a recon /
 * metadata-service probe oracle when surfaced verbatim to an HTTP response, a persisted DLQ row, or a
 * hook payload. Log the full detail server-side (when a `logger` is supplied) and return the generic
 * {@link SSRF_BLOCKED_CLIENT_MESSAGE} instead; any other error passes through verbatim so genuine
 * receiver failures (5xx, timeout, bad-zip) keep their actionable text.
 */
export function redactSsrfError(error: unknown, logger?: { warn: (message: string) => void }, site?: string): string {
  if (error instanceof SsrfBlockedError) {
    logger?.warn(`SSRF guard blocked ${site ?? 'an outbound fetch'}: ${error.message}`);
    return SSRF_BLOCKED_CLIENT_MESSAGE;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Outbound webhook SSRF protection. Default ON; disable only with an explicit
 * WEBHOOK_SSRF_PROTECT=false (e.g. a closed network that delivers to internal sidecars — prefer
 * the SSRF_ALLOWED_HOSTS escape-hatch instead of disabling protection wholesale).
 */
export function isSsrfProtectionEnabled(): boolean {
  return process.env.WEBHOOK_SSRF_PROTECT !== 'false';
}

/**
 * Escape-hatch for self-hosted topologies that intentionally fetch from / deliver to
 * internal hosts (e.g. a localhost media store or a sidecar webhook receiver).
 * `SSRF_ALLOWED_HOSTS` is a comma-separated list of hostnames and/or IP literals that
 * bypass the block. Matched case-insensitively against the URL hostname.
 */
function getAllowedHosts(): Set<string> {
  return new Set(
    (process.env.SSRF_ALLOWED_HOSTS ?? '')
      .split(',')
      // Strip IPv6 brackets so an entry copied from a URL (e.g. "[::1]") matches the
      // bracket-stripped url.hostname we compare against below.
      .map(h =>
        h
          .trim()
          .replace(/^\[|\]$/g, '')
          .toLowerCase(),
      )
      .filter(Boolean),
  );
}

/**
 * Reject a response obtained with `redirect: 'manual'` that turned out to be a redirect.
 * The pre-fetch SSRF check only validates the original URL, so a followed 3xx to an
 * internal host would bypass it. We never follow redirects on guarded
 * fetches; a redirect is treated as a delivery failure.
 */
export function assertNoRedirect(response: { status: number; type?: string }, url: string): void {
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new SsrfBlockedError(`Refusing to follow redirect from ${url}`);
  }
}

/** Default DNS resolution deadline (ms) — generous for healthy resolvers; bounds a hang. */
const DEFAULT_DNS_TIMEOUT_MS = 10000;

function resolveDnsTimeoutMs(): number {
  const raw = process.env.SSRF_DNS_TIMEOUT_MS;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DNS_TIMEOUT_MS;
}

/**
 * Resolve a host with `{ all: true }`, bounded by a deadline so a hanging/slow DNS resolver cannot
 * pin a worker indefinitely (the lookup is otherwise unbounded). The default deadline is generous
 * and overridable via SSRF_DNS_TIMEOUT_MS. On expiry — or on a rejected lookup (NXDOMAIN, transient
 * EAI_AGAIN, ESERVFAIL, …) — it throws SsrfBlockedError; the in-flight lookup is left to settle with
 * its late result swallowed (no unhandledRejection). Wrapping the rejection keeps every resolution
 * failure typed, so callers map it to a 4xx instead of leaking a raw DNS error as a generic 500.
 */
async function lookupWithDeadline(host: string): Promise<LookupAddress[]> {
  const lookupPromise = lookup(host, { all: true });
  lookupPromise.catch(() => undefined); // swallow a late rejection if the deadline already fired
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SsrfBlockedError(`Timed out resolving host: ${host}`)), resolveDnsTimeoutMs());
  });
  try {
    return await Promise.race([lookupPromise, deadline]);
  } catch (err) {
    if (err instanceof SsrfBlockedError) throw err; // deadline already produced a typed error
    const code = (err as NodeJS.ErrnoException)?.code;
    throw new SsrfBlockedError(`Could not resolve host: ${host}${code ? ` (${code})` : ''}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Validate an outbound URL and resolve its host ONCE. Throws SsrfBlockedError if the scheme is not
 * http(s) or if the host (literal or any DNS-resolved address) is internal/reserved. Guards both
 * webhook delivery and server-side media fetches. Hosts named in `SSRF_ALLOWED_HOSTS` are allowed
 * through (escape-hatch for trusted internal targets).
 *
 * Returns the vetted resolved addresses so a caller can PIN the connection to them — defeating the
 * DNS-rebinding window where the address validated here differs from the one `fetch` would re-resolve.
 * Returns null when there is nothing to pin: an allowlisted host (trusted — deliberately left
 * unpinned, since the operator opts in to whatever its DNS returns) or a literal IP (no DNS, so no
 * rebind is possible — fetch connects straight to the validated literal).
 */
export async function resolveSafeFetchTarget(rawUrl: string): Promise<LookupAddress[] | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`Blocked URL scheme: ${url.protocol}`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  if (getAllowedHosts().has(host.toLowerCase())) {
    return null; // explicitly allowlisted internal target
  }

  if (isIPv4(host) || isIPv6(host)) {
    if (isBlockedAddress(host)) {
      throw new SsrfBlockedError(`Blocked internal address: ${host}`);
    }
    return null; // literal IP — fetch connects directly, nothing to rebind
  }

  const resolved = await lookupWithDeadline(host);
  if (resolved.length === 0) {
    throw new SsrfBlockedError(`Could not resolve host: ${host}`);
  }
  for (const { address } of resolved) {
    if (isBlockedAddress(address)) {
      throw new SsrfBlockedError(`Host ${host} resolves to a blocked internal address: ${address}`);
    }
  }
  return resolved; // vetted addresses — pin the connection to these
}

/**
 * Backwards-compatible assertion form: validate the URL (used at webhook registration time, where
 * only the throw/no-throw outcome matters).
 */
export async function assertSafeFetchUrl(rawUrl: string): Promise<void> {
  await resolveSafeFetchTarget(rawUrl);
}

/**
 * Build a `net`-style lookup function that always returns the pre-validated addresses and never
 * consults DNS — so a connection using it cannot be re-resolved to a different (internal) address.
 */
export function pinnedLookup(addresses: LookupAddress[]): LookupFunction {
  // undici always invokes the lookup with an options object; `all: true` expects the address array,
  // otherwise a single (address, family) pair.
  const fn = (_hostname: string, options: LookupOptions, callback: (...args: unknown[]) => void): void => {
    if (options.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0].address, addresses[0].family);
    }
  };
  return fn as unknown as LookupFunction;
}

/**
 * A `connect.lookup` that resolves EVERY host it is asked to connect to and refuses any that resolve
 * to an internal/reserved address. Used by the redirect-following download path so that each hop —
 * the original URL AND every redirect target — is validated at connect time, not just the first one.
 * This closes the redirect-bypass hole a single-host pin can't: a 3xx to an internal host is rejected
 * at the socket. Allowlisted hosts (SSRF_ALLOWED_HOSTS) are resolved without the block check, matching
 * {@link resolveSafeFetchTarget}.
 */
export function validatingLookup(): LookupFunction {
  const fn = (hostname: string, options: LookupOptions, callback: (...args: unknown[]) => void): void => {
    const host = hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
    const allowlisted = getAllowedHosts().has(host.toLowerCase());
    const finish = (addrs: LookupAddress[]): void => {
      if (options.all) callback(null, addrs);
      else callback(null, addrs[0].address, addrs[0].family);
    };

    if (isIPv4(host) || isIPv6(host)) {
      if (!allowlisted && isBlockedAddress(host)) {
        callback(new SsrfBlockedError(`Blocked internal address: ${host}`));
        return;
      }
      finish([{ address: host, family: isIPv6(host) ? 6 : 4 }]);
      return;
    }

    lookupWithDeadline(host)
      .then(resolved => {
        if (resolved.length === 0) {
          callback(new SsrfBlockedError(`Could not resolve host: ${host}`));
          return;
        }
        if (!allowlisted) {
          const bad = resolved.find(a => isBlockedAddress(a.address));
          if (bad) {
            callback(new SsrfBlockedError(`Host ${host} resolves to a blocked internal address: ${bad.address}`));
            return;
          }
        }
        finish(resolved);
      })
      .catch((err: unknown) => callback(err instanceof Error ? err : new Error(String(err))));
  };
  return fn as unknown as LookupFunction;
}

/**
 * Perform an SSRF-safe fetch and hand the response to `use`, then tear down the per-request
 * connection. The host is validated and resolved ONCE; the connection is pinned to the vetted IP(s)
 * via an undici dispatcher so it cannot be re-resolved to an internal address between check and
 * connect (DNS-rebinding TOCTOU). The original hostname is preserved for TLS SNI and the Host header,
 * so virtual hosting and certificate validation are unaffected, and ALL vetted addresses are offered
 * so A-record failover still works. Redirects are refused (the guard only validated the original host).
 *
 * `use` must read everything it needs from the response before returning — the dispatcher (and its
 * sockets) is destroyed once `use` settles, so a still-streaming body would be cut off.
 *
 * @param opts.guard - when false (the WEBHOOK_SSRF_PROTECT opt-out), skips validation/pinning and
 *   performs a plain redirect-following fetch. Defaults to true (always guard).
 */
export async function withSafeFetch<T>(
  rawUrl: string,
  init: RequestInit,
  use: (response: Response) => Promise<T> | T,
  opts: { guard?: boolean; followRedirects?: boolean } = {},
): Promise<T> {
  const guard = opts.guard ?? true;
  if (!guard) {
    return use(await undiciFetch(rawUrl, { ...init, redirect: 'follow' }));
  }

  if (opts.followRedirects) {
    // Download path (plugin .zip / catalog JSON): public release hosts legitimately 302 to a CDN, so
    // refusing every redirect breaks them. Follow redirects, but SECURELY — instead of pinning one
    // host's IPs, route the connection through a lookup that resolves+validates EVERY host on demand,
    // so each hop (original + every redirect target) is checked at connect time and a 3xx to an
    // internal host is blocked at the socket. The scheme/host of the original URL is validated first.
    await resolveSafeFetchTarget(rawUrl);
    const dispatcher = new Agent({ connect: { lookup: validatingLookup() } });
    try {
      return await use(await undiciFetch(rawUrl, { ...init, redirect: 'follow', dispatcher }));
    } finally {
      await dispatcher.destroy().catch(() => undefined);
    }
  }

  const target = await resolveSafeFetchTarget(rawUrl);
  const dispatcher = target ? new Agent({ connect: { lookup: pinnedLookup(target) } }) : undefined;
  try {
    const response = await undiciFetch(rawUrl, { ...init, redirect: 'manual', dispatcher });
    assertNoRedirect(response, rawUrl);
    return await use(response);
  } finally {
    if (dispatcher) await dispatcher.destroy().catch(() => undefined);
  }
}
