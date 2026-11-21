/**
 * The lifetime field of a capture rule: one text box for both forms. Digits
 * are a number of seconds; any other text is a JSON path into the response.
 */

import { MAX_CAPTURE_TTL_SECONDS, type HttpCapture } from '../protocol.ts'

type Lifetime = Pick<HttpCapture, 'ttlSeconds' | 'ttlPath'>

/** Text of the field: the path when set, else the seconds, else empty. */
export function lifetimeText(rule: Lifetime): string {
  return rule.ttlPath !== '' ? rule.ttlPath : rule.ttlSeconds > 0 ? String(rule.ttlSeconds) : ''
}

/** Lifetime of a typed text; seconds above the maximum are capped. */
export function parseLifetime(text: string): Lifetime {
  const value = text.trim()
  if (/^\d+$/.test(value)) return { ttlSeconds: Math.min(Number(value), MAX_CAPTURE_TTL_SECONDS), ttlPath: '' }
  return { ttlSeconds: 0, ttlPath: value }
}
