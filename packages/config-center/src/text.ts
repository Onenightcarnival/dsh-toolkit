/** Text of a value of unknown shape: strings as is, numbers, bigints, booleans and errors through String, other objects as JSON; anything else is empty. */
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value)
  if (value instanceof Error) return String(value)
  if (typeof value !== 'object' || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}
