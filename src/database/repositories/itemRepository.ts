import type { ItemRow } from '../../types/database';
import { queryOne, queryMany, execute } from '../queryHelpers';

export function getItem(id: string): string | null {
  const row = queryOne<ItemRow>('SELECT * FROM items WHERE id = ?', [id]);
  return row?.value ?? null;
}

export function setItem(id: string, value: string): void {
  execute('INSERT OR REPLACE INTO items (id, value) VALUES (?, ?)', [
    id,
    value,
  ]);
}

export function removeItem(id: string): void {
  execute('DELETE FROM items WHERE id = ?', [id]);
}

export function getAllItems(): ItemRow[] {
  return queryMany<ItemRow>('SELECT * FROM items');
}
