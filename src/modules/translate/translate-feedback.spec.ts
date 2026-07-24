import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FeedbackStore } from './translate-feedback';

describe('FeedbackStore', () => {
  let file: string;
  let store: FeedbackStore;

  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-')), 'bad-feedback.json');
    store = new FeedbackStore(file);
    store.load();
  });

  it('recovers source from the ring on report', () => {
    store.record('m1', '出貨', 'giao hàng');
    const e = store.report('m1', 'ignored-fallback', 'u1@c.us');
    expect(e.source).toBe('出貨');
    expect(e.translated).toBe('giao hàng');
    expect(e.reporter).toBe('u1@c.us');
  });

  it('falls back to the quoted body when the id is not in the ring', () => {
    const e = store.report('unknown', 'quoted translation', 'u1@c.us');
    expect(e.source).toBe('');
    expect(e.translated).toBe('quoted translation');
  });

  it('persists reports across reloads', () => {
    store.record('m1', '出貨', 'giao hàng');
    store.report('m1', 'x', 'u1@c.us');
    expect(new FeedbackStore(file).load()).toBe(1);
  });

  it('evicts the oldest sent entry past the 500 cap', () => {
    for (let i = 0; i < 501; i++) store.record(`m${i}`, `s${i}`, `t${i}`);
    // m0 evicted → its report falls back; m500 still recoverable
    expect(store.report('m0', 'fb', 'u').source).toBe('');
    expect(store.report('m500', 'fb', 'u').source).toBe('s500');
  });
});
