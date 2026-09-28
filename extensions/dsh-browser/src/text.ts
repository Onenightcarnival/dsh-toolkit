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
