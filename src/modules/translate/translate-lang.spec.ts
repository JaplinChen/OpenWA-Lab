import { stripThinking } from './translate-lang';

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
