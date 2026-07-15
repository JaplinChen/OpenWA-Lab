import type { WAMessage } from '@whiskeysockets/baileys';

// Pure helpers for BaileysSessionStore: lid/pn pairing, disappearing-timer extraction, and timestamp
// coercion. No store state — split out of baileys-session-store.ts.

/** Sorts a JID and its WhatsApp-supplied "Alt" counterpart into { lid, pn } by @lid suffix. */
export function lidPnPair(jid?: string | null, alt?: string | null): { lid?: string; pn?: string } {
  if (!jid || !alt) {
    return {};
  }
  if (jid.endsWith('@lid')) {
    return { lid: jid, pn: alt };
  }
  if (alt.endsWith('@lid')) {
    return { lid: alt, pn: jid };
  }
  return {};
}

/** Walk a message's content (unwrapping known envelopes) and return the first positive `contextInfo.expiration`. */
function contextExpiration(content: WAMessage['message'], depth = 0): number | undefined {
  if (!content || typeof content !== 'object' || depth > 4) {
    return undefined;
  }
  const nodes = content as Record<
    string,
    { contextInfo?: { expiration?: number | null }; message?: WAMessage['message'] } | undefined
  >;
  for (const node of Object.values(nodes)) {
    const exp = node?.contextInfo?.expiration;
    if (typeof exp === 'number' && exp > 0) {
      return exp;
    }
    if (node?.message) {
      const nested = contextExpiration(node.message, depth + 1);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

/**
 * Best-effort read of a message's disappearing timer (seconds). `WebMessageInfo.ephemeralDuration` is
 * populated on history-synced messages but is typically ABSENT on a live 1:1 `messages.upsert`, so fall
 * back to the per-message `contextInfo.expiration` WhatsApp stamps on every message in a disappearing
 * chat — read after unwrapping the ephemeral / view-once / document-with-caption envelope.
 */
export function extractEphemeralDuration(msg: WAMessage): number | undefined {
  const fromInfo = msg.ephemeralDuration;
  if (typeof fromInfo === 'number' && fromInfo > 0) {
    return fromInfo;
  }
  const fromContext = contextExpiration(msg.message);
  return typeof fromContext === 'number' && fromContext > 0 ? fromContext : undefined;
}

export function toUnixSeconds(ts: number | { toNumber(): number } | null | undefined): number {
  if (ts == null) {
    return 0;
  }
  return typeof ts === 'number' ? ts : ts.toNumber();
}
