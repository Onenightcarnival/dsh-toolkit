/**
 * Rate-limit window handling shared by the subscription adapters: converts a
 * provider's disclosed reset instant into the `providerRetryAfterMs` the
 * optional `@deepseek-ai/dsh-llm-retry` plugin waits out, and resolves the
 * retry policy whose `maxDelayMs` bounds how long a route holds the turn.
 * Each adapter contributes one {@link RateLimitResetReader} built from the
 * parsing primitives here.
 *
 * @module dsh-plugin-subscriptions/providers/rate-limit
 */

import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'

/**
 * Reads the instant one provider's rate-limit window reopens off a 429.
 * @param response - the failed response, for its headers.
 * @param body - the complete response body (never truncated: readers parse JSON).
 * @param now - the current epoch milliseconds, injected so parsing is testable.
 * @returns epoch milliseconds of the reset, or undefined when the provider said nothing.
 */
export type RateLimitResetReader = (response: Response, body: string, now: number) => number | undefined

/** Extra time added to every provider-disclosed wait, absorbing clock skew. */
const RESET_GRACE_MS = 2_000

/** Shortest wait ever scheduled, including for a reset instant already in the past. */
const MIN_WAIT_MS = 1_000

/** Below this a bare number is a delay in seconds rather than an epoch stamp. */
const EPOCH_SECONDS_FLOOR = 1_000_000_000

/** At or above this a bare epoch stamp is already in milliseconds. */
const EPOCH_MILLIS_FLOOR = 1_000_000_000_000

/** Node's maximum timer delay; a longer wait cannot be scheduled at all. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Default ceiling on a rate-limit wait: six hours covers a five-hour session window with slack. */
export const DEFAULT_RATE_LIMIT_MAX_WAIT_MS = 6 * 60 * 60 * 1_000

/**
 * Interpret a bare numeric rate-limit value: epoch milliseconds, epoch
 * seconds, or a delay in seconds, separated by magnitude.
 * @param value - the raw numeric value.
 * @param now - the current epoch milliseconds.
 * @returns epoch milliseconds of the reset, or undefined when the value is unusable.
 */
export function resetInstantFromNumber(value: number, now: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined
  if (value >= EPOCH_MILLIS_FLOOR) return value
  if (value >= EPOCH_SECONDS_FLOOR) return value * 1_000
  // Values below the epoch floor are seconds; a provider reader normalizes millisecond fields first.
  return now + value * 1_000
}

/**
 * Parse a Go-style duration (`6m0s`, `1h2m3.5s`, `150ms`) into milliseconds —
 * the form OpenAI-compatible `x-ratelimit-reset-*` headers use.
 * @param text - the raw header value.
 * @returns the duration in milliseconds, or undefined when the text is not one.
 */
export function durationMs(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  // Sticky: components must be contiguous; the final length check rejects trailing text.
  const pattern = /(\d+(?:\.\d+)?)(ms|h|m|s)/y
  const units: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1 }
  let total = 0
  let matched = false
  // A failed sticky exec resets `lastIndex`; the offset is tracked separately.
  let index = 0
  // Components run strictly coarse to fine; repeated or out-of-order units are rejected.
  let previousUnit = Number.POSITIVE_INFINITY
  for (;;) {
    pattern.lastIndex = index
    const match = pattern.exec(trimmed)
    if (match === null) break
    const unit = units[match[2]]
    if (unit >= previousUnit) return undefined
    previousUnit = unit
    total += Number(match[1]) * unit
    index = pattern.lastIndex
    matched = true
  }
  if (!matched || index !== trimmed.length) return undefined
  // A zero duration is not a disclosed reset.
  return total > 0 ? total : undefined
}

/**
 * Interpret any single rate-limit value — a number, a numeric string, a
 * duration (`6m0s`), or a date — as the instant a window reopens.
 * @param value - the raw header value or JSON field.
 * @param now - the current epoch milliseconds.
 * @returns epoch milliseconds of the reset, or undefined when the value is unusable.
 */
