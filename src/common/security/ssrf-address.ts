import { isIPv4, isIPv6 } from 'net';

// Pure IP-literal classification for the SSRF guard: decides whether an address points at an
// internal/reserved range. No DNS, no I/O — split out of ssrf-guard.ts and re-exported from there.

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

function inCidr4(ipInt: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) >>> 0 === (baseInt & mask) >>> 0;
}

// IPv4 ranges that must never be reachable by an outbound webhook (SSRF targets).
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this" network / unspecified
  ['10.0.0.0', 8], // RFC1918 private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. 169.254.169.254 cloud metadata)
  ['172.16.0.0', 12], // RFC1918 private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // RFC1918 private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

/** Two 16-bit hextets → dotted IPv4 string (for IPv4-in-IPv6 embeddings like ::ffff:, 6to4, NAT64). */
function hextetsToV4(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/**
 * Expand a (possibly ::-compressed, possibly dotted-IPv4-tailed) IPv6 literal to its 8 numeric
 * hextets, or null if malformed. Full expansion is required so a compressed all-zero embedded segment
 * (e.g. 2002:7f00:: → 127.0.0.0) is read as 0x0000 rather than silently skipped.
 */
function expandIPv6(lower: string): number[] | null {
  let s = lower;
  // Fold a trailing dotted IPv4 (::a.b.c.d) into two hex hextets so the remainder is pure hex.
  const dotted = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const octets = dotted.slice(1, 5).map(Number);
    if (octets.some(o => o > 255)) return null;
    const [a, b, c, d] = octets;
    s = s.slice(0, dotted.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const gap = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : gap < 1) return null;
  const parts = [...head, ...Array<string>(Math.max(gap, 0)).fill('0'), ...tail];
  if (parts.length !== 8) return null;
  const nums = parts.map(h => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  return nums.some(n => Number.isNaN(n)) ? null : nums;
}

/**
 * Whether an IP literal points at an internal/reserved range that an outbound
 * webhook must not be allowed to reach (loopback, RFC1918, link-local/metadata,
 * CGNAT, multicast, IPv6 loopback/ULA/link-local, IPv4-mapped variants).
 * Anything that isn't a recognizable public IP is treated as blocked (fail-closed).
 */
export function isBlockedAddress(ip: string): boolean {
  if (isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return BLOCKED_V4.some(([base, bits]) => inCidr4(n, base, bits));
  }

  if (isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;

    // IPv4-mapped (::ffff:a.b.c.d or ::ffff:hhhh:hhhh) — classify by the embedded IPv4, handling
    // BOTH the dotted-decimal and the hex-hextet form (the hex form bypassed a dotted-only regex).
    if (lower.startsWith('::ffff:')) {
      const tail = lower.slice('::ffff:'.length);
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) {
        return isBlockedAddress(tail);
      }
      const hextets = tail.split(':');
      if (hextets.length === 2 && hextets.every(h => /^[0-9a-f]{1,4}$/.test(h))) {
        const hi = parseInt(hextets[0], 16);
        const lo = parseInt(hextets[1], 16);
        return isBlockedAddress(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
      }
    }

    const firstHextet = lower.split(':')[0];
    if (firstHextet.startsWith('fc') || firstHextet.startsWith('fd')) return true; // ULA fc00::/7
    if (/^fe[89ab]/.test(firstHextet)) return true; // link-local fe80::/10
    if (/^fe[c-f]/.test(firstHextet)) return true; // deprecated site-local fec0::/10 (RFC 3879)

    // IPv6 forms that embed an IPv4 — 6to4 (2002::/16), NAT64 (64:ff9b::/96), and the deprecated
    // IPv4-compatible ::/96 — are classified by the embedded address so they reach the IPv4 blocklist,
    // mirroring the ::ffff: handling above. The literal is fully expanded first so a compressed all-zero
    // embedded hextet (e.g. 2002:7f00:: → 127.0.0.0) is not skipped. A 6to4/NAT64/compat of a genuinely
    // public IPv4 still returns false, so legitimate IPv6 delivery is unaffected.
    const hextets = expandIPv6(lower);
    if (hextets) {
      if (hextets[0] === 0x2002) {
        return isBlockedAddress(hextetsToV4(hextets[1], hextets[2])); // 6to4
      }
      if (hextets[0] === 0x64 && hextets[1] === 0xff9b) {
        return isBlockedAddress(hextetsToV4(hextets[6], hextets[7])); // NAT64
      }
      if (hextets.slice(0, 6).every(h => h === 0) && (hextets[6] | hextets[7]) !== 0) {
        return isBlockedAddress(hextetsToV4(hextets[6], hextets[7])); // IPv4-compatible ::/96
      }
      // RFC6052 IPv4-translatable (::ffff:0:a.b.c.d → 0:0:0:0:ffff:0:X:X): embeds an IPv4 in the
      // low 32 bits just like the mapped/NAT64 forms, so a NAT64/SIIT translator could otherwise
      // reach an internal IPv4 through it. Classify by the embedded address (public stays allowed).
      if (
        hextets[0] === 0 &&
        hextets[1] === 0 &&
        hextets[2] === 0 &&
        hextets[3] === 0 &&
        hextets[4] === 0xffff &&
        hextets[5] === 0
      ) {
        return isBlockedAddress(hextetsToV4(hextets[6], hextets[7]));
      }
      // Fully-expanded IPv4-mapped (::ffff:0:0/96 → 0:0:0:0:0:ffff:X:X): the compressed "::ffff:"
      // form is caught by the prefix check above, but the fully-expanded literal bypasses it.
      // Distinct from IPv4-compat (idx5 has no 0xffff) and RFC6052 (0xffff at idx4, not idx5).
      // Classify by the embedded IPv4 (public stays allowed).
      if (
        hextets[0] === 0 &&
        hextets[1] === 0 &&
        hextets[2] === 0 &&
        hextets[3] === 0 &&
        hextets[4] === 0 &&
        hextets[5] === 0xffff
      ) {
        return isBlockedAddress(hextetsToV4(hextets[6], hextets[7]));
      }
    }
    return false;
  }

  // Not a valid IP literal — cannot verify, so block.
  return true;
}
