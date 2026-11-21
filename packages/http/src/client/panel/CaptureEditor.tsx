import { useRef, type JSX } from 'react'
import { HTTP_CAPTURE_REFRESH, HTTP_CAPTURE_SOURCES, MAX_CAPTURE_RULES, blankCapture, type HttpCapture, type HttpCaptureRefresh, type HttpCaptureSource, type HttpCapturedValue } from '../../protocol.ts'
import { lifetimeText, parseLifetime } from '../lifetime.ts'
import { tt } from '../locales.ts'
import { shortTime } from './common.tsx'

export interface CaptureEditorProps {
  rules: HttpCapture[]
  onChange: (rules: HttpCapture[]) => void
  disabled?: boolean
  /** Captured variables of the scope. */
  captured: HttpCapturedValue[]
  /** Title of a saved request of the scope by id. */
  requestTitle: (id: string) => string | undefined
  onClear: (name: string) => void
}

/** Rules that count toward the tab badge. */
export function activeCaptures(rules: HttpCapture[]): number {
  return rules.filter(rule => rule.enabled && rule.name.trim() !== '').length
}

/**
 * Capture rules of a saved request, one card each with four labelled fields
 * (variable, value source, lifetime, auto refresh), then the captured
 * variables of its scope.
 */
export function CaptureEditor(props: CaptureEditorProps): JSX.Element {
  const { rules, onChange } = props
  const listRef = useRef<HTMLDivElement>(null)
  const update = (index: number, patch: Partial<HttpCapture>): void => {
    onChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)))
  }
  /** Append a blank rule and put the caret in its variable field. */
  const add = (): void => {
    onChange([...rules, blankCapture()])
    setTimeout(() => { [...(listRef.current?.querySelectorAll<HTMLInputElement>('[data-rule-name]') ?? [])].pop()?.focus() }, 0)
  }
  const refreshing = rules.some(rule => rule.enabled && rule.refresh !== 'off')
  const now = Date.now()
  return (
    <>
      <div className="dsh-http-rules" ref={listRef}>
        {rules.map((rule, index) => (
          <div key={index} className="dsh-http-rule" {...(!rule.enabled ? { 'data-off': '' } : {})}>
            <input type="checkbox" className="dsh-http-check" checked={rule.enabled} disabled={props.disabled} aria-label={tt('capture.enabled')} title={tt('capture.enabled')} onChange={(e) => { update(index, { enabled: e.target.checked }) }} />
            <div className="dsh-http-ruleFields">
              <label className="dsh-http-ruleField">
                <span>{tt('capture.name')}</span>
                <input className="dsh-http-input" data-mono data-rule-name value={rule.name} placeholder="access_token" disabled={props.disabled} autoCapitalize="off" spellCheck={false} onChange={(e) => { update(index, { name: e.target.value }) }} />
              </label>
              <div className="dsh-http-ruleField">
                <span>{tt('capture.value')}</span>
                <div className="dsh-http-ruleSource">
                  <select className="dsh-http-select" value={rule.source} aria-label={tt('capture.source')} disabled={props.disabled} onChange={(e) => { update(index, { source: e.target.value as HttpCaptureSource }) }}>
                    {HTTP_CAPTURE_SOURCES.map(source => <option key={source} value={source}>{tt(`capture.source.${source}`)}</option>)}
                  </select>
                  <input className="dsh-http-input" data-mono value={rule.path} placeholder={tt(`capture.path.${rule.source}`)} aria-label={tt(`capture.path.${rule.source}`)} disabled={props.disabled} autoCapitalize="off" spellCheck={false} onChange={(e) => { update(index, { path: e.target.value }) }} />
                </div>
              </div>
              <label className="dsh-http-ruleField" title={tt('capture.lifetime.hint')}>
                <span>{tt('capture.lifetime')}</span>
                <input className="dsh-http-input" data-mono value={lifetimeText(rule)} placeholder={tt('capture.lifetime.placeholder')} disabled={props.disabled} autoCapitalize="off" spellCheck={false} onChange={(e) => { update(index, parseLifetime(e.target.value)) }} />
              </label>
              <label className="dsh-http-ruleField">
                <span>{tt('capture.refresh')}</span>
                <select className="dsh-http-select" value={rule.refresh} disabled={props.disabled} onChange={(e) => { update(index, { refresh: e.target.value as HttpCaptureRefresh }) }}>
                  {HTTP_CAPTURE_REFRESH.map(mode => <option key={mode} value={mode}>{tt(`capture.refresh.${mode}`)}</option>)}
                </select>
              </label>
            </div>
            <button type="button" className="dsh-http-iconButton" data-danger aria-label={tt('capture.remove')} title={tt('capture.remove')} disabled={props.disabled} onClick={() => { onChange(rules.filter((_, i) => i !== index)) }}>×</button>
          </div>
        ))}
        <div className="dsh-http-kvTools">
          <button type="button" className="dsh-http-link" disabled={props.disabled || rules.length >= MAX_CAPTURE_RULES} onClick={add}>+ {tt('capture.add')}</button>
        </div>
      </div>
      <p className="dsh-http-note">{tt('capture.note')}</p>
      {refreshing && <p className="dsh-http-note">{tt('capture.refreshNote')}</p>}
      <div className="dsh-http-readonlyBlock">
        <span className="dsh-http-label">{tt('capture.values')}</span>
        {props.captured.length === 0 ? <span className="dsh-http-note">{tt('capture.values.none')}</span> : (
          <div className="dsh-http-values">
            {props.captured.map((value) => {
              const title = props.requestTitle(value.requestId)
              const expired = value.expiresAt !== undefined && value.expiresAt <= now
              return (
                <div key={value.name} className="dsh-http-value">
                  <span className="dsh-http-valueName">{`{{${value.name}}}`}</span>
                  <span className="dsh-http-valueHint">{value.hint}</span>
                  {value.expiresAt !== undefined && <span className="dsh-http-valueExpiry" {...(expired ? { 'data-expired': '' } : {})}>{expired ? tt('capture.expired') : tt('capture.expiresAt', { time: shortTime(value.expiresAt) })}</span>}
                  <button type="button" className="dsh-http-link" data-danger onClick={() => { props.onClear(value.name) }}>{tt('capture.clear')}</button>
                  <span className="dsh-http-valueMeta">{title === undefined ? tt('capture.fromDeleted') : tt('capture.from', { request: title })} · {shortTime(value.at)}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
