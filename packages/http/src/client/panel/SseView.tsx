/**
 * Server-sent event stream view: the events as a list that grows while the
 * stream is read, the text assembled from LLM-style delta events, and the raw
 * stream text once it is complete.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { HttpStreamEnd } from '../../protocol.ts'
import { deltaText, type SseRow } from '../sse.ts'
import { tt, type HttpKey } from '../locales.ts'
import { prettyJson } from './common.tsx'

const TEXT_CACHE = new WeakMap<SseRow, string>()

function rowText(row: SseRow): string {
  let text = TEXT_CACHE.get(row)
  if (text === undefined) {
    text = deltaText(row.data)
    TEXT_CACHE.set(row, text)
  }
  return text
}

const MODES = ['events', 'text', 'raw'] as const
type Mode = typeof MODES[number]
/** Rows kept in the list; a longer stream shows its latest ones. */
const MAX_ROWS = 2000
/** Distance from the bottom within which new rows keep the list scrolled to the end. */
const STICK_PX = 48

export interface SseViewProps {
  rows: SseRow[]
  /** Stream text; absent while the stream is still read. */
  raw?: string
  streaming: boolean
  ended?: HttpStreamEnd
}

export function SseView(props: SseViewProps): JSX.Element {
  const { rows } = props
  const [mode, setMode] = useState<Mode>('events')
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const text = useMemo(() => rows.map(rowText).join(''), [rows])
  const available = MODES.filter(value => (value === 'text' ? text !== '' : value === 'raw' ? props.raw !== undefined : true))
  const current: Mode = available.includes(mode) ? mode : 'events'
  const offset = Math.max(0, rows.length - MAX_ROWS)
  const shown = offset === 0 ? rows : rows.slice(offset)

  // New content keeps the view at the end while the reader has not scrolled away from it.
  useEffect(() => {
    const element = scrollRef.current
    if (element !== null && props.streaming && stick.current) element.scrollTop = element.scrollHeight
  }, [rows.length, text, current, props.streaming])

  const toggle = (index: number): void => {
    setOpen((previous) => {
      const next = new Set(previous)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  return (
    <div className="dsh-http-sse">
      <div className="dsh-http-toolRow">
        <div className="dsh-http-segments" data-small role="radiogroup">
          {available.map(value => (
            <button key={value} type="button" role="radio" aria-checked={current === value} className="dsh-http-segment" {...(current === value ? { 'data-active': '' } : {})} onClick={() => { setMode(value) }}>{tt(`response.stream.${value}` as HttpKey)}</button>
          ))}
        </div>
        <span className="dsh-http-spacer" />
        {props.ended !== undefined && props.ended !== 'complete' && props.ended !== 'limit' && <span className="dsh-http-note">{tt(`response.stream.ended.${props.ended}` as HttpKey)}</span>}
      </div>
      <div className="dsh-http-sseScroll" ref={scrollRef} onScroll={(event) => { const element = event.currentTarget; stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX }}>
        {current === 'events' && (
          rows.length === 0
            ? <div className="dsh-http-empty">{tt(props.streaming ? 'response.stream.waiting' : 'response.stream.empty')}</div>
            : (
              <>
                {offset > 0 && <div className="dsh-http-note">{tt('response.stream.latest', { count: MAX_ROWS })}</div>}
                {shown.map((row, position) => {
                  const index = offset + position
                  const expanded = open.has(index)
                  return (
                    <div key={index} className="dsh-http-sseRow" {...(expanded ? { 'data-open': '' } : {})}>
                      <button type="button" className="dsh-http-sseHead" aria-expanded={expanded} onClick={() => { toggle(index) }}>
                        <span className="dsh-http-sseIndex">{index + 1}</span>
                        <span className="dsh-http-sseTime">{row.at === undefined ? '' : `+${(row.at / 1000).toFixed(2)}s`}</span>
                        <span className="dsh-http-sseType" {...(row.event === '' ? {} : { 'data-named': '' })}>{row.event === '' ? 'message' : row.event}</span>
                        <span className="dsh-http-sseData">{row.data.length > 240 ? `${row.data.slice(0, 240)}…` : row.data}</span>
                      </button>
                      {expanded && (
                        <div className="dsh-http-sseDetail">
                          {(row.id !== undefined || row.retry !== undefined) && <span className="dsh-http-meta">{row.id !== undefined ? `id: ${row.id}` : ''}{row.id !== undefined && row.retry !== undefined ? ' · ' : ''}{row.retry !== undefined ? `retry: ${row.retry}` : ''}</span>}
                          <pre className="dsh-http-code">{prettyJson(row.data).text}</pre>
                        </div>
                      )}
                    </div>
                  )
                })}
              </>
            )
        )}
        {current === 'text' && <pre className="dsh-http-code dsh-http-sseText">{text}</pre>}
        {current === 'raw' && <pre className="dsh-http-code">{props.raw}</pre>}
      </div>
    </div>
  )
}
