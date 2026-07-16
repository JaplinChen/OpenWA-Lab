import { userPart } from '../identity/wa-id';
import type { LidMappingStore } from '../identity/lid-mapping-store.service';
import { isNoLidForUserError } from './whatsapp-web-js.helpers';

/**
 * Collaborators for send-id resolution. `resolvedSendIds` is the adapter's cache passed BY REFERENCE —
 * resolveSendId writes to it and sendResolved deletes from it to self-heal a stale mapping, so both must
 * see the same Map. `getNumberId` is a CLOSURE over the adapter's live client (a rate-limited WhatsApp
 * Web probe), never a snapshot.
 */
export interface SendIdCtx {
  resolvedSendIds: Map<string, string>;
  getNumberId: (chatId: string) => Promise<string | null>;
  lidMappingStore?: LidMappingStore;
  sessionId: string;
}

/**
 * Resolve an individual (`@c.us`) recipient to the id whatsapp-web.js will accept. WhatsApp has
 * migrated some contacts to privacy-id addressing, for which `sendMessage` throws `No LID for user`
 * on the phone WID but accepts the `@lid` that `getNumberId` returns (#573). Any server-confirmed
 * resolution (a distinct `@lid` OR a confirmed non-migrated `@c.us`) is cached, since it is stable
 * and re-probing costs a rate-limited round-trip (#580); a `null`/thrown lookup is NOT cached so an
 * unregistered or transiently-flaky contact keeps being retried. Groups/channels and already-`@lid`
 * targets are returned unchanged, and any resolution failure falls back to the original id so a send
 * is never blocked on it.
 */
export async function resolveSendId(ctx: SendIdCtx, chatId: string): Promise<string> {
  if (!chatId.endsWith('@c.us')) {
    return chatId;
  }
  const cached = ctx.resolvedSendIds.get(chatId);
  if (cached) {
    return cached;
  }
  try {
    const wid = await ctx.getNumberId(chatId);
    if (wid) {
      ctx.resolvedSendIds.set(chatId, wid);
      if (wid.endsWith('@lid')) {
        // Persist the learned phone -> lid so the message read-path (resolveJidCandidates) can
        // bridge this contact's `@c.us` and `@lid` rows on a pure whatsapp-web.js deployment
        // (#583 R3). Fire-and-forget: resolution (and the send) must never block/fail on the write.
        void ctx.lidMappingStore?.remember(userPart(wid), userPart(chatId), ctx.sessionId)?.catch(() => {});
      }
      return wid;
    }
    return chatId;
  } catch {
    return chatId;
  }
}

/**
 * Resolve `chatId` and run `send` against the resolved id. If the send fails with `No LID for user`
 * — the signature of a contact whose cached/resolved id is stale (typically a `@c.us` for a contact
 * that has since migrated to `@lid`) — drop the mapping, re-resolve once, and retry only if the
 * fresh id differs, so a genuinely unreachable recipient surfaces its error instead of looping.
 */
export async function sendResolved<T>(ctx: SendIdCtx, chatId: string, send: (to: string) => Promise<T>): Promise<T> {
  const to = await resolveSendId(ctx, chatId);
  try {
    return await send(to);
  } catch (err) {
    if (!chatId.endsWith('@c.us') || !isNoLidForUserError(err)) {
      throw err;
    }
    ctx.resolvedSendIds.delete(chatId);
    const fresh = await resolveSendId(ctx, chatId);
    if (fresh === to) {
      throw err;
    }
    return send(fresh);
  }
}
