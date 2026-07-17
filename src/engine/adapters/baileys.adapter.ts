import * as path from 'path';
import * as qrcode from 'qrcode';
import type * as BaileysLib from '@whiskeysockets/baileys';
import type { AnyMessageContent, WAMessage, WASocket } from '@whiskeysockets/baileys';
import { mapBaileysStatus } from './baileys-message-mapper';
import { mapBaileysGroup, mapBaileysGroupInfo } from './baileys-group-mapper';
import type { ILogger } from '@whiskeysockets/baileys/lib/Utils/logger.js';
import {
  ChatState,
  Channel,
  ChannelMessage,
  Catalog,
  Contact,
  ContactCard,
  EngineEventCallbacks,
  EngineStatus,
  Group,
  GroupInfo,
  IncomingMessage,
  IWhatsAppEngine,
  Label,
  LocationInput,
  MediaInput,
  MessageReaction,
  MessageResult,
  PaginatedProducts,
  PollInput,
  Product,
  ProductQueryOptions,
  ReactionEvent,
  RevokedMessage,
  Status,
  StatusResult,
  ChatSummary,
  StatusPostOptions,
} from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { ChannelNotFoundError } from '../../common/errors/channel-not-found.error';
import { createLogger } from '../../common/services/logger.service';
import { BaileysAdapterConfig } from '../types/baileys.types';
import { BAILEYS_BROWSER, createBaileysLogger, createSilentLogger } from './baileys-logger';
import { buildSocketOptions, classifyClose, clearAuthState, detachAndEndSocket } from './baileys-connection';
import { toUnixSeconds, extractPhone, resolveMediaBuffer } from './baileys-adapter.helpers';
import { BaileysSessionStore } from './baileys-session-store';
import { InboundMapperCtx, mapMessage, mapHistoryMessage } from './baileys-inbound-mapper';
import {
  AdapterSendCtx,
  sendContent,
  toDeliverableJid,
  withEphemeral,
  requireStored,
  postStatus,
  emitOwnSendEcho,
} from './baileys-send';
import { buildVCard } from './vcard';
import { inboundMediaConcurrency, inboundMediaTimeoutMs, withInboundDownloadTimeout } from './inbound-media-cap';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

export class BaileysAdapter implements IWhatsAppEngine {
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;

  private readonly logger = createLogger('BaileysAdapter');
  // Bound concurrent inbound media downloads: each materialises a full decrypted buffer in heap, so an
  // unbounded fire-and-forget loop lets a sender flood the gateway with N parallel multi-MB allocations.
  private readonly inboundLimiter = new ConcurrencyLimiter(
    inboundMediaConcurrency(),
    // Queue cap == active slots: beyond (active + queued) concurrent media messages, reject instead of
    // parking, so a burst can't grow heap without bound (each parked closure holds the message).
    inboundMediaConcurrency(),
  );
  private readonly authPath: string;
  private readonly sessionStore: BaileysSessionStore;
  private sock: WASocket | null = null;
  private status: EngineStatus = EngineStatus.DISCONNECTED;
  private qrCode: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  private callbacks: EngineEventCallbacks = {};
  private intentionalClose = false;
  private connecting = false;
  /** Unix-seconds timestamp of the last 'open' connection.update, used to distinguish a genuinely
   *  live message misfiled as 'append' (see handleMessagesUpsert) from real history backfill. */
  private connectedAt = 0;
  /** Message ids this session just sent via the API. emitOwnSendEcho already fires onMessageCreate for
   *  them, so when Baileys echoes the same message back as a 'notify' upsert we must skip it (else the
   *  own-send fires twice). Keyed id -> unix-ms; entries self-evict by age so the map stays bounded and
   *  a never-echoed send can't leak. Own sends from the PHONE (no API call) are absent here and pass
   *  through normally. */
  private readonly echoedOwnSendIds = new Map<string, number>();
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  /** Lazily loaded @whiskeysockets/baileys module (ESM-only; loaded on first connect, not at boot). */
  private lib?: typeof BaileysLib;

  private async loadLib(): Promise<typeof BaileysLib> {
    return (this.lib ??= await import('@whiskeysockets/baileys'));
  }

  constructor(private readonly config: BaileysAdapterConfig) {
    // Isolate each session's auth state under its own subdirectory of the shared auth dir.
    this.authPath = path.join(config.authDir, config.sessionId);
    this.sessionStore = new BaileysSessionStore(config.lidMappingStore, config.sessionId);
    if (config.proxyUrl) {
      // Proxy support is gated for this slice — Baileys proxying needs an http/socks agent (a new dep).
      this.logger.warn('Proxy configured but not supported by the baileys engine in this slice; ignoring it', {
        action: 'baileys_proxy_unsupported',
        sessionId: config.sessionId,
      });
    }
  }

