import { stripThinking, detectPair, buildPrompt, VI_TO_ZH, ZH_TO_VI } from './translate-lang';

describe('buildPrompt', () => {
  it('renders the built-in default when no template is given', () => {
    const out = buildPrompt('xin chào', VI_TO_ZH, 'GLOSSARY');
    expect(out).toBe(
      [
        '你是專業翻譯引擎，只做翻譯。',
        '請把以下內容從 越南文 翻譯成 繁體中文。',
        '規則：',
        '1) 僅輸出翻譯結果，不要解釋、不要加註。',
        '2) 使用自然口語，符合群組聊天語氣；商務對話用正式敬語（您/quý vị）。',
        '3) 人名、敬稱、頭銜、品牌、產品名、英文技術術語保留原文不翻譯（術語表另有指定者除外）。',
        '4) 數字、單位、網址、程式碼維持原始格式。',
        '5) 成語與慣用語轉換為目標語言的對應慣用表達，不要逐字直譯；量詞依目標語言習慣自然轉換。',
        '6) 標點符號轉換為目標語言慣用寫法。',
        '7) 保留原文換行與段落結構。',
        '8) 若原文主要不是可翻譯的自然語言，原樣回傳。',
        'GLOSSARY',
        'xin chào',
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
