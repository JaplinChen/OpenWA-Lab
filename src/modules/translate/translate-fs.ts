import * as fs from 'node:fs';
import * as path from 'node:path';

// Atomic tmp+rename so a crash mid-write never leaves a truncated JSON file (mirrors TranslateConfigStore.write).
export function atomicWriteJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file) || '.', { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
