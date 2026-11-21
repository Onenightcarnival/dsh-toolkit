/** Keep a UTF-16 length budget without splitting a code point; replace lone surrogates. */
export function safeTextPrefix(text: string, maxChars: number): string {
  let end = Math.max(0, Math.floor(maxChars))
  if (end > 0 && end < text.length) {
    const before = text.charCodeAt(end - 1)
    const after = text.charCodeAt(end)
    if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) end--
  }
  return text.slice(0, end).replace(/\p{Surrogate}/gu, '\uFFFD')
}

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
