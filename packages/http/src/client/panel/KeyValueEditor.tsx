import { useRef, useState } from 'react'
import type { HttpPairs } from '../../protocol.ts'
import { tt } from '../locales.ts'

export interface KeyValueRow {
  key: string
  value: string
  /** Rows switched off stay in the editor and are left out of the request. Default on. */
  enabled?: boolean
}

export interface KeyValueEditorProps {
  rows: KeyValueRow[]
  onChange: (rows: KeyValueRow[]) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
  /** Show the per-row enable checkbox. */
  toggle?: boolean
  /** Show the toolbar: add, bulk edit, delete all. */
  tools?: boolean
  disabled?: boolean
}

/** Rows as bulk-edit text: one `name: value` per line, switched-off rows behind `# `. */
export function rowsToBulk(rows: KeyValueRow[]): string {
  return rows.map(row => `${row.enabled === false ? '# ' : ''}${row.key}: ${row.value}`).join('\n')
}

/** Bulk-edit text as rows: `name: value` or `name=value` per line; `#` switches a line off; blank lines are skipped. */
export function bulkToRows(text: string): KeyValueRow[] {
  const rows: KeyValueRow[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim()
    if (line === '') continue
    const off = line.startsWith('#')
    if (off) line = line.slice(1).trim()
    if (line === '') continue
    const colon = line.indexOf(':')
    const equals = line.indexOf('=')
    const index = colon < 0 ? equals : equals < 0 ? colon : Math.min(colon, equals)
    const key = index < 0 ? line : line.slice(0, index).trim()
    const value = index < 0 ? '' : line.slice(index + 1).trim()
    rows.push({ key, value, ...(off ? { enabled: false } : {}) })
  }
  return rows
}

/**
 * Name/value rows. A blank row always follows the last one and typing in it
 * adds the row; the toolbar adds a row explicitly, switches to bulk text
 * editing, and deletes every row. Rows with an empty name are dropped by
 * {@link rowsToRecord} and {@link rowsToPairs}.
 */
export function KeyValueEditor(props: KeyValueEditorProps): JSX.Element {
  const { rows, onChange } = props
  const [bulk, setBulk] = useState<string | undefined>()
  const rootRef = useRef<HTMLDivElement>(null)

  const update = (index: number, patch: Partial<KeyValueRow>): void => {
    if (index >= rows.length) {
      onChange([...rows, { key: '', value: '', ...patch }])
      return
    }
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }
  const focusBlank = (): void => {
    setTimeout(() => { rootRef.current?.querySelector<HTMLInputElement>('[data-ghost] input[data-kv-name]')?.focus() }, 0)
  }

  const shown: KeyValueRow[] = [...rows, { key: '', value: '' }]
  return (
    <div className="dsh-http-kv" ref={rootRef} {...(props.toggle ? { 'data-toggle': '' } : {})}>
      {props.tools && (
        <div className="dsh-http-kvTools">
          <button type="button" className="dsh-http-link" disabled={props.disabled || bulk !== undefined} onClick={focusBlank}>+ {tt('kv.add')}</button>
          <button type="button" className="dsh-http-link" disabled={props.disabled} onClick={() => { setBulk(bulk === undefined ? rowsToBulk(rows) : undefined) }}>{bulk === undefined ? tt('kv.bulk') : tt('kv.table')}</button>
          <span className="dsh-http-spacer" />
          <button type="button" className="dsh-http-link" data-danger disabled={props.disabled || rows.length === 0} onClick={() => { onChange([]); if (bulk !== undefined) setBulk('') }}>{tt('kv.deleteAll')}</button>
        </div>
      )}
      {bulk !== undefined ? (
        <>
          <textarea className="dsh-http-editor dsh-http-bulk" value={bulk} disabled={props.disabled} spellCheck={false} aria-label={tt('kv.bulk')} placeholder={'name: value'} onChange={(e) => { setBulk(e.target.value); onChange(bulkToRows(e.target.value)) }} />
          <span className="dsh-http-note">{tt('kv.bulkHint')}</span>
        </>
      ) : shown.map((row, index) => {
        const ghost = index >= rows.length
        const off = row.enabled === false
        return (
          <div key={index} className="dsh-http-kvRow" {...(off ? { 'data-off': '' } : {})} {...(ghost ? { 'data-ghost': '' } : {})}>
            {props.toggle && (
              <input type="checkbox" className="dsh-http-check" checked={!off} disabled={props.disabled || ghost} aria-label={tt('kv.enabled')} onChange={(e) => { update(index, { enabled: e.target.checked }) }} />
            )}
            <input className="dsh-http-input" data-mono data-kv-name value={row.key} placeholder={props.keyPlaceholder ?? tt('kv.key')} disabled={props.disabled} autoCapitalize="off" spellCheck={false} onChange={(e) => { update(index, { key: e.target.value }) }} />
            <input className="dsh-http-input" data-mono value={row.value} placeholder={props.valuePlaceholder ?? tt('kv.value')} disabled={props.disabled} autoCapitalize="off" spellCheck={false} autoComplete="off" onChange={(e) => { update(index, { value: e.target.value }) }} />
            <button type="button" className="dsh-http-iconButton" data-danger aria-label={tt('kv.remove')} title={tt('kv.remove')} disabled={props.disabled || ghost} onClick={() => { onChange(rows.filter((_, i) => i !== index)) }}>×</button>
          </div>
        )
      })}
    </div>
  )
}

/** Enabled rows with a name, as a record; a repeated name keeps its last value. */
export function rowsToRecord(rows: KeyValueRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key !== '' && row.enabled !== false) out[key] = row.value
  }
  return out
}

/** Enabled rows with a name, in order, repeated names included. */
export function rowsToPairs(rows: KeyValueRow[]): HttpPairs {
  return rows.filter(row => row.key.trim() !== '' && row.enabled !== false).map(row => [row.key.trim(), row.value])
}

export function recordToRows(value: Record<string, string> | HttpPairs | undefined): KeyValueRow[] {
  const pairs = value === undefined ? [] : Array.isArray(value) ? value : Object.entries(value)
  return pairs.map(([key, rowValue]) => ({ key, value: rowValue }))
}

/** Rows that count toward a tab badge. */
export function activeCount(rows: KeyValueRow[]): number {
  return rows.filter(row => row.key.trim() !== '' && row.enabled !== false).length
}
