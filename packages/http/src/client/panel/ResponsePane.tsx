import { useEffect, useMemo, useState } from 'react'
import { isEventStream, type HttpExchange, type HttpExchangeResponse, type HttpStreamHead } from '../../protocol.ts'
import { tt, type HttpKey } from '../locales.ts'
import { copyText, formatTime, humanSize, prettyJson, sendShortcut, shortTime, statusKind } from './common.tsx'
import { sseRows, type SseRow } from '../sse.ts'
import { SseView } from './SseView.tsx'

/** An event stream being read: its response head and the events received so far. */
export interface LiveStream {
  head: HttpStreamHead
  rows: SseRow[]
}

export const RESPONSE_TABS = ['preview', 'headers', 'request'] as const
export type ResponseTab = typeof RESPONSE_TABS[number]

export interface ResponsePaneProps {
  exchange: HttpExchange | undefined
  /** Earlier exchanges of the same saved request, newest first; a picker shows when the exchange is one of them. */
  versions?: HttpExchange[]
  onVersion?: (exchange: HttpExchange) => void
  /** Start time of the request in flight. */
  sendingSince: number | undefined
  /** Set once the request in flight turns out to be an event stream; replaces the waiting overlay. */
  live?: LiveStream
  onCancel: () => void
  tab: ResponseTab
  onTab: (tab: ResponseTab) => void
}

const EXTENSIONS: Array<[RegExp, string]> = [
  [/json/i, 'json'], [/html/i, 'html'], [/xml/i, 'xml'], [/csv/i, 'csv'], [/javascript/i, 'js'], [/css/i, 'css'], [/^text\//i, 'txt'],
  [/png/i, 'png'], [/jpe?g/i, 'jpg'], [/gif/i, 'gif'], [/webp/i, 'webp'], [/svg/i, 'svg'], [/pdf/i, 'pdf'], [/zip/i, 'zip'],
]

/** File name for a saved body: the URL's last path segment, with an extension from the content type when it has none. */
export function saveName(url: string, contentType: string): string {
  let name = 'response'
  try {
    const segment = new URL(url).pathname.split('/').filter(part => part !== '').pop()
    if (segment !== undefined) name = decodeURIComponent(segment).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80) || 'response'
  } catch { /* keep the default */ }
  if (/\.[A-Za-z0-9]{1,8}$/.test(name)) return name
  const extension = EXTENSIONS.find(([pattern]) => pattern.test(contentType))?.[1]
  return extension === undefined ? name : `${name}.${extension}`
}

/** The body as a Blob: the complete binary body when the host returned it, else the decoded text. */
function bodyBlob(response: HttpExchangeResponse): Blob | undefined {
  const type = response.contentType.split(';')[0].trim() || 'application/octet-stream'
  if (response.bodyBase64 !== undefined) {
    const binary = atob(response.bodyBase64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new Blob([bytes], { type })
  }
  if (!response.binary && response.body !== '') return new Blob([response.body], { type: `${type}; charset=utf-8` })
  return undefined
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function Elapsed({ since, label = 'response.sending' }: { since: number; label?: HttpKey }): JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 100)
    return () => { clearInterval(timer) }
  }, [since])
  return <>{tt(label, { seconds: (Math.max(0, now - since) / 1000).toFixed(1) })}</>
}

