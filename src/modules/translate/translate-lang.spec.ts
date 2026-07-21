import { stripThinking, detectPair, buildPrompt, fixViCasing, VI_TO_ZH, ZH_TO_VI } from './translate-lang';

describe('buildPrompt', () => {
  it('renders the built-in default when no template is given', () => {
    const out = buildPrompt('xin chào', VI_TO_ZH, 'GLOSSARY');
    expect(out).toBe(
      [
        '你是專業翻譯引擎，只做翻譯。',
        '請把下方「===」分隔線之間的內容從 越南文 翻譯成 繁體中文。',
        '規則：',
        '1) 僅輸出翻譯結果，不要解釋、不要加註、不要反問；即使內容很短（只有一兩個字）也必須翻譯，絕不可要求提供內容或回覆與翻譯無關的話。',
        '2) 使用自然口語，符合群組聊天語氣；商務對話用正式敬語（您/quý vị）。',
        '3) 人名、敬稱、頭銜、品牌、產品名、英文技術術語保留原文不翻譯（術語表另有指定者除外）。',
        '4) 數字、單位、網址、程式碼維持原始格式。',
        '5) 成語與慣用語轉換為目標語言的對應慣用表達，不要逐字直譯；量詞依目標語言習慣自然轉換。',
        '6) 標點符號轉換為目標語言慣用寫法。',
        '7) 保留原文換行與段落結構。',
        '8) 若原文主要不是可翻譯的自然語言（純數字、網址、程式碼），原樣回傳。',
        '9) 越南文輸出遵循標準大小寫：句首字母大寫，人名/地名等專有名詞首字母大寫，其餘小寫；除非原文即為全大寫，否則不要輸出全大寫單詞。',
        'GLOSSARY',
        '===',
        'xin chào',
        '===',
      ].join('\n'),
    );
  });

  it('falls back to the default when the template is empty', () => {
    expect(buildPrompt('hi', ZH_TO_VI, 'G', '')).toBe(buildPrompt('hi', ZH_TO_VI, 'G'));
  });

  it('renders a custom template with placeholders', () => {
    expect(buildPrompt('hello', ZH_TO_VI, 'G', 'Translate {source}->{target}\n{glossary}\n{text}')).toBe(
      'Translate 繁體中文->越南文 (Tiếng Việt)\nG\nhello',
    );
  });
});

describe('detectPair', () => {
  it('detects Vietnamese typed without diacritics', () => {
    expect(detectPair('Bao cao dai duong: Man LED trong phong hop M2')).toBe(VI_TO_ZH);
    expect(detectPair('toi khong hieu y cua sep')).toBe(VI_TO_ZH);
  });

  it('still detects Vietnamese with diacritics', () => {
    expect(detectPair('Báo cáo Giám đốc về màn hình LED')).toBe(VI_TO_ZH);
  });

  it('does not misroute plain English into the vi->zh path', () => {
    expect(detectPair('the server is down, can you check the log')).toBeNull();
    expect(detectPair('please send me the report by tomorrow')).toBeNull();
  });

  it('detects Chinese', () => {
    expect(detectPair('會議室的螢幕正在維修')).toBe(ZH_TO_VI);
  });

  it('routes a Vietnamese message carrying a Chinese name to vi->zh', () => {
    expect(detectPair('Bao cao Giam doc @VPIC1 陳嘉元 ve noi dung man hinh LED')).toBe(VI_TO_ZH);
  });

  it('returns null for text that is neither', () => {
    expect(detectPair('12345 :)')).toBeNull();
  });
});

describe('fixViCasing', () => {
  it('capitalizes the sentence start (glossary lowercase leak)', () => {
    expect(fixViCasing('sếp ơi, em gửi báo cáo rồi ạ')).toBe('Sếp ơi, em gửi báo cáo rồi ạ');
  });

  it('capitalizes after sentence punctuation and newlines', () => {
    expect(fixViCasing('sếp đã xem. nên không cần giải thích.\nem cảm ơn ạ')).toBe(
      'Sếp đã xem. Nên không cần giải thích.\nEm cảm ơn ạ',
    );
  });

  it('handles Vietnamese diacritic initials', () => {
    expect(fixViCasing('đơn đã ký')).toBe('Đơn đã ký');
  });

  it('never lowercases acronyms or ALL-CAPS', () => {
    expect(fixViCasing('SỢI HÀN QUANG đã về kho. LED ổn')).toBe('SỢI HÀN QUANG đã về kho. LED ổn');
  });
});

describe('stripThinking', () => {
  it('keeps only what follows the last </think>', () => {
    expect(stripThinking('<think>let me translate\nhmm</think>\n\n報告總經理')).toBe('報告總經理');
  });

  it('handles Ollama emitting only the closing tag', () => {
    expect(stripThinking('reasoning here</think>xin chào')).toBe('xin chào');
  });

  it('returns empty when a think block was opened but never closed (all reasoning, no answer)', () => {
    expect(stripThinking('<think>still thinking, cut off mid-way')).toBe('');
  });

  it('passes plain output through untouched', () => {
    expect(stripThinking('  báo cáo giám đốc  ')).toBe('báo cáo giám đốc');
  });
});
