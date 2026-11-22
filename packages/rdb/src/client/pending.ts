/**
 * Pending changes of the data grid. Each change is tied to the primary key of
 * its row, read when the change is made, so it stays with that row whatever
 * page, sort order or filter the grid shows afterwards.
 */

import type { RowChange } from '../protocol.ts'

/** Primary-key column → value of one row. */
export type RowKey = Record<string, unknown>

/** New values of one row, by column name. */
export interface PendingUpdate {
  key: RowKey
  values: Record<string, unknown>
}

/** Pending updates and deletes by row id (see {@link rowId}). */
export type PendingUpdates = ReadonlyMap<string, PendingUpdate>
export type PendingDeletes = ReadonlyMap<string, RowKey>

/**
 * Primary key of a result row. Undefined when the row cannot be addressed: the
 * table has no primary key, a key column is not in the result, or a key value
 * is null or not a scalar (a binary key arrives as a size placeholder).
 */
export function rowKey(primaryKey: readonly string[], columnIndex: ReadonlyMap<string, number>, row: readonly unknown[]): RowKey | undefined {
  if (primaryKey.length === 0) return undefined
  const key: RowKey = {}
  for (const name of primaryKey) {
    const index = columnIndex.get(name)
    const value = index === undefined ? undefined : row[index]
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined
    key[name] = value
  }
  return key
}

/** Identity of a row within its table: the key values in primary-key order. A number and its digits as text stay distinct. */
export function rowId(primaryKey: readonly string[], key: RowKey): string {
  return JSON.stringify(primaryKey.map(name => key[name]))
}

/** Cell text for display and comparison; objects and arrays are shown as JSON. */
export function cellText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value)
  if (typeof value !== 'object' || value === null) return ''
  return JSON.stringify(value)
}

/**
 * Pending updates after one cell edit. A value equal to the stored one removes
 * the cell from the pending update, and a row without pending cells leaves the map.
 * @param original - the cell value as loaded.
 */
export function withCellEdit(updates: PendingUpdates, id: string, key: RowKey, column: string, value: unknown, original: unknown): Map<string, PendingUpdate> {
  const next = new Map(updates)
  const values = { ...next.get(id)?.values }
  if (cellText(value) === cellText(original) && (value === null) === (original === null)) delete values[column]
  else values[column] = value
  if (Object.keys(values).length === 0) next.delete(id)
  else next.set(id, { key, values })
  return next
}

/** The changes to send: updates of rows not marked for deletion, then inserts, then deletes. */
export function buildChanges(updates: PendingUpdates, inserts: ReadonlyArray<Record<string, unknown>>, deletes: PendingDeletes): RowChange[] {
  const out: RowChange[] = []
  for (const [id, update] of updates) {
    if (!deletes.has(id)) out.push({ kind: 'update', key: update.key, values: update.values })
  }
  for (const values of inserts) out.push({ kind: 'insert', values })
  for (const key of deletes.values()) out.push({ kind: 'delete', key })
  return out
}
