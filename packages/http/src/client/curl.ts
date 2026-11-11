/**
 * cURL command lines: parsing a pasted command into request fields, and
 * writing a request as a command. Pure functions; no DOM.
 *
 * Parsed: method, URL, headers, data (`-d` family, `--json`, `-G`), form
 * fields (`-F`, without files), basic auth (`-u`), bearer (`--oauth2-bearer`),
 * user agent, referer and cookie strings. Other options are skipped.
 */
import { HTTP_METHODS, type HttpMethod, type HttpPairs } from '../protocol.ts'

export interface ParsedCurl {
  method: HttpMethod
  url: string
  headers: HttpPairs
  /** `raw`: `body` as written. `form`: `fields` as URL-encoded form fields. */
  bodyKind: 'none' | 'raw' | 'form'
  body: string
  fields: HttpPairs
  basic?: { username: string; password: string }
  /** The command used multipart form fields (`-F`); they are returned as plain fields. */
  multipart: boolean
}

const ANSI_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', v: '\v', '0': '\0' }

/** Split a command line the way a POSIX shell does: quotes, `$'…'`, backslash escapes and line continuations. */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let i = 0
  const push = (): void => {
    if (started) tokens.push(current)
    current = ''
    started = false
  }
  while (i < text.length) {
    const c = text[i]
    if (c === '\\') {
      const next = text[i + 1]
      if (next === '\n') { i += 2; continue }
      if (next === '\r' && text[i + 2] === '\n') { i += 3; continue }
      if (next !== undefined) { current += next; started = true; i += 2; continue }
      i++
      continue
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1)
      current += text.slice(i + 1, end < 0 ? text.length : end)
      started = true
      i = end < 0 ? text.length : end + 1
      continue
    }
    if (c === '$' && text[i + 1] === "'") {
      i += 2
      started = true
      while (i < text.length && text[i] !== "'") {
        if (text[i] === '\\' && i + 1 < text.length) {
          const e = text[i + 1]
          if (e === 'x') {
            const hex = /^[0-9a-fA-F]{1,2}/.exec(text.slice(i + 2))?.[0] ?? ''
            current += hex === '' ? 'x' : String.fromCharCode(parseInt(hex, 16))
            i += 2 + hex.length
          } else if (e === 'u') {
            const hex = /^[0-9a-fA-F]{1,4}/.exec(text.slice(i + 2))?.[0] ?? ''
            current += hex === '' ? 'u' : String.fromCharCode(parseInt(hex, 16))
            i += 2 + hex.length
          } else {
            current += ANSI_ESCAPES[e] ?? e
            i += 2
          }
        } else {
          current += text[i]
          i++
        }
      }
      i++
      continue
    }
    if (c === '"') {
      i++
      started = true
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) {
          const e = text[i + 1]
          if (e === '\n') { i += 2; continue }
          current += '"\\$`'.includes(e) ? e : `\\${e}`
          i += 2
        } else {
          current += text[i]
          i++
        }
      }
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      push()
      i++
      continue
    }
    current += c
    started = true
    i++
  }
  push()
  return tokens
}

/** Long options that take a value. `true` marks the ones this parser reads. */
const LONG_VALUE: Record<string, true | false> = {
  request: true, header: true, data: true, 'data-raw': true, 'data-binary': true, 'data-ascii': true, 'data-urlencode': true, json: true,
  form: true, 'form-string': true, user: true, 'user-agent': true, referer: true, cookie: true, url: true, 'oauth2-bearer': true,
  output: false, 'max-time': false, 'connect-timeout': false, proxy: false, retry: false, 'write-out': false, 'cookie-jar': false, cacert: false,
  cert: false, key: false, resolve: false, 'max-redirs': false, 'limit-rate': false, range: false, 'proxy-user': false, 'upload-file': false,
  interface: false, ciphers: false, 'tls-max': false, 'retry-delay': false, 'retry-max-time': false, config: false, 'dump-header': false,
  trace: false, 'trace-ascii': false, stderr: false, 'connect-to': false, 'dns-servers': false, 'unix-socket': false, 'request-target': false,
}
/** Short options that take a value, mapped to their long names. */
const SHORT_VALUE: Record<string, string> = {
  X: 'request', H: 'header', d: 'data', F: 'form', u: 'user', A: 'user-agent', e: 'referer', b: 'cookie',
  o: 'output', m: 'max-time', x: 'proxy', w: 'write-out', c: 'cookie-jar', T: 'upload-file', r: 'range', K: 'config', D: 'dump-header', E: 'cert',
}

function splitHeader(line: string): [string, string] | undefined {
  const index = line.indexOf(':')
  if (index <= 0) return undefined
  return [line.slice(0, index).trim(), line.slice(index + 1).trim()]
}

function splitField(text: string): [string, string] {
  const index = text.indexOf('=')
  return index < 0 ? [text, ''] : [text.slice(0, index), text.slice(index + 1)]
}

