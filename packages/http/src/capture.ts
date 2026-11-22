/**
 * Capture rules: read one value from a response (a path into the JSON body, or
 * a header) for a variable of the request's scope. Pure; the engine runs the
 * rules on the response as received, before masking.
 */

import type { HttpCapture, HttpCaptureResult } from './protocol.ts'

/** Variable name grammar, shared with target variables. */
export const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/
/** Longest captured value. */
export const MAX_CAPTURED_LENGTH = 16 * 1024
const MAX_PATH_LENGTH = 512

/**
 * Segments of a JSON path: `data.token`, `items[0].id`, `$.a["b.c"]`. A leading
 * `$` is optional; names follow dots, indexes and quoted names sit in brackets.
 * @throws on a malformed path.
 */
export function parseJsonPath(path: string): Array<string | number> {
  const text = path.trim()
  if (text === '' || text === '$') throw new Error('path is empty')
  if (text.length > MAX_PATH_LENGTH) throw new Error('path is too long')
  const out: Array<string | number> = []
  let i = text.startsWith('$') ? 1 : 0
  let first = i === 0
  while (i < text.length) {
    const char = text[i]
    if (char === '[') {
      const close = text.indexOf(']', i)
      if (close < 0) throw new Error(`unclosed "[" at ${i}`)
      const inner = text.slice(i + 1, close).trim()
      const quoted = /^(["'])(.*)\1$/.exec(inner)
      if (quoted !== null) out.push(quoted[2] ?? '')
      else if (/^\d+$/.test(inner)) out.push(Number(inner))
      else throw new Error(`invalid index "${inner}"`)
      i = close + 1
    } else {
      if (char === '.') i++
      else if (!first) throw new Error(`unexpected "${char}" at ${i}`)
      const match = /^[^.[\]]+/.exec(text.slice(i))
      if (match === null) throw new Error(`name expected at ${i}`)
      out.push(match[0])
      i += match[0].length
    }
    first = false
  }
  return out
}

/** Value at a parsed path; undefined when a step is missing. */
export function readPath(root: unknown, segments: ReadonlyArray<string | number>): unknown {
  let node: unknown = root
  for (const segment of segments) {
    if (Array.isArray(node)) {
      const index = typeof segment === 'number' ? segment : /^\d+$/.test(segment) ? Number(segment) : -1
      node = index >= 0 ? node[index] : undefined
    } else if (typeof node === 'object' && node !== null) {
      const key = String(segment)
      node = Object.hasOwn(node, key) ? (node as Record<string, unknown>)[key] : undefined
    } else {
      return undefined
    }
  }
  return node
}

/** The response as the capture rules read it. */
export interface CaptureInput {
  status: number
  headers: Headers
  /** Decoded body; empty for a binary body. */
  body: string
  /** The body cap cut the body short. */
  truncated: boolean
}

/**
 * Run capture rules on a response. Rules switched off or without a name are
 * left out; a response outside 2xx captures nothing. A rule's lifetime comes
 * from `ttlPath` (seconds, read from the JSON body) or else from `ttlSeconds`;
 * a lifetime path that yields no positive number leaves the value without
 * expiry and puts a warning on the result.
 * @returns the captured values and their lifetimes in ms by variable name, and one result per rule run.
 */
export function runCaptures(rules: readonly HttpCapture[], input: CaptureInput): { values: Record<string, string>; lifetimes: Record<string, number>; results: HttpCaptureResult[] } {
  const values: Record<string, string> = {}
  const lifetimes: Record<string, number> = {}
  const results: HttpCaptureResult[] = []
  let parsed: { value: unknown } | { error: string } | undefined
  const json = (): { value: unknown } | { error: string } => {
    if (parsed !== undefined) return parsed
    if (input.truncated) parsed = { error: 'response body is truncated' }
    else {
      try {
        parsed = { value: JSON.parse(input.body) as unknown }
      } catch {
        parsed = { error: 'response body is not JSON' }
      }
    }
    return parsed
  }
  for (const rule of rules) {
    const name = rule.name.trim()
    if (!rule.enabled || name === '') continue
    const fail = (error: string): void => { results.push({ name, ok: false, error }) }
    if (!VARIABLE_NAME_RE.test(name)) { fail('invalid variable name'); continue }
    if (input.status < 200 || input.status > 299) { fail(`response status ${input.status}`); continue }
    let found: unknown
    if (rule.source === 'header') {
      const header = rule.path.trim()
      if (header === '') { fail('header name is empty'); continue }
      let value: string | null
      try {
        value = input.headers.get(header)
      } catch {
        fail(`invalid header name "${header}"`)
        continue
      }
      if (value === null) { fail(`header "${header}" not found`); continue }
      found = value
    } else {
      let segments: Array<string | number>
      try {
        segments = parseJsonPath(rule.path)
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
        continue
      }
      const body = json()
      if ('error' in body) { fail(body.error); continue }
      found = readPath(body.value, segments)
      if (found === undefined || found === null) { fail(`path "${rule.path.trim()}" not found`); continue }
    }
    if (typeof found !== 'string' && typeof found !== 'number' && typeof found !== 'boolean') { fail('value is not a string, number or boolean'); continue }
    const value = String(found)
    if (value === '') { fail('value is empty'); continue }
    if (value.length > MAX_CAPTURED_LENGTH) { fail('value is too long'); continue }
    if (/[\r\n]/.test(value)) { fail('value contains line breaks'); continue }
    values[name] = value
    delete lifetimes[name]
    let warning: string | undefined
    const ttlPath = (rule.ttlPath ?? '').trim()
    if (ttlPath !== '') {
      const body = json()
      let seconds: unknown
      try {
        seconds = 'error' in body ? undefined : readPath(body.value, parseJsonPath(ttlPath))
      } catch {
        seconds = undefined
      }
      const number = typeof seconds === 'number' ? seconds : typeof seconds === 'string' && /^\d+(\.\d+)?$/.test(seconds.trim()) ? Number(seconds) : Number.NaN
      if (Number.isFinite(number) && number > 0) lifetimes[name] = Math.round(number * 1000)
      else warning = `lifetime "${ttlPath}" is not a positive number of seconds`
    } else if (typeof rule.ttlSeconds === 'number' && rule.ttlSeconds > 0) {
      lifetimes[name] = rule.ttlSeconds * 1000
    }
    results.push({ name, ok: true, ...(warning !== undefined ? { warning } : {}) })
  }
  return { values, lifetimes, results }
}
