/**
 * Shared contract for the text a user highlights in a browser page.
 *
 * A selection travels content script → service worker → side panel before the
 * user attaches it to a prompt, so it crosses two message boundaries as
 * page-authored data. Each hop re-validates and re-normalizes it here rather
 * than trusting the previous one, and the character ceiling is enforced at
 * every hop so a hostile page cannot grow the payload after capture.
 *
 * @module
 */

/** Hard ceiling on one captured selection; longer highlights are truncated. */
export const MAX_SELECTION_CHARS = 4_000

const MAX_SELECTION_TITLE_CHARS = 200
const MAX_SELECTION_URL_CHARS = 500

/** One selection as observed inside a single frame. */
export interface SelectionCapture {
  text: string
  /** The highlight exceeded {@link MAX_SELECTION_CHARS} and was cut. */
  truncated: boolean
  title: string
  url: string
}

/** A capture stamped by the service worker for the side panels. */
export interface PageSelection extends SelectionCapture {
  capturedAt: number
}

/**
 * Collapse a raw highlight into quotable text: horizontal whitespace runs
 * become single spaces while line structure survives, because a quoted
 * paragraph list is unreadable once its breaks are flattened.
 * @param raw - the browser's selection string.
 * @returns the normalized text and whether the ceiling cut it.
 */
export function normalizeSelectionText(raw: string): { text: string; truncated: boolean } {
  const collapsed = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (collapsed.length <= MAX_SELECTION_CHARS) return { text: collapsed, truncated: false }
  return { text: collapsed.slice(0, MAX_SELECTION_CHARS).trimEnd(), truncated: true }
}

function normalizeSelectionTitle(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_SELECTION_TITLE_CHARS)
}

/** Keep only page URLs the extension is allowed to run in; drop anything else. */
function normalizeSelectionUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_SELECTION_URL_CHARS) return ''
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString().slice(0, MAX_SELECTION_URL_CHARS) : ''
  } catch {
    return ''
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate a capture that arrived over a runtime message.
 * @param value - the untrusted message payload.
 * @returns the normalized capture, or null when it carries no usable text.
 */
export function parseSelectionCapture(value: unknown): SelectionCapture | null {
  if (!isRecord(value) || typeof value.text !== 'string') return null
  const { text, truncated } = normalizeSelectionText(value.text)
  if (text === '') return null
  return {
    text,
    truncated: truncated || value.truncated === true,
    title: normalizeSelectionTitle(value.title),
    url: normalizeSelectionUrl(value.url),
  }
}

/**
 * Validate a stamped selection that arrived over the panel port.
 * @param value - the untrusted message payload.
 * @returns the normalized selection, or null when it is unusable.
 */
export function parsePageSelection(value: unknown): PageSelection | null {
  const capture = parseSelectionCapture(value)
  if (capture === null || !isRecord(value)) return null
  const capturedAt = value.capturedAt
  if (typeof capturedAt !== 'number' || !Number.isFinite(capturedAt)) return null
  return { ...capture, capturedAt }
}
