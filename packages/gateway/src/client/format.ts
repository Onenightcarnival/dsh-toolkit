/** Number display of the usage tab: exact below 1 000, compact K / M / B above. */
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', compactDisplay: 'short', maximumSignificantDigits: 3 })

export const formatNumber = (value: number): string => value.toLocaleString()

/** 1 234 → 1.23K, 5 600 000 → 5.6M, 999 950 → 1M; values under 1 000 stay exact. */
export function formatCompact(value: number): string {
  return Math.abs(value) < 1000 ? formatNumber(value) : compact.format(value)
}
