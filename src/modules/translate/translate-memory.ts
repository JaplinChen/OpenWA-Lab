import * as fs from 'node:fs';
import * as path from 'node:path';

// sqlite3 ships no bundled types and the translate module is deliberately kept off the app's TypeORM
// layer, so a standalone DB file with a minimal local typing keeps this self-contained (like the
// module's glossary/senders JSON sidecars) while giving O(1) upserts + indexed top-N queries.
interface SqliteDb {
  run(sql: string, params: unknown[], cb?: (err: Error | null) => void): void;
  all(sql: string, params: unknown[], cb: (err: Error | null, rows: MemoryRow[]) => void): void;
  get(sql: string, params: unknown[], cb: (err: Error | null, row?: MemoryRow) => void): void;
  // No-arg serialize() puts the connection in serialized mode for ALL later statements. Required so the
  // read-modify-write ON CONFLICT upsert isn't raced by node-sqlite3's default parallel mode (which
  // silently drops the count increment — two inserts both land at count 1 instead of one at 2).
  serialize(): void;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sqlite3 = require('sqlite3') as { Database: new (file: string) => SqliteDb };

export interface MemoryRow {
  id: number;
  pair_key: string;
  source: string;
  translated: string;
  count: number;
  updated_at: string;
}

export interface Candidate {
  id: number;
  pairKey: string;
  source: string;
  translated: string;
  count: number;
  at: string;
}

export const memoryDbPath = (): string => process.env.TRANSLATE_MEMORY_DB_PATH || 'data/translations.sqlite';

/**
 * Translation memory: every LLM translation is upserted here (deduped by pair+source, counting
 * repeats). High-frequency sources surface as candidates to promote into the glossary via the
 * dashboard's approval view. Writes are best-effort — a DB hiccup must never break a translation.
 */
export class TranslationMemory {
  private db: SqliteDb | null = null;

  constructor(private readonly file = memoryDbPath()) {}

  init(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new sqlite3.Database(this.file);
    db.serialize(); // serialized mode for the whole connection — see SqliteDb.serialize note
    db.run(
      `CREATE TABLE IF NOT EXISTS translation_memory (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         pair_key TEXT NOT NULL,
         source TEXT NOT NULL,
         translated TEXT NOT NULL,
         count INTEGER NOT NULL DEFAULT 1,
         status TEXT NOT NULL DEFAULT 'new',
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         UNIQUE(pair_key, source)
       )`,
      [],
    );
    db.run(`CREATE INDEX IF NOT EXISTS idx_tm_status_count ON translation_memory(status, count DESC)`, []);
    this.db = db;
  }

  /** Fire-and-forget upsert; never rejects into the translation path. */
  record(pairKey: string, source: string, translated: string): void {
    const s = source.trim();
    const t = translated.trim();
    if (!this.db || !s || !t) return;
    const now = new Date().toISOString();
    // ON CONFLICT bumps count + refreshes translation, but leaves `status` alone so a
    // dismissed/approved candidate doesn't pop back into the review queue on the next repeat.
    this.db.run(
      `INSERT INTO translation_memory (pair_key, source, translated, count, status, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'new', ?, ?)
       ON CONFLICT(pair_key, source) DO UPDATE SET count = count + 1, translated = excluded.translated, updated_at = excluded.updated_at`,
      [pairKey, s, t, now, now],
      () => {
        /* best-effort */
      },
    );
  }

  /** Every recorded source with its repeat count — feeds the phrase miner (all statuses included). */
  allSources(): Promise<{ source: string; count: number }[]> {
    return new Promise(resolve => {
      if (!this.db) return resolve([]);
      this.db.all(`SELECT source, count FROM translation_memory`, [], (err, rows) => {
        resolve(err || !rows ? [] : rows.map(r => ({ source: r.source, count: r.count })));
      });
    });
  }

  /** Count of unreviewed candidates, for paginating the approval view. */
  candidatesCount(): Promise<number> {
    return new Promise(resolve => {
      if (!this.db) return resolve(0);
      this.db.get(
        `SELECT COUNT(*) AS n FROM translation_memory WHERE status = 'new'`,
        [],
        (err, row) => resolve(err || !row ? 0 : Number((row as { n?: number }).n) || 0),
      );
    });
  }

  /** Top unreviewed candidates by frequency, for the approval view. */
  candidates(limit = 50, offset = 0): Promise<Candidate[]> {
    return new Promise(resolve => {
      if (!this.db) return resolve([]);
      this.db.all(
        `SELECT id, pair_key, source, translated, count, updated_at
           FROM translation_memory WHERE status = 'new'
           ORDER BY count DESC, updated_at DESC LIMIT ? OFFSET ?`,
        [Math.max(1, Math.min(500, limit)), Math.max(0, offset)],
        (err, rows) => {
          if (err || !rows) return resolve([]);
          resolve(
            rows.map(r => ({
              id: r.id,
              pairKey: r.pair_key,
              source: r.source,
              translated: r.translated,
              count: r.count,
              at: r.updated_at,
            })),
          );
        },
      );
    });
  }

  private get(id: number): Promise<Candidate | null> {
    return new Promise(resolve => {
      if (!this.db) return resolve(null);
      this.db.get(
        `SELECT id, pair_key, source, translated, count, updated_at FROM translation_memory WHERE id = ?`,
        [id],
        (err, r) => {
          if (err || !r) return resolve(null);
          resolve({ id: r.id, pairKey: r.pair_key, source: r.source, translated: r.translated, count: r.count, at: r.updated_at });
        },
      );
    });
  }

  private setStatus(id: number, status: 'approved' | 'dismissed'): Promise<void> {
    return new Promise(resolve => {
      if (!this.db) return resolve();
      this.db.run(`UPDATE translation_memory SET status = ? WHERE id = ?`, [status, id], () => resolve());
    });
  }

  /** Mark approved and return the row so the caller can add it to the glossary. */
  async takeForApproval(id: number): Promise<Candidate | null> {
    const row = await this.get(id);
    if (!row) return null;
    await this.setStatus(id, 'approved');
    return row;
  }

  dismiss(id: number): Promise<void> {
    return this.setStatus(id, 'dismissed');
  }
}
