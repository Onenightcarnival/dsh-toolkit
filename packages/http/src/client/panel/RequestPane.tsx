import { useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import {
  DIRECT_TARGET_ID, HTTP_AUTH_TYPES, HTTP_BODY_MODES, HTTP_METHODS, joinUrl, substitute,
  type HttpAuth, type HttpAuthType, type HttpBodyMode, type HttpExchange, type HttpKeyValue, type HttpMethod, type HttpPairs, type HttpRequestInput,
  type HttpSavedRequest, type HttpSavedRequestPayload, type HttpTargetSummary,
} from '../../protocol.ts'
import { parseCurl, splitQuery, toCurl, type ParsedCurl } from '../curl.ts'
import { tt, type HttpKey } from '../locales.ts'
import { copyText, prettyJson, sendShortcut } from './common.tsx'
import { KeyValueEditor, activeCount, recordToRows, rowsToPairs, rowsToRecord, type KeyValueRow } from './KeyValueEditor.tsx'

export type BodyMode = HttpBodyMode
const BODY_MODES: readonly BodyMode[] = HTTP_BODY_MODES

export const REQUEST_TABS = ['params', 'body', 'headers', 'auth'] as const
export type RequestTab = typeof REQUEST_TABS[number]

/** The form fields of a saved request, as edited in the panel. */
export interface BuilderState {
  method: HttpMethod
  path: string
  query: KeyValueRow[]
  headers: KeyValueRow[]
  /** The request's own authentication; used when its target has none. */
  auth: HttpAuth
  bodyMode: BodyMode
  body: string
  form: KeyValueRow[]
}

function storedRows(rows: KeyValueRow[]): HttpKeyValue[] {
  return rows.map(row => ({ key: row.key, value: row.value, enabled: row.enabled !== false }))
}

/** Form fields of a saved request. */
export function builderFromSaved(request: HttpSavedRequest): BuilderState {
  return { method: request.method, path: request.path, query: request.query, headers: request.headers, auth: request.auth ?? { type: 'none' }, bodyMode: request.bodyMode, body: request.body, form: request.form }
}

/** Stored fields of a form. */
export function savedFromBuilder(state: BuilderState): Required<Omit<HttpSavedRequestPayload, 'targetId' | 'name'>> {
  return { method: state.method, path: state.path, query: storedRows(state.query), headers: storedRows(state.headers), auth: state.auth, bodyMode: state.bodyMode, body: state.body, form: storedRows(state.form) }
}

/** Builder state reproducing a recorded exchange; credentials are not part of a record. */
export function builderFromExchange(exchange: HttpExchange): BuilderState {
  const request = exchange.request
  const body = request.body
  const contentType = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? ''
  let bodyMode: BodyMode = 'none'
  let form: KeyValueRow[] = []
  if (body !== '') {
    if (/x-www-form-urlencoded/i.test(contentType)) {
      bodyMode = 'form'
      form = [...new URLSearchParams(body).entries()].map(([key, value]) => ({ key, value }))
    } else {
      bodyMode = prettyJson(body).json ? 'json' : 'text'
    }
  }
  return {
    method: request.method,
    path: request.path,
    query: recordToRows(request.query),
    headers: recordToRows(request.headers),
    auth: { type: 'none' },
    bodyMode,
    body: bodyMode === 'form' ? '' : body,
    form,
  }
}

/** A full URL rewritten as a path below `baseUrl`; unchanged when it lies elsewhere. */
export function pathBelow(baseUrl: string, path: string): string {
  try {
    const full = joinUrl('', path, {})
    const base = new URL(baseUrl)
    const basePath = base.pathname.replace(/\/+$/, '')
    if (full.origin !== base.origin || !(full.pathname === basePath || full.pathname.startsWith(`${basePath}/`))) return path
    return (full.pathname.slice(basePath.length) || '/') + full.search
  } catch {
    return path
  }
}

/** Builder state of a parsed cURL command: query split into rows, the URL made relative to the target when it lies below it. */
export function builderFromCurl(parsed: ParsedCurl, target: HttpTargetSummary): BuilderState {
  const { path: bare, pairs } = splitQuery(parsed.url)
  const contentType = parsed.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? ''
  let headers = parsed.headers
  let bodyMode: BodyMode = 'none'
  let body = ''
  let form: KeyValueRow[] = []
  if (parsed.bodyKind === 'form') {
    bodyMode = 'form'
    form = recordToRows(parsed.fields)
    // The form mode sets its own content type.
    headers = headers.filter(([name]) => name.toLowerCase() !== 'content-type')
  } else if (parsed.bodyKind === 'raw') {
    bodyMode = /json/i.test(contentType) ? 'json' : 'text'
    body = parsed.body
  }
  return {
    method: parsed.method,
    path: target.id === DIRECT_TARGET_ID ? bare : pathBelow(target.baseUrl, bare),
    query: recordToRows(pairs),
    headers: recordToRows(headers),
    auth: parsed.basic === undefined ? { type: 'none' } : { type: 'basic', username: parsed.basic.username, password: parsed.basic.password },
    bodyMode,
    body,
    form,
  }
}

/** The request the host receives for a builder state. */
export function toRequestInput(state: BuilderState): HttpRequestInput {
  const headers = rowsToRecord(state.headers)
  const hasContentType = Object.keys(headers).some(name => name.toLowerCase() === 'content-type')
  let body: string | undefined
  if (state.method !== 'GET' && state.method !== 'HEAD') {
    if (state.bodyMode === 'json' || state.bodyMode === 'text') {
      body = state.body === '' ? undefined : state.body
      if (body !== undefined && !hasContentType) headers['content-type'] = state.bodyMode === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8'
    } else if (state.bodyMode === 'form') {
      const params = new URLSearchParams()
      for (const [key, value] of rowsToPairs(state.form)) params.append(key, value)
      body = params.toString()
      if (!hasContentType) headers['content-type'] = 'application/x-www-form-urlencoded; charset=utf-8'
    }
  }
  return { method: state.method, path: state.path, query: rowsToPairs(state.query), headers, body, ...(state.auth.type === 'none' ? {} : { auth: state.auth }) }
}

/** URL the host will request for a builder state (query auth excluded); an error message when it cannot be built. */
export function previewUrl(target: HttpTargetSummary, state: BuilderState): { url: string } | { error: string } {
  const vars = target.variables
  // A request without a target has nothing to preview until a URL is typed.
  if (target.baseUrl === '' && state.path.trim() === '') return { url: '' }
  try {
    const query: HttpPairs = rowsToPairs(state.query).map(([k, v]) => [substitute(k, vars), substitute(v, vars)])
    return { url: joinUrl(target.baseUrl, substitute(state.path.trim(), vars), query).toString() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)))
}

