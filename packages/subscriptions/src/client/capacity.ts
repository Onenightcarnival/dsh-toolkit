/** DSH capacity syntax: decimal tokens, with optional case-insensitive K/M. */
export function parseCapacity(text: string): number | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(trimmed)
  if (!match) return NaN
  const scale = match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2]?.toLowerCase() === 'k' ? 1_000 : 1
  const scaled = Number(match[1]) * scale
  const rounded = Math.round(scaled)
  return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled
}

/** Format whole thousands/millions without losing precision. */
export function formatCapacity(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) return String(value)
  if (value % 1_000_000 === 0) return `${value / 1_000_000}M`
  if (value % 1_000 === 0) return `${value / 1_000}K`
  return String(value)
}
