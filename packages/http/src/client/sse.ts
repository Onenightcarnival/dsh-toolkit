/** Event stream helpers of the panel: rows of a recorded stream and the text of model output streams. Pure functions; no DOM. */
import { parseSse, type HttpSseEvent } from '../protocol.ts'

/** An event with its arrival time (ms after the request started), when known. */
export interface SseRow extends HttpSseEvent {
  at?: number
}

/** Rows of a recorded stream: its text parsed again, paired with the recorded arrival times. */
export function sseRows(body: string, times: readonly number[] | undefined): SseRow[] {
  return parseSse(body).map((event, index) => (times?.[index] === undefined ? event : { ...event, at: times[index] }))
}

type Json = Record<string, unknown>

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Json)[key] : undefined
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined
}

/**
 * Text increment carried by one event of a model output stream, or '' when the
 * event carries none. Recognized shapes: OpenAI Chat Completions
 * (`choices[0].delta.content`), completions (`choices[0].text`), Responses
 * (`response.output_text.delta`), Anthropic Messages (`content_block_delta`
 * with `delta.text`) and Gemini (`candidates[0].content.parts[0].text`).
 */
export function deltaText(data: string): string {
  if (data === '' || data[0] !== '{') return ''
  let json: unknown
  try {
    json = JSON.parse(data)
  } catch {
    return ''
  }
  const choice = first(field(json, 'choices'))
  const candidates: unknown[] = [
    field(field(choice, 'delta'), 'content'),
    field(choice, 'text'),
    field(json, 'type') === 'response.output_text.delta' ? field(json, 'delta') : undefined,
    field(json, 'type') === 'content_block_delta' ? field(field(json, 'delta'), 'text') : undefined,
    field(first(field(field(first(field(json, 'candidates')), 'content'), 'parts')), 'text'),
  ]
  const found = candidates.find(value => typeof value === 'string' && value !== '')
  return typeof found === 'string' ? found : ''
}
