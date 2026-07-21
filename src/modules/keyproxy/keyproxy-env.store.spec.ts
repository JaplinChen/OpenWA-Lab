import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KeyProxyEnvStore, parseEnv, serializeEnv } from './keyproxy-env.store';

describe('keyproxy-env.store', () => {
  it('parses key + account lines and preserves PROXY_API_KEY / comments', () => {
    const p = parseEnv(
      '# hdr\nPROXY_API_KEY="secret"\nGEMINI_API_KEY_1="g1"\nGEMINI_ACCOUNT_1="alice@gmail"\nGROQ_API_KEY_1=q1\n',
    );
    expect(p.proxyApiKey).toBe('secret');
    expect(p.keys).toEqual([
      { provider: 'gemini', index: 1, key: 'g1', account: 'alice@gmail' },
      { provider: 'groq', index: 1, key: 'q1', account: '' },
    ]);
    // Neither PROXY_API_KEY nor the ACCOUNT line is parsed as a rotation key.
    expect(p.keys.some(k => k.key === 'secret' || k.key === 'alice@gmail')).toBe(false);
  });

  it('round-trips the account label through serialize', () => {
    const out = serializeEnv(parseEnv('GEMINI_API_KEY_1="g1"\nGEMINI_ACCOUNT_1="acct"\n'));
    expect(out).toContain('GEMINI_API_KEY_1="g1"');
    expect(out).toContain('GEMINI_ACCOUNT_1="acct"');
  });

  it('renumbers contiguously so a delete leaves no gap', () => {
    const parsed = parseEnv('GEMINI_API_KEY_1="a"\nGEMINI_API_KEY_2="b"\nGEMINI_API_KEY_3="c"\n');
    parsed.keys = parsed.keys.filter(k => k.index !== 2); // drop the middle
    const out = serializeEnv(parsed);
    expect(out).toContain('GEMINI_API_KEY_1="a"');
    expect(out).toContain('GEMINI_API_KEY_2="c"');
    expect(out).not.toContain('_KEY_3');
  });

  it('add then delete round-trips through the file, keeping PROXY_API_KEY', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-'));
    process.env.KEYPROXY_ENV_PATH = path.join(dir, '.env');
    fs.writeFileSync(process.env.KEYPROXY_ENV_PATH, 'PROXY_API_KEY="p"\n');
    const store = new KeyProxyEnvStore();

    store.addKey('gemini', 'k1', 'acctA');
    store.addKey('gemini', 'k2', '');
    expect(store.read().keys.map(k => k.key)).toEqual(['k1', 'k2']);

    expect(store.deleteKey('gemini', 1)).toBe(true);
    const after = store.read();
    expect(after.keys).toEqual([{ provider: 'gemini', index: 1, key: 'k2', account: '' }]);
    expect(after.proxyApiKey).toBe('p'); // untouched
    expect(store.deleteKey('gemini', 9)).toBe(false); // missing index

    delete process.env.KEYPROXY_ENV_PATH;
  });
});
