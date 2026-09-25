/** Render a literal for SQL previews and grid edits (standard '' quoting; backslashes are plain characters). */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return "'" + text.replace(/'/g, "''") + "'"
}
