import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CategoryStore } from './translate-categories';

describe('CategoryStore', () => {
  let file: string;

  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'categories-')), 'categories.json');
  });

  it('load on a missing file yields an empty list', () => {
    const c = new CategoryStore(file);
    expect(c.load()).toBe(0);
    expect(c.list()).toEqual([]);
  });

  it('adds, trims, and persists categories', () => {
    const c = new CategoryStore(file);
    expect(c.add('  產品  ')).toEqual(['產品']);
    c.add('客戶');
    const reloaded = new CategoryStore(file);
    reloaded.load();
    expect(reloaded.list()).toEqual(['產品', '客戶']);
  });

  it('rejects empty/blank names and deduplicates', () => {
    const c = new CategoryStore(file);
    c.add('產品');
    expect(c.add('  ')).toEqual(['產品']);
    expect(c.add('產品')).toEqual(['產品']);
  });

  it('removes a category', () => {
    const c = new CategoryStore(file);
    c.add('產品');
    c.add('客戶');
    expect(c.remove('產品')).toEqual(['客戶']);
    expect(c.remove('不存在')).toEqual(['客戶']);
  });
});
