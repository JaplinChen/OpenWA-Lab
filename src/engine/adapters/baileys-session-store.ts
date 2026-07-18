import * as fs from 'node:fs';
import type { Chat, Contact as BaileysContact, WAMessage, WAMessageKey } from '@whiskeysockets/baileys';
import { ChatSummary, Contact } from '../interfaces/whatsapp-engine.interface';
import { parseWaId, toNeutralJid as canonicalizeWaId, userPart } from '../identity/wa-id';
import type { LidMappingStore } from '../identity/lid-mapping-store.service';
import { lidPnPair, extractEphemeralDuration, toUnixSeconds } from './baileys-session-store.helpers';
import { resolveContactName } from './baileys-contact-naming';

interface LastMessage {
  key: WAMessageKey;
  timestamp: number;
  text: string;
}

/**
 * Per-session, in-memory snapshot of Baileys contacts + chats, fed from `sock.ev` events. Baileys has
 * no fetch-all; this data arrives via `contacts.*`/`chats.*`/`messaging-history.set` (a full re-sync on
 * each connect) and is mapped to the neutral `Contact`/`ChatSummary` on read. Holds no socket — pure data.
 */
export class BaileysSessionStore {
  private readonly contacts = new Map<string, BaileysContact>();
  private readonly chats = new Map<string, Chat>();
  private readonly lastMessages = new Map<string, LastMessage>();
  private readonly lidToPn = new Map<string, string>();
  /**
   * Per-chat disappearing-messages timer (seconds) learned from inbound messages (#473), the reliable
   * source for it: `Chat.ephemeralExpiration` (from `chats.*`/history sync) is empirically absent for a
   * long-standing timer after a reconnect (observed live: 0 of 159 cached chats carried it). Keyed by
   * both the raw and neutral JID so an outbound send addressed in either dialect (phone `@c.us` /
   * `@s.whatsapp.net` or `@lid`) resolves to the same entry. See {@link extractEphemeralDuration} for
   * which message field is read.
   */
  private readonly ephemeralByChat = new Map<string, number>();

  /**
   * @param lidStore  optional persisted, cross-session lid->phone table that backs resolution beyond
   *                  this session's in-memory map (survives restarts, shared across sessions).
   * @param sessionId provenance recorded on rows this session writes to the table.
   */
  constructor(
    private readonly lidStore?: LidMappingStore,
    private readonly sessionId?: string,
  ) {}

  upsertContacts(records: Partial<BaileysContact>[] = []): void {
    for (const r of records) {
      if (!r.id) {
        continue;
      }
      const existing = this.contacts.get(r.id) ?? { id: r.id };
      const merged: BaileysContact = { ...existing, ...r };
      this.contacts.set(r.id, merged);
      // Capture a lid->phone pair from the merged record (lid + phone can arrive in separate updates).
      // `phoneNumber` is the authoritative PN field; fall back to `id` itself only when it's already
      // in the phone dialect (a lid-only contact's `id` is `<lid>@lid`, which is not a usable phone).
      const phone = merged.phoneNumber ?? (merged.id.endsWith('@s.whatsapp.net') ? merged.id : undefined);
      if (merged.lid && phone) {
        this.lidToPn.set(merged.lid, phone);
        this.persistLidMapping(merged.lid, phone);
      }
    }
  }

  upsertChats(records: Partial<Chat>[] = []): void {
    for (const r of records) {
      if (!r.id) {
        continue;
      }
      const existing = this.chats.get(r.id) ?? { id: r.id };
      this.chats.set(r.id, { ...existing, ...r });
    }
  }

  addLidMappings(mappings: { lid?: string; pn?: string }[] = []): void {
    for (const m of mappings) {
      if (m.lid && m.pn) {
        this.lidToPn.set(m.lid, m.pn);
        this.persistLidMapping(m.lid, m.pn);
      }
    }
  }

  /**
   * Learn lid->pn mappings from an inbound message key (#362). Baileys v7 replaced the 6.7.x
   * `senderLid`/`senderPn`/`participantLid`/`participantPn` fields with `remoteJidAlt` (DM) and
   * `participantAlt` (group) — the "Alt" is always the other dialect of the same field
   * (`remoteJid`/`participant`): if one side is `@lid`, the Alt is the phone JID, and vice versa. This
   * is still the only place a fresh `@lid` sender's number is revealed on the message key itself; the
   * pairs flow through addLidMappings, so they also write through to the persistent table.
   */
  recordKeyLidMappings(key: Pick<WAMessageKey, 'remoteJid' | 'remoteJidAlt' | 'participant' | 'participantAlt'>): void {
    this.addLidMappings([lidPnPair(key.remoteJid, key.remoteJidAlt), lidPnPair(key.participant, key.participantAlt)]);
  }

  /** Write a learned lid->phone pair through to the persistent table (bare digits, fire-and-forget). */
  private persistLidMapping(lidJid: string, pnJid: string): void {
    void this.lidStore?.remember(userPart(lidJid), userPart(pnJid), this.sessionId);
  }

