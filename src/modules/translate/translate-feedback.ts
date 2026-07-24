import * as fs from 'node:fs';
import { atomicWriteJson } from './translate-fs';

export interface FeedbackEntry {
  reportedId: string; // WA id of the translation message the user quoted
  source: string; // original text (empty when the send predates this process / was evicted)
  translated: string; // the flagged translation
  reporter: string; // WID of who reported it
  at: string; // ISO timestamp
}

/**
 * `/bad` feedback collection (v1 read-only). Two parts:
 *  - an in-memory ring of the last N sent translations (sentId -> {source, translated}), so a later
 *    /bad quoting that message can recover the ORIGINAL text (the quoted body only carries the
 *    translation). Ephemeral by design — restarts drop it; the quoted body is the fallback.
 *  - a persisted append-only list of reports, for later human review (dashboard/JSON).
 */
export class FeedbackStore {
  private ring = new Map<string, { source: string; translated: string }>();
  private readonly max = 500;
  private entries: FeedbackEntry[] = [];

  constructor(private readonly filePath: string) {}

  /** Load persisted reports; returns the count (0 if absent/unreadable). */
  load(): number {
    try {
      this.entries = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as FeedbackEntry[];
      return this.entries.length;
    } catch {
      this.entries = [];
      return 0;
    }
  }

  /** Remember a sent translation so a later /bad can recover its source. Evicts oldest past `max`. */
  record(sentId: string | undefined, source: string, translated: string): void {
    if (!sentId) return;
    this.ring.set(sentId, { source, translated });
    if (this.ring.size > this.max) {
      const oldest = this.ring.keys().next().value as string | undefined;
      if (oldest !== undefined) this.ring.delete(oldest);
    }
  }

  /** Append a report; recovers source from the ring when available, else uses the quoted fallback. */
  report(reportedId: string, translatedFallback: string, reporter: string): FeedbackEntry {
    const found = this.ring.get(reportedId);
    const entry: FeedbackEntry = {
      reportedId,
      source: found?.source ?? '',
      translated: found?.translated ?? translatedFallback,
      reporter,
      at: new Date().toISOString(),
    };
    this.entries.push(entry);
    atomicWriteJson(this.filePath, this.entries);
    return entry;
  }

  list(): FeedbackEntry[] {
    return [...this.entries];
  }
}

// ponytail: assert-based self-check — run `node -r ts-node/register translate-feedback.ts`
if (require.main === module) {
  const os = require('node:os');
  const path = require('node:path');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-')), 'bad-feedback.json');
  const fb = new FeedbackStore(tmp);
  fb.load();
  fb.record('m1', '出貨', 'giao hàng');
  const e = fb.report('m1', 'fallback', 'u1@c.us');
  if (e.source !== '出貨' || e.translated !== 'giao hàng') throw new Error(`ring lookup failed: ${JSON.stringify(e)}`);
  const e2 = fb.report('unknown', 'fallback-text', 'u1@c.us');
  if (e2.source !== '' || e2.translated !== 'fallback-text') throw new Error('fallback failed');
  if (new FeedbackStore(tmp).load() !== 2) throw new Error('persist failed');
  // eslint-disable-next-line no-console
  console.log('FeedbackStore self-check ok');
}