  // ----- Lifecycle -----

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.intentionalClose = false;
    try {
      await this.connect();
    } catch (err) {
      this.setStatus(EngineStatus.FAILED);
      this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private async connect(): Promise<void> {
    // I4: in-flight guard — skip if a connect() is already in progress.
    if (this.connecting) {
      return;
    }
    this.connecting = true;
    try {
      await this.connectInner();
    } finally {
      this.connecting = false;
    }
  }

  private async connectInner(): Promise<void> {
    this.setStatus(EngineStatus.INITIALIZING);
    const b = await this.loadLib();
    const { state, saveCreds } = await b.useMultiFileAuthState(this.authPath);
    const { version } = await b.fetchLatestBaileysVersion();
    // BaileysLogger matches ILogger exactly; cast needed because the module resolves the type
    // through a deep import path that TypeScript does not auto-unify here. Shared by the key
    // store wrapper below and the socket itself, rather than constructing two instances.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const baileysLogger = createBaileysLogger() as unknown as ILogger;

    // Wrap the raw file-backed signal key store with Baileys' own official caching layer.
    // Without it, every session read/write hits disk directly with no protection against a
    // write-then-immediate-read race — observed here as a freshly-established Signal session
    // appearing "missing" moments later, forcing Baileys to discard it and start a brand new
    // PreKey handshake on the very next send (visible as repeated "Closing session" log spam and
    // the recipient stuck on "waiting for this message" until a slow WhatsApp-side retry rescues
    // it). makeCacheableSignalKeyStore keeps the just-written state visible in memory immediately,
    // regardless of disk I/O timing.
    state.keys = b.makeCacheableSignalKeyStore(state.keys, baileysLogger);

    // C2: resurrect-after-stop guard — if disconnect/logout/destroy ran during the awaits above,
    // bail now so we don't create a live socket for a session that was intentionally stopped.
    if (this.intentionalClose) {
      return;
    }

    // An internal reconnect (transient drop) overwrites this.sock WITHOUT going through
    // disconnect/logout/destroy, so the previous socket's WebSocket and the 10 ev listeners we
    // register below would leak on every reconnect. Tear the prior socket down first. Detach OUR
    // connection.update listener BEFORE end(): Baileys' own end() synchronously emits a synthetic
    // connection.update {connection:'close'}, which — if still wired — would re-enter
    // handleConnectionUpdate and schedule a spurious second reconnect.
    detachAndEndSocket(this.sock);

    const sock = b.default(
      buildSocketOptions({
        state,
        version,
        browser: BAILEYS_BROWSER,
        logger: baileysLogger,
        getMessage: async key => {
          if (!key.id) {
            return undefined;
          }
          const stored = await this.config.messageStore?.getMessage(this.config.dbSessionId, key.id);
          return stored?.message ?? undefined;
        },
      }),
    );
    this.sock = sock;

    sock.ev.on('creds.update', () => void saveCreds());
    sock.ev.on('connection.update', update => this.handleConnectionUpdate(update));
    sock.ev.on('messages.upsert', event => this.handleMessagesUpsert(event));
    sock.ev.on('messages.update', updates => this.handleMessagesUpdate(updates));
    sock.ev.on('contacts.upsert', contacts => {
      this.logContactEvent('contacts.upsert', contacts);
      this.sessionStore.upsertContacts(contacts);
    });
    sock.ev.on('contacts.update', updates => {
      this.logContactEvent('contacts.update', updates);
      this.sessionStore.upsertContacts(updates);
    });
    sock.ev.on('chats.upsert', chats => {
      this.logger.debug('Baileys chats event', { action: 'baileys_chats', event: 'upsert', count: chats?.length ?? 0 });
      this.sessionStore.upsertChats(chats);
    });
    sock.ev.on('chats.update', updates => {
      this.logger.debug('Baileys chats event', {
        action: 'baileys_chats',
        event: 'update',
        count: updates?.length ?? 0,
      });
      this.sessionStore.upsertChats(updates);
    });
    sock.ev.on('messaging-history.set', history => {
      this.sessionStore.upsertContacts(history.contacts);
      this.sessionStore.upsertChats(history.chats);
      this.sessionStore.addLidMappings(history.lidPnMappings ?? []);
      void this.captureHistoryMessages(history.messages ?? []);
      this.logger.debug('History sync received', {
        action: 'baileys_history_set',
        sessionId: this.config.sessionId,
        syncType: history.syncType,
        isLatest: history.isLatest,
        progress: history.progress,
        chats: history.chats?.length ?? 0,
        messages: history.messages?.length ?? 0,
        contacts: history.contacts?.length ?? 0,
        namedContacts: history.contacts?.filter(c => c.name || c.notify).length ?? 0,
        lidContacts: history.contacts?.filter(c => c.lid).length ?? 0,
        lidPnMappings: history.lidPnMappings?.length ?? 0,
      });
    });
    // WhatsApp pushes this when a lid<->phone mapping is learned (renamed from the pre-v7
    // 'chats.phoneNumberShare' event, whose { lid, jid } payload this shape directly replaces).
    sock.ev.on('lid-mapping.update', ({ lid, pn }) => this.sessionStore.addLidMappings([{ lid, pn }]));
  }

  private handleConnectionUpdate(update: {
    connection?: string;
    qr?: string;
    lastDisconnect?: { error?: unknown };
  }): void {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      // Baileys hands us the raw QR ref string; render it to a PNG data URL so the stored
      // value matches the whatsapp-web.js engine's contract (the dashboard does <img src={qrCode}>).
      void this.handleQrCode(qr);
    }

    if (connection === 'connecting') {
      this.setStatus(EngineStatus.INITIALIZING);
    }

    if (connection === 'open') {
      this.qrCode = null;
      this.phoneNumber = extractPhone(this.sock?.user?.id);
      this.pushName = this.sock?.user?.name ?? null;
      // I4: reset the reconnect counter on a successful connection.
      this.reconnectAttempts = 0;
      // Small backward buffer for clock skew between this host and WhatsApp's server (messageTimestamp
      // is WA's clock, Date.now() is ours) — without it, a message sent right at reconnect time could
      // land a couple seconds "before" connectedAt and be misjudged as history.
      this.connectedAt = Math.floor(Date.now() / 1000) - 10;
      this.setStatus(EngineStatus.READY);
      this.callbacks.onReady?.(this.phoneNumber ?? '', this.pushName ?? '');
      // Backfill names the initial sync skipped (see hydrateNames).
      void this.hydrateNames();
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
        ?.statusCode;

      const decision = classifyClose({
        intentionalClose: this.intentionalClose,
        statusCode,
        loggedOutCode: this.lib?.DisconnectReason.loggedOut,
        reconnectAttempts: this.reconnectAttempts,
        maxAttempts: BaileysAdapter.MAX_RECONNECT_ATTEMPTS,
      });

      if (decision.kind === 'intentional') {
        this.setStatus(EngineStatus.DISCONNECTED);
        return;
      }

      if (decision.kind === 'logged-out') {
        // Credentials invalidated — terminal. Re-linking requires a fresh QR/pairing, so the now-dead
        // multi-file auth dir MUST be wiped: otherwise the next connect() reloads the stale creds and
        // Baileys silently retries them instead of emitting a new QR, leaving the session stuck (no QR).
        this.setStatus(EngineStatus.DISCONNECTED);
        this.sock = null;
        void clearAuthState(this.authPath, this.logger);
        this.callbacks.onDisconnected?.('logged out');
        return;
      }

      // Recoverable (e.g. restartRequired right after pairing, transient drop) — reconnect with backoff.
      // Do NOT fire onDisconnected here; this is a transient drop, not a terminal disconnect.
      // connect() calls setStatus(INITIALIZING) which fires onStateChanged — that is the correct signal.
      this.logger.log('Baileys connection dropped; reconnecting', { statusCode });

      // I4: capped exponential backoff with in-flight timer guard.
      if (decision.kind === 'exhausted') {
        this.setStatus(EngineStatus.FAILED);
        this.callbacks.onError?.(`reconnect attempts exhausted (${this.reconnectAttempts})`);
        return;
      }
      this.reconnectAttempts = decision.attempt;
      // Guard: if a timer is already pending, don't stack another one.
      if (this.reconnectTimer) {
        return;
      }
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        if (this.intentionalClose) {
          return; // stopped while waiting — abort
        }
        void this.connect().catch(err => {
          this.setStatus(EngineStatus.FAILED);
          this.callbacks.onError?.(err instanceof Error ? err.message : String(err));
        });
      }, decision.delayMs);
    }
  }

  /** Render the raw Baileys QR ref to a PNG data URL, then publish it (mirrors the whatsapp-web.js engine). */
  private async handleQrCode(qr: string): Promise<void> {
    try {
      this.qrCode = await qrcode.toDataURL(qr);
      this.setStatus(EngineStatus.QR_READY);
      this.callbacks.onQRCode?.(this.qrCode);
    } catch (error) {
      this.logger.error('Error generating QR code', String(error));
    }
  }

  disconnect(): Promise<void> {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.sock?.end(undefined);
    this.sock = null;
    this.setStatus(EngineStatus.DISCONNECTED);
    return Promise.resolve();
  }

  async logout(): Promise<void> {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    try {
      await this.sock?.logout();
    } catch (err) {
      this.logger.warn('Baileys logout failed; ending socket', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.sock?.end(undefined);
    }
    this.sock = null;
    this.setStatus(EngineStatus.DISCONNECTED);
    await this.config.messageStore?.clearSession(this.config.dbSessionId).catch(() => undefined);
    // Wipe the multi-file auth dir so a fresh link starts clean — stale creds would otherwise be
    // reloaded on the next connect() and block re-linking (Baileys retries them, no QR emitted).
    await clearAuthState(this.authPath, this.logger);
  }

  destroy(): Promise<void> {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.sock?.end(undefined);
    this.sock = null;
    this.setStatus(EngineStatus.DISCONNECTED);
    return Promise.resolve();
  }

  // Baileys has no separate Chromium process to SIGKILL (destroy() already ends the socket
  // synchronously), so a force-destroy is just a destroy.
  forceDestroy(): Promise<void> {
    return this.destroy();
  }

  // ----- Status -----

  getStatus(): EngineStatus {
    return this.status;
  }

  getQRCode(): string | null {
    return this.qrCode;
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    if (!this.sock) {
      throw new EngineNotReadyError('Cannot request a pairing code before the engine is initialized.');
    }
    return this.sock.requestPairingCode(phoneNumber);
  }

  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  getPushName(): string | null {
    return this.pushName;
  }

  // ----- Messaging -----

  async sendTextMessage(chatId: string, text: string, mentions?: string[]): Promise<MessageResult> {
    this.ensureReady();
    const jid = await toDeliverableJid(this.sendCtx, chatId);
    const options = withEphemeral(this.sendCtx, jid);
    const content = { text, ...this.withMentions(mentions) };
    const sent = options
      ? await this.sock!.sendMessage(jid, content, options)
      : await this.sock!.sendMessage(jid, content);
    if (sent) {
      void this.config.messageStore?.put(this.config.dbSessionId, sent).catch(err =>
        this.logger.warn('Failed to persist sent message to store', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      // Parity with the wwjs engine's message_create → message.sent (see emitOwnSendEcho).
      void emitOwnSendEcho(this.sendCtx, sent);
    }
    return {
      id: sent?.key?.id ?? '',
      timestamp: toUnixSeconds(sent?.messageTimestamp),
    };
  }

  async checkNumberExists(number: string): Promise<boolean> {
    return (await this.getNumberId(number)) !== null;
  }

  async getNumberId(number: string): Promise<string | null> {
    this.ensureReady();
    const results = await this.sock!.onWhatsApp(number);
    const hit = results?.[0];
    // Baileys returns a raw `<phone>@s.whatsapp.net`; neutralize it before it crosses the engine
    // boundary so the value matches whatsapp-web.js (`<phone>@c.us`) and the IWhatsAppEngine contract
    // (no raw `@s.whatsapp.net` in a neutral field). It also round-trips back to a send on either engine.
    return hit?.exists ? this.sessionStore.toNeutralJid(hit.jid) : null;
  }

  async sendChatState(chatId: string, state: ChatState): Promise<void> {
    this.ensureReady();
    const presence = state === 'typing' ? 'composing' : state === 'recording' ? 'recording' : 'paused';
    try {
      await this.sock!.sendPresenceUpdate(presence, await toDeliverableJid(this.sendCtx, chatId));
    } catch (error) {
      // Presence is best-effort — a failure here must never surface as a 500 on the direct typing
      // endpoint or MCP tool (mirrors the whatsapp-web.js adapter; #583 R4). A migrated contact can
      // yield `No LID for user` on the presence path even when the actual send succeeds.
      this.logger.warn(`Could not set chat state '${state}' for ${chatId} (best-effort)`, { error: String(error) });
    }
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const { data, mimetype } = await resolveMediaBuffer(media);
    return sendContent(this.sendCtx, chatId, {
      image: data,
      caption: media.caption,
      mimetype,
      ...this.withMentions(media.mentions),
    });
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const { data, mimetype } = await resolveMediaBuffer(media);
    return sendContent(this.sendCtx, chatId, {
      video: data,
      caption: media.caption,
      mimetype,
      ...this.withMentions(media.mentions),
    });
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const { data, mimetype } = await resolveMediaBuffer(media);
    return sendContent(this.sendCtx, chatId, { audio: data, mimetype, ptt: media.ptt ?? false });
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const { data, mimetype } = await resolveMediaBuffer(media);
    return sendContent(this.sendCtx, chatId, {
      document: data,
      mimetype,
      fileName: media.filename ?? 'file',
      caption: media.caption,
      ...this.withMentions(media.mentions),
    });
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    this.ensureReady();
    const { data } = await resolveMediaBuffer(media);
    return sendContent(this.sendCtx, chatId, { sticker: data });
  }

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    this.ensureReady();
    return sendContent(this.sendCtx, chatId, {
      location: {
        degreesLatitude: location.latitude,
        degreesLongitude: location.longitude,
        name: location.description,
        address: location.address,
      },
    });
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    this.ensureReady();
    return sendContent(this.sendCtx, chatId, {
      contacts: { displayName: contact.name, contacts: [{ vcard: buildVCard(contact) }] },
    });
  }

  async sendPollMessage(chatId: string, poll: PollInput): Promise<MessageResult> {
    this.ensureReady();
    // selectableCount 1 = single choice; 0 = no limit, which is how WhatsApp expresses
    // "allow multiple answers". Baileys generates the poll's messageSecret itself.
    return sendContent(this.sendCtx, chatId, {
      poll: {
        name: poll.name,
        values: poll.options,
        selectableCount: poll.allowMultipleAnswers ? 0 : 1,
      },
    });
  }

  async replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    this.ensureReady();
    const quoted = await requireStored(this.sendCtx, quotedMsgId);
    return sendContent(this.sendCtx, chatId, { text }, { quoted });
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    this.ensureReady();
    const forward = await requireStored(this.sendCtx, messageId);
    return sendContent(this.sendCtx, toChatId, { forward });
  }

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    this.ensureReady();
    const target = await requireStored(this.sendCtx, messageId);
    await this.sock!.sendMessage(chatId, { react: { text: emoji, key: target.key } });
  }

  async deleteMessage(chatId: string, messageId: string, forEveryone = true): Promise<void> {
    this.ensureReady();
    const target = await requireStored(this.sendCtx, messageId);
    if (forEveryone) {
      await this.sock!.sendMessage(chatId, { delete: target.key });
      return;
    }
    // Delete-for-me (revoke on this device only): Baileys exposes it as a chat modification, not a
    // sendMessage. The stored message timestamp (epoch seconds) is part of the payload.
    await this.sock!.chatModify(
      {
        deleteForMe: {
          deleteMedia: true,
          key: target.key,
          timestamp: toUnixSeconds(target.messageTimestamp),
        },
      },
      chatId,
    );
  }

  // ----- Groups -----

  async getGroups(): Promise<Group[]> {
    this.ensureReady();
    const all = await this.sock!.groupFetchAllParticipating();
    const self = this.normalizedSelfJid();
    return Object.values(all).map(metadata =>
      mapBaileysGroup(metadata, self, jid => this.sessionStore.toNeutralJid(jid)),
    );
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    this.ensureReady();
    try {
      const metadata = await this.sock!.groupMetadata(groupId);
      return mapBaileysGroupInfo(metadata, jid => this.sessionStore.toNeutralJid(jid));
    } catch (err) {
      this.logger.debug('groupMetadata failed; treating as not-found', {
        groupId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null; // not a group / not found
    }
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    this.ensureReady();
    const metadata = await this.sock!.groupCreate(name, this.toEngineParticipants(participants));
    return mapBaileysGroup(metadata, this.normalizedSelfJid(), jid => this.sessionStore.toNeutralJid(jid));
  }

  async addParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    await this.sock!.groupParticipantsUpdate(groupId, this.toEngineParticipants(participants), 'add');
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    await this.sock!.groupParticipantsUpdate(groupId, this.toEngineParticipants(participants), 'remove');
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    await this.sock!.groupParticipantsUpdate(groupId, this.toEngineParticipants(participants), 'promote');
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<void> {
    this.ensureReady();
    await this.sock!.groupParticipantsUpdate(groupId, this.toEngineParticipants(participants), 'demote');
  }

  /**
   * Fold neutral `<phone>@c.us` participant ids back to the engine wire dialect (`@s.whatsapp.net`) before
   * a group write. `@lid` (a first-class addressing mode) and the group id itself are left untouched.
   */
  private toEngineParticipants(participants: string[]): string[] {
    return participants.map(p => this.sessionStore.toEngineJid(p));
  }

  /**
   * Build the `{ mentions }` slice of a Baileys message content, de-normalizing neutral `@c.us` WIDs to
   * the engine dialect. Returns an empty object when none are given so the content is byte-identical to
   * the pre-#530 send (no stray `mentions` key). The text must still contain the `@<number>` token for
   * WhatsApp to render the tag — that is the caller's responsibility.
   */
  private withMentions(mentions?: string[]): { mentions?: string[] } {
    return mentions?.length ? { mentions: this.toEngineParticipants(mentions) } : {};
  }

  async leaveGroup(groupId: string): Promise<void> {
    this.ensureReady();
    await this.sock!.groupLeave(groupId);
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    this.ensureReady();
    await this.sock!.groupUpdateSubject(groupId, subject);
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    this.ensureReady();
    await this.sock!.groupUpdateDescription(groupId, description);
  }

  async getGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    return (await this.sock!.groupInviteCode(groupId)) ?? '';
  }

  async revokeGroupInviteCode(groupId: string): Promise<string> {
    this.ensureReady();
    return (await this.sock!.groupRevokeInvite(groupId)) ?? '';
  }

  async getProfilePicture(contactId: string): Promise<string | null> {
    this.ensureReady();
    try {
      return (await this.sock!.profilePictureUrl(contactId, 'image')) ?? null;
    } catch (err) {
      this.logger.debug('profilePictureUrl failed; no picture or hidden', {
        contactId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null; // no picture set, or hidden by privacy
    }
  }

  async blockContact(contactId: string): Promise<void> {
    this.ensureReady();
    await this.sock!.updateBlockStatus(contactId, 'block');
  }

  async unblockContact(contactId: string): Promise<void> {
    this.ensureReady();
    await this.sock!.updateBlockStatus(contactId, 'unblock');
  }

  // ----- Contacts & chats -----

  // eslint-disable-next-line @typescript-eslint/require-await
  async getContacts(): Promise<Contact[]> {
    this.ensureReady();
    return this.sessionStore.listContacts();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getContactById(contactId: string): Promise<Contact | null> {
    this.ensureReady();
    return this.sessionStore.findContact(contactId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async resolveContactPhone(contactId: string): Promise<string | null> {
    this.ensureReady();
    return this.sessionStore.resolvePhone(contactId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getChats(): Promise<ChatSummary[]> {
    this.ensureReady();
    return this.sessionStore.listChats();
  }

  async sendSeen(chatId: string): Promise<boolean> {
    this.ensureReady();
    const last = this.sessionStore.lastMessage(chatId);
    if (!last) {
      return false; // nothing known to mark read
    }
    await this.sock!.readMessages([last.key]);
    return true;
  }

  async markUnread(chatId: string): Promise<boolean> {
    this.ensureReady();
    const last = this.sessionStore.lastMessage(chatId);
    if (!last) {
      return false; // Baileys' unread toggle needs the last message; can't synthesize it
    }
    await this.sock!.chatModify(
      { markRead: false, lastMessages: [{ key: last.key, messageTimestamp: last.timestamp }] },
      chatId,
    );
    return true;
  }

  async deleteChat(chatId: string): Promise<boolean> {
    this.ensureReady();
    const last = this.sessionStore.lastMessage(chatId);
    if (!last) {
      return false; // Baileys' delete needs the last message; can't synthesize it
    }
    await this.sock!.chatModify(
      { delete: true, lastMessages: [{ key: last.key, messageTimestamp: last.timestamp }] },
      chatId,
    );
    return true;
  }

  // ----- Gated: not supported by this minimal slice (no store) -----
  /* eslint-disable @typescript-eslint/no-unused-vars */

  getMessageReactions(_chatId: string, _messageId: string): Promise<MessageReaction[]> {
    return this.unsupported('getMessageReactions');
  }
  getChatHistory(_chatId: string, _limit?: number, _includeMedia?: boolean): Promise<IncomingMessage[]> {
    return this.unsupported('getChatHistory');
  }
  getLabels(): Promise<Label[]> {
    return this.unsupported('getLabels');
  }
  getLabelById(_labelId: string): Promise<Label | null> {
    return this.unsupported('getLabelById');
  }
  getChatLabels(_chatId: string): Promise<Label[]> {
    return this.unsupported('getChatLabels');
  }
  // WhatsApp Business only — Baileys rejects these on personal accounts. The label must already
  // exist (use getLabels on an engine that lists them); addChatLabel/removeChatLabel associate it
  // with a chat, they do not create/edit the label definition.
  async addLabelToChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    await this.sock!.addChatLabel(chatId, labelId);
  }
  async removeLabelFromChat(chatId: string, labelId: string): Promise<void> {
    this.ensureReady();
    await this.sock!.removeChatLabel(chatId, labelId);
  }
  getSubscribedChannels(): Promise<Channel[]> {
    return this.unsupported('getSubscribedChannels');
  }
  async getChannelById(channelId: string): Promise<Channel | null> {
    this.ensureReady();
    // newsletterMetadata resolves ANY channel by jid (richer than the wwjs subscribed-list lookup).
    const meta = await this.sock!.newsletterMetadata('jid', channelId);
    return meta ? this.toChannel(meta) : null;
  }

  async subscribeToChannel(inviteCode: string): Promise<Channel> {
    this.ensureReady();
    const meta = await this.sock!.newsletterMetadata('invite', inviteCode);
    if (!meta) {
      throw new ChannelNotFoundError(inviteCode);
    }
    await this.sock!.newsletterFollow(meta.id);
    return this.toChannel(meta);
  }

  async unsubscribeFromChannel(channelId: string): Promise<void> {
    this.ensureReady();
    await this.sock!.newsletterUnfollow(channelId);
  }

  // getChannelMessages is not wired: Baileys' newsletterFetchMessages returns the RAW query
  // BinaryNode with no library parser, so mapping it to ChannelMessage[] needs a verified
  // BinaryNode walk (or a live spike) that can't be validated without a WhatsApp session. Kept as a
  // documented adapter-gap in the engine capability matrix rather than shipped as an unverified walk.
  getChannelMessages(_channelId: string, _limit?: number): Promise<ChannelMessage[]> {
    return this.unsupported('getChannelMessages');
  }

  /** Map a Baileys NewsletterMetadata to the neutral Channel shape (optionals only when present). */
  private toChannel(meta: {
    id: string;
    name: string;
    description?: string;
    invite?: string;
    creation_time?: number;
    subscribers?: number;
    picture?: { url?: string };
    verification?: string;
    thread_metadata?: { creation_time?: number };
  }): Channel {
    const createdAt = meta.creation_time ?? meta.thread_metadata?.creation_time;
    return {
      id: meta.id,
      name: meta.name,
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.invite ? { inviteCode: meta.invite } : {}),
      ...(meta.subscribers !== undefined ? { subscriberCount: meta.subscribers } : {}),
      ...(meta.picture?.url ? { picture: meta.picture.url } : {}),
      ...(meta.verification ? { verified: meta.verification === 'VERIFIED' } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
    };
  }
  getContactStatuses(): Promise<Status[]> {
    return this.unsupported('getContactStatuses');
  }
  getContactStatus(_contactId: string): Promise<Status[]> {
    return this.unsupported('getContactStatus');
  }
  postTextStatus(text: string, options: StatusPostOptions): Promise<StatusResult> {
    return postStatus(this.sendCtx, { text }, options);
  }
  postImageStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.postMediaStatus('image', media, options);
  }
  postVideoStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult> {
    return this.postMediaStatus('video', media, options);
  }
  private async postMediaStatus(
    kind: 'image' | 'video',
    media: MediaInput,
    options: StatusPostOptions,
  ): Promise<StatusResult> {
    this.ensureReady();
    const { data, mimetype } = await resolveMediaBuffer(media);
    const content: AnyMessageContent =
      kind === 'image'
        ? { image: data, caption: options.caption, mimetype }
        : { video: data, caption: options.caption, mimetype };
    return postStatus(this.sendCtx, content, options);
  }
  /**
   * Best-effort status revoke. Unlike deleteMessage, status messages are NOT persisted, so the revoke
   * key must be constructed from statusId alone (no messageStore lookup). The participant is the
   * engine-dialect self JID (`<me>@s.whatsapp.net`). The revoke shape is empirically UNVERIFIED — the
   * live spike only tested posting; if WhatsApp rejects it, fall back to EngineNotSupportedError.
   */
  async deleteStatus(statusId: string): Promise<void> {
    this.ensureReady();
    await this.sock!.sendMessage('status@broadcast', {
      delete: {
        remoteJid: 'status@broadcast',
        fromMe: true,
        id: statusId,
        participant: this.sessionStore.toEngineJid(this.normalizedSelfJid()),
      },
    });
  }
  getCatalog(): Promise<Catalog | null> {
    return this.unsupported('getCatalog');
  }
  getProducts(_options?: ProductQueryOptions): Promise<PaginatedProducts> {
    return this.unsupported('getProducts');
  }
  getProduct(_productId: string): Promise<Product | null> {
    return this.unsupported('getProduct');
  }
  sendProduct(_chatId: string, _productId: string, _body?: string): Promise<MessageResult> {
    return this.unsupported('sendProduct');
  }
  sendCatalog(_chatId: string, _body?: string): Promise<MessageResult> {
    return this.unsupported('sendCatalog');
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */

  // ----- Helpers -----

  private handleMessagesUpsert(event: { messages: WAMessage[]; type: string }): void {
    for (const msg of event.messages) {
      if (!msg.message || !msg.key?.remoteJid) {
        continue; // protocol/empty messages carry no neutral content
      }
      if (event.type !== 'notify') {
        // Baileys echoes back OUR OWN just-sent messages through this same 'append' path too, and
        // sendContent() already emits onMessageCreate for those via emitOwnSendEcho() — always
        // exclude fromMe here (unconditionally, regardless of timestamp) so that echo doesn't fire
        // onMessageCreate a second time.
        if (msg.key.fromMe === true) {
          continue;
        }
        // For everyone else: gate on the message's own timestamp vs. this connection's open time,
        // not the upsert batch's `type` tag. `type: 'append'` usually means real history-sync
        // backfill, but Baileys can also tag a genuinely new CUSTOMER message 'append' when it
        // arrives in the same window as a reconnect's state-sync handshake — a strict
        // `type !== 'notify'` filter silently drops that message (observed as "the first message
        // after a reconnect gets ignored"). A message sent AFTER this connection opened is live
        // regardless of which tag the batch carries; true backfill always predates it.
        if (toUnixSeconds(msg.messageTimestamp) < this.connectedAt) {
          continue;
        }
      } else if (msg.key.fromMe === true && this.consumeOwnSendEcho(msg.key.id)) {
        // notify echo of a message WE just sent via the API — emitOwnSendEcho already fired
        // onMessageCreate for it. Skip so the own-send doesn't emit twice. A fromMe notify NOT in the
        // echo set is a genuine phone-originated send (no API call, no prior echo) and falls through.
        continue;
      }
      // Throttle through the limiter so a burst of media messages can't run unbounded parallel
      // downloads (each a full decrypted buffer in heap). Ordering stays correct — the message store
      // keeps the newest by timestamp. When the waiter queue is saturated we REJECT instead of parking
      // forever, and re-process the message WITHOUT media: the message (body + metadata) is still
      // emitted, but we skip the heap-heavy download that the limiter exists to bound.
      void this.inboundLimiter
        .run(() => this.processInboundMessage(msg))
        .catch(() => {
          this.logger.warn('Inbound media limiter saturated; emitting message without media', {
            msgId: msg.key?.id ?? 'unknown',
          });
          return this.processInboundMessage(msg, { skipMedia: true });
        });
    }
  }

  /** Diagnostic: log a contacts event's size + whether records carry names/lids (and a small sample). */
  private logContactEvent(
    event: string,
    records: Array<{
      id?: string;
      name?: string;
      notify?: string;
      verifiedName?: string;
      lid?: string;
      jid?: string;
    }> = [],
  ): void {
    const list = records ?? [];
    this.logger.debug('Baileys contacts event', {
      action: 'baileys_contacts',
      event,
      count: list.length,
      withName: list.filter(r => r.name || r.notify || r.verifiedName).length,
      withLid: list.filter(r => r.lid).length,
      sample: list.slice(0, 3).map(r => ({ id: r.id, name: r.name, notify: r.notify, lid: r.lid, jid: r.jid })),
    });
  }

  private async processInboundMessage(msg: WAMessage, opts?: { skipMedia?: boolean }): Promise<void> {
    try {
      const b = await this.loadLib();
      const remoteJid = msg.key.remoteJid!;
      // Learn any lid->pn pair the key carries BEFORE canonicalizing ids below, so a fresh @lid
      // sender resolves to its phone in this message and for later contact lookups (#362). The pairs
      // also write through to the persistent lid->phone table via addLidMappings.
      this.sessionStore.recordKeyLidMappings(msg.key);
      // A live disappearing message (also viewOnce / documentWithCaption / edited) arrives wrapped, so the
      // raw `getContentType` returns the OUTER wrapper key (e.g. 'ephemeralMessage') and downstream type/
      // body/media/location detection would miss the real inner content. Normalize ONCE so the true inner
      // type drives routing here AND mapMessage. normalizeMessageContent leaves protocolMessage and
      // reactionMessage untouched, so the early-return branches below still match.
      const normalizedRoot = b.normalizeMessageContent(msg.message ?? undefined) ?? msg.message ?? undefined;
      const contentType = b.getContentType(normalizedRoot);

      // --- protocolMessage REVOKE: don't emit onMessage ---
      if (contentType === 'protocolMessage') {
        const pm = msg.message?.protocolMessage;
        if (pm?.type === b.proto.Message.ProtocolMessage.Type.REVOKE) {
          const from = msg.key.fromMe === true ? this.normalizedSelfJid() : remoteJid;
          const to = msg.key.fromMe === true ? remoteJid : this.normalizedSelfJid();
          const revoked: RevokedMessage = {
            id: pm.key?.id ?? '',
            // The REVOKE protocolMessage's key points at the ORIGINAL deleted message,
            // so `id` already IS the original here. Mirror it into `revokedId` so that
            // field is the reliable cross-engine handle (wwebjs sets it separately).
            revokedId: pm.key?.id ?? undefined,
            chatId: this.sessionStore.toNeutralJid(remoteJid),
            from: this.sessionStore.toNeutralJid(from),
            to: this.sessionStore.toNeutralJid(to),
            type: 'revoked',
            body: '',
            timestamp: toUnixSeconds(msg.messageTimestamp),
          };
          this.callbacks.onMessageRevoked?.(revoked);
          return;
        }
        // Other protocol messages (ephemeral, history sync, etc.) — skip silently.
        return;
      }

      // --- reactionMessage: don't emit onMessage ---
      if (contentType === 'reactionMessage') {
        const rm = msg.message?.reactionMessage;
        const event: ReactionEvent = {
          messageId: rm?.key?.id ?? '',
          chatId: this.sessionStore.toNeutralJid(remoteJid),
          reaction: rm?.text ?? '',
          senderId: this.sessionStore.toNeutralJid(msg.key.participant ?? remoteJid),
        };
        this.callbacks.onMessageReaction?.(event);
        return;
      }

      // --- Normal message: enrich + emit ---
      const incoming = await mapMessage(this.mapperCtx, msg, contentType, { skipMediaDownload: opts?.skipMedia });
      if (msg.key.fromMe === true) {
        this.callbacks.onMessageCreate?.(incoming);
      } else {
        this.callbacks.onMessage?.(incoming);
      }
      void this.config.messageStore?.put(this.config.dbSessionId, msg).catch(err =>
        this.logger.warn('Failed to persist message to store', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      this.sessionStore.recordMessage(msg);
    } catch (err) {
      this.logger.error(
        `Unhandled error processing inbound message (id=${msg.key?.id ?? 'unknown'}); dropping`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private handleMessagesUpdate(
    updates: Array<{ key?: { id?: string | null }; update?: { status?: number | null } }>,
  ): void {
    for (const u of updates) {
      const status = mapBaileysStatus(u.update?.status);
      if (status && u.key?.id) {
        this.callbacks.onMessageAck?.(u.key.id, status);
      }
    }
  }

  /**
   * Download inbound media via a stream, accumulating chunks but ABORTING (destroy + discard) once the
   * running total exceeds `maxBytes`. Returns null on abort. Uses `downloadMediaMessage(..., 'stream')`
   * (not the raw `downloadContentFromMessage`) so the library's expired-media re-upload retry is kept;
   * for under-cap media the concatenated buffer is byte-identical to the 'buffer' mode it replaces.
   */
  private async downloadInboundMediaCapped(msg: WAMessage, maxBytes: number): Promise<Buffer | null> {
    // Hold the stream handle in the outer scope so the timeout can destroy it. A genuine
    // download/read error still rejects (propagating to the caller's catch as before); only a
    // wall-clock timeout or the byte-cap overflow resolves to null.
    let stream: (AsyncIterable<Buffer> & { destroy?: () => void }) | undefined;
    const download = (async (): Promise<Buffer | null> => {
      const b = await this.loadLib();
      stream = (await b.downloadMediaMessage(
        msg,
        'stream',
        {},
        {
          logger: createSilentLogger(),
          reuploadRequest: this.sock!.updateMediaMessage,
        },
      )) as AsyncIterable<Buffer> & { destroy?: () => void };

      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream) {
        total += chunk.length;
        if (total > maxBytes) {
          stream.destroy?.();
          return null;
        }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    })();

    // A slow/trickling sender never trips the byte cap, so without a deadline it pins a concurrency
    // slot (and, on Baileys, the whole inbound handler) indefinitely. On timeout, destroy the stream
    // and treat it as no usable media (same null the cap-abort returns).
    return withInboundDownloadTimeout(download, inboundMediaTimeoutMs(), () => stream?.destroy?.());
  }

  /**
   * Persist the bulk history Baileys pushes on connect (`messaging-history.set`) - the only
   * pre-connection history source. Maps each message media-free and hands the batch to the dispatch-free
   * `onHistoryMessages` callback, harvesting `pushName` into contacts on the way (history `contacts`
   * carry no names) and seeding each chat's last-message preview.
   */
  private async captureHistoryMessages(messages: WAMessage[]): Promise<void> {
    if (!messages.length) {
      return;
    }
    const b = await this.loadLib();
    const nameUpdates: { id: string; notify: string }[] = [];
    const mapped: IncomingMessage[] = [];
    for (const msg of messages) {
      if (msg.key?.fromMe !== true && msg.pushName) {
        const sender = msg.key?.participant ?? msg.key?.remoteJid;
        if (sender) {
          nameUpdates.push({ id: sender, notify: msg.pushName });
        }
      }
      // Seed the chat's last-message preview + sort time (newest wins); else history-only chats
      // would read "No messages yet".
      this.sessionStore.recordMessage(msg);
      const incoming = mapHistoryMessage(this.mapperCtx, b, msg);
      if (incoming) {
        mapped.push(incoming);
      }
    }
    if (nameUpdates.length) {
      this.sessionStore.upsertContacts(nameUpdates);
    }
    if (mapped.length) {
      this.callbacks.onHistoryMessages?.(mapped);
    }
  }

  /**
   * Backfill chat/contact display names after connect. Baileys 6.7.x often skips the initial app-state
   * sync (the state machine goes Online before it runs) and the PUSH_NAME sync can fail to decrypt, so
   * names never arrive. Fetch group subjects (reliable) and best-effort re-trigger the app-state sync;
   * both are non-fatal, and DM push-names still arrive via `contacts.update` on live messages.
   */
  private async hydrateNames(): Promise<void> {
    try {
      const groups = await this.sock!.groupFetchAllParticipating();
      const named = Object.values(groups)
        .filter(g => g?.id && g.subject)
        .map(g => ({ id: g.id, name: g.subject }));
      if (named.length) {
        this.sessionStore.upsertChats(named);
        this.logger.debug('Hydrated group names', { action: 'baileys_hydrate_groups', count: named.length });
      }
    } catch (err) {
      this.logger.warn('Group name hydration failed', { error: err instanceof Error ? err.message : String(err) });
    }
    try {
      const b = await this.loadLib();
      await this.sock!.resyncAppState(b.ALL_WA_PATCH_NAMES, false);
      this.logger.debug('Re-synced app state for contact names', { action: 'baileys_resync_appstate' });
    } catch (err) {
      this.logger.warn('App-state resync for contact names failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Collaborators for the inbound mappers. Rebuilt per access and passing `sock`-reading operations as
   * closures, so a reconnect's new socket is always picked up (never snapshotted).
   */
  private get mapperCtx(): InboundMapperCtx {
    return {
      loadLib: () => this.loadLib(),
      sessionStore: this.sessionStore,
      logger: this.logger,
      normalizedSelfJid: () => this.normalizedSelfJid(),
      downloadMedia: (msg, maxBytes) => this.downloadInboundMediaCapped(msg, maxBytes),
    };
  }

  /**
   * Collaborators for the outbound send pipeline. Rebuilt per access and passing sock/callbacks-reading
   * operations as closures, so a reconnect's new socket is always picked up (never snapshotted).
   */
  private get sendCtx(): AdapterSendCtx {
    return {
      sock: () => this.sock,
      sessionStore: this.sessionStore,
      config: this.config,
      logger: this.logger,
      loadLib: () => this.loadLib(),
      callbacks: () => this.callbacks,
      mapperCtx: () => this.mapperCtx,
      ensureReady: () => this.ensureReady(),
      markOwnSendEchoed: (id: string) => this.markOwnSendEchoed(id),
    };
  }

  /** Record an API-sent message id so its later 'notify' echo is skipped. Evicts entries older than
   *  60s on each insert — well past the sub-second echo window, so it never drops a live echo. */
  private markOwnSendEchoed(id: string): void {
    if (!id) return;
    const now = Date.now();
    for (const [key, ts] of this.echoedOwnSendIds) {
      if (now - ts > 60_000) this.echoedOwnSendIds.delete(key);
    }
    this.echoedOwnSendIds.set(id, now);
  }

  /** True (and forgets the id) if this id was an API send already echoed via emitOwnSendEcho. */
  private consumeOwnSendEcho(id: string | null | undefined): boolean {
    if (!id) return false;
    return this.echoedOwnSendIds.delete(id);
  }

  private normalizedSelfJid(): string {
    const phone = extractPhone(this.sock?.user?.id);
    return phone ? `${phone}@s.whatsapp.net` : '';
  }

  private unsupported(method: string): Promise<any> {
    return Promise.reject(new EngineNotSupportedError(method));
  }

  protected ensureReady(): void {
    if (this.status !== EngineStatus.READY || !this.sock) {
      throw new EngineNotReadyError();
    }
  }

  private setStatus(status: EngineStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    this.callbacks.onStateChanged?.(status);
  }
}
