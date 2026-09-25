/** Browser-side client for the /api/dsh-rdb route family (same origin, cookie auth). */
import { RDB_API, type ChangesResult, type DbProfilePayload, type DbProfileSummary, type DbTestResult, type QueryResult, type RdbSettings, type RowChange, type RowFilter, type RowsPage, type TableInfo, type TableRef } from '../protocol.ts'
import { tt } from './locales.ts'

export class RdbApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'RdbApiError' }
}

async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try { body = await response.json() } catch {
    if (response.status === 404) throw new RdbApiError(tt('error.disabled'), 404)
    throw new RdbApiError(`HTTP ${response.status}`, response.status)
  }
  if (!response.ok) {
    const error = (body as { error?: unknown } | null)?.error
    throw new RdbApiError(typeof error === 'string' ? error : `HTTP ${response.status}`, response.status)
  }
  return body as T
}

const JSON_HEADERS = { 'content-type': 'application/json' }
const get = (url: string) => fetch(url, { credentials: 'same-origin' })
const post = (url: string, body: unknown, method = 'POST') => fetch(url, { method, headers: JSON_HEADERS, body: JSON.stringify(body), credentials: 'same-origin' })

export class RdbApi {
  async profiles(): Promise<DbProfileSummary[]> { return (await readJson<{ profiles: DbProfileSummary[] }>(await get(RDB_API.profiles))).profiles }
  async createProfile(p: DbProfilePayload): Promise<DbProfileSummary> { return (await readJson<{ profile: DbProfileSummary }>(await post(RDB_API.profiles, p))).profile }
  async updateProfile(id: string, p: DbProfilePayload): Promise<DbProfileSummary> { return (await readJson<{ profile: DbProfileSummary }>(await post(`${RDB_API.profiles}?id=${encodeURIComponent(id)}`, p, 'PATCH'))).profile }
  async deleteProfile(id: string): Promise<void> { await readJson(await fetch(`${RDB_API.profiles}?id=${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' })) }
  async settings(): Promise<RdbSettings> { return (await readJson<{ settings: RdbSettings }>(await get(RDB_API.settings))).settings }
  async saveSettings(patch: Partial<RdbSettings>): Promise<RdbSettings> { return (await readJson<{ settings: RdbSettings }>(await post(RDB_API.settings, patch))).settings }
  async test(id: string): Promise<DbTestResult> { return (await readJson<{ result: DbTestResult }>(await post(RDB_API.test, { id }))).result }
  async schemas(id: string): Promise<{ schemas: string[]; defaultSchema: string }> { return readJson(await get(`${RDB_API.schemas}?id=${encodeURIComponent(id)}`)) }
  async tables(id: string, schema: string): Promise<TableRef[]> { return (await readJson<{ tables: TableRef[] }>(await get(`${RDB_API.tables}?${new URLSearchParams({ id, schema })}`))).tables }
  async tableInfo(id: string, table: TableRef): Promise<TableInfo> { return (await readJson<{ info: TableInfo }>(await get(`${RDB_API.columns}?${new URLSearchParams({ id, schema: table.schema, table: table.name, kind: table.kind })}`))).info }
  async ddl(id: string, table: TableRef): Promise<string> { return (await readJson<{ ddl: string }>(await get(`${RDB_API.ddl}?${new URLSearchParams({ id, schema: table.schema, table: table.name, kind: table.kind })}`))).ddl }
  async rows(id: string, req: { schema: string; table: string; offset: number; limit: number; sort?: { column: string; desc: boolean }; filters?: RowFilter[] }): Promise<RowsPage> {
    return (await readJson<{ page: RowsPage }>(await post(RDB_API.rows, { id, ...req }))).page
  }
  async query(id: string, sql: string, maxRows?: number): Promise<QueryResult> { return (await readJson<{ result: QueryResult }>(await post(RDB_API.query, { id, sql, maxRows }))).result }
  async changes(id: string, req: { schema: string; table: string; changes: RowChange[]; apply: boolean }): Promise<ChangesResult> {
    return (await readJson<{ result: ChangesResult }>(await post(RDB_API.changes, { id, ...req }))).result
  }
  exportUrl(id: string, sql: string, name: string): string { return `${RDB_API.exportCsv}?${new URLSearchParams({ id, sql, name })}` }
}
