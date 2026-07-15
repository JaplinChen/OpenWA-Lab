// WhatsApp Engine Interface - Abstract layer for WA engines
//
// Identity contract (the engine boundary is an anti-corruption layer for WhatsApp's id dialects):
// every JID an engine EMITS in a neutral field (`from` / `to` / `chatId` / `author` / contact + chat
// `id`, etc.) is in the NEUTRAL dialect, so application code never has to know which engine produced
// it. The neutral dialect is small:
//   - `<phone>@c.us`  a user known by phone (the raw `@s.whatsapp.net` form folds into this)
//   - `<id>@g.us`     a group
//   - `<lid>@lid`     a user known ONLY by privacy id - phone genuinely unknown (a first-class state)
//   - `status@broadcast` / `<id>@newsletter` / `<id>@broadcast`  special channels
//   - never `@s.whatsapp.net`, never a `:device` suffix
// Resolution rule: prefer `@c.us` (resolve a lid to its phone when the mapping is known), fall back to
// `@lid` only when it can't be resolved. See `engine/identity/wa-id.ts` for the shared implementation.
// (Ids the engine ACCEPTS - e.g. `sendTextMessage(chatId)` - may be neutral; the adapter de-normalizes
// to its own dialect. Full inbound + outbound conformance is being rolled out per-engine.)

// Engine-neutral data types live in a sibling module; re-exported so every importer resolves unchanged.
export * from './whatsapp-engine.types';
import type {
  MessageResult,
  MediaInput,
  IncomingMessage,
  Contact,
  Group,
  GroupInfo,
  ContactCard,
  LocationInput,
  PollInput,
  MessageReaction,
  Label,
  Status,
  StatusPostOptions,
  StatusResult,
  Channel,
  ChannelMessage,
  Catalog,
  Product,
  ProductQueryOptions,
  PaginatedProducts,
  ChatSummary,
  ChatState,
  DeliveryStatus,
  RevokedMessage,
  ReactionEvent,
} from './whatsapp-engine.types';

export enum EngineStatus {
  DISCONNECTED = 'disconnected',
  INITIALIZING = 'initializing',
  QR_READY = 'qr_ready',
  AUTHENTICATING = 'authenticating',
  READY = 'ready',
  FAILED = 'failed',
}

export interface EngineEventCallbacks {
  onQRCode?: (qr: string) => void;
  onReady?: (phone: string, pushName: string) => void;
  onMessage?: (message: IncomingMessage) => void;
  /**
   * Fired for messages the account itself created (outgoing) — including sends composed on a
   * linked phone, which the `message`/`onMessage` event never delivers. Used to emit `message.sent`.
   */
  onMessageCreate?: (message: IncomingMessage) => void;
  /**
   * Fired when the delivery status of an outgoing message advances. The adapter maps its native
   * delivery signal to the neutral `DeliveryStatus`, so consumers never see engine-specific codes.
   */
  onMessageAck?: (messageId: string, status: DeliveryStatus) => void;
  onMessageRevoked?: (message: RevokedMessage) => void;
  onMessageReaction?: (event: ReactionEvent) => void;
  /**
   * Bulk historical messages from an engine's initial sync (e.g. Baileys `messaging-history.set`).
   * They predate the live session, so consumers persist them for the chat view but must not dispatch.
   */
  onHistoryMessages?: (messages: IncomingMessage[]) => void;
  onDisconnected?: (reason: string) => void;
  onStateChanged?: (state: EngineStatus) => void;
  /**
   * Fired on a terminal initialization/authentication failure (e.g. Chromium
   * could not launch, or WhatsApp rejected the stored credentials). The engine
   * has already moved to FAILED; `reason` carries a human-readable cause that
   * callers may surface to operators. Distinct from `onDisconnected`, which is
   * recoverable and triggers reconnection.
   */
  onError?: (reason: string) => void;
}

export interface IWhatsAppEngine {
  // Lifecycle
  initialize(callbacks: EngineEventCallbacks): Promise<void>;
  disconnect(): Promise<void>; // Closes browser but keeps session (can reconnect without QR)
  logout(): Promise<void>; // Logs out and clears session data (requires QR scan again)
  destroy(): Promise<void>;
  // Force-kill THIS engine's own resources immediately (e.g. SIGKILL a wedged Chromium for a stuck
  // session), then best-effort graceful teardown — used to recover a session that destroy() can't.
  // Each adapter kills only its own resources (never a process-wide pkill).
  forceDestroy(): Promise<void>;

  // Status
  getStatus(): EngineStatus;
  getQRCode(): string | null;
  /** Request an 8-char pairing code to link via phone number instead of scanning the QR. */
  requestPairingCode(phoneNumber: string): Promise<string>;
  getPhoneNumber(): string | null;
  getPushName(): string | null;

