import { parseCommand, COMMANDS } from './translate-commands';

describe('parseCommand (dispatch table)', () => {
  it('matches every alias of every registered command', () => {
    for (const spec of COMMANDS) {
      for (const alias of spec.aliases) {
        expect(parseCommand(`/${alias}`)?.spec.cmd).toBe(spec.cmd);
        expect(parseCommand(`/${alias.toUpperCase()}`)?.spec.cmd).toBe(spec.cmd); // case-insensitive
      }
    }
  });

  it('strips the prefix into rest, trimmed', () => {
    expect(parseCommand('/g 客戶 = khách hàng')?.rest).toBe('客戶 = khách hàng');
    expect(parseCommand('/glossary  pending')?.rest).toBe('pending');
    expect(parseCommand('/g')?.rest).toBe('');
  });

  it('requires a word boundary after the alias (no false prefix match)', () => {
    expect(parseCommand('/glossaryx')).toBeNull(); // not /glossary
    expect(parseCommand('/gg')).toBeNull(); // not /g
    expect(parseCommand('/help')?.spec.cmd).toBe('help');
  });

  it('returns null for non-commands', () => {
    expect(parseCommand('hello')).toBeNull();
    expect(parseCommand('/unknown')).toBeNull();
  });
});
