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
    expect(s.entries()).toEqual([{ jid: '200859128434777', name: '總經理' }]);
    const reloaded = new SenderDirectory(file);
    reloaded.load();
    expect(reloaded.entries()).toEqual([{ jid: '200859128434777', name: '總經理' }]);
  });

  it('replaces @<jid> tokens in text with @<name>', () => {
    const s = new SenderDirectory(file);
    s.add('200859128434777', '總經理');
    expect(s.apply('報告給@200859128434777以及其他同事')).toBe('報告給@總經理以及其他同事');
  });

  it('removes by any JID form', () => {
    const s = new SenderDirectory(file);
    s.add('200859128434777', '總經理');
    expect(s.remove('@200859128434777')).toBe(true);
    expect(s.entries()).toEqual([]);
    expect(s.remove('nope')).toBe(false);
  });
});
