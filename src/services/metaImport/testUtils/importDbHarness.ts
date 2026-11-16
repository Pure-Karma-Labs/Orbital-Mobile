/**
 * A REAL SQLite database for the import suites (#926).
 *
 * `importRepository` is the whole storage contract for the runner, and every
 * other suite in this repo exercises it against a mocked op-sqlite — which
 * proves the SQL strings and the bindings, but not that a status-guarded
 * UPDATE actually moves a row. The batch assembly layer's contract is written
 * in terms of those return values ("a short `markItemsUploading` means the
 * batch is stale"), so the suites here run the REAL repository against
 * migration 009's DDL executed on `node:sqlite` — the same harness
 * `src/database/__tests__/migrations.ddl.test.ts` established, and the same
 * SQLite series (3.53.x) op-sqlite ships.
 *
 * The test file must declare the op-sqlite mock itself (`jest.mock` is
 * hoisted, so it cannot live here):
 *
 * ```ts
 * jest.mock('@op-engineering/op-sqlite', () => ({ open: jest.fn() }));
 * ```
 *
 * Test-only helper: nothing here is reachable from app code.
 */

import { DatabaseSync } from 'node:sqlite';
import { open } from '@op-engineering/op-sqlite';
import { resetDatabaseForTesting } from '../../../database/connection';
import { SQL as SQL_009 } from '../../../database/migrations/009_meta_import_tables';

import type { DB, Scalar } from '@op-engineering/op-sqlite';

/** What op-sqlite's `executeSync` resolves to, as the query helpers read it. */
interface SyncResult {
  rows: Record<string, Scalar>[];
  rowsAffected: number;
}

type Bindable = null | number | bigint | string | Uint8Array;

/** Statements `node:sqlite` will not prepare, or that return nothing. */
const DIRECT_EXEC = /^(BEGIN|COMMIT|ROLLBACK|PRAGMA)/i;

/** Statements whose answer is rows rather than a change count. */
const READ = /^(SELECT|WITH|EXPLAIN)/i;

function bindables(params?: unknown[]): Bindable[] {
  return (params ?? []).map((p) => (p === undefined ? null : (p as Bindable)));
}

function runSql(db: DatabaseSync, sql: string, params?: unknown[]): SyncResult {
  const text = sql.trim();
  if (DIRECT_EXEC.test(text)) {
    db.exec(text);
    return { rows: [], rowsAffected: 0 };
  }
  const statement = db.prepare(text);
  if (READ.test(text)) {
    return {
      rows: statement.all(...bindables(params)) as unknown as Record<string, Scalar>[],
      rowsAffected: 0,
    };
  }
  const result = statement.run(...bindables(params));
  return { rows: [], rowsAffected: Number(result.changes) };
}

export interface ImportDbHarness {
  /** The underlying database, for assertions the repository has no reader for. */
  readonly sqlite: DatabaseSync;
  /** Every statement the repository issued, in order. */
  readonly executeSync: jest.Mock;
  readonly close: () => void;
}

/**
 * Open an in-memory database with migration 009 applied and point
 * `src/database/connection` at it.
 */
export function openImportDb(): ImportDbHarness {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(SQL_009);

  const executeSync = jest.fn((sql: string, params?: unknown[]) => runSql(sqlite, sql, params));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    sqlite.close();
  };

  (open as jest.MockedFunction<typeof open>).mockReturnValueOnce({
    executeSync,
    close,
  } as unknown as DB);
  resetDatabaseForTesting();

  return { sqlite, executeSync, close };
}
