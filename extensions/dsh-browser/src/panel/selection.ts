/**
 * Attaching a captured page selection to a prompt, and reading it back out.
 *
 * The quote is page-authored text, so it ships inside the same nonce-fenced
 * boundary as every snapshot — including its source title and URL, which a
 * hostile page also controls. The header line above the fence is the only
 * extension-authored part.
 *
 * The composed text is what the transcript stores, so the panel parses its own
 * format back into a quote card. Parsing survives a session resume, where the
 * only record of the attachment is the message itself. Every field the parser
 * reads is a labelled header line above the quote, so page text can never be
 * mistaken for metadata by ending with the right sentence.
 *
 * @module
 */

import { wrapUntrustedContent } from '../security/untrusted.ts'
import type { PageSelection } from '../selection.ts'

const SELECTION_HEADER = '[user-selected page text] The user highlighted this text in their browser and attached it to the message below.'
const TITLE_LABEL = 'Source title: '
const URL_LABEL = 'Source URL: '
const TRUNCATED_LABEL = 'Truncated: '
const TEXT_LABEL = 'Selected text:'
const TRUNCATED_NOTE = 'yes (the highlight was longer than the capture limit and was cut)'
const OPEN_PREFIX = '<UNTRUSTED_PAGE_CONTENT nonce="'
/** Generous ceiling: a capture is already bounded well below the boundary cost. */
const SELECTION_BLOCK_MAX_CHARS = 8_000

/** The attachment recovered from a stored message, for the quote card. */
export interface AttachedSelection {
  title: string
  url: string
  quote: string
  truncated: boolean
}

/**
 * Compose the prompt text for a message that carries a selection.
 * @param selection - the captured highlight.
 * @param message - what the user typed; may be empty.
 * @returns the fenced quote block followed by the user's own words.
 */
export function selectionPromptText(selection: PageSelection, message: string): string {
  const body = [
    `${TITLE_LABEL}${selection.title === '' ? '(untitled page)' : selection.title}`,
    `${URL_LABEL}${selection.url === '' ? '(unknown URL)' : selection.url}`,
    `${TRUNCATED_LABEL}${selection.truncated ? TRUNCATED_NOTE : 'no'}`,
    TEXT_LABEL,
    selection.text,
  ].join('\n')
  const block = `${SELECTION_HEADER}\n${wrapUntrustedContent(body, SELECTION_BLOCK_MAX_CHARS)}`
  return message === '' ? block : `${block}\n\n${message}`
}

/**
 * Recover the quote and the user's words from a composed message.
 * @param text - a stored user message.
 * @returns the parts, or null when the message carries no selection.
 */
export function splitSelectionMessage(text: string): { selection: AttachedSelection; message: string } | null {
  if (!text.startsWith(SELECTION_HEADER)) return null
  const openStart = text.indexOf(OPEN_PREFIX)
  if (openStart === -1) return null
  const nonceStart = openStart + OPEN_PREFIX.length
  const nonceEnd = text.indexOf('">\n', nonceStart)
  if (nonceEnd === -1) return null
  const closing = `\n</UNTRUSTED_PAGE_CONTENT nonce="${text.slice(nonceStart, nonceEnd)}">`
  const bodyStart = nonceEnd + '">\n'.length
  const bodyEnd = text.indexOf(closing, bodyStart)
  if (bodyEnd === -1) return null

  const lines = text.slice(bodyStart, bodyEnd).split('\n')
  const [titleLine, urlLine, truncatedLine, textLine] = lines
  if (titleLine?.startsWith(TITLE_LABEL) !== true
    || urlLine?.startsWith(URL_LABEL) !== true
    || truncatedLine?.startsWith(TRUNCATED_LABEL) !== true
    || textLine !== TEXT_LABEL) return null

  // Everything after the last header line is quote, so page text cannot be
  // read as metadata however it happens to end.
  return {
    selection: {
      title: titleLine.slice(TITLE_LABEL.length),
      url: urlLine.slice(URL_LABEL.length),
      quote: lines.slice(4).join('\n'),
      truncated: truncatedLine.slice(TRUNCATED_LABEL.length) === TRUNCATED_NOTE,
    },
    // The trailing notice closes the boundary; the user's own words follow it.
    message: (() => {
      const afterBoundary = text.indexOf('\n\n', bodyEnd + closing.length)
      return afterBoundary === -1 ? '' : text.slice(afterBoundary + 2)
    })(),
  }
}

/** Label a quote's origin: the page title, else its host, else nothing. */
export function selectionSourceLabel(selection: { title: string; url: string }): string {
  if (selection.title !== '') return selection.title
  try {
    return new URL(selection.url).hostname
  } catch {
    return ''
  }
}