/** Parse a pasted cURL command; undefined when the text is not one or names no URL. */
export function parseCurl(text: string): ParsedCurl | undefined {
  const tokens = tokenize(text.trim())
  if (tokens[0] !== 'curl') return undefined
  let method: string | undefined
  let url: string | undefined
  const headers: HttpPairs = []
  const data: string[] = []
  const fields: HttpPairs = []
  let json = false
  let get = false
  let head = false
  let basic: ParsedCurl['basic']

  const option = (name: string, value: string): void => {
    switch (name) {
      case 'request': method = value.toUpperCase(); break
      case 'header': { const pair = splitHeader(value); if (pair !== undefined) headers.push(pair); break }
      case 'data': case 'data-raw': case 'data-binary': case 'data-ascii': data.push(value); break
      case 'data-urlencode': {
        const index = value.indexOf('=')
        data.push(index < 0 ? encodeURIComponent(value) : index === 0 ? encodeURIComponent(value.slice(1)) : `${value.slice(0, index)}=${encodeURIComponent(value.slice(index + 1))}`)
        break
      }
      case 'json': data.push(value); json = true; break
      case 'form': case 'form-string': fields.push(splitField(value)); break
      case 'user': { const index = value.indexOf(':'); basic = index < 0 ? { username: value, password: '' } : { username: value.slice(0, index), password: value.slice(index + 1) }; break }
      case 'user-agent': headers.push(['User-Agent', value]); break
      case 'referer': headers.push(['Referer', value]); break
      case 'cookie': if (value.includes('=')) headers.push(['Cookie', value]); break
      case 'oauth2-bearer': headers.push(['Authorization', `Bearer ${value}`]); break
      case 'url': url ??= value; break
      default: break
    }
  }

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.startsWith('--') && token.length > 2) {
      const eq = token.indexOf('=')
      const name = eq < 0 ? token.slice(2) : token.slice(2, eq)
      if (name === 'get') { get = true; continue }
      if (name === 'head') { head = true; continue }
      if (!(name in LONG_VALUE)) continue
      const value = eq < 0 ? tokens[++i] : token.slice(eq + 1)
      if (value !== undefined && LONG_VALUE[name]) option(name, value)
      continue
    }
    if (token.startsWith('-') && token.length > 1) {
      for (let j = 1; j < token.length; j++) {
        const flag = token[j]
        if (flag === 'G') { get = true; continue }
        if (flag === 'I') { head = true; continue }
        const long = SHORT_VALUE[flag]
        if (long === undefined) continue
        const attached = token.slice(j + 1)
        const value = attached !== '' ? attached : tokens[++i]
        if (value !== undefined && LONG_VALUE[long]) option(long, value)
        break
      }
      continue
    }
    url ??= token
  }
  if (url === undefined || url === '') return undefined

  const hasHeader = (name: string): boolean => headers.some(([key]) => key.toLowerCase() === name)
  let bodyKind: ParsedCurl['bodyKind'] = 'none'
  let body = ''
  if (data.length > 0 && get) {
    url += (url.includes('?') ? '&' : '?') + data.join('&')
  } else if (data.length > 0) {
    body = json ? data.join('') : data.join('&')
    if (json) {
      if (!hasHeader('content-type')) headers.push(['Content-Type', 'application/json'])
      if (!hasHeader('accept')) headers.push(['Accept', 'application/json'])
      bodyKind = 'raw'
    } else if (!hasHeader('content-type')) {
      // curl sends -d data as a URL-encoded form unless a header says otherwise.
      const formLike = body !== '' && !/[\s{}[\]"]/.test(body) && body.split('&').every(part => part.includes('='))
      if (formLike) bodyKind = 'form'
      else { bodyKind = 'raw'; headers.push(['Content-Type', 'application/x-www-form-urlencoded']) }
    } else {
      bodyKind = 'raw'
    }
  } else if (fields.length > 0) {
    bodyKind = 'form'
  }

  const fallback: HttpMethod = head ? 'HEAD' : bodyKind !== 'none' ? 'POST' : 'GET'
  const picked = method !== undefined && (HTTP_METHODS as readonly string[]).includes(method) ? method as HttpMethod : fallback
  const formFields: HttpPairs = fields.length > 0 ? fields : bodyKind === 'form' ? [...new URLSearchParams(body).entries()] : []
  return { method: picked, url, headers, bodyKind, body: bodyKind === 'raw' ? body : '', fields: formFields, basic, multipart: fields.length > 0 }
}

/** Split `?query` off a path or URL into decoded pairs; the path keeps its fragment-free remainder. */
export function splitQuery(path: string): { path: string; pairs: HttpPairs } {
  const index = path.indexOf('?')
  if (index < 0) return { path, pairs: [] }
  const decode = (text: string): string => {
    try {
      return decodeURIComponent(text.replace(/\+/g, ' '))
    } catch {
      return text
    }
  }
  const pairs: HttpPairs = path.slice(index + 1).split('&').filter(part => part !== '').map((part) => {
    const eq = part.indexOf('=')
    return eq < 0 ? [decode(part), ''] : [decode(part.slice(0, eq)), decode(part.slice(eq + 1))]
  })
  return { path: path.slice(0, index), pairs }
}

function quote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/** A request as a multi-line cURL command. */
export function toCurl(request: { method: string; url: string; headers: HttpPairs; body?: string }): string {
  const lines = [`curl${request.method === 'GET' ? '' : ` -X ${request.method}`} ${quote(request.url)}`]
  for (const [name, value] of request.headers) lines.push(`  -H ${quote(`${name}: ${value}`)}`)
  if (request.body !== undefined && request.body !== '') lines.push(`  --data-raw ${quote(request.body)}`)
  return lines.join(' \\\n')
}
