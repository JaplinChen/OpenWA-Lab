import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SenderDirectory } from './translate-senders';

describe('SenderDirectory', () => {
  let file: string;

  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'senders-')), 'senders.json');
  });

  it('adds and lists an override, normalizing the JID to digits', () => {
    const s = new SenderDirectory(file);
    s.add('200859128434777@c.us', '總經理');
    expect(s.entries()).toEqual([{ jid: '200859128434777', name: '總經理', count: 0 }]);
    const reloaded = new SenderDirectory(file);
    reloaded.load();
    expect(reloaded.entries()).toEqual([{ jid: '200859128434777', name: '總經理', count: 0 }]);
  });

  it('replaces @<jid> tokens in text with @<name>', () => {
    const s = new SenderDirectory(file);
    s.add('200859128434777', '總經理');
    expect(s.apply('報告給@200859128434777以及其他同事')).toBe('報告給@總經理以及其他同事');
  });

  it('markUsed counts mentioned jids in the table (any dialect) and persists, ignoring unknown jids', () => {
    const s = new SenderDirectory(file);
    s.add('84396422018', 'Cuong');
    s.markUsed(['84396422018@c.us', '61998440124575@lid', '84396422018@c.us']);
    expect(s.entries()).toEqual([{ jid: '84396422018', name: 'Cuong', count: 2 }]);
    const reloaded = new SenderDirectory(file);
    reloaded.load();
    expect(reloaded.entries()[0].count).toBe(2);
  });

  it('notePending queues only leaked unknown mentions as empty-name entries, later fillable by learn', () => {
    const s = new SenderDirectory(file);
    s.add('84396422018', 'Cuong');
    s.notePending(['84396422018@c.us', '225821461577953@lid', '999@lid'], '@225821461577953 nói gì đó');
    expect(s.entries()).toEqual([
      { jid: '84396422018', name: 'Cuong', count: 0 },
      { jid: '225821461577953', name: '', count: 0 }, // leaked -> queued; 999 not in body -> skipped
    ]);
    expect(s.apply('hi @225821461577953')).toBe('hi @225821461577953'); // pending entry never replaces
    expect(s.learn('225821461577953@lid', 'Minh Kien')).toBe(true); // pending filled when they speak
    expect(s.apply('hi @225821461577953')).toBe('hi @Minh Kien');
  });

  it('removes by any JID form', () => {
    const s = new SenderDirectory(file);
    s.add('200859128434777', '總經理');
    expect(s.remove('@200859128434777')).toBe(true);
    expect(s.entries()).toEqual([]);
    expect(s.remove('nope')).toBe(false);
  });

  it('learn stores a new sender once and never overwrites a known JID', () => {
    const s = new SenderDirectory(file);
    expect(s.learn('84912830550@c.us', 'Bạch Nga')).toBe(true);
    expect(s.learn('84912830550', '改過的名')).toBe(false); // already known → keep first
    expect(s.learn('999@c.us', '  ')).toBe(false); // blank → ignored
    expect(s.entries()).toEqual([{ jid: '84912830550', name: 'Bạch Nga', count: 0 }]);
  });

  it('importEntries adds only new JIDs and never overwrites existing names', () => {
    const s = new SenderDirectory(file);
    s.add('111@c.us', '手動名');
    const added = s.importEntries([
      { jid: '111@c.us', name: '聯絡人名' }, // existing → skipped
      { jid: '222@c.us', name: '阿明' }, // new → added
      { jid: '333@c.us', name: '  ' }, // blank → skipped
    ]);
    expect(added).toBe(1);
    expect(s.entries()).toEqual([
      { jid: '111', name: '手動名', count: 0 },
      { jid: '222', name: '阿明', count: 0 },
    ]);
  });

  it('markUsed is the sole usage counter; apply never bumps counts', () => {
    const s = new SenderDirectory(file);
    s.add('111', '總經理');
    s.add('222', '阿明');
    expect(s.apply('報告給@111')).toBe('報告給@總經理');
    expect(s.entries()).toEqual([
      { jid: '111', name: '總經理', count: 0 },
      { jid: '222', name: '阿明', count: 0 },
    ]);
    s.markUsed(['111', '999']);
    s.markUsed(['111']);
    const reloaded = new SenderDirectory(file);
    reloaded.load();
    expect(reloaded.entries().find(e => e.jid === '111')?.count).toBe(2);
  });
});