export function resetInstantFromValue(value: unknown, now: number): number | undefined {
  if (typeof value === 'number') return resetInstantFromNumber(value, now)
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const numeric = Number(trimmed)
  if (Number.isFinite(numeric)) return resetInstantFromNumber(numeric, now)
  const duration = durationMs(trimmed)
  if (duration !== undefined) return now + duration
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Read a header carrying any of the {@link resetInstantFromValue} shapes.
 * @param response - the failed response.
 * @param name - the header to read.
 * @param now - the current epoch milliseconds.
 * @returns epoch milliseconds of the reset, or undefined when absent or unusable.
 */
export function resetInstantFromHeader(response: Response, name: string, now: number): number | undefined {
  return resetInstantFromValue(response.headers.get(name), now)
}

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
 * Parse a response body as JSON; a non-JSON body reads as undefined.
 * @param body - the complete response body.
 * @returns the parsed value, or undefined when the body is not JSON.
 */
export function jsonBody(body: string): unknown {
  if (body.length === 0) return undefined
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

/** How deep {@link resetFromFields} walks. */
const MAX_BODY_DEPTH = 4

/**
 * Find reset instants by provider-specific field names at any body depth
 * within the recursion limit. Returns the earliest matching instant.
 * @param value - the parsed body, or any nested value.
 * @param keys - field names this provider uses for a reset or delay.
 * @param now - the current epoch milliseconds.
 * @param depth - remaining recursion depth.
 * @returns the earliest instant found, or undefined when no key matched.
 */
export function resetFromFields(
  value: unknown,
  keys: readonly string[],
  now: number,
  depth = MAX_BODY_DEPTH,
): number | undefined {
  if (depth <= 0 || value === null || typeof value !== 'object') return undefined
  let earliest: number | undefined
  const consider = (candidate: number | undefined): void => {
    if (candidate !== undefined && (earliest === undefined || candidate < earliest)) earliest = candidate
  }
  if (Array.isArray(value)) {
    for (const item of value) consider(resetFromFields(item, keys, now, depth - 1))
    return earliest
  }
  for (const [key, nested] of Object.entries(value)) {
    if (keys.includes(key)) consider(resetInstantFromValue(nested, now))
    else consider(resetFromFields(nested, keys, now, depth - 1))
  }
  return earliest
}

/**
 * The earliest of several candidate reset instants, ignoring absent ones.
 * @param candidates - reset instants in no particular order.
 * @returns the earliest instant, or undefined when every candidate is absent.
 */
export function earliestReset(...candidates: (number | undefined)[]): number | undefined {
  let earliest: number | undefined
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    if (earliest === undefined || candidate < earliest) earliest = candidate
  }
  return earliest
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

/** Header names worth showing when a 429 disclosed no reset this code recognizes. */
const DIAGNOSTIC_HEADER = /rate-?limit|retry|reset|^x-codex-/i

/**
 * Render rate-limit headers and the start of a 429 response body as one line.
 * The adapter emits this diagnostic through onWarn when no reset is parsed.
 * Per-bucket rollover snapshots are diagnostic data, not wait deadlines.
 * @param response - the failed response.
 * @param body - the complete response body.
 * @returns a one-line diagnostic.
 */
export function rateLimitDiagnostics(response: Response, body: string): string {
  const headers: string[] = []
  response.headers.forEach((value, key) => {
    if (DIAGNOSTIC_HEADER.test(key)) headers.push(`${key}: ${value}`)
  })
  headers.sort()
  const rendered = headers.length > 0 ? headers.join('; ') : '(none)'
  const head = body.slice(0, 200)
  return `429 disclosed no reset time; headers [${rendered}]; body ${head.length > 0 ? head : '(empty)'}`
}

/** Per-route retry shape a subscription adapter starts from. */
export interface RetryDefaults {
  /** Retries after the first attempt. */
  readonly maxRetries: number
  /** First local backoff delay. */
  readonly initialDelayMs: number
  /** Local backoff ceiling, and the accepted-provider-delay ceiling when waiting is off. */
  readonly maxDelayMs: number
  /** Symmetric jitter around each local delay. */
  readonly jitterRatio: number
}

/** Subscription retries use exponential backoff from 1s to 60s, with 20% jitter.
 * A disclosed quota reset is bounded separately by the configured wait ceiling.
 */
export const DEFAULT_RETRY: RetryDefaults = Object.freeze({
  maxRetries: 10,
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  jitterRatio: 0.2,
})

/** How long a route may hold a turn open waiting for a rate-limit window. */
export interface RateLimitWait {
  /** Whether a disclosed reset may be waited out at all. */
  readonly wait: boolean
  /** Ceiling on one wait; a reset further out fails the turn instead. */
  readonly maxWaitMs: number
}

/** Rate-limit waiting as the plugin config accepts it. */
export interface RateLimitConfig {
  /** Wait for a disclosed reset instead of failing the turn (default true). */
  wait?: boolean
  /** Ceiling on one wait in milliseconds (default six hours). */
  maxWaitMs?: number
}

/** Waiting behavior a route falls back to when the plugin passed none (waiting on, six-hour ceiling). */
export const DEFAULT_RATE_LIMIT_WAIT: RateLimitWait = Object.freeze({
  wait: true,
  maxWaitMs: DEFAULT_RATE_LIMIT_MAX_WAIT_MS,
})

/**
 * Validate and default the rate-limit waiting config.
 * @param config - the raw plugin config section, when present.
 * @param path - diagnostic path naming the config that owns the value.
 * @returns the resolved, immutable behavior.
 */
export function resolveRateLimitWait(config: RateLimitConfig | undefined, path: string): RateLimitWait {
  const wait = config?.wait ?? true
  const maxWaitMs = config?.maxWaitMs ?? DEFAULT_RATE_LIMIT_MAX_WAIT_MS
  if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0) {
    throw new Error(`${path}.maxWaitMs must be a positive finite number of milliseconds`)
  }
  if (maxWaitMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.maxWaitMs must be no greater than ${String(MAX_TIMER_DELAY_MS)} (the maximum schedulable delay)`)
  }
  return Object.freeze({ wait, maxWaitMs })
}

/**
 * Resolve retry policy with a delay ceiling covering the configured reset wait.
 * The same ceiling applies to exponential backoff; the retry count remains
 * bounded by the route policy.
 * @param defaults - the route's retry shape.
 * @param rateLimit - resolved waiting behavior.
 * @param path - diagnostic path naming the provider route.
 * @returns the policy to report from `providerRetryPolicy`.
 */
export function subscriptionRetryPolicy(
  defaults: RetryDefaults,
  rateLimit: RateLimitWait,
  path: string,
): ResolvedRetryPolicy {
  const maxDelayMs = rateLimit.wait
    ? Math.max(defaults.maxDelayMs, rateLimit.maxWaitMs)
    : defaults.maxDelayMs
  return resolveRetryPolicy({
    mode: 'normal',
    maxRetries: defaults.maxRetries,
    backoff: {
      initialDelayMs: defaults.initialDelayMs,
      maxDelayMs,
      jitterRatio: defaults.jitterRatio,
    },
  }, path)
}
