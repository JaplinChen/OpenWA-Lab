// zh<->vi language detection, prompt construction, and shared constants for the translate hook.
// Split out of translate.service.ts (pure — no service state).

// Invisible marker (ported from WA-Translate) prepended to bot output so the bot never re-translates
// its own messages. U+2063 is a zero-width invisible separator — it does not alter the visible text.
export const BOT_MARKER = '⁣⁣';

/**
 * Strip a reasoning model's chain-of-thought so only the final answer is sent to the group. Models like
 * qwen3 / deepseek-r1 wrap reasoning in `<think>...</think>`; Ollama sometimes emits only the closing
 * tag. Take whatever follows the last `</think>`; if a block was opened but never closed the output is
 * all reasoning with no answer, so return '' (lets the caller fall back / skip instead of spamming
 * reasoning). Plain outputs pass through untouched.
 */
export function stripThinking(s: string): string {
  const close = s.lastIndexOf('</think>');
  if (close !== -1) return s.slice(close + '</think>'.length).trim();
  if (/<think>/i.test(s)) return '';
  return s.trim();
}

const ZH_RE = /[㐀-鿿豈-﫿]/;
const VI_RE = /[ăâđêôơưĂÂĐÊÔƠƯáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;
// Vietnamese typed WITHOUT diacritics ("Bao cao dai duong") is pure ASCII, so VI_RE misses it and the
// message is silently never translated — common on phone keyboards. Match high-frequency Vietnamese
// function words instead. Every word here is deliberately one that is NOT an English word, so plain
// English is not misrouted into the vi->zh path (excludes look-alikes: the/la/co/va/cho/ban/con/may/
// dang/hang/sang/tin).
const VI_NO_TONE_RE =
  /\b(khong|duoc|nguoi|nhung|chua|biet|hieu|viec|cua|voi|truoc|hoac|neu|vay|nhieu|minh|giup|xin|gui|nhan|phai|muon|xong|luon|thang|duong|bao cao|cam on)\b/i;

export interface Pair {
  key: string; // glossary lookup key, matches WA-Translate glossary.json (e.g. "zh-tw:vi")
  source: string;
  targetLabel: string;
}
export const ZH_TO_VI: Pair = { key: 'zh-tw:vi', source: '繁體中文', targetLabel: '越南文 (Tiếng Việt)' };
export const VI_TO_ZH: Pair = { key: 'vi:zh-tw', source: '越南文', targetLabel: '繁體中文' };

/** Detect the zh<->vi translation direction for a message, or null when it is neither script. */
export function detectPair(text: string): Pair | null {
  const hasVi = VI_RE.test(text) || VI_NO_TONE_RE.test(text);
  const hasZh = ZH_RE.test(text);
  // Mixed (e.g. a Vietnamese message @-mentioning a Chinese name): decide by dominant script.
  // Checking ZH first would misread any Vietnamese message carrying a CJK name as Chinese and
  // never translate it to Chinese — the actual bug this guards against.
  if (hasVi && hasZh) {
    const cjk = (text.match(/[㐀-鿿豈-﫿]/g) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    return latin >= cjk ? VI_TO_ZH : ZH_TO_VI;
  }
  if (hasVi) return VI_TO_ZH;
  if (hasZh) return ZH_TO_VI;
  return null;
}

export const DEFAULT_PROMPT_TEMPLATE = [
  '你是專業翻譯引擎，只做翻譯。',
  '請把以下內容從 {source} 翻譯成 {target}。',
  '規則：',
  '1) 僅輸出翻譯結果，不要解釋。',
  '2) 保留人名、網址、程式碼、數字與專有名詞（術語表另有指定者除外）。',
  '3) 若原文主要不是可翻譯自然語言，回傳原文。',
  '{glossary}',
  '{text}',
].join('\n');

/** Build the translation prompt for the local model, injecting the glossary section for this pair. */
export function buildPrompt(text: string, pair: Pair, glossarySection: string, template?: string): string {
  return (template || DEFAULT_PROMPT_TEMPLATE)
    .replaceAll('{source}', pair.source)
    .replaceAll('{target}', pair.targetLabel)
    .replaceAll('{glossary}', glossarySection)
    .replaceAll('{text}', text);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