/** Response pane: status, time and size tags, then Preview / Headers / Request tabs. */
export function ResponsePane(props: ResponsePaneProps): JSX.Element {
  const { exchange, tab } = props
  const [pretty, setPretty] = useState(true)
  const [rendered, setRendered] = useState(false)
  const [copied, setCopied] = useState<string | undefined>()
  useEffect(() => {
    setCopied(undefined)
    setRendered(false)
  }, [exchange?.id])

  const response = exchange?.response
  const formatted = useMemo(() => (response === undefined ? { text: '', json: false } : prettyJson(response.body)), [response])
  const streamRows = useMemo(() => (response !== undefined && (response.stream !== undefined || isEventStream(response.contentType)) ? sseRows(response.body, response.stream?.times) : undefined), [response])
  const bodyText = response === undefined ? '' : pretty && formatted.json ? formatted.text : response.body
  const responseHeaders = Object.entries(response?.headers ?? {})
  const sentHeaders = Object.entries(exchange?.request.sentHeaders ?? exchange?.request.headers ?? {})
  const mediaType = (response?.contentType ?? '').split(';')[0].trim().toLowerCase()
  const html = response !== undefined && !response.binary && response.body !== '' && (mediaType === 'text/html' || mediaType === 'application/xhtml+xml')
  const image = response !== undefined && response.bodyBase64 !== undefined && mediaType.startsWith('image/')
    ? `data:${mediaType};base64,${response.bodyBase64}` : undefined
  const savable = response !== undefined && (response.bodyBase64 !== undefined || (!response.binary && response.body !== ''))

  const copy = async (what: string, text: string): Promise<void> => {
    try {
      await copyText(text)
      setCopied(what)
      setTimeout(() => { setCopied(undefined) }, 1500)
    } catch { /* clipboard unavailable */ }
  }

  const save = (): void => {
    if (response === undefined || exchange === undefined) return
    const blob = bodyBlob(response)
    if (blob === undefined) return
    const href = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = href
    link.download = saveName(exchange.request.url, response.contentType)
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => { URL.revokeObjectURL(href) }, 10_000)
  }

  const overlay = props.sendingSince !== undefined && (
    <div className="dsh-http-overlay" role="status">
      <span className="dsh-http-spinner" aria-hidden="true" />
      <span><Elapsed since={props.sendingSince} /></span>
      <button type="button" className="dsh-http-ghost" onClick={props.onCancel}>{tt('response.cancel')}</button>
    </div>
  )

  const live = props.sendingSince !== undefined ? props.live : undefined
  if (live !== undefined) {
    const liveHeaders = Object.entries(live.head.headers)
    const liveTab = tab === 'headers' ? 'headers' : 'preview'
    return (
      <div className="dsh-http-pane" data-pane="response">
        <div className="dsh-http-paneHead">
          <span className="dsh-http-tag" data-kind={statusKind(live.head.status)}>{live.head.status} {live.head.statusText}</span>
          <span className="dsh-http-tag">{tt('response.stream.count', { count: live.rows.length })}</span>
          <span className="dsh-http-spacer" />
          <span className="dsh-http-spinner" data-small aria-hidden="true" />
          <span className="dsh-http-meta"><Elapsed since={props.sendingSince ?? Date.now()} label="response.stream.receiving" /></span>
          <button type="button" className="dsh-http-ghost" onClick={props.onCancel}>{tt('response.stream.stop')}</button>
        </div>
        <div className="dsh-http-tabs" role="tablist">
          {(['preview', 'headers'] as const).map(value => (
            <button key={value} type="button" role="tab" aria-selected={liveTab === value} className="dsh-http-tab" {...(liveTab === value ? { 'data-active': '' } : {})} onClick={() => { props.onTab(value) }}>
              {tt(`response.tab.${value}` as HttpKey)}{value === 'headers' && liveHeaders.length > 0 && <span className="dsh-http-count">{liveHeaders.length}</span>}
            </button>
          ))}
        </div>
        <div className="dsh-http-paneBody" role="tabpanel">
          {liveTab === 'preview'
            ? <SseView rows={live.rows} streaming />
            : <table className="dsh-http-headersTable"><tbody>{liveHeaders.map(([name, value]) => <tr key={name}><th>{name}</th><td>{value}</td></tr>)}</tbody></table>}
        </div>
      </div>
    )
  }

  if (exchange === undefined) {
    return (
      <div className="dsh-http-pane" data-pane="response">
        <div className="dsh-http-paneBody" data-center>
          <div className="dsh-http-hints">
            <span>{tt('response.empty')}</span>
            <span className="dsh-http-hintRow"><span>{tt('request.send')}</span><kbd className="dsh-http-kbd">{sendShortcut()}</kbd></span>
          </div>
        </div>
        {overlay}
      </div>
    )
  }

  return (
    <div className="dsh-http-pane" data-pane="response">
      <div className="dsh-http-paneHead">
        {response !== undefined ? (
          <>
            <span className="dsh-http-tag" data-kind={statusKind(response.status)}>{response.status} {response.statusText}</span>
            <span className="dsh-http-tag">{tt('response.time', { ms: response.durationMs })}</span>
            <span className="dsh-http-tag">{humanSize(response.bodyBytes)}</span>
            {streamRows !== undefined && <span className="dsh-http-tag">{tt('response.stream.count', { count: streamRows.length })}</span>}
          </>
        ) : <span className="dsh-http-tag" data-kind="error">{tt('response.errorTag')}</span>}
        <span className="dsh-http-spacer" />
        {props.versions !== undefined && props.versions.length > 1 && props.versions.some(v => v.id === exchange.id) ? (
          <select className="dsh-http-select dsh-http-versionSelect" value={exchange.id} aria-label={tt('response.versions')} title={tt('response.versions')} onChange={(e) => { const picked = props.versions?.find(v => v.id === e.target.value); if (picked !== undefined) props.onVersion?.(picked) }}>
            {props.versions.map(version => <option key={version.id} value={version.id}>{shortTime(version.at)} · {version.response?.status ?? tt('history.failed')}</option>)}
          </select>
        ) : <span className="dsh-http-meta">{formatTime(exchange.at)}</span>}
        <span className="dsh-http-sourceTag" data-source={exchange.source}>{tt(exchange.source === 'agent' ? 'history.source.agent' : 'history.source.panel')}</span>
      </div>

      <div className="dsh-http-tabs" role="tablist">
        {RESPONSE_TABS.map(value => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} className="dsh-http-tab" {...(tab === value ? { 'data-active': '' } : {})} onClick={() => { props.onTab(value) }}>
            {tt(`response.tab.${value}` as HttpKey)}{value === 'headers' && responseHeaders.length > 0 && <span className="dsh-http-count">{responseHeaders.length}</span>}
          </button>
        ))}
        <span className="dsh-http-spacer" />
        {tab === 'preview' && response !== undefined && formatted.json && (
          <div className="dsh-http-segments" data-small role="radiogroup">
            <button type="button" role="radio" aria-checked={pretty} className="dsh-http-segment" {...(pretty ? { 'data-active': '' } : {})} onClick={() => { setPretty(true) }}>{tt('response.pretty')}</button>
            <button type="button" role="radio" aria-checked={!pretty} className="dsh-http-segment" {...(!pretty ? { 'data-active': '' } : {})} onClick={() => { setPretty(false) }}>{tt('response.raw')}</button>
          </div>
        )}
        {tab === 'preview' && html && (
          <div className="dsh-http-segments" data-small role="radiogroup">
            <button type="button" role="radio" aria-checked={!rendered} className="dsh-http-segment" {...(!rendered ? { 'data-active': '' } : {})} onClick={() => { setRendered(false) }}>{tt('response.source')}</button>
            <button type="button" role="radio" aria-checked={rendered} className="dsh-http-segment" {...(rendered ? { 'data-active': '' } : {})} onClick={() => { setRendered(true) }}>{tt('response.render')}</button>
          </div>
        )}
        {tab === 'preview' && response !== undefined && !response.binary && response.body !== '' && (
          <button type="button" className="dsh-http-link" onClick={() => { void copy('body', bodyText) }}>{copied === 'body' ? tt('response.copied') : tt('response.copy')}</button>
        )}
        {tab === 'preview' && savable && <button type="button" className="dsh-http-link" onClick={save}>{tt('response.save')}</button>}
      </div>

      <div className="dsh-http-paneBody" role="tabpanel">
        {tab === 'preview' && (
          <>
            {exchange.error !== undefined && <div className="dsh-http-banner" data-kind="error" role="alert"><span>{tt('response.error', { error: exchange.error })}</span></div>}
            {response !== undefined && response.redirects.length > 0 && <div className="dsh-http-note">{tt('response.redirects', { list: response.redirects.join(' → ') })}</div>}
            {response !== undefined && (
              image !== undefined
                ? <div className="dsh-http-imageBox"><img className="dsh-http-image" src={image} alt={saveName(exchange.request.url, response.contentType)} /></div>
                : response.binary
                  ? <div className="dsh-http-empty">{tt('response.binary', { size: humanSize(response.bodyBytes) })}</div>
                  : response.body === ''
                    ? <div className="dsh-http-empty">{tt('response.noBody')}</div>
                    : streamRows !== undefined
                      ? <SseView rows={streamRows} raw={response.body} streaming={false} ended={response.stream?.ended} />
                    : html && rendered
                      // Scripts, forms and same-origin access stay off; relative links resolve against the request URL.
                      ? <iframe className="dsh-http-frame" sandbox="" referrerPolicy="no-referrer" title={tt('response.render')} srcDoc={`<base href="${escapeAttribute(exchange.request.url)}">${response.body}`} />
                      : <pre className="dsh-http-code">{bodyText}</pre>
            )}
            {response?.bodyTruncated === true && <div className="dsh-http-note">{tt('response.truncated', { size: humanSize(response.bodyBytes) })}</div>}
          </>
        )}

        {tab === 'headers' && (
          responseHeaders.length === 0
            ? <div className="dsh-http-empty">{tt('response.noHeaders')}</div>
            : <table className="dsh-http-headersTable"><tbody>{responseHeaders.map(([name, value]) => <tr key={name}><th>{name}</th><td>{value}</td></tr>)}</tbody></table>
        )}

        {tab === 'request' && (
          <>
            <div className="dsh-http-previewBox">
              <div className="dsh-http-previewHead">
                <span className="dsh-http-methodTag" data-method={exchange.request.method}>{exchange.request.method}</span>
                <span className="dsh-http-spacer" />
                <button type="button" className="dsh-http-link" disabled={exchange.request.url === ''} onClick={() => { void copy('url', exchange.request.url) }}>{copied === 'url' ? tt('response.copied') : tt('response.copyUrl')}</button>
              </div>
              <code className="dsh-http-previewUrl">{exchange.request.url || exchange.request.path}</code>
            </div>
            {sentHeaders.length > 0 && (
              <div className="dsh-http-readonlyBlock">
                <span className="dsh-http-label">{tt('response.sentHeaders')}</span>
                <table className="dsh-http-headersTable"><tbody>{sentHeaders.map(([name, value]) => <tr key={name}><th>{name}</th><td>{value}</td></tr>)}</tbody></table>
              </div>
            )}
            {exchange.request.body !== '' && (
              <div className="dsh-http-readonlyBlock">
                <span className="dsh-http-label">{tt('response.sentBody')}</span>
                <pre className="dsh-http-code">{exchange.request.body}</pre>
                {exchange.request.bodyTruncated && <div className="dsh-http-note">{tt('response.requestTruncated')}</div>}
              </div>
            )}
          </>
        )}
      </div>
      {overlay}
    </div>
  )
}
