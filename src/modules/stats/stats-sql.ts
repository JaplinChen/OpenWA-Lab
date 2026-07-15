/**
 * SQL for the time-series timestamp bucket, per DB dialect. SQLite has strftime(); Postgres has
 * neither strftime nor a case-insensitive bare `m.createdAt` (unquoted it folds to lowercase and
 * misses the quoted "createdAt" column) — so it needs to_char() with a quoted column. The hour
 * format yields an identical zero-padded, chronologically-sortable label on both engines, so the
 * GROUP BY/ORDER BY on the alias and the downstream map() are unchanged.
 */
export function timeSeriesTimestampSql(dbType: string, interval: 'hour' | 'day'): string {
  if (dbType === 'postgres') {
    const fmt = interval === 'hour' ? 'YYYY-MM-DD HH24:00:00' : 'YYYY-MM-DD';
    return `to_char(m."createdAt", '${fmt}')`;
  }
  const fmt = interval === 'hour' ? '%Y-%m-%d %H:00:00' : '%Y-%m-%d';
  return `strftime('${fmt}', m.createdAt)`;
}

/** SQL for the integer hour-of-day (0-23) bucket, per DB dialect. */
export function hourBucketSql(dbType: string): string {
  return dbType === 'postgres'
    ? `CAST(EXTRACT(HOUR FROM m."createdAt") AS INTEGER)`
    : `CAST(strftime('%H', m.createdAt) AS INTEGER)`;
}

/**
 * SQL for the most-recent-activity timestamp (MAX of createdAt) as an identical text format on both
 * engines. SQLite's MAX over a `datetime` column returns the stored text; Postgres returns a timestamp
 * the driver hydrates to a JS Date (serialized to a different ISO string). to_char/strftime pin both
 * to `YYYY-MM-DD HH:MM:SS`, matching the format the time-series buckets already use, so the lastActive
 * field is stable regardless of the backing database.
 */
export function maxCreatedAtSql(dbType: string): string {
  return dbType === 'postgres'
    ? `to_char(MAX(m."createdAt"), 'YYYY-MM-DD HH24:MI:SS')`
    : `strftime('%Y-%m-%d %H:%M:%S', MAX(m.createdAt))`;
}
