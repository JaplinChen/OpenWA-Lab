import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WatchwordStore } from './translate-watchwords';

describe('WatchwordStore', () => {
  let file: string;
  let store: WatchwordStore;

  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-')), 'watchwords.json');
    store = new WatchwordStore(file);
    store.load();
  });

  it('adds, dedupes, persists across reloads', () => {
    expect(store.add('u1@c.us', '緊急')).toBe(true);
    expect(store.add('u1@c.us', '緊急')).toBe(false); // dupe
    const reloaded = new WatchwordStore(file);
    expect(reloaded.load()).toBe(1);
    expect(reloaded.list('u1@c.us')).toEqual(['緊急']);
  });

  it('matches keywords case-insensitively and skips the author', () => {
    store.add('u1@c.us', 'urgent');
    expect(store.matches('this is URGENT', 'u2@c.us')).toEqual([{ watcher: 'u1@c.us', keyword: 'urgent' }]);
    expect(store.matches('this is URGENT', 'u1@c.us')).toEqual([]); // author skipped
  });

  it('removes and prunes an emptied watcher', () => {
    store.add('u1@c.us', '緊急');
    expect(store.remove('u1@c.us', '緊急')).toBe(true);
    expect(store.remove('u1@c.us', '緊急')).toBe(false);
    expect(new WatchwordStore(file).load()).toBe(0);
  });

  it('command: list / add / del', () => {
    expect(store.command('', 'u1@c.us')).toContain('尚未設定');
    expect(store.command('add 緊急', 'u1@c.us')).toContain('已新增');
    expect(store.command('', 'u1@c.us')).toContain('緊急');
    expect(store.command('del 緊急', 'u1@c.us')).toContain('已移除');
  });
});
