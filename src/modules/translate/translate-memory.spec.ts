import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TranslationMemory } from './translate-memory';

describe('translate-memory', () => {
  let mem: TranslationMemory;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-'));
    mem = new TranslationMemory(path.join(dir, 'm.sqlite'));
    mem.init();
  });

  it('dedups by pair+source and counts repeats, ordered by frequency', async () => {
    mem.record('zh-tw:vi', '明白', 'Hiểu rồi');
    mem.record('zh-tw:vi', '明白', 'Hiểu rồi');
    mem.record('zh-tw:vi', '好', 'Được');
    const c = await mem.candidates();
    expect(c.map(x => [x.source, x.count])).toEqual([
      ['明白', 2],
      ['好', 1],
    ]);
  });

  it('approve returns the row and drops it from candidates', async () => {
    mem.record('zh-tw:vi', '明白', 'Hiểu rồi');
    const id = (await mem.candidates())[0].id;
    const taken = await mem.takeForApproval(id);
    expect(taken?.source).toBe('明白');
    expect(taken?.translated).toBe('Hiểu rồi');
    expect((await mem.candidates()).length).toBe(0);
  });

  it('paginates candidates by limit/offset and counts the full set', async () => {
    for (let i = 0; i < 25; i++) mem.record('zh-tw:vi', `詞${i}`, `t${i}`);
    expect(await mem.candidatesCount()).toBe(25);
    const page1 = await mem.candidates(20, 0);
    const page2 = await mem.candidates(20, 20);
    expect(page1.length).toBe(20);
    expect(page2.length).toBe(5);
    // No overlap between pages.
    const ids = new Set(page1.map(c => c.id));
    expect(page2.every(c => !ids.has(c.id))).toBe(true);
  });

  it('dismiss drops it and it stays dismissed even when seen again', async () => {
    mem.record('zh-tw:vi', '好', 'Được');
    const id = (await mem.candidates())[0].id;
    await mem.dismiss(id);
    expect((await mem.candidates()).length).toBe(0);
    mem.record('zh-tw:vi', '好', 'Được'); // repeat bumps count but must not resurface
    expect((await mem.candidates()).length).toBe(0);
  });
});
