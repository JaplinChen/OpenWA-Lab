import * as fs from 'node:fs';
import * as path from 'node:path';
import { memoryDbPath } from './translate-memory';

// High-frequency Chinese phrases mined from translation memory + their LLM-suggested Vietnamese, held
// for dashboard approval into the glossary. Kept in a separate table from translation_memory so the
// whole-sentence candidates and the word-level candidates never mix (different count semantics).
interface SqliteDb {
  run(sql: string, params: unknown[], cb?: (err: Error | null) => void): void;
  all(sql: string, params: unknown[], cb: (err: Error | null, rows: PhraseRow[]) => void): void;
  get(sql: string, params: unknown[], cb: (err: Error | null, row?: PhraseRow) => void): void;
  serialize(): void;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sqlite3 = require('sqlite3') as { Database: new (file: string) => SqliteDb };

interface PhraseRow {
  id: number;
  phrase: string;
  translated: string;
  count: number;
  updated_at: string;
}

export interface PhraseCandidate {
  id: number;
  phrase: string;
  translated: string;
  count: number;
  at: string;
}

/**
 * Phrase-candidate store. Mining upserts fresh phrases (bumping count on repeat, refreshing the LLM
 * translation), leaving approved/dismissed rows untouched so a curated phrase doesn't reappear.
 */
export class PhraseCandidates {
  private db: SqliteDb | null = null;

  constructor(private readonly file = memoryDbPath()) {}

  init(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new sqlite3.Database(this.file);
    db.serialize(); // serialized mode — same rationale as TranslationMemory
    db.run(
      `CREATE TABLE IF NOT EXISTS phrase_candidates (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         phrase TEXT NOT NULL,
         translated TEXT NOT NULL DEFAULT '',
         count INTEGER NOT NULL DEFAULT 1,
         status TEXT NOT NULL DEFAULT 'new',
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         UNIQUE(phrase)
       )`,
      [],
    );
    db.run(`CREATE INDEX IF NOT EXISTS idx_pc_status_count ON phrase_candidates(status, count DESC)`, []);
    this.db = db;
  }

  /** Upsert one mined phrase; refreshes count + translation but never revives a curated (non-new) row. */
  upsert(phrase: string, translated: string, count: number): Promise<void> {
    return new Promise(resolve => {
      const p = phrase.trim();
      if (!this.db || !p) return resolve();
      const now = new Date().toISOString();
      this.db.run(
        `INSERT INTO phrase_candidates (phrase, translated, count, status, created_at, updated_at)
         VALUES (?, ?, ?, 'new', ?, ?)
         ON CONFLICT(phrase) DO UPDATE SET count = excluded.count, translated = excluded.translated, updated_at = excluded.updated_at
         WHERE phrase_candidates.status = 'new'`,
        [p, translated.trim(), Math.max(1, count), now, now],
        () => resolve(),
      );
    });
  }

  /** Top unreviewed phrase candidates by frequency. */
  list(limit = 50): Promise<PhraseCandidate[]> {
    return new Promise(resolve => {
      if (!this.db) return resolve([]);
      this.db.all(
        `SELECT id, phrase, translated, count, updated_at FROM phrase_candidates
           WHERE status = 'new' ORDER BY count DESC, updated_at DESC LIMIT ?`,
        [Math.max(1, Math.min(500, limit))],
        (err, rows) => resolve(err || !rows ? [] : rows.map(toCandidate)),
      );
    });
  }

  private get(id: number): Promise<PhraseCandidate | null> {
    return new Promise(resolve => {
      if (!this.db) return resolve(null);
      this.db.get(
        `SELECT id, phrase, translated, count, updated_at FROM phrase_candidates WHERE id = ?`,
        [id],
        (err, r) => resolve(err || !r ? null : toCandidate(r)),
      );
    });
  }

  private setStatus(id: number, status: 'approved' | 'dismissed'): Promise<void> {
    return new Promise(resolve => {
      if (!this.db) return resolve();
      this.db.run(`UPDATE phrase_candidates SET status = ? WHERE id = ?`, [status, id], () => resolve());
    });
  }

  /** Mark approved and return the row so the caller can add it to the glossary. */
  async takeForApproval(id: number): Promise<PhraseCandidate | null> {
    const row = await this.get(id);
    if (!row) return null;
    await this.setStatus(id, 'approved');
    return row;
  }

  dismiss(id: number): Promise<void> {
    return this.setStatus(id, 'dismissed');
  }
}

function toCandidate(r: PhraseRow): PhraseCandidate {
  return { id: r.id, phrase: r.phrase, translated: r.translated, count: r.count, at: r.updated_at };
}
