import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RdbApi } from '../api.ts'
import { quoteIdentifier, type ChangesResult, type DbKind, type RowChange, type RowFilter, type RowsPage, type TableInfo, type TableRef } from '../../protocol.ts'
import { tt } from '../locales.ts'
import { BannerView, Modal, errorMessage, type Banner } from './common.tsx'

const PAGE = 100
const OPS: RowFilter['op'][] = ['=', '!=', '>', '>=', '<', '<=', 'like', 'is null', 'is not null']

export interface DataGridProps {
  api: RdbApi
  connectionId: string
  kind: DbKind
  table: TableRef
  info: TableInfo
}

/** Cell text for display; objects/arrays are shown as JSON. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

interface EditState { row: number; col: number; value: string }

export function DataGrid(props: DataGridProps): JSX.Element {
  const { api, connectionId, kind, table, info } = props
  const pk = info.primaryKey
  const editable = pk.length > 0 && table.kind === 'table'
  const [page, setPage] = useState<RowsPage | undefined>()
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState<{ column: string; desc: boolean } | undefined>()
  const [filter, setFilter] = useState<RowFilter>({ column: info.columns[0]?.name ?? '', op: '=', value: '' })
  const [applied, setApplied] = useState<RowFilter[]>([])
  const [loading, setLoading] = useState(false)
  const [banner, setBanner] = useState<Banner | undefined>()
  // Pending changes: per original row index → new values; new rows; deleted row indexes.
  const [updates, setUpdates] = useState<Map<number, Record<string, unknown>>>(new Map())
  const [inserts, setInserts] = useState<Record<string, unknown>[]>([])
  const [deletes, setDeletes] = useState<Set<number>>(new Set())
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [editing, setEditing] = useState<EditState | undefined>()
  const [preview, setPreview] = useState<{ statements: string[]; changes: RowChange[] } | undefined>()

  const reset = (): void => { setUpdates(new Map()); setInserts([]); setDeletes(new Set()); setSelected(new Set()); setEditing(undefined) }

  const load = useCallback(async (off = offset, s = sort, f = applied): Promise<void> => {
    setLoading(true)
    try {
      const result = await api.rows(connectionId, { schema: table.schema, table: table.name, offset: off, limit: PAGE, ...(s ? { sort: s } : {}), filters: f })
      setPage(result)
      setBanner(undefined)
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) })
    } finally { setLoading(false) }
  }, [api, connectionId, table.schema, table.name, offset, sort, applied])

  useEffect(() => { reset(); setOffset(0); setSort(undefined); setApplied([]); setPage(undefined) }, [connectionId, table.schema, table.name])
  useEffect(() => { void load(offset, sort, applied) }, [connectionId, table.schema, table.name, offset, sort, applied]) // eslint-disable-line react-hooks/exhaustive-deps

  const columns = page?.columns ?? info.columns.map(c => ({ name: c.name, type: c.type }))
  const colIndex = useMemo(() => new Map(columns.map((c, i) => [c.name, i])), [columns])
  const pending = updates.size + inserts.length + deletes.size

  const toggleSort = (column: string): void => {
    setOffset(0)
    setSort(prev => prev?.column === column ? (prev.desc ? undefined : { column, desc: true }) : { column, desc: false })
  }

  const applyFilter = (): void => {
    setOffset(0)
    if (filter.column === '') { setApplied([]); return }
    setApplied(filter.op === 'is null' || filter.op === 'is not null' ? [{ column: filter.column, op: filter.op }] : [{ column: filter.column, op: filter.op, value: filter.value ?? '' }])
  }

  const startEdit = (row: number, col: number): void => {
    if (!editable || deletes.has(row)) return
    const original = page?.rows[row]?.[col]
    const name = columns[col].name
    const current = updates.get(row)?.[name]
    setEditing({ row, col, value: cellText(current !== undefined ? current : original) })
  }
  const commitEdit = (value: unknown): void => {
    if (editing === undefined) return
    const name = columns[editing.col].name
    setUpdates(prev => {
      const next = new Map(prev)
      const rowPatch = { ...(next.get(editing.row) ?? {}) }
      const original = page?.rows[editing.row]?.[editing.col]
      if (cellText(value) === cellText(original) && (value === null) === (original === null)) delete rowPatch[name]
      else rowPatch[name] = value
      if (Object.keys(rowPatch).length === 0) next.delete(editing.row)
      else next.set(editing.row, rowPatch)
      return next
    })
    setEditing(undefined)
  }

  const keyOf = (row: unknown[]): Record<string, unknown> => Object.fromEntries(pk.map(k => [k, row[colIndex.get(k) ?? -1]]))
  const buildChanges = (): RowChange[] => {
    const out: RowChange[] = []
    for (const [row, values] of updates) if (!deletes.has(row) && page) out.push({ kind: 'update', key: keyOf(page.rows[row]), values })
    for (const values of inserts) out.push({ kind: 'insert', values })
    for (const row of deletes) if (page) out.push({ kind: 'delete', key: keyOf(page.rows[row]) })
    return out
  }

  const openPreview = async (): Promise<void> => {
    const changes = buildChanges()
    if (changes.length === 0) return
    try {
      const result: ChangesResult = await api.changes(connectionId, { schema: table.schema, table: table.name, changes, apply: false })
      setPreview({ statements: result.statements, changes })
    } catch (error) { setBanner({ kind: 'error', text: errorMessage(error) }) }
  }
  const applyChanges = async (): Promise<void> => {
    if (preview === undefined) return
    const { changes } = preview
    setPreview(undefined)
    try {
      const result = await api.changes(connectionId, { schema: table.schema, table: table.name, changes, apply: true })
      if (result.applied) {
        reset()
        await load()
        setBanner({ kind: 'ok', text: tt('data.applied', { count: result.statements.length, affected: result.affected ?? 0 }) })
      } else {
        setBanner({ kind: 'error', text: tt('data.failed', { error: result.error ?? '?' }) })
      }
    } catch (error) { setBanner({ kind: 'error', text: errorMessage(error) }) }
  }

  const total = page?.total
  const from = offset + 1
  const to = offset + (page?.rows.length ?? 0)
  const exportUrl = api.exportUrl(connectionId, `SELECT * FROM ${quoteIdentifier(kind, table.schema)}.${quoteIdentifier(kind, table.name)}`, `${table.schema}.${table.name}`)

  return (
    <div className="dsh-rdb-grid">
      <div className="dsh-rdb-toolbar">
        <select className="dsh-rdb-select" value={filter.column} onChange={(e) => { setFilter({ ...filter, column: e.target.value }) }} aria-label={tt('data.filter')}>
          {info.columns.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
        </select>
        <select className="dsh-rdb-select" value={filter.op} onChange={(e) => { setFilter({ ...filter, op: e.target.value as RowFilter['op'] }) }}>
          {OPS.map(op => <option key={op} value={op}>{op}</option>)}
        </select>
        {filter.op !== 'is null' && filter.op !== 'is not null' && (
          <input className="dsh-rdb-input dsh-rdb-filterValue" data-mono value={filter.value ?? ''} placeholder={tt('data.filterPlaceholder')} onChange={(e) => { setFilter({ ...filter, value: e.target.value }) }} onKeyDown={(e) => { if (e.key === 'Enter') applyFilter() }} />
        )}
        <button type="button" className="dsh-rdb-ghost" onClick={applyFilter}>{tt('data.filter')}</button>
        {applied.length > 0 && <button type="button" className="dsh-rdb-link" onClick={() => { setApplied([]); setOffset(0) }}>×</button>}
        <span className="dsh-rdb-spacer" />
        <button type="button" className="dsh-rdb-ghost" disabled={loading} onClick={() => { void load() }}>{tt('data.refresh')}</button>
        <a className="dsh-rdb-ghost" href={exportUrl} download>{tt('data.export')}</a>
        {editable && <>
          <button type="button" className="dsh-rdb-ghost" onClick={() => { setInserts(prev => [...prev, {}]) }}>{tt('data.addRow')}</button>
          <button type="button" className="dsh-rdb-ghost" disabled={selected.size === 0} onClick={() => { setDeletes(prev => new Set([...prev, ...selected])); setSelected(new Set()) }}>{tt('data.deleteRows')}</button>
        </>}
      </div>

      <BannerView banner={banner} onClose={() => { setBanner(undefined) }} />
      {!editable && table.kind === 'table' && <div className="dsh-rdb-banner" data-kind="info"><span>{tt('data.noPk')}</span></div>}

      <div className="dsh-rdb-tableWrap">
        {page === undefined && loading ? <div className="dsh-rdb-loading">{tt('tree.loading')}</div> : (
          <table className="dsh-rdb-table">
            <thead>
              <tr>
                {editable && <th className="dsh-rdb-colCheck" />}
                {columns.map(c => (
                  <th key={c.name} onClick={() => { toggleSort(c.name) }} title={c.type} {...(sort?.column === c.name ? { 'data-sort': sort.desc ? 'desc' : 'asc' } : {})}>
                    {c.name}{pk.includes(c.name) && <span className="dsh-rdb-pk">PK</span>}
                    <span className="dsh-rdb-sortMark">{sort?.column === c.name ? (sort.desc ? '▼' : '▲') : ''}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(page?.rows ?? []).map((row, r) => (
                <tr key={r} {...(deletes.has(r) ? { 'data-deleted': '' } : {})} {...(updates.has(r) ? { 'data-changed': '' } : {})}>
                  {editable && <td className="dsh-rdb-colCheck"><input type="checkbox" className="dsh-rdb-check" checked={selected.has(r)} onChange={() => { setSelected(prev => { const n = new Set(prev); n.has(r) ? n.delete(r) : n.add(r); return n }) }} /></td>}
                  {row.map((v, c) => {
                    const name = columns[c]?.name
                    const patched = updates.get(r)
                    const value = patched && name in patched ? patched[name] : v
                    const isEditing = editing?.row === r && editing.col === c
                    return (
                      <td key={c} {...(patched && name in patched ? { 'data-dirty': '' } : {})} {...(value === null ? { 'data-null': '' } : {})} onDoubleClick={() => { startEdit(r, c) }}>
                        {isEditing ? (
                          <CellEditor value={editing.value} onChange={(val) => { setEditing({ ...editing, value: val }) }} onCommit={(val) => { commitEdit(val) }} onCancel={() => { setEditing(undefined) }} />
                        ) : (value === null ? 'NULL' : cellText(value))}
                      </td>
                    )
                  })}
                </tr>
              ))}
              {inserts.map((values, i) => (
                <tr key={`new-${i}`} data-new="">
                  <td className="dsh-rdb-colCheck"><button type="button" className="dsh-rdb-link" data-danger onClick={() => { setInserts(prev => prev.filter((_, j) => j !== i)) }}>×</button></td>
                  {columns.map(c => (
                    <td key={c.name} {...(values[c.name] === null ? { 'data-null': '' } : {})}>
                      <input className="dsh-rdb-cellInput" data-mono value={values[c.name] === null || values[c.name] === undefined ? '' : cellText(values[c.name])} placeholder={values[c.name] === null ? 'NULL' : ''} onChange={(e) => { setInserts(prev => prev.map((row, j) => j === i ? { ...row, [c.name]: e.target.value } : row)) }} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {page !== undefined && page.rows.length === 0 && inserts.length === 0 && <div className="dsh-rdb-empty">{tt('tree.empty')}</div>}
      </div>

      <div className="dsh-rdb-footer">
        <span>{page ? (total !== undefined ? tt('data.rows', { from: page.rows.length ? from : 0, to, total }) : tt('data.rowsNoTotal', { from, to })) : ''}</span>
        <button type="button" className="dsh-rdb-link" disabled={offset === 0 || loading} onClick={() => { setOffset(Math.max(0, offset - PAGE)) }}>{tt('data.prev')}</button>
        <button type="button" className="dsh-rdb-link" disabled={loading || (page?.rows.length ?? 0) < PAGE} onClick={() => { setOffset(offset + PAGE) }}>{tt('data.next')}</button>
        <span className="dsh-rdb-spacer" />
        {pending > 0 && <>
          <span>{tt('data.pending', { count: pending })}</span>
          <button type="button" className="dsh-rdb-ghost" onClick={reset}>{tt('data.discard')}</button>
          <button type="button" className="dsh-rdb-primary" onClick={() => { void openPreview() }}>{tt('data.save')}</button>
        </>}
      </div>

      {preview !== undefined && (
        <Modal title={tt('data.confirmTitle')} wide onClose={() => { setPreview(undefined) }} footer={<>
          <button type="button" className="dsh-rdb-ghost" onClick={() => { setPreview(undefined) }}>{tt('form.cancel')}</button>
          <button type="button" className="dsh-rdb-primary" data-danger onClick={() => { void applyChanges() }}>{tt('data.confirmOk')}</button>
        </>}>
          <p style={{ margin: 0 }}>{tt('data.confirmBody', { count: preview.statements.length })}</p>
          <pre className="dsh-rdb-pre">{preview.statements.join(';\n')};</pre>
        </Modal>
      )}
    </div>
  )
}

function CellEditor(props: { value: string; onChange: (v: string) => void; onCommit: (v: unknown) => void; onCancel: () => void }): JSX.Element {
  return (
    <span className="dsh-rdb-cellEdit">
      <input
        className="dsh-rdb-cellInput" data-mono autoFocus value={props.value}
        onChange={(e) => { props.onChange(e.target.value) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') props.onCommit(props.value)
          else if (e.key === 'Escape') props.onCancel()
        }}
        onBlur={() => { props.onCommit(props.value) }}
      />
      <button type="button" className="dsh-rdb-link" title={tt('data.setNull')} onMouseDown={(e) => { e.preventDefault(); props.onCommit(null) }}>∅</button>
    </span>
  )
}
