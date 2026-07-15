// Engine-neutral WhatsApp data types (messages, contacts, groups, statuses, channels, catalog).
// Split out of whatsapp-engine.interface.ts; re-exported from there so all importers resolve unchanged.
// See the identity contract in whatsapp-engine.interface.ts for the neutral JID dialect these use.

export interface MessageResult {
  id: string;
  timestamp: number;
}

export interface MediaInput {
  mimetype: string;
  data: Buffer | string; // Buffer or base64 or URL
  filename?: string;
  caption?: string;
  /** Neutral WIDs (`<phone>@c.us`) to @mention in the caption. The adapter de-normalizes per engine. */
  mentions?: string[];
  /** When true, send as a WhatsApp voice note (PTT). audio-only; ignored by other media types. */
  ptt?: boolean;
}

/**
 * Engine-neutral message type. Each adapter maps its library's native message-type tokens
 * (e.g. whatsapp-web.js `chat`/`ptt`/`vcard`) to this vocabulary at the adapter boundary,
 * so no consumer outside the adapter sees engine-specific type strings. `unknown` covers any
 * type the active engine reports that doesn't map to a first-class kind.
 */
export type MessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'voice'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'poll'
  | 'call'
  | 'revoked'
  // A message WhatsApp deliberately withheld from linked/companion devices (e.g. high-security
  // business OTPs): the payload is absent by design, not unparseable. See `mapBaileysMessageType`.
  | 'masked'
  | 'unknown';

export interface IncomingMessage {
  id: string;
  from: string;
  to: string;
  chatId: string;
  body: string;
  type: MessageType;
  timestamp: number;
  fromMe: boolean;
  isGroup: boolean;
  /**
   * True for a status/story broadcast (not a real conversation). Set by the adapter so engine-neutral
   * code can skip these without matching an engine-specific pseudo-JID (e.g. `status@broadcast`).
   */
  isStatusBroadcast?: boolean;
  /** WhatsApp ephemeral/disappearing-messages timer in seconds. Set per-chat on each message
   *  in the raw payload. 0 or undefined = no disappearing timer.
   *  Known values: 86400 (24h), 604800 (7d), 7776000 (90d). */
  ephemeralDuration?: number;
  /** For group messages, the WID of the participant who actually sent it (`from` is the group JID there). */
  author?: string;
  /** WIDs @mentioned in the message (empty/absent when none). Surfaced for command targeting. */
  mentionedIds?: string[];
  /** Set for `call` (call_log) messages: video vs voice, and whether an incoming call went unanswered. */
  call?: { video: boolean; missed: boolean };
  /**
   * Set by the adapter when the sender is identified by a privacy id (e.g. a WhatsApp `@lid`) rather
   * than a phone number, so engine-neutral code can decide whether to attempt phone resolution without
   * matching an engine-specific JID scheme.
   */
  isLidSender?: boolean;
  /**
   * Best-effort phone number (MSISDN digits) of the sender, resolved from a privacy id when inline
   * resolution is enabled (`RESOLVE_LID_TO_PHONE`). `null` when the engine cannot map it. Only
   * populated for `isLidSender` messages.
   */
  senderPhone?: string | null;
  /** Sender contact info, best-effort from the WhatsApp Web cache. Sync fields only (no network). */
  contact?: MessageContact;
  media?: {
    mimetype: string;
    filename?: string;
    data?: string; // base64; absent when the payload was omitted (see `omitted`)
    /** True when the media exceeded the inbound size cap and the blob was dropped (envelope kept). */
    omitted?: boolean;
    /** Decoded byte size of the media; always set when `omitted` is true. */
    sizeBytes?: number;
  };
  quotedMessage?: {
    id: string;
    body: string;
  };
  location?: {
    latitude: number;
    longitude: number;
    description?: string;
    address?: string;
    url?: string;
  };
}

/**
 * Synchronous (already-resolved, no network call) fields of a sender contact, surfaced on
 * {@link IncomingMessage}. Async getters (profile pic / about / formatted number) are intentionally
 * NOT included — they hit WhatsApp servers per message and risk rate-limit/ban. All optional; a key
 * is present only when the engine populated it.
 */
export interface MessageContact {
  /** Sender JID (`…@c.us` or a `…@lid` privacy id). */
  id?: string;
  /** Phone digits, best-effort. For `@lid` senders the authoritative number is `IncomingMessage.senderPhone`. */
  number?: string;
  name?: string;
  pushName?: string;
  shortName?: string;
  /** whatsapp-web.js contact type token. */
  type?: string;
  /** Saved in the account's address book. */
  isMyContact?: boolean;
  /** Is a WhatsApp user. */
  isWAContact?: boolean;
  isBusiness?: boolean;
  isEnterprise?: boolean;
  /** Business verified name. */
  verifiedName?: string;
  /** Business verification level. */
  verifiedLevel?: number;
  isBlocked?: boolean;
  /** Label IDs (CRM). Names are not resolved — that would need a network call. */
  labels?: string[];
}

export interface Contact {
  id: string;
  name?: string;
  pushName?: string;
  number: string;
  isMyContact: boolean;
  isBlocked: boolean;
  profilePicUrl?: string;
}