  // Messaging - Basic
  sendTextMessage(chatId: string, text: string, mentions?: string[]): Promise<MessageResult>;
  sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult>;
  sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult>;
  sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult>;
  sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult>;

  // Messaging - Extended (Phase 3)
  sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult>;
  sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult>;
  sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult>;
  sendPollMessage(chatId: string, poll: PollInput): Promise<MessageResult>;

  // Reply & Forward
  replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult>;
  forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult>;

  // Reactions (Phase 3)
  reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void>;
  getMessageReactions(chatId: string, messageId: string): Promise<MessageReaction[]>;

  // Contacts
  getContacts(): Promise<Contact[]>;
  getContactById(contactId: string): Promise<Contact | null>;
  checkNumberExists(number: string): Promise<boolean>;
  /**
   * Resolve a phone number to its canonical chat id in the neutral dialect (`<phone>@c.us`), or null
   * if the number is not registered. The engine owns the JID scheme and returns it already neutralized,
   * so the value is engine-agnostic and round-trips back to a send on any engine.
   */
  getNumberId(number: string): Promise<string | null>;
  /**
   * Best-effort resolution of a contact id to a phone number (MSISDN digits), or `null` when the
   * engine cannot map it (e.g. a privacy `@lid` the account has never seen). The contact id is the
   * engine's native scheme; the adapter decides how to resolve it.
   */
  resolveContactPhone(contactId: string): Promise<string | null>;

  // Groups - Basic
  getGroups(): Promise<Group[]>;

  // Groups - Extended (Phase 3)
  getGroupInfo(groupId: string): Promise<GroupInfo | null>;
  createGroup(name: string, participants: string[]): Promise<Group>;
  addParticipants(groupId: string, participants: string[]): Promise<void>;
  removeParticipants(groupId: string, participants: string[]): Promise<void>;
  promoteParticipants(groupId: string, participants: string[]): Promise<void>;
  demoteParticipants(groupId: string, participants: string[]): Promise<void>;
  leaveGroup(groupId: string): Promise<void>;
  setGroupSubject(groupId: string, subject: string): Promise<void>;
  setGroupDescription(groupId: string, description: string): Promise<void>;
  getGroupInviteCode(groupId: string): Promise<string>;
  revokeGroupInviteCode(groupId: string): Promise<string>;

  // Message Operations
  deleteMessage(chatId: string, messageId: string, forEveryone?: boolean): Promise<void>;
  getChatHistory(chatId: string, limit?: number, includeMedia?: boolean): Promise<IncomingMessage[]>;

  // Contact Extended Operations
  getProfilePicture(contactId: string): Promise<string | null>;
  blockContact(contactId: string): Promise<void>;
  unblockContact(contactId: string): Promise<void>;

  // Labels (Phase 3) - WhatsApp Business only
  getLabels(): Promise<Label[]>;
  getLabelById(labelId: string): Promise<Label | null>;
  getChatLabels(chatId: string): Promise<Label[]>;
  addLabelToChat(chatId: string, labelId: string): Promise<void>;
  removeLabelFromChat(chatId: string, labelId: string): Promise<void>;

  // Channels/Newsletter (Phase 3)
  getSubscribedChannels(): Promise<Channel[]>;
  getChannelById(channelId: string): Promise<Channel | null>;
  subscribeToChannel(inviteCode: string): Promise<Channel>;
  unsubscribeFromChannel(channelId: string): Promise<void>;
  getChannelMessages(channelId: string, limit?: number): Promise<ChannelMessage[]>;

  // Status/Stories (Phase 3)
  getContactStatuses(): Promise<Status[]>;
  getContactStatus(contactId: string): Promise<Status[]>;
  postTextStatus(text: string, options: StatusPostOptions): Promise<StatusResult>;
  postImageStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult>;
  postVideoStatus(media: MediaInput, options: StatusPostOptions): Promise<StatusResult>;
  deleteStatus(statusId: string): Promise<void>;

  // Catalog (Phase 3) - WhatsApp Business only
  getCatalog(): Promise<Catalog | null>;
  getProducts(options?: ProductQueryOptions): Promise<PaginatedProducts>;
  getProduct(productId: string): Promise<Product | null>;
  sendProduct(chatId: string, productId: string, body?: string): Promise<MessageResult>;
  sendCatalog(chatId: string, body?: string): Promise<MessageResult>;

  // Chats
  getChats(): Promise<ChatSummary[]>;
  sendSeen(chatId: string): Promise<boolean>;
  markUnread(chatId: string): Promise<boolean>;
  deleteChat(chatId: string): Promise<boolean>;
  /**
   * Send a typing/recording presence indicator to a chat, or clear it (`paused`).
   * Engine-agnostic and best-effort: engines without a presence concept should no-op.
   */
  sendChatState(chatId: string, state: ChatState): Promise<void>;
}
