/**
 * Rate-limit window handling: converts the reset instant a response discloses
 * into the `providerRetryAfterMs` the optional `@deepseek-ai/dsh-llm-retry`
 * plugin waits out.
 *
 * @module dsh-plugin-subscriptions/providers/rate-limit
 */

/** Extra time added to every provider-disclosed wait, absorbing clock skew. */
const RESET_GRACE_MS = 2_000

/** Shortest wait ever scheduled, including for a reset instant already in the past. */
const MIN_WAIT_MS = 1_000

/**
 * Read the RFC 7231 `retry-after` header in both its forms: a delay in seconds
 * (never an epoch stamp, whatever its magnitude) or an HTTP-date.
 * @param response - the failed response.
 * @param now - the current epoch milliseconds.
 * @returns epoch milliseconds of the reset, or undefined when absent or unusable.
 */
export function retryAfterInstant(response: Response, now: number): number | undefined {
  const raw = response.headers.get('retry-after')
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds)) return seconds > 0 ? now + seconds * 1_000 : undefined
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Convert a reset instant to providerRetryAfterMs without an upper cap.
 * A wait above the retry policy maxDelayMs delegates immediately.
 * @param instant - epoch milliseconds the window reopens.
 * @param now - the current epoch milliseconds.
 * @returns the wait in milliseconds, never below {@link MIN_WAIT_MS}.
 */
export function waitFromReset(instant: number, now: number): number {
  return Math.max(MIN_WAIT_MS, instant - now + RESET_GRACE_MS)
}
