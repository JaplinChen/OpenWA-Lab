import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let renameBehavior: (() => void) | null = null;
jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs');
  return {
    ...actual,
    renameSync: (...args: unknown[]) => {
      if (renameBehavior) return renameBehavior();
      return (actual.renameSync as (...a: unknown[]) => void)(...args);
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
import { atomicWriteJson } from './translate-fs';

describe('atomicWriteJson', () => {
  let dir: string;
  beforeEach(() => {
    renameBehavior = null;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomicwrite-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes JSON via tmp+rename', () => {
    const file = path.join(dir, 'g.json');
    atomicWriteJson(file, { a: 1 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 1 });
  });

  it('falls back to in-place write when rename fails with EBUSY (single-file bind mount)', () => {
    const file = path.join(dir, 'g.json');
    fs.writeFileSync(file, '{}');
    renameBehavior = () => {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    };
    atomicWriteJson(file, { a: 2 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 2 });
    expect(fs.existsSync(file + '.tmp')).toBe(false);
  });

  it('rethrows non-EBUSY/EXDEV rename errors', () => {
    const file = path.join(dir, 'g.json');
    renameBehavior = () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    expect(() => atomicWriteJson(file, { a: 3 })).toThrow('EACCES');
  });
});
