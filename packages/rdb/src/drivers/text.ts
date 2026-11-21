/** Text of a catalog value: strings as is, numbers, bigints and booleans through String, binary as UTF-8, dates as ISO 8601, other objects as JSON; anything else is empty. */
export function catalogText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value)
  if (value instanceof Uint8Array) return Buffer.from(value).toString()
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'object' || value === null) return ''
  return JSON.stringify(value)
}