  recordMessage(msg: WAMessage): void {
    const chatId = msg.key?.remoteJid;
    if (!chatId || !msg.key) {
      return;
    }
    // Learn the chat's disappearing-messages timer from the message itself (#473). This runs before the
    // newest-message guard so every inbound refreshes it; the timer is cached under both the raw and
    // neutral JID so an outbound send addressed in either dialect (phone or @lid) finds it.
    this.recordEphemeralFromMessage(chatId, msg);
    this.recordPushName(chatId, msg);
    const timestamp = toUnixSeconds(msg.messageTimestamp);
    const existing = this.lastMessages.get(chatId);
    if (existing && existing.timestamp >= timestamp) {
      return; // keep the newest
    }
    const text = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? '';
    this.lastMessages.set(chatId, { key: msg.key, timestamp, text });
  }

  /**
   * Cache the sender's `pushName` from an inbound message as the contact's `notify` (#369 follow-up).
   * For an unsaved contact with no `contacts.*` record, `pushName` is the only name Baileys reveals.
   * Keyed by the true sender — the group participant for a group message, else the chat JID — so it
   * fills both a titleless 1:1 chat and a group participant's name (used to resolve `@mention` tokens).
   * Skips own messages and status broadcasts. Never overwrites an existing saved name: `notify` is a
   * fallback below `name`/`verifiedName` in the resolution chain, and merging only sets `notify`.
   */
  private recordPushName(chatId: string, msg: WAMessage): void {
    if (msg.key?.fromMe || chatId === 'status@broadcast') {
      return;
    }
    const pushName = msg.pushName?.trim();
    if (!pushName) {
      return;
    }
    const senderId = chatId.endsWith('@g.us') ? msg.key?.participant : chatId;
    if (!senderId) {
      return;
    }
    const existing = this.contacts.get(senderId);
    if (existing?.name ?? existing?.verifiedName ?? existing?.notify) {
      return;
    }
    this.upsertContacts([{ id: senderId, notify: pushName }]);
  }

  /**
   * Public best-known display name for any contact/participant JID (raw engine dialect), for mention
   * (`@<number>`) resolution at the adapter boundary. Returns the raw user-part when nothing is known.
   */
  displayName(id: string): string {
    return this.senderOverride(id) ?? this.resolveContactName(id);
  }

  // Manual @mention overrides shared with the translate module (data/senders.json, flat {digits: name}).
  // Highest-priority name source so a JID the address book never synced (e.g. a mentioned non-participant)
  // still shows a name in the dashboard and translations. mtime-cached so runtime /sender edits are picked
  // up without a restart, without re-parsing the file on every lookup.
  private overrideCache: { mtimeMs: number; map: Record<string, string> } | null = null;

  private senderOverride(id: string): string | undefined {
    const digits = userPart(id);
    if (!digits) return undefined;
    const path = process.env.TRANSLATE_SENDERS_PATH || 'data/senders.json';
    try {
      const mtimeMs = fs.statSync(path).mtimeMs;
      if (this.overrideCache?.mtimeMs !== mtimeMs) {
        this.overrideCache = { mtimeMs, map: JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, string> };
      }
    } catch {
      this.overrideCache = { mtimeMs: 0, map: {} };
    }
    return this.overrideCache.map[digits] || undefined; // '' = pending entry, fall through to contacts
  }

  /**
   * Cache a positive disappearing-messages timer learned from an inbound message under both the raw chat
   * JID and its neutral form, so {@link getEphemeralExpiration} hits regardless of which dialect the caller
   * sends to. A non-positive/absent value means "no live timer on this message" and is left untouched (a
   * single non-ephemeral message must not clear a known timer; WhatsApp keeps stamping it while on).
   */
  private recordEphemeralFromMessage(chatId: string, msg: WAMessage): void {
    const duration = this.extractEphemeralDuration(msg);
    if (duration === undefined) {
      return;
    }
    this.ephemeralByChat.set(chatId, duration);
    this.ephemeralByChat.set(this.toNeutralJid(chatId), duration);
  }

  /**
   * Best-effort read of a message's disappearing timer (seconds) — see the helper for why both
   * `ephemeralDuration` and `contextInfo.expiration` are consulted. Exposed so the history-backfill
   * mapper can populate the same signal the live path uses, without duplicating the extraction.
   */
  extractEphemeralDuration(msg: WAMessage): number | undefined {
    return extractEphemeralDuration(msg);
  }

  listContacts(): Contact[] {
    return [...this.contacts.values()].map(c => this.toNeutralContact(c));
  }

  findContact(id: string): Contact | null {
    const c = this.contacts.get(id) ?? this.contacts.get(this.toEngineJid(id));
    return c ? this.toNeutralContact(c) : null;
  }

  listChats(): ChatSummary[] {
    return [...this.chats.values()].map(c => this.toNeutralChat(c));
  }

  lastMessage(chatId: string): { key: WAMessageKey; timestamp: number } | null {
    const m = this.lastMessages.get(chatId) ?? this.lastMessages.get(this.toEngineJid(chatId));
    return m ? { key: m.key, timestamp: m.timestamp } : null;
  }

