import { MessageService } from '../message/message.service';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { Glossary } from './translate-glossary';
import { WatchwordStore } from './translate-watchwords';
import { FeedbackStore } from './translate-feedback';
import { BOT_MARKER } from './translate-lang';

/** Stores/services every chat command may need; the caller wires the shared singletons in. */
export interface CommandDeps extends GlossaryCommandDeps {
  watchwords: WatchwordStore;
  feedback: FeedbackStore;
}

/** Everything a command handler needs; built once per command by the caller. */
export interface CommandContext {
  deps: CommandDeps;
  sessionId: string;
  msg: IncomingMessage;
  raw: string; // full trimmed command text (handlers that re-split a batch use this)
  rest: string; // text after the prefix, trimmed
}

export interface CommandSpec {
  cmd: string;
  aliases: string[]; // matched as /<alias>; first is the canonical name
  handle: (ctx: CommandContext) => Promise<void>;
}

// Command registry. Adding a chat command = append one row + write its handler; parse and dispatch
// both drive off this table, so no if-chain or switch to touch. Aliases are plain words (no regex
// metacharacters), so joining them into the strip-prefix regex below is safe.
export const COMMANDS: CommandSpec[] = [
  {
    cmd: 'glossary',
    aliases: ['glossary', 'g'],
    handle: ctx => handleGlossaryCommand(ctx.deps, ctx.sessionId, ctx.msg, ctx.raw),
  },
  {
    cmd: 'watch',
    aliases: ['watch', 'w'],
    handle: ctx => handleWatchCommand(ctx),
  },
  {
    cmd: 'bad',
    aliases: ['bad'],
    handle: ctx => handleBadCommand(ctx),
  },
  {
    cmd: 'help',
    aliases: ['help', 'h'],
    handle: ctx => handleHelpCommand(ctx.deps.messageService, ctx.sessionId, ctx.msg),
  },
];

/** Single parse for chat commands; null = not a command (regular content). */
export function parseCommand(trimmed: string): { spec: CommandSpec; rest: string } | null {
  for (const spec of COMMANDS) {
    // /<alias> must be followed by whitespace (incl. newline, for pasted multi-line batches) or end.
    const prefix = new RegExp(`^/(?:${spec.aliases.join('|')})(?=\\s|$)\\s*`, 'i');
    if (prefix.test(trimmed)) return { spec, rest: trimmed.replace(prefix, '').trim() };
  }
  return null;
}

export const HELP_TEXT = [
  '指令一覽：',
  '建議詞彙：/g 詞 = nghĩa（管理員=直接新增）',
  '列出詞彙：/g',
  '待審清單：/g pending（管理員）',
  '核准建議：/g ok 編號（管理員）',
  '退回建議：/g no 編號（管理員）',
  '刪除詞彙：/g del 詞（管理員）',
  '關鍵字提醒：/watch add 關鍵字（命中時私訊你）',
  '列出提醒：/watch',
  '移除提醒：/watch del 關鍵字',
  '回報翻譯：引用譯文後輸入 /bad',
  '顯示說明：/help',
].join('\n');

export interface GlossaryCommandDeps {
  glossary: Glossary;
  adminIds: Set<string>;
  messageService: MessageService;
}

// Marker-prefixed reply so the bot never re-translates its own output. Admin allowlist (if set)
// gates mutating subcommands; the parsing/persistence lives in Glossary.
export async function handleGlossaryCommand(
  deps: GlossaryCommandDeps,
  sessionId: string,
  msg: IncomingMessage,
  raw: string,
): Promise<void> {
  // Each line may repeat the /g prefix (pasted batch adds); strip it per line.
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^\/(?:glossary|g)(?=\s|$)\s*/i, '').trim())
    .filter((l, i) => i === 0 || l !== '');
  const rest = lines[0] ?? '';
  const author = msg.author || msg.from;
  const canMutate = deps.adminIds.size === 0 || deps.adminIds.has(author);
  const batch = lines.length > 1 ? lines.filter((l) => l !== '') : lines;
  const reply = batch.map((l) => deps.glossary.command(l, canMutate, author)).join('\n');
  // ponytail: long lists (full glossary / pending queue) DM the author so they don't flood the
  // group; short results (add/suggest/ok/no/del acks, usage) reply in place.
  const isList = batch.length === 1 && (rest === '' || /^pending(?=\s|$)/i.test(rest));
  const target = msg.isGroup && isList ? author : msg.chatId;
  if (!target) return;
  await deps.messageService.sendText(sessionId, { chatId: target, text: BOT_MARKER + reply });
}

// Keyword alerts are per-user (each manages their own list), so no admin gate. The ack replies in the
// same chat where it was typed — always deliverable, unlike a DM to a watcher that may be an unresolved
// @lid. The MATCH alert (sent from the service) is what DMs the watcher.
export async function handleWatchCommand(ctx: CommandContext): Promise<void> {
  const watcher = ctx.msg.author || ctx.msg.from;
  if (!watcher || !ctx.msg.chatId) return;
  const reply = ctx.deps.watchwords.command(ctx.rest, watcher);
  await ctx.deps.messageService.sendText(ctx.sessionId, { chatId: ctx.msg.chatId, text: BOT_MARKER + reply });
}

// /bad — quote the bot's translation and report it as wrong. v1 just collects (read-only); the ring
// buffer recovers the original text, falling back to the quoted body when the send predates this run.
export async function handleBadCommand(ctx: CommandContext): Promise<void> {
  if (!ctx.msg.chatId) return;
  const reporter = ctx.msg.author || ctx.msg.from;
  const quoted = ctx.msg.quotedMessage;
  const send = (text: string): Promise<unknown> =>
    ctx.deps.messageService.sendText(ctx.sessionId, { chatId: ctx.msg.chatId, text: BOT_MARKER + text });
  if (!quoted?.id) {
    await send('請「引用」要回報的翻譯訊息，再輸入 /bad。');
    return;
  }
  const fallback = quoted.body.replace(BOT_MARKER, '').trim();
  const entry = ctx.deps.feedback.report(quoted.id, fallback, reporter);
  await send(`已記錄翻譯回饋，謝謝。原文：${entry.source || '（無法回溯，已記譯文）'}`);
}

export async function handleHelpCommand(
  messageService: MessageService,
  sessionId: string,
  msg: IncomingMessage,
): Promise<void> {
  const target = msg.chatId;
  if (!target) return;
  await messageService.sendText(sessionId, { chatId: target, text: BOT_MARKER + HELP_TEXT });
}
