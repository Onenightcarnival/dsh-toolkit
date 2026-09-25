import { useEffect, useState } from 'react'
import type { RdbApi } from '../api.ts'
import type { TableInfo, TableRef } from '../../protocol.ts'
import { tt } from '../locales.ts'
import { errorMessage } from './common.tsx'

export interface StructureProps {
  api: RdbApi
  connectionId: string
  table: TableRef
  info: TableInfo
}

export function Structure(props: StructureProps): JSX.Element {
  const { api, connectionId, table, info } = props
  const [ddl, setDdl] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    let cancelled = false
    setDdl(undefined); setError(undefined)
    api.ddl(connectionId, table).then(text => { if (!cancelled) setDdl(text) }, err => { if (!cancelled) setError(errorMessage(err)) })
    return () => { cancelled = true }
  }, [api, connectionId, table.schema, table.name, table.kind])

  return (
    <div className="dsh-rdb-struct">
      <div className="dsh-rdb-sectionTitle">
        <span>{tt('struct.col.name')}</span>
        {info.estimatedRows !== undefined && <span className="dsh-rdb-meta">{tt('struct.rows', { count: info.estimatedRows })}</span>}
      </div>
      <div className="dsh-rdb-tableWrap">
        <table className="dsh-rdb-table">
          <thead>
            <tr>
              <th>{tt('struct.col.name')}</th>
              <th>{tt('struct.col.type')}</th>
              <th>{tt('struct.col.nullable')}</th>
              <th>{tt('struct.col.default')}</th>
              <th>{tt('struct.col.pk')}</th>
            </tr>
          </thead>
          <tbody>
            {info.columns.map(c => (
              <tr key={c.name}>
                <td>{c.name}</td>
                <td>{c.type}</td>
                <td>{c.nullable ? 'YES' : 'NO'}</td>
                <td {...(c.defaultValue === null || c.defaultValue === undefined ? { 'data-null': '' } : {})}>{c.defaultValue ?? ''}</td>
                <td>{c.primaryKey ? 'PK' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {info.indexes.length > 0 && <>
        <div className="dsh-rdb-sectionTitle">{tt('struct.indexes')}</div>
        <div className="dsh-rdb-tableWrap">
          <table className="dsh-rdb-table">
            <tbody>
              {info.indexes.map(i => (
                <tr key={i.name}>
                  <td>{i.name}</td>
                  <td>{i.columns.join(', ')}</td>
                  <td>{i.primary ? 'PRIMARY' : i.unique ? 'UNIQUE' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>}
      <div className="dsh-rdb-sectionTitle">{tt('data.ddl')}</div>
      {error !== undefined ? <div className="dsh-rdb-formError">{error}</div> : <pre className="dsh-rdb-pre">{ddl ?? tt('tree.loading')}</pre>}
    </div>
  )
}