export interface Group {
  id: string;
  name: string;
  participantsCount?: number;
  isAdmin?: boolean;
  /** JID of the parent community this group is linked to, or null if standalone. */
  linkedParentJID?: string | null;
}

export interface GroupParticipant {
  id: string;
  number: string;
  name?: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

export interface GroupInfo {
  id: string;
  name: string;
  description?: string;
  owner?: string;
  createdAt?: number;
  participants: GroupParticipant[];
  isReadOnly?: boolean;
  isAnnounce?: boolean;
  /** JID of the parent community this group is linked to, or null if standalone. */
  linkedParentJID?: string | null;
}

export interface ContactCard {
  name: string;
  number: string;
}

export interface LocationInput {
  latitude: number;
  longitude: number;
  description?: string;
  address?: string;
}

export interface PollInput {
  /** Poll question / title. */
  name: string;
  /** Options to vote on (WhatsApp accepts between 2 and 12). */
  options: string[];
  /** When true a voter can pick several options; default is single choice. */
  allowMultipleAnswers?: boolean;
}

export interface ReactionSender {
  senderId: string;
  emoji: string;
  timestamp: number;
}

export interface MessageReaction {
  emoji: string;
  senders: ReactionSender[];
}

// Phase 3: Labels (WhatsApp Business)
export interface Label {
  id: string;
  name: string;
  hexColor: string;
}

// Phase 3: Status/Stories
export interface Status {
  id: string;
  contact: {
    id: string;
    name?: string;
    pushName?: string;
  };
  type: 'text' | 'image' | 'video';
  caption?: string;
  mediaUrl?: string;
  backgroundColor?: string;
  font?: number;
  timestamp: Date;
  expiresAt: Date;
}

export interface StatusPostOptions {
  /** REQUIRED. Neutral JIDs (@c.us / @lid) permitted to see the status. Maps to Baileys statusJidList. */
  recipients: string[];
  /** Hex background colour (#RRGGBB). Text status only. */
  backgroundColor?: string;
  /** Font index. Text status only. */
  font?: number;
  /** Caption. Image/video status only. */
  caption?: string;
}

export interface StatusResult {
  statusId: string;
  timestamp: Date;
  expiresAt: Date;
}

// Phase 3: Channels/Newsletter
export interface Channel {
  id: string;
  name: string;
  description?: string;
  inviteCode?: string;
  subscriberCount?: number;
  picture?: string;
  verified?: boolean;
  createdAt?: number;
}

export interface ChannelMessage {
  id: string;
  body: string;
  timestamp: number;
  hasMedia: boolean;
  mediaUrl?: string;
}

// Phase 3: Catalog (WhatsApp Business)
export interface Catalog {
  id: string;
  name: string;
  description?: string;
  productCount: number;
  url: string;
}

export interface Product {
  id: string;
  name: string;
  description?: string;
  price: number;
  currency: string;
  priceFormatted: string;
  imageUrl?: string;
  url: string;
  isAvailable: boolean;
  retailerId?: string;
}

export interface ProductQueryOptions {
  page?: number;
  limit?: number;
}

export interface PaginatedProducts {
  products: Product[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/**
 * Lightweight summary of a chat, exposed to the dashboard's real-time chats view.
 * Only library-agnostic primitives are leaked here; raw whatsapp-web.js objects are
 * mapped to this shape inside the adapter.
 */
export interface ChatSummary {
  id: string;
  name: string;
  isGroup: boolean;
  unreadCount: number;
  timestamp: number;
  lastMessage?: string;
}

/**
 * Engine-neutral chat presence state. `typing`/`recording` show the indicator to the chat;
 * `paused` clears it. Best-effort: engines without a presence concept may no-op.
 */
export type ChatState = 'typing' | 'recording' | 'paused';

/**
 * Engine-neutral message delivery status. Each adapter maps its native delivery signal
 * (e.g. whatsapp-web.js MessageAck integers, Baileys WAMessageStatus) to this vocabulary,
 * so no consumer outside the adapter sees engine-specific ack codes.
 */
export type DeliveryStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

/**
 * Structured payload for a remotely-revoked ("deleted for everyone") message.
 * The engine layer never emits a localized display string; `body` is intentionally
 * empty and the dashboard renders the localized "message deleted" text.
 */
export interface RevokedMessage {
  id: string;
  /**
   * Serialized id of the ORIGINAL message that was deleted (when available).
   *
   * This is the reliable cross-engine field for reconciling the deleted message in
   * your own storage — both adapters populate it with the original message id:
   *  - whatsapp-web.js: `id` is the revocation NOTIFICATION (a distinct message), so
   *    `id !== revokedId`. `revokedId` may be undefined when the original is not in
   *    the local store.
   *  - Baileys: the revoke arrives as a protocolMessage whose key already points at
   *    the original, so `id === revokedId`.
   *
   * Consumers should match on `revokedId` (falling back to `id`) rather than `id`.
   */
  revokedId?: string;
  chatId: string;
  from: string;
  to: string;
  type: 'revoked';
  body: '';
  timestamp: number;
}

export interface ReactionEvent {
  messageId: string;
  chatId: string;
  reaction: string;
  senderId: string;
}