/**
 * The request as a cURL command: the target's fixed headers and the request's
 * own authentication included, the target's credentials left out (the browser
 * never holds them). Undefined while the URL cannot be built.
 */
export function curlOf(target: HttpTargetSummary, state: BuilderState): string | undefined {
  const preview = previewUrl(target, state)
  if (!('url' in preview) || preview.url === '') return undefined
  const vars = target.variables
  const input = toRequestInput(state)
  const url = new URL(preview.url)
  const headers: HttpPairs = [...Object.entries(target.headers), ...Object.entries(input.headers ?? {}).map(([name, value]): [string, string] => [name, substitute(value, vars)])]
  if (target.auth.type === 'none') {
    const auth = state.auth
    if (auth.type === 'bearer' && auth.token !== '') headers.push(['Authorization', `Bearer ${auth.token}`])
    if (auth.type === 'basic' && auth.username !== '') headers.push(['Authorization', `Basic ${base64(`${auth.username}:${auth.password}`)}`])
    if (auth.type === 'header' && auth.name !== '' && auth.value !== '') headers.push([auth.name, auth.value])
    if (auth.type === 'query' && auth.name !== '' && auth.value !== '') url.searchParams.set(auth.name, auth.value)
  }
  return toCurl({ method: state.method, url: url.toString(), headers, body: input.body === undefined ? undefined : substitute(input.body, vars) })
}

function authSummary(target: HttpTargetSummary): Array<[string, string]> {
  const auth = target.auth
  switch (auth.type) {
    case 'none': return [[tt('form.auth'), tt('form.auth.none')]]
    case 'bearer': return [[tt('form.auth'), tt('form.auth.bearer')], [tt('form.auth.token'), auth.hint]]
    case 'basic': return [[tt('form.auth'), tt('form.auth.basic')], [tt('form.auth.username'), auth.username], [tt('form.auth.password'), '••••••']]
    case 'header': return [[tt('form.auth'), tt('form.auth.header')], [tt('form.auth.headerName'), auth.name], [tt('form.auth.value'), auth.hint]]
    case 'query': return [[tt('form.auth'), tt('form.auth.query')], [tt('form.auth.queryName'), auth.name], [tt('form.auth.value'), auth.hint]]
  }
}