  /**
   * The chat's disappearing-messages timer in seconds (#473), or `undefined` when no timer is known.
   * Only a positive value is returned: `0` / `null` / absent all mean "no known timer", so the caller
   * omits the per-message `ephemeralExpiration` and reproduces today's send behavior (Baileys' own send
   * guard is truthy). This keeps a stale-empty or boot-window cache from ever forcing a message to
   * disappear. Folds a neutral `@c.us` id to the engine dialect first, like the other chat lookups.
   */
  getEphemeralExpiration(chatId: string): number | undefined {
    // Prefer the timer learned from inbound messages (reliably present); try the raw, engine, and
    // neutral keys so an @lid-keyed entry and a phone-dialect send target resolve to the same value.
    const fromMessage =
      this.ephemeralByChat.get(chatId) ??
      this.ephemeralByChat.get(this.toEngineJid(chatId)) ??
      this.ephemeralByChat.get(this.toNeutralJid(chatId));
    if (typeof fromMessage === 'number' && fromMessage > 0) {
      return fromMessage;
    }
    // Fallback to the chat object's own timer for sessions/engines that do surface it on `chats.*`.
    const chat =
      this.chats.get(chatId) ?? this.chats.get(this.toEngineJid(chatId)) ?? this.chats.get(this.toNeutralJid(chatId));
    const exp = chat?.ephemeralExpiration;
    return typeof exp === 'number' && exp > 0 ? exp : undefined;
  }

  resolvePhone(id: string): string | null {
    const parsed = parseWaId(id);
    // A user id (@c.us / @s.whatsapp.net) already carries the phone as its user-part. The @c.us case
    // matters once inbound ids are canonicalized: a resolved-lid sender arrives as <phone>@c.us.
    if (parsed.kind === 'user') {
      return parsed.userPart;
    }
    if (parsed.kind === 'lid') {
      // Look up by the device-stripped lid; mappings/contacts are keyed without a :device suffix.
      const lidJid = `${parsed.userPart}@lid`;
      const pn = this.lidToPn.get(lidJid) ?? this.lidToPn.get(id);
      if (pn) {
        return userPart(pn);
      }
      const contactPhone = (this.contacts.get(lidJid) ?? this.contacts.get(id))?.phoneNumber;
      if (contactPhone) {
        return userPart(contactPhone);
      }
      // Fall back to the persistent, cross-session table (in-memory cache, keyed by bare lid digits).
      // `null` means a cached negative (known-unresolved); `undefined` means never seen - both -> null.
      return this.lidStore?.getCached(parsed.userPart) ?? null;
    }
    return null;
  }

  /**
   * Canonicalize a Baileys JID to the neutral dialect (see {@link canonicalizeWaId} / wa-id.ts),
   * resolving a lid to its phone via this session's lid->pn map when the mapping is known.
   */
  toNeutralJid(jid: string): string {
    return canonicalizeWaId(jid, id => this.resolvePhone(id));
  }

  /**
   * Fold an app-facing neutral id back to the engine's raw dialect. The contacts / chats / lastMessages
   * maps are keyed by Baileys' raw `@s.whatsapp.net`, but the app now hands us the neutral `@c.us`
   * (contact/chat ids are emitted neutral), so map lookups must fold first. The outbound group-participant
   * ops fold for the same reason: only `@s.whatsapp.net` encodes to the single-byte protocol token, whereas
   * a raw `c.us` server suffix would go on the wire as an unknown string. Groups/lids/others share the
   * dialect, so pass them through unchanged.
   */
  toEngineJid(jid: string): string {
    const parsed = parseWaId(jid);
    return parsed.kind === 'user' ? `${parsed.userPart}@s.whatsapp.net` : jid;
  }

  private toNeutralContact(c: BaileysContact): Contact {
    const number = c.phoneNumber ? userPart(c.phoneNumber) : c.id.endsWith('@s.whatsapp.net') ? userPart(c.id) : '';
    return {
      id: this.toNeutralJid(c.id),
      name: c.name ?? c.verifiedName,
      pushName: c.notify,
      number,
      isMyContact: true, // best-effort: present in the synced address book / chat list
      isBlocked: false, // best-effort: blocklist state is not tracked in this slice
      profilePicUrl: c.imgUrl ?? undefined,
    };
  }

  private toNeutralChat(c: Chat): ChatSummary {
    // Chat.id is nullable on Baileys' own type (it's the raw proto.IConversation field), but
    // upsertChats() only ever stores a record under a truthy r.id, so every value in `this.chats`
    // is provably keyed by a real id.
    const id = c.id!;
    const last = this.lastMessages.get(id);
    return {
      id: this.toNeutralJid(id),
      name: c.name ?? this.resolveContactName(id),
      isGroup: id.endsWith('@g.us'),
      unreadCount: c.unreadCount ?? 0,
      timestamp: last?.timestamp ?? toUnixSeconds(c.conversationTimestamp),
      lastMessage: last?.text,
    };
  }

  /** Best-known display name for a chat id when Baileys gave the chat no title (#369). */
  private resolveContactName(id: string): string {
    return resolveContactName(this.contacts, this.lidToPn, id);
  }
}
