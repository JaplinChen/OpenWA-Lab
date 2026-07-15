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
    expect(g.entries()).toEqual([{ source: '電腦', target: 'máy tính' }]);
    // persisted and reloadable
    const reloaded = new Glossary(file);
    reloaded.load();
    expect(reloaded.entries()).toEqual([{ source: '電腦', target: 'máy tính' }]);
  });

  it('removes a pairing when the term appears on either side', () => {
    const g = new Glossary(file);
    g.add('電腦', 'máy tính');
    expect(g.remove('máy tính')).toBe(true); // match on target side
    expect(g.entries()).toEqual([]);
    expect(g.remove('nope')).toBe(false);
  });

  it('injects added terms into the prompt section', () => {
    const g = new Glossary(file);
    g.add('電腦', 'máy tính');
    expect(g.section('zh-tw:vi')).toContain('電腦 → máy tính');
  });
});
