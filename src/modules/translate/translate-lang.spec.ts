import { stripThinking, detectPair, VI_TO_ZH, ZH_TO_VI } from './translate-lang';

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
