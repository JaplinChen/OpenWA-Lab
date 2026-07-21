import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Glossary } from './translate-glossary';

describe('Glossary.exact', () => {
  it('matches the whole trimmed message, not substrings, both directions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-'));
    const g = new Glossary(path.join(dir, 'g.json'));
    g.load();
    g.add('明白', 'Hiểu rồi');

    expect(g.exact('zh-tw:vi', '明白')).toBe('Hiểu rồi');
    expect(g.exact('zh-tw:vi', '  明白  ')).toBe('Hiểu rồi'); // trims
    expect(g.exact('zh-tw:vi', '明白了嗎')).toBeNull(); // substring, must go to the LLM
    expect(g.exact('vi:zh-tw', 'Hiểu rồi')).toBe('明白'); // reverse direction
    expect(g.exact('zh-tw:vi', '不存在')).toBeNull();
  });
});
