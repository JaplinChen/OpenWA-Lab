import type { QueryRunner } from 'typeorm';
import { isMissingTableError } from '../../common/utils/db-errors';
import type { ImportDataResult, MigrationCounts, MigrationTables } from './infra.types';
import type { DataTransferCtx } from './infra-data-transfer.ctx';
import { IMPORT_SPECS, type AnyImportSpec } from './infra-import-specs';

/**
 * Restore one table. A row that fails to INSERT is recorded as a warning rather than thrown: the
 * caller turns any warning into a full rollback, so collecting them reports every bad row at once
 * instead of only the first.
 */
async function importRows(
  queryRunner: QueryRunner,
  spec: AnyImportSpec,
  rows: readonly unknown[] | undefined,
  warnings: string[],
): Promise<number> {
  // One cast, here: the specs are a union over MigrationTables keys, so the checker can't correlate
  // `spec.values` with the rows read out of `data.tables[spec.key]`. Each spec's mapping IS checked
  // against its own row type at the definition site (the `spec<K>()` helper), which is where a wrong
  // column would actually be written.
  const { values, id, skip } = spec as unknown as {
    values: (row: unknown) => unknown[];
    id: (row: unknown) => unknown;
    skip?: (row: unknown) => string | null;
  };
  let count = 0;
  for (const row of rows ?? []) {
    const skipWarning = skip?.(row);
    if (skipWarning) {
      warnings.push(skipWarning);
      continue;
    }
    try {
      await queryRunner.query(spec.sql, values(row));
      count++;
    } catch (err) {
      warnings.push(`Failed to import ${spec.noun} ${String(id(row))}: ${err}`);
    }
  }
  return count;
}

/**
 * Tables cleared before the restore, in FK-safe order. templates and baileys_stored_messages FK
 * sessions ON DELETE CASCADE, so the sessions DELETE would clear them too; clearing them explicitly
 * first keeps the order correct on engines where the cascade is not enforced. lid_mappings is not an
 * FK to sessions, and the Integration Fabric tables + both DLQs carry no FK to it either (sessionId
 * is provenance), so each must be cleared explicitly for replace-semantics to be complete.
 */
const CLEARED_TABLES = [
  'messages',
  'message_batches',
  'templates',
  'baileys_stored_messages',
  'lid_mappings',
  'plugin_instances',
  'conversation_mappings',
  'ingress_events',
  'webhook_delivery_failures',
  'integration_delivery_failures',
] as const;

export async function importData(
  ctx: DataTransferCtx,
  data: { tables: Partial<MigrationTables> },
): Promise<ImportDataResult> {
  const warnings: string[] = [];
  const queryRunner = ctx.dataDataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();

  try {
    // Tolerate a genuinely-absent table (isMissingTableError) but let any OTHER failure (lock, I/O,
    // aborted tx) propagate to the transaction rollback below — a blind `.catch(() => {})` here could
    // otherwise silently commit a MERGED (not replaced) restore on SQLite, violating the endpoint's
    // "replaces existing data" contract.
    const clearTable = async (table: string): Promise<void> => {
      try {
        await queryRunner.query(`DELETE FROM ${table}`);
      } catch (err) {
        if (!isMissingTableError(err)) throw err;
        ctx.logger.debug('Skipped clearing a table that does not exist during import', { table });
      }
    };
    await queryRunner.query('DELETE FROM webhooks');
    for (const table of CLEARED_TABLES) {
      await clearTable(table);
    }
    await queryRunner.query('DELETE FROM sessions');

    // Ordered by IMPORT_SPECS — sessions first, since other tables FK it.
    const counts = {} as MigrationCounts;
    for (const spec of IMPORT_SPECS) {
      counts[spec.key] = await importRows(queryRunner, spec, data.tables[spec.key], warnings);
    }

    // "Replace all data" must be all-or-nothing: the import already DELETEd every row, so if any
    // INSERT failed we must roll back (restoring the pre-import data) rather than commit a
    // half-wiped DB and report success. A partial restore reported as imported:true was how
    // message history could silently vanish on a SQLite->Postgres migration.
    if (warnings.length > 0) {
      await queryRunner.rollbackTransaction();
      return { imported: false, counts, warnings };
    }

    // A wrong/empty/garbage backup file restores zero rows but the DELETE already ran — committing
    // would silently WIPE the database and report success. Refuse it and roll back instead. (#488 review)
    const totalRestored = IMPORT_SPECS.reduce((sum, s) => sum + counts[s.key], 0);
    if (totalRestored === 0) {
      await queryRunner.rollbackTransaction();
      return {
        imported: false,
        counts,
        warnings: ['Backup contained no rows to restore; refused to replace existing data. Check the file.'],
      };
    }

    await queryRunner.commitTransaction();
    return { imported: true, counts, warnings };
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    await queryRunner.release();
  }
}

// ============================================================================
// STORAGE MIGRATION API
// ============================================================================
