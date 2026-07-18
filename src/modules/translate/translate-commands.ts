import { MessageService } from '../message/message.service';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { Glossary } from './translate-glossary';
import { BOT_MARKER } from './translate-lang';

export interface ParsedCommand {
  cmd: 'glossary' | 'help';
  rest: string;
}

/** Single parse for chat commands; null = not a command (regular content). */
export function parseCommand(trimmed: string): ParsedCommand | null {
  const lower = trimmed.toLowerCase();
  if (lower === '/glossary' || lower.startsWith('/glossary ') || lower === '/g' || lower.startsWith('/g ')) {
    return { cmd: 'glossary', rest: trimmed.replace(/^\/(?:glossary|g)(?=\s|$)\s*/i, '').trim() };
  }
  if (lower === '/help' || lower === '/h') return { cmd: 'help', rest: '' };
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
  const rest = raw.replace(/^\/(?:glossary|g)(?=\s|$)\s*/i, '').trim();
  const author = msg.author || msg.from;
  const canMutate = deps.adminIds.size === 0 || deps.adminIds.has(author);
  const reply = deps.glossary.command(rest, canMutate, author);
  // ponytail: long lists (full glossary / pending queue) DM the author so they don't flood the
  // group; short results (add/suggest/ok/no/del acks, usage) reply in place.
  const isList = rest === '' || /^pending(?=\s|$)/i.test(rest);
  const target = msg.isGroup && isList ? author : msg.chatId;
  if (!target) return;
  await deps.messageService.sendText(sessionId, { chatId: target, text: BOT_MARKER + reply });
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
