import { useRef, useState } from 'react'
import type { RdbApi } from '../api.ts'
import type { QueryResult } from '../../protocol.ts'
import { tt } from '../locales.ts'
import { Modal, errorMessage } from './common.tsx'
import { cellText } from './DataGrid.tsx'

const MAX_ROWS = 1000
const READ_START = /^\s*(?:--[^\n]*\n\s*|#[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*(select|with|explain|show|values|table|describe|desc|pragma)\b/i
const WRITE_WORDS = /\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|vacuum|reindex|attach|detach|copy|call|do|lock|refresh)\b|\bselect\b[\s\S]*\binto\b|\bfor\s+update\b/i

/** Client-side classification used only to decide whether to ask before running. */
export function looksReadOnly(sql: string): boolean {
  return READ_START.test(sql) && !WRITE_WORDS.test(sql.replace(/'(?:[^']|'')*'/g, "''"))
}

function commandOf(sql: string): string {
  const m = /^\s*(?:--[^\n]*\n\s*|#[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*([a-z]+)/i.exec(sql)
  return (m?.[1] ?? 'SQL').toUpperCase()
}

export interface SqlEditorProps {
  api: RdbApi
  connectionId: string
  initialSql?: string
}

export function SqlEditor(props: SqlEditorProps): JSX.Element {
  const { api, connectionId } = props
  const [sql, setSql] = useState(props.initialSql ?? '')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<QueryResult | undefined>()
  const [ranSql, setRanSql] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [confirm, setConfirm] = useState<string | undefined>()
  const textarea = useRef<HTMLTextAreaElement>(null)

  const statementToRun = (): string => {
    const el = textarea.current
    if (el !== null && el.selectionStart !== el.selectionEnd) return el.value.slice(el.selectionStart, el.selectionEnd)
    return sql
  }

  const execute = async (statement: string): Promise<void> => {
    setRunning(true); setError(undefined)
    try {
      const out = await api.query(connectionId, statement, MAX_ROWS)
      setResult(out); setRanSql(statement)
    } catch (err) {
      setError(errorMessage(err)); setResult(undefined)
    } finally { setRunning(false) }
  }

  const run = (): void => {
    const statement = statementToRun().trim()
    if (statement === '' || running) return
    if (looksReadOnly(statement)) void execute(statement)
    else setConfirm(statement)
  }

  const canExport = result !== undefined && result.columns.length > 0 && looksReadOnly(ranSql)

  return (
    <div className="dsh-rdb-sql">
      <textarea
        ref={textarea} className="dsh-rdb-sqlEditor" value={sql} placeholder={tt('sql.placeholder')} spellCheck={false}
        onChange={(e) => { setSql(e.target.value) }}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run() } }}
      />
      <div className="dsh-rdb-toolbar">
        <button type="button" className="dsh-rdb-primary" disabled={running || sql.trim() === ''} onClick={run}>{running ? tt('sql.running') : tt('sql.run')}</button>
        {result !== undefined && (
          <span className="dsh-rdb-sqlStatus">
            {result.columns.length > 0 ? tt('sql.result', { count: result.rowCount, ms: result.durationMs }) : tt('sql.affected', { command: result.command, count: result.rowCount, ms: result.durationMs })}
            {result.truncated && ' ' + tt('sql.truncated', { count: result.rows.length })}
          </span>
        )}
        <span className="dsh-rdb-spacer" />
        {canExport && <a className="dsh-rdb-ghost" href={api.exportUrl(connectionId, ranSql, 'query')} download>{tt('sql.export')}</a>}
      </div>
      {error !== undefined && <div className="dsh-rdb-banner" data-kind="error"><span>{tt('sql.error', { error })}</span></div>}
      {result !== undefined && result.columns.length > 0 && (
        <div className="dsh-rdb-tableWrap">
          <table className="dsh-rdb-table">
            <thead><tr>{result.columns.map((c, i) => <th key={i} title={c.type}>{c.name}</th>)}</tr></thead>
            <tbody>
              {result.rows.map((row, r) => (
                <tr key={r}>{row.map((v, c) => <td key={c} {...(v === null ? { 'data-null': '' } : {})}>{v === null ? 'NULL' : cellText(v)}</td>)}</tr>
              ))}
            </tbody>
          </table>
          {result.rows.length === 0 && <div className="dsh-rdb-empty">{tt('tree.empty')}</div>}
        </div>
      )}
      {confirm !== undefined && (
        <Modal title={tt('data.confirmTitle')} onClose={() => { setConfirm(undefined) }} footer={<>
          <button type="button" className="dsh-rdb-ghost" onClick={() => { setConfirm(undefined) }}>{tt('form.cancel')}</button>
          <button type="button" className="dsh-rdb-primary" data-danger onClick={() => { const s = confirm; setConfirm(undefined); void execute(s) }}>{tt('data.confirmOk')}</button>
        </>}>
          <p style={{ margin: 0 }}>{tt('sql.confirmWrite', { command: commandOf(confirm) })}</p>
          <pre className="dsh-rdb-pre">{confirm}</pre>
        </Modal>
      )}
    </div>
  )
}
