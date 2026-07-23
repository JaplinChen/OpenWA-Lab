import * as fs from 'node:fs';
import { atomicWriteJson } from './translate-fs';

/**
 * Dynamic glossary category list, persisted as a flat JSON string array (e.g. ["產品","客戶"]).
 * Lets an admin manage the category dropdown without a code change; consumed by the dashboard.
 */
export class CategoryStore {
  private data: string[] = [];

  constructor(private readonly filePath: string) {}

  /** Load from disk; returns the entry count (0 if absent/unreadable — start empty). */
  load(): number {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
      this.data = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      this.data = [];
    }
    return this.data.length;
  }

  private save(): void {
    atomicWriteJson(this.filePath, this.data);
  }

  list(): string[] {
    return [...this.data];
  }

  add(name: string): string[] {
    const n = name.trim();
    if (n && !this.data.includes(n)) {
      this.data.push(n);
      this.save();
    }
    return this.list();
  }

  remove(name: string): string[] {
    const n = name.trim();
    const next = this.data.filter(c => c !== n);
    if (next.length !== this.data.length) {
      this.data = next;
      this.save();
    }
    return this.list();
  }
}