function blankAuth(type: HttpAuthType): HttpAuth {
  switch (type) {
    case 'none': return { type: 'none' }
    case 'bearer': return { type: 'bearer', token: '' }
    case 'basic': return { type: 'basic', username: '', password: '' }
    case 'header': return { type: 'header', name: '', value: '' }
    case 'query': return { type: 'query', name: '', value: '' }
  }
}

/** Type and fields of a request's own authentication. */
function AuthEditor(props: { auth: HttpAuth; onChange: (auth: HttpAuth) => void; disabled: boolean }): JSX.Element {
  const { auth, onChange } = props
  const [reveal, setReveal] = useState(false)
  const secretType = reveal ? 'text' : 'password'
  return (
    <div className="dsh-http-authEditor">
      <div className="dsh-http-toolRow">
        <div className="dsh-http-segments" role="radiogroup" aria-label={tt('form.auth')}>
          {HTTP_AUTH_TYPES.map(type => (
            <button key={type} type="button" role="radio" aria-checked={auth.type === type} className="dsh-http-segment" {...(auth.type === type ? { 'data-active': '' } : {})} disabled={props.disabled} onClick={() => { if (auth.type !== type) onChange(blankAuth(type)) }}>{tt(`form.auth.${type}` as HttpKey)}</button>
          ))}
        </div>
        <span className="dsh-http-spacer" />
        {auth.type !== 'none' && <button type="button" className="dsh-http-link" onClick={() => { setReveal(!reveal) }}>{reveal ? tt('request.hideSecret') : tt('request.showSecret')}</button>}
      </div>
      {auth.type === 'bearer' && (
        <label className="dsh-http-field">
          <span className="dsh-http-fieldLabel">{tt('form.auth.token')}</span>
          <input className="dsh-http-input" data-mono type={secretType} value={auth.token} disabled={props.disabled} autoComplete="off" spellCheck={false} onChange={(e) => { onChange({ ...auth, token: e.target.value }) }} />
        </label>
      )}
      {auth.type === 'basic' && (
        <div className="dsh-http-formRow">
          <label className="dsh-http-field">
            <span className="dsh-http-fieldLabel">{tt('form.auth.username')}</span>
            <input className="dsh-http-input" data-mono value={auth.username} disabled={props.disabled} autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(e) => { onChange({ ...auth, username: e.target.value }) }} />
          </label>
          <label className="dsh-http-field">
            <span className="dsh-http-fieldLabel">{tt('form.auth.password')}</span>
            <input className="dsh-http-input" data-mono type={secretType} value={auth.password} disabled={props.disabled} autoComplete="off" onChange={(e) => { onChange({ ...auth, password: e.target.value }) }} />
          </label>
        </div>
      )}
      {(auth.type === 'header' || auth.type === 'query') && (
        <div className="dsh-http-formRow">
          <label className="dsh-http-field">
            <span className="dsh-http-fieldLabel">{tt(auth.type === 'header' ? 'form.auth.headerName' : 'form.auth.queryName')}</span>
            <input className="dsh-http-input" data-mono value={auth.name} disabled={props.disabled} placeholder={auth.type === 'header' ? 'X-API-Key' : 'api_key'} autoCapitalize="off" spellCheck={false} onChange={(e) => { onChange({ ...auth, name: e.target.value }) }} />
          </label>
          <label className="dsh-http-field" style={{ flex: 2 }}>
            <span className="dsh-http-fieldLabel">{tt('form.auth.value')}</span>
            <input className="dsh-http-input" data-mono type={secretType} value={auth.value} disabled={props.disabled} autoComplete="off" onChange={(e) => { onChange({ ...auth, value: e.target.value }) }} />
          </label>
        </div>
      )}
    </div>
  )
}

export interface RequestPaneProps {
  target: HttpTargetSummary
  state: BuilderState
  onChange: (state: BuilderState) => void
  onSend: () => void
  sending: boolean
  tab: RequestTab
  onTab: (tab: RequestTab) => void
  onEditTarget: () => void
  /** Request without a target: create a target from its URL and move the request there. */
  onCreateTarget: () => void
  /** Short status line for the panel banner. */
  onNotice: (text: string) => void
}

