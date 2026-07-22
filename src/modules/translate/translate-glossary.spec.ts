import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Glossary } from './translate-glossary';

describe('Glossary', () => {
  let file: string;

  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glossary-')), 'glossary.json');
  });

  it('adds a term in both directions and lists it zh->vi', () => {
    const g = new Glossary(file);
    g.add('電腦', 'máy tính');
    expect(g.entries()).toEqual([{ source: '電腦', target: 'máy tính', count: 0 }]);
    // persisted and reloadable
    const reloaded = new Glossary(file);
    reloaded.load();
    expect(reloaded.entries()).toEqual([{ source: '電腦', target: 'máy tính', count: 0 }]);
  });

  it('orients reversed input so the CJK term lands on the zh side', () => {
    const g = new Glossary(file);
    g.add('sếp ơi', '長官啊');
    expect(g.entries()).toEqual([{ source: '長官啊', target: 'sếp ơi', count: 0 }]);
    expect(g.section('vi:zh-tw', 'sếp ơi giúp em')).toContain('sếp ơi → 長官啊');
  });

  it('section bumps usage count for matched terms in either direction, persisted', () => {
    const g = new Glossary(file);
    g.add('電腦', 'máy tính');
    g.section('zh-tw:vi', '我的電腦壞了');
    g.section('vi:zh-tw', 'máy tính hỏng rồi');
    g.section('zh-tw:vi', '沒提到術語'); // no match → no bump
    expect(g.entries()).toEqual([{ source: '電腦', target: 'máy tính', count: 2 }]);
    const reloaded = new Glossary(file);
    reloaded.load();
    expect(reloaded.entries()[0].count).toBe(2);
  });

  it('migrates reversed entries persisted by older versions on load', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ 'zh-tw:vi': { 'sếp ơi': '長官啊', 電腦: 'máy tính' }, 'vi:zh-tw': { 長官啊: 'sếp ơi', 'máy tính': '電腦' } }),
      'utf8',
    );
    const g = new Glossary(file);
    g.load();
    expect(g.entries()).toEqual(expect.arrayContaining([
      { source: '長官啊', target: 'sếp ơi', count: 0 },
      { source: '電腦', target: 'máy tính', count: 0 },
    ]));
    expect(g.section('vi:zh-tw', 'sếp ơi')).toContain('sếp ơi → 長官啊');
  });

  it('removes a pairing when the term appears on either side', () => {
    const g = new Glossary(file);
    g.add('電腦', 'máy tính');
    expect(g.remove('máy tính')).toBe(true); // match on target side
    expect(g.entries()).toEqual([]);
    expect(g.remove('nope')).toBe(false);
  });

  it('injects only terms present in the text, not the whole table', () => {
    const g = new Glossary(file);
    g.add('電腦', 'máy tính');
    g.add('印表機', 'máy in');
    // term appears in the text → included
    expect(g.section('zh-tw:vi', '我的電腦壞了')).toContain('電腦 → máy tính');
    // other term absent from the text → excluded (prevents dumping the full glossary)
    expect(g.section('zh-tw:vi', '我的電腦壞了')).not.toContain('印表機');
    // no matching term → empty section
    expect(g.section('zh-tw:vi', '你好嗎')).toBe('');
  });

  it('suggest queues a pending entry and approve moves it into the glossary', () => {
    const g = new Glossary(file);
    const reply = g.command('suggest 電腦 = máy tính', false, 'user@c.us');
    expect(reply).toContain('#1');
    expect(g.pending()).toMatchObject([{ id: 1, zh: '電腦', vi: 'máy tính', suggestedBy: 'user@c.us' }]);
    // persisted and reloadable
    const reloaded = new Glossary(file);
    reloaded.load();
    expect(reloaded.pending()).toHaveLength(1);

    expect(g.command('approve 1', true)).toContain('已核准');
    expect(g.pending()).toEqual([]);
    expect(g.entries()).toEqual([{ source: '電腦', target: 'máy tính', count: 0 }]);
  });

  it('reject drops the pending entry without touching the glossary', () => {
    const g = new Glossary(file);
    g.command('suggest 電腦 = máy tính', false, 'user@c.us');
    expect(g.command('reject 1', true)).toContain('已拒絕');
    expect(g.pending()).toEqual([]);
    expect(g.entries()).toEqual([]);
    expect(g.command('approve 1', true)).toContain('找不到');
  });

  it('blocks non-admins from pending/approve/reject but not suggest', () => {
    const g = new Glossary(file);
    g.command('suggest 電腦 = máy tính', false, 'user@c.us');
    expect(g.command('pending', false)).toBe('此指令僅限管理員使用。');
    expect(g.command('approve 1', false)).toBe('此指令僅限管理員使用。');
    expect(g.command('reject 1', false)).toBe('此指令僅限管理員使用。');
    expect(g.pending()).toHaveLength(1);
    expect(g.command('pending', true)).toContain('#1 電腦 = máy tính（user@c.us）');
  });

  it('bare pair adds as admin and suggests as member', () => {
    const g = new Glossary(file);
    expect(g.command('電腦 = máy tính', true)).toContain('已新增術語');
    expect(g.entries()).toEqual([{ source: '電腦', target: 'máy tính', count: 0 }]);
    expect(g.command('印表機 = máy in', false, 'user@c.us')).toContain('#1');
    expect(g.pending()).toMatchObject([{ id: 1, zh: '印表機', vi: 'máy in', suggestedBy: 'user@c.us' }]);
  });

  it('ok/no aliases approve and reject', () => {
    const g = new Glossary(file);
    g.command('suggest 電腦 = máy tính', false, 'a');
    g.command('suggest 印表機 = máy in', false, 'a');
    expect(g.command('ok 1', true)).toContain('已核准');
    expect(g.entries()).toEqual([{ source: '電腦', target: 'máy tính', count: 0 }]);
    expect(g.command('no 2', true)).toContain('已拒絕');
    expect(g.pending()).toEqual([]);
  });

  it('stores a category in a sidecar, exposes it via entries, and reloads it', () => {
    const g = new Glossary(file);
    g.add('鍵盤', 'bàn phím', 'asset');
    expect(g.entries()).toEqual([{ source: '鍵盤', target: 'bàn phím', count: 0, category: 'asset' }]);
    expect(g.getCategory('鍵盤')).toBe('asset');
    const reloaded = new Glossary(file);
    reloaded.load();
    expect(reloaded.getCategory('鍵盤')).toBe('asset');
  });

  it('omits category when untagged so the entry shape is unchanged', () => {
    const g = new Glossary(file);
    g.add('電腦', 'máy tính');
    expect(g.entries()).toEqual([{ source: '電腦', target: 'máy tính', count: 0 }]);
    expect(g.getCategory('電腦')).toBe('');
  });

  it('setCategory with empty string clears the tag', () => {
    const g = new Glossary(file);
    g.add('電腦', 'máy tính', 'term');
    g.setCategory('電腦', '');
    expect(g.getCategory('電腦')).toBe('');
    expect(g.entries()[0]).not.toHaveProperty('category');
  });

  it('remove drops the category tag too', () => {
    const g = new Glossary(file);
    g.add('電腦', 'máy tính', 'term');
    g.remove('電腦');
    const reloaded = new Glossary(file);
    reloaded.load();
    expect(reloaded.getCategory('電腦')).toBe('');
  });

  it('dedupes suggestions against the glossary and the pending list', () => {
    const g = new Glossary(file);
    g.add('電腦', 'máy tính');
    expect(g.command('suggest 電腦 = máy tính', false, 'a')).toContain('已存在');
    expect(g.pending()).toEqual([]);
    g.command('suggest 印表機 = máy in', false, 'a');
    expect(g.command('suggest 印表機 = máy in', false, 'b')).toContain('已存在');
    expect(g.pending()).toHaveLength(1);
  });
});
