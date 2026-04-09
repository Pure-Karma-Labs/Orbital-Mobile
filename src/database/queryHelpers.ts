import type { Scalar } from '@op-engineering/op-sqlite';
import { getDatabase } from './connection';

/**
 * Execute a query and return the first row as a typed object, or null if no rows.
 *
 * Converts ArrayBuffer BLOB values to Uint8Array automatically.
 */
export function queryOne<T>(sql: string, params?: Scalar[]): T | null {
  const db = getDatabase();
  const result = db.executeSync(sql, params);
  if (result.rows.length === 0) return null;
  return mapRow<T>(result.rows[0]);
}

/**
 * Execute a query and return all rows as typed objects.
 *
 * Converts ArrayBuffer BLOB values to Uint8Array automatically.
 */
export function queryMany<T>(sql: string, params?: Scalar[]): T[] {
  const db = getDatabase();
  const result = db.executeSync(sql, params);
  return result.rows.map((row) => mapRow<T>(row));
}

/**
 * Execute a DML statement (INSERT, UPDATE, DELETE) and return the number of
 * affected rows.
 */
export function execute(
  sql: string,
  params?: Scalar[],
): { rowsAffected: number } {
  const db = getDatabase();
  const result = db.executeSync(sql, params);
  return { rowsAffected: result.rowsAffected ?? 0 };
}

/**
 * Map a QueryResult row (Record<string, Scalar>) to a typed object.
 * Converts ArrayBuffer BLOB values to Uint8Array for consistent consumption
 * by repository callers.
 */
function mapRow<T>(row: Record<string, Scalar>): T {
  const obj: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const value: Scalar = row[key];
    obj[key] = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  }
  return obj as unknown as T;
}