/** Request pane: URL bar, then Params / Body / Headers / Auth tabs. */
export function RequestPane(props: RequestPaneProps): JSX.Element {
  const { state, onChange, target, tab } = props
  const [copied, setCopied] = useState(false)
  const set = (patch: Partial<BuilderState>): void => { onChange({ ...state, ...patch }) }
  const bodyAllowed = state.method !== 'GET' && state.method !== 'HEAD'
  const jsonError = state.bodyMode === 'json' && state.body.trim() !== '' ? (() => { try { JSON.parse(state.body); return undefined } catch (error) { return error instanceof Error ? error.message : String(error) } })() : undefined
  const preview = previewUrl(target, state)
  const fixedHeaders = Object.entries(target.headers)
  const direct = target.id === DIRECT_TARGET_ID
  /** The request's own authentication is in effect when the target brings none. */
  const ownAuth = target.auth.type === 'none'

  const badge = (value: RequestTab): string | undefined => {
    if (value === 'params') { const n = activeCount(state.query); return n > 0 ? String(n) : undefined }
    if (value === 'headers') { const n = activeCount(state.headers); return n > 0 ? String(n) : undefined }
    if (value === 'body') return bodyAllowed && state.bodyMode !== 'none' ? tt(`request.bodyMode.${state.bodyMode}` as HttpKey) : undefined
    if (value === 'auth') {
      const type = ownAuth ? state.auth.type : target.auth.type
      return type === 'none' ? undefined : tt(`form.auth.${type}` as HttpKey)
    }
    return undefined
  }

  const copyPreview = async (): Promise<void> => {
    if (!('url' in preview) || preview.url === '') return
    try {
      await copyText(preview.url)
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 1500)
    } catch { /* clipboard unavailable */ }
  }

  /** A pasted cURL command replaces the whole form. */
  const onUrlPaste = (event: ClipboardEvent<HTMLInputElement>): void => {
    const text = event.clipboardData.getData('text')
    if (!/^\s*curl\s/.test(text)) return
    const parsed = parseCurl(text)
    if (parsed === undefined) return
    event.preventDefault()
    onChange(builderFromCurl(parsed, target))
    props.onNotice(parsed.multipart ? tt('request.curlMultipart') : tt('request.curlImported'))
  }

  const importQuery = (): void => {
    const { path, pairs } = splitQuery(state.path)
    set({ path, query: [...state.query, ...recordToRows(pairs)] })
  }

  /** Tab indents by two spaces in the body editor. */
  const onEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Tab' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
    event.preventDefault()
    const area = event.currentTarget
    const start = area.selectionStart
    set({ body: `${state.body.slice(0, start)}  ${state.body.slice(area.selectionEnd)}` })
    requestAnimationFrame(() => { area.selectionStart = area.selectionEnd = start + 2 })
  }

  return (
    <div className="dsh-http-pane" data-pane="request">
      <form className="dsh-http-paneHead dsh-http-urlBar" onSubmit={(event) => { event.preventDefault(); if (!props.sending) props.onSend() }}>
        <select className="dsh-http-method" data-method={state.method} value={state.method} onChange={(e) => { set({ method: e.target.value as HttpMethod }) }} aria-label="method">
          {HTTP_METHODS.map(method => <option key={method} value={method}>{method}</option>)}
        </select>
        <div className="dsh-http-urlBox">
          {!direct && <span className="dsh-http-baseUrl" title={target.baseUrl}><bdi>{target.baseUrl}</bdi></span>}
          <input className="dsh-http-pathInput" data-http-url {...(direct ? { 'data-direct': '' } : {})} value={state.path} placeholder={tt(direct ? 'request.urlPlaceholder' : 'request.pathPlaceholder')} onChange={(e) => { set({ path: e.target.value }) }} onPaste={onUrlPaste} autoCapitalize="off" spellCheck={false} aria-label={tt('request.path')} />
        </div>
        <button type="submit" className="dsh-http-send" disabled={props.sending} title={sendShortcut()}>{tt('request.send')}</button>
      </form>

      <div className="dsh-http-tabs" role="tablist">
        {REQUEST_TABS.map(value => {
          const label = badge(value)
          return (
            <button key={value} type="button" role="tab" aria-selected={tab === value} className="dsh-http-tab" {...(tab === value ? { 'data-active': '' } : {})} onClick={() => { props.onTab(value) }}>
              {tt(`request.tab.${value}` as HttpKey)}{label !== undefined && <span className="dsh-http-count">{label}</span>}
            </button>
          )
        })}
      </div>

      <div className="dsh-http-paneBody" role="tabpanel">
        {tab === 'params' && (
          <>
            <div className="dsh-http-previewBox">
              <div className="dsh-http-previewHead">
                <span className="dsh-http-label">{tt('request.urlPreview')}</span>
                <span className="dsh-http-spacer" />
                {state.path.includes('?') && <button type="button" className="dsh-http-link" disabled={props.sending} onClick={importQuery}>{tt('request.importQuery')}</button>}
                <button type="button" className="dsh-http-link" disabled={!('url' in preview) || preview.url === ''} onClick={() => { void copyPreview() }}>{copied ? tt('response.copied') : tt('request.copy')}</button>
              </div>
              {'url' in preview
                ? <code className="dsh-http-previewUrl">{preview.url || '—'}</code>
                : <code className="dsh-http-previewUrl" data-error>{preview.error}</code>}
            </div>
            <KeyValueEditor rows={state.query} onChange={(query) => { set({ query }) }} toggle tools disabled={props.sending} />
          </>
        )}

        {tab === 'body' && (
          bodyAllowed ? (
            <>
              <div className="dsh-http-toolRow">
                <div className="dsh-http-segments" role="radiogroup">
                  {BODY_MODES.map(mode => (
                    <button key={mode} type="button" role="radio" aria-checked={state.bodyMode === mode} className="dsh-http-segment" {...(state.bodyMode === mode ? { 'data-active': '' } : {})} onClick={() => { set({ bodyMode: mode }) }}>{tt(`request.bodyMode.${mode}` as HttpKey)}</button>
                  ))}
                </div>
                <span className="dsh-http-spacer" />
                {state.bodyMode === 'json' && (
                  <button type="button" className="dsh-http-link" disabled={jsonError !== undefined || state.body.trim() === ''} onClick={() => { set({ body: prettyJson(state.body).text }) }}>{tt('request.formatJson')}</button>
                )}
              </div>
              {(state.bodyMode === 'json' || state.bodyMode === 'text') && (
                <textarea className="dsh-http-editor" value={state.body} placeholder={state.bodyMode === 'json' ? tt('request.bodyPlaceholder') : ''} onChange={(e) => { set({ body: e.target.value }) }} onKeyDown={onEditorKeyDown} spellCheck={false} disabled={props.sending} />
              )}
              {state.bodyMode === 'form' && (
                <KeyValueEditor rows={state.form} onChange={(form) => { set({ form }) }} toggle tools disabled={props.sending} />
              )}
              {state.bodyMode === 'none' && <div className="dsh-http-empty">{tt('request.bodyNone')}</div>}
              {jsonError !== undefined && <div className="dsh-http-formError">{tt('request.invalidJson', { error: jsonError })}</div>}
            </>
          ) : <div className="dsh-http-empty">{tt('request.noBody', { method: state.method })}</div>
        )}

        {tab === 'headers' && (
          <>
            <KeyValueEditor rows={state.headers} onChange={(headers) => { set({ headers }) }} toggle tools disabled={props.sending} />
            {fixedHeaders.length > 0 && (
              <div className="dsh-http-readonlyBlock">
                <span className="dsh-http-label">{tt('request.fixedHeaders')}</span>
                <table className="dsh-http-headersTable">
                  <tbody>{fixedHeaders.map(([name, value]) => <tr key={name}><th>{name}</th><td>{value}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </>
        )}

        {tab === 'auth' && ownAuth && (
          <>
            <AuthEditor auth={state.auth} onChange={(auth) => { set({ auth }) }} disabled={props.sending} />
            <p className="dsh-http-note">{tt(direct ? 'request.directAuthNote' : 'request.ownAuthNote')}</p>
            {direct && <div><button type="button" className="dsh-http-ghost" onClick={props.onCreateTarget}>{tt('targets.fromRequest')}</button></div>}
          </>
        )}
        {tab === 'auth' && !ownAuth && (
          <div className="dsh-http-readonlyBlock">
            <table className="dsh-http-headersTable">
              <tbody>{authSummary(target).map(([name, value]) => <tr key={name}><th>{name}</th><td>{value}</td></tr>)}</tbody>
            </table>
            <p className="dsh-http-note">{tt('request.authNote')}</p>
            <div><button type="button" className="dsh-http-ghost" onClick={props.onEditTarget}>{tt('targets.edit')}</button></div>
          </div>
        )}
      </div>
    </div>
  )
}
