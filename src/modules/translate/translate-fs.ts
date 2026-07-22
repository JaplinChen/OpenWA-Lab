import * as fs from 'node:fs';
import * as path from 'node:path';

// Atomic tmp+rename so a crash mid-write never leaves a truncated JSON file (mirrors TranslateConfigStore.write).
export function atomicWriteJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file) || '.', { recursive: true });
  const tmp = file + '.tmp';
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, json, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // A single-file bind mount (e.g. host-mounted glossary.json/senders.json) is a fixed mount
    // point: rename-over-it fails with EBUSY, and a cross-device tmp would give EXDEV. Fall back to
    // an in-place write — non-atomic, but the only option for a bind-mounted target.
    if ((e as NodeJS.ErrnoException).code !== 'EBUSY' && (e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    fs.writeFileSync(file, json, 'utf8');
    fs.rmSync(tmp, { force: true });
  }
}
