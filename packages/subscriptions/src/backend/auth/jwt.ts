/** Minimal JWT payload decoding for claims extraction (no signature verification). */

/**
 * Decode JWT account claims without signature verification.
 * Accepts id_tokens from the provider TLS channel during an initiated code
 * exchange. The decoded claims must not authorize operations.
 * @param token - the compact JWT string.
 * @returns the parsed payload object, or `undefined` when the token is not a
 *   well-formed JWT with a JSON object payload.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    // Malformed base64url or non-JSON payload: the token is unusable for claims.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}
