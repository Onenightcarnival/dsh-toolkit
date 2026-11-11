import type { HttpExchange } from '../../protocol.ts'
import { tt } from '../locales.ts'
import { shortTime, statusKind } from './common.tsx'

export interface HistorySidebarProps {
  entries: HttpExchange[]
  filter: string
  onFilter: (value: string) => void
  activeId?: string
  /** Show the exchange in the response pane. */
  onPick: (entry: HttpExchange) => void
  /** Keep the recorded request as a saved request. */
  onSave: (entry: HttpExchange) => void
  onDelete: (entry: HttpExchange) => void
  onClear: () => void
}

/** Path and query of a recorded request; the composed path when no URL was built. */
export function requestLabel(entry: HttpExchange): string {
  const url = entry.request.url
  if (url === '') return entry.request.path || '/'
  try {
    const parsed = new URL(url)
    return parsed.pathname + parsed.search
  } catch {
    return url
  }
}

function matches(entry: HttpExchange, needle: string): boolean {
  if (needle === '') return true
  return `${entry.request.method} ${requestLabel(entry)} ${entry.response?.status ?? entry.error ?? ''}`.toLowerCase().includes(needle)
}

/** Exchanges of the active target, the panel's and the agent's: filter, newest first, save as request, clear. */
export function HistorySidebar(props: HistorySidebarProps): JSX.Element {
  const needle = props.filter.trim().toLowerCase()
  const shown = props.entries.filter(entry => matches(entry, needle))
  return (
    <>
      <div className="dsh-http-sideFilter">
        <input className="dsh-http-input" value={props.filter} placeholder={tt('history.filter')} onChange={(e) => { props.onFilter(e.target.value) }} spellCheck={false} aria-label={tt('history.filter')} />
      </div>
      <div className="dsh-http-historyList" role="list">
        {shown.length === 0 && <div className="dsh-http-hint">{props.entries.length === 0 ? tt('history.empty') : tt('history.noMatch')}</div>}
        {shown.map(entry => (
          <div key={entry.id} role="listitem" className="dsh-http-item" {...(entry.id === props.activeId ? { 'data-active': '' } : {})}>
            <button type="button" className="dsh-http-itemMain" onClick={() => { props.onPick(entry) }} title={entry.request.url || entry.request.path}>
              <span className="dsh-http-itemLine">
                <span className="dsh-http-methodText" data-method={entry.request.method}>{entry.request.method}</span>
                <span className="dsh-http-itemPath">{requestLabel(entry)}</span>
              </span>
              <span className="dsh-http-itemLine" data-sub>
                {entry.response !== undefined
                  ? <span className="dsh-http-statusText" data-kind={statusKind(entry.response.status)}>{entry.response.status}</span>
                  : <span className="dsh-http-statusText" data-kind="error" title={entry.error}>{tt('history.failed')}</span>}
                <span>{entry.response !== undefined ? tt('response.time', { ms: entry.response.durationMs }) : ''}</span>
                <span className="dsh-http-spacer" />
                {entry.source === 'agent' && <span className="dsh-http-sourceTag" data-source="agent">{tt('history.source.agent')}</span>}
                <span>{shortTime(entry.at)}</span>
              </span>
            </button>
            <div className="dsh-http-itemActions">
              <button type="button" className="dsh-http-iconButton" aria-label={tt('history.saveAs')} title={tt('history.saveAs')} onClick={() => { props.onSave(entry) }}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
              </button>
              <button type="button" className="dsh-http-iconButton" data-danger aria-label={tt('history.delete')} title={tt('history.delete')} onClick={() => { props.onDelete(entry) }}>×</button>
            </div>
          </div>
        ))}
      </div>
      <div className="dsh-http-sideFoot">
        <span>{tt('history.count', { count: props.entries.length })}</span>
        <span className="dsh-http-spacer" />
        <button type="button" className="dsh-http-link" data-danger disabled={props.entries.length === 0} onClick={props.onClear}>{tt('history.clear')}</button>
      </div>
    </>
  )
}
