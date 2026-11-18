import { HTTP_CAPTURE_SOURCES, type HttpCapture, type HttpCaptureSource, type HttpCapturedValue } from '../../protocol.ts'
import { tt, type HttpKey } from '../locales.ts'
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
 * Capture rules of a saved request, then the captured variables of its scope.
 * A blank row always follows the last rule and typing in it adds the rule.
 */
export function CaptureEditor(props: CaptureEditorProps): JSX.Element {
  const { rules, onChange } = props
  const update = (index: number, patch: Partial<HttpCapture>): void => {
    if (index >= rules.length) {
      onChange([...rules, { name: '', source: 'body', path: '', enabled: true, ...patch }])
      return
    }
    onChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)))
  }
  const shown: HttpCapture[] = [...rules, { name: '', source: 'body', path: '', enabled: true }]
  return (
    <>
      <div className="dsh-http-kv">
        {shown.map((rule, index) => {
          const ghost = index >= rules.length
          return (
            <div key={index} className="dsh-http-kvRow dsh-http-captureRow" {...(!rule.enabled ? { 'data-off': '' } : {})} {...(ghost ? { 'data-ghost': '' } : {})}>
              <input type="checkbox" className="dsh-http-check" checked={rule.enabled} disabled={props.disabled || ghost} aria-label={tt('capture.enabled')} onChange={(e) => { update(index, { enabled: e.target.checked }) }} />
              <input className="dsh-http-input" data-mono value={rule.name} placeholder={tt('capture.name')} aria-label={tt('capture.name')} disabled={props.disabled} autoCapitalize="off" spellCheck={false} onChange={(e) => { update(index, { name: e.target.value }) }} />
              <select className="dsh-http-select" value={rule.source} aria-label={tt('capture.source')} disabled={props.disabled} onChange={(e) => { update(index, { source: e.target.value as HttpCaptureSource }) }}>
                {HTTP_CAPTURE_SOURCES.map(source => <option key={source} value={source}>{tt(`capture.source.${source}` as HttpKey)}</option>)}
              </select>
              <input className="dsh-http-input" data-mono value={rule.path} placeholder={tt(`capture.path.${rule.source}` as HttpKey)} aria-label={tt(`capture.path.${rule.source}` as HttpKey)} disabled={props.disabled} autoCapitalize="off" spellCheck={false} onChange={(e) => { update(index, { path: e.target.value }) }} />
              <button type="button" className="dsh-http-iconButton" data-danger aria-label={tt('capture.remove')} title={tt('capture.remove')} disabled={props.disabled || ghost} onClick={() => { onChange(rules.filter((_, i) => i !== index)) }}>×</button>
            </div>
          )
        })}
      </div>
      <p className="dsh-http-note">{tt('capture.note')}</p>
      <div className="dsh-http-readonlyBlock">
        <span className="dsh-http-label">{tt('capture.values')}</span>
        {props.captured.length === 0 ? <span className="dsh-http-note">{tt('capture.values.none')}</span> : (
          <table className="dsh-http-headersTable dsh-http-valuesTable">
            <tbody>
              {props.captured.map((value) => {
                const title = props.requestTitle(value.requestId)
                return (
                  <tr key={value.name}>
                    <th>{`{{${value.name}}}`}</th>
                    <td>{value.hint}</td>
                    <td className="dsh-http-valueMeta">{title === undefined ? tt('capture.fromDeleted') : tt('capture.from', { request: title })} · {shortTime(value.at)}</td>
                    <td className="dsh-http-valueAction"><button type="button" className="dsh-http-link" data-danger onClick={() => { props.onClear(value.name) }}>{tt('capture.clear')}</button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
