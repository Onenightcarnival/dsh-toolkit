/**
 * Database engine shared by the routes and the agent tools: connection cache
 * per profile, statement classification, table paging, and grid-change SQL.
 */
import type { ChangesResult, DbProfile, DbTestResult, QueryResult, RowChange, RowFilter, RowsPage, RowsRequest, TableInfo, TableRef } from './protocol.ts'
import type { DbConnection, QueryOptions } from './drivers/types.ts'
import { SqliteConnection } from './drivers/sqlite.ts'
import { PgConnection } from './drivers/postgres.ts'
import { MysqlConnection } from './drivers/mysql.ts'
import type { ProfileStore } from './store.ts'

export const DEFAULT_MAX_ROWS = 1000
export const DEFAULT_TIMEOUT_MS = 30000
const IDLE_CLOSE_MS = 10 * 60 * 1000

export function errorText(error: unknown): string {
  if (error instanceof Error) {
    const detail = (error as { detail?: string; hint?: string }).detail
    return error.message + (detail ? ` (${detail})` : '')
  }
  return String(error)
}

/** Dialect facts the SQL text scans depend on. */
export interface SqlDialect {
  /** `# …` line comments and backslash escapes inside strings (MySQL / MariaDB). */
  mysql?: boolean
}

/** Strip string literals, quoted identifiers, and comments for keyword scans. */
function skeleton(sql: string, dialect: SqlDialect = {}): string {
  let s = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
  if (dialect.mysql) {
    s = s.replace(/#[^\n]*/g, ' ').replace(/'(?:[^'\\]|''|\\.)*'/g, "''").replace(/`(?:[^`]|``)*`/g, '``')
  }
  return s
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/\$\$[\s\S]*?\$\$/g, "''")
}

/** Split on top-level semicolons; pieces holding only comments and whitespace are dropped. */
export function splitStatements(sql: string, dialect: SqlDialect = {}): string[] {
  const out: string[] = []
  let depth = 0
  let inS = false
  let inD = false
  let inB = false
  let start = 0
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (inS) { if (dialect.mysql && ch === '\\') { i++; continue } if (ch === "'" ) inS = false; continue }
    if (inD) { if (ch === '"') inD = false; continue }
    if (inB) { if (ch === '`') inB = false; continue }
    if (ch === "'") { inS = true; continue }
    if (ch === '"') { inD = true; continue }
    if (dialect.mysql && ch === '`') { inB = true; continue }
    if ((ch === '-' && sql[i + 1] === '-') || (dialect.mysql && ch === '#')) { const nl = sql.indexOf('\n', i); i = nl < 0 ? sql.length : nl; continue }
    if (ch === '/' && sql[i + 1] === '*') { const end = sql.indexOf('*/', i + 2); i = end < 0 ? sql.length : end + 1; continue }
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ';' && depth === 0) { out.push(sql.slice(start, i)); start = i + 1 }
  }
  out.push(sql.slice(start))
  return out.map(s => s.trim()).filter(s => s !== '' && skeleton(s, dialect).trim() !== '')
}

const READ_START = /^(select|with|explain|show|values|table|describe|desc|pragma)\b/i
const DML_OR_DDL = /\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|vacuum|reindex|attach|detach|copy|call|do|lock|refresh|cluster|comment|set|reset|begin|commit|rollback|start|end|savepoint|release)\b/i

/** Whether a single statement only reads. Conservative: anything unclear is a write. */
export function isReadOnly(statement: string, dialect: SqlDialect = {}): boolean {
  const s = skeleton(statement, dialect).trim()
  if (!READ_START.test(s)) return false
  const rest = s.replace(READ_START, '')
  if (/^\s*pragma/i.test(s) && /[=(]/.test(rest)) return /^\s*\(/.test(rest) && !/=/.test(rest) ? true : false
  if (/^\s*select\b/i.test(s) && /\binto\b/i.test(rest)) return false
  if (/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(rest)) return false
  return !DML_OR_DDL.test(rest)
}

export { sqlLiteral as literal } from './drivers/literal.ts'

interface Cached { conn: DbConnection; updatedAt: number; lastUsed: number; opening?: Promise<void> }

export class RdbEngine {
  private readonly conns = new Map<string, Cached>()
  private readonly store: ProfileStore
  private readonly sweeper: NodeJS.Timeout

  constructor(store: ProfileStore) {
    this.store = store
    store.subscribe(() => { void this.dropStale() })
    this.sweeper = setInterval(() => { void this.sweepIdle() }, 60 * 1000)
    if (typeof this.sweeper.unref === 'function') this.sweeper.unref()
  }

  profile(idOrName: string): DbProfile {
    const profile = this.store.find(idOrName)
    if (profile === undefined) throw new Error(`unknown connection '${idOrName}' (configure it in the database panel first)`)
    return profile
  }

  /** Open (or reuse) the connection for a profile. */
  async connect(idOrName: string): Promise<{ profile: DbProfile; conn: DbConnection }> {
    const profile = this.profile(idOrName)
    let cached = this.conns.get(profile.id)
    if (cached !== undefined && (cached.updatedAt !== profile.updatedAt || cached.conn.alive === false)) {
      await cached.conn.close().catch(() => undefined)
      this.conns.delete(profile.id)
      cached = undefined
    }
    if (cached === undefined) {
      const conn = profile.kind === 'sqlite' ? new SqliteConnection(profile.file) : profile.kind === 'mysql' ? new MysqlConnection(profile) : new PgConnection(profile)
      cached = { conn, updatedAt: profile.updatedAt, lastUsed: Date.now() }
      if (conn instanceof PgConnection || conn instanceof MysqlConnection) {
        cached.opening = conn.connect().catch((error) => { this.conns.delete(profile.id); throw error })
      }
      this.conns.set(profile.id, cached)
    }
    if (cached.opening !== undefined) await cached.opening
    cached.lastUsed = Date.now()
    return { profile, conn: cached.conn }
  }

  /** Drop the pooled connection of a profile (after edits / delete). */
  async drop(id: string): Promise<void> {
    const cached = this.conns.get(id)
    if (cached === undefined) return
    this.conns.delete(id)
    await cached.conn.close().catch(() => undefined)
  }

  private async dropStale(): Promise<void> {
    for (const [id, cached] of this.conns) {
      const profile = this.store.list().find(p => p.id === id)
      if (profile === undefined || profile.updatedAt !== cached.updatedAt) await this.drop(id)
    }
  }

  private async sweepIdle(): Promise<void> {
    const now = Date.now()
    for (const [id, cached] of this.conns) if (now - cached.lastUsed > IDLE_CLOSE_MS) await this.drop(id)
  }

  async test(idOrName: string): Promise<DbTestResult> {
    const started = Date.now()
    try {
      const { conn } = await this.connect(idOrName)
      const serverVersion = await conn.serverVersion()
      return { ok: true, latencyMs: Date.now() - started, serverVersion, ...(conn.node !== undefined ? { node: conn.node } : {}) }
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: errorText(error) }
    }
  }

  async schemas(idOrName: string): Promise<{ schemas: string[]; defaultSchema: string }> {
    const { conn } = await this.connect(idOrName)
    return { schemas: await conn.listSchemas(), defaultSchema: conn.defaultSchema }
  }

  async tables(idOrName: string, schema?: string): Promise<TableRef[]> {
    const { conn } = await this.connect(idOrName)
    return conn.listTables(schema || conn.defaultSchema)
  }

  async tableInfo(idOrName: string, ref: { schema?: string; name: string; kind?: 'table' | 'view' }): Promise<TableInfo> {
    const { conn } = await this.connect(idOrName)
    const table: TableRef = { schema: ref.schema || conn.defaultSchema, name: ref.name, kind: ref.kind ?? 'table' }
    // One statement at a time per connection: pg clients serialize anyway and warn on overlap.
    const columns = await conn.columns(table)
    const indexes = await conn.indexes(table)
    const estimatedRows = await conn.estimatedRows(table)
    const primaryKey = columns.filter(c => c.primaryKey).map(c => c.name)
    return { table, columns, indexes, primaryKey, ...(estimatedRows !== undefined ? { estimatedRows } : {}) }
  }

  async ddl(idOrName: string, ref: { schema?: string; name: string; kind?: 'table' | 'view' }): Promise<string> {
    const { conn } = await this.connect(idOrName)
    return conn.ddl({ schema: ref.schema || conn.defaultSchema, name: ref.name, kind: ref.kind ?? 'table' })
  }

  /** Run one statement. `allowWrite=false` refuses anything that is not a read. */
  async query(idOrName: string, sql: string, options: { allowWrite: boolean; maxRows?: number; timeoutMs?: number; params?: unknown[] }): Promise<QueryResult> {
    const dialect: SqlDialect = { mysql: this.profile(idOrName).kind === 'mysql' }
    const statements = splitStatements(sql, dialect)
    if (statements.length === 0) throw new Error('empty SQL')
    if (statements.length > 1) throw new Error(`one statement at a time (got ${statements.length}); run them separately or use a transaction`)
    const statement = statements[0]
    if (!options.allowWrite && !isReadOnly(statement, dialect)) throw new Error('refused: only read statements run here (SELECT / WITH / EXPLAIN / SHOW); writes go through db_execute')
    const { conn } = await this.connect(idOrName)
    const q: QueryOptions = { maxRows: Math.max(1, Math.min(100000, options.maxRows ?? DEFAULT_MAX_ROWS)), timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS }
    return conn.query(statement, options.params ?? [], q)
  }

  /** Run several statements in one transaction (writes allowed by the caller). */
  async transaction(idOrName: string, statements: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<number> {
    const { conn } = await this.connect(idOrName)
    return conn.transaction(statements.map(sql => ({ sql, params: [] })), { maxRows: 1, timeoutMs })
  }

  /** One page of a table with optional sort and filters; exact total for the filter. */
  async rows(idOrName: string, request: RowsRequest): Promise<RowsPage> {
    const { conn } = await this.connect(idOrName)
    const table: TableRef = { schema: request.schema || conn.defaultSchema, name: request.table, kind: 'table' }
    const columns = await conn.columns(table)
    const names = new Set(columns.map(c => c.name))
    const q = (s: string) => conn.quoteIdent(s)
    const target = `${q(table.schema)}.${q(table.name)}`
    const params: unknown[] = []
    const where: string[] = []
    for (const f of request.filters ?? []) {
      if (!names.has(f.column)) throw new Error(`unknown column '${f.column}'`)
      const col = q(f.column)
      if (f.op === 'is null' || f.op === 'is not null') { where.push(`${col} ${f.op.toUpperCase()}`); continue }
      if (!['=', '!=', '>', '>=', '<', '<=', 'like'].includes(f.op)) throw new Error(`unsupported operator '${f.op}'`)
      params.push(f.value ?? '')
      where.push(f.op === 'like' ? `${conn.castToText(col)} LIKE ${conn.placeholder(params.length - 1)}` : `${col} ${f.op} ${conn.placeholder(params.length - 1)}`)
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
    let orderSql = ''
    if (request.sort !== undefined) {
      if (!names.has(request.sort.column)) throw new Error(`unknown column '${request.sort.column}'`)
      orderSql = ` ORDER BY ${q(request.sort.column)} ${request.sort.desc ? 'DESC' : 'ASC'}`
    } else {
      const pk = columns.filter(c => c.primaryKey).map(c => q(c.name))
      if (pk.length > 0) orderSql = ` ORDER BY ${pk.join(', ')}`
    }
    const limit = Math.max(1, Math.min(1000, request.limit || 100))
    const offset = Math.max(0, request.offset || 0)
    const opts: QueryOptions = { maxRows: limit, timeoutMs: DEFAULT_TIMEOUT_MS }
    const page = await conn.query(`SELECT * FROM ${target}${whereSql}${orderSql} LIMIT ${limit} OFFSET ${offset}`, params, opts)
    let total: number | undefined
    try {
      const count = await conn.query(`SELECT COUNT(*) AS n FROM ${target}${whereSql}`, params, { maxRows: 1, timeoutMs: 10000 })
      total = Number(count.rows[0]?.[0] ?? 0)
    } catch { total = undefined }
    return { ...page, primaryKey: columns.filter(c => c.primaryKey).map(c => c.name), ...(total !== undefined ? { total } : {}) }
  }

  /** Turn grid changes into SQL; optionally apply them in one transaction. */
  async changes(idOrName: string, request: { schema: string; table: string; changes: RowChange[]; apply: boolean }): Promise<ChangesResult> {
    const { conn } = await this.connect(idOrName)
    const table: TableRef = { schema: request.schema || conn.defaultSchema, name: request.table, kind: 'table' }
    const columns = await conn.columns(table)
    const names = new Set(columns.map(c => c.name))
    const pk = columns.filter(c => c.primaryKey).map(c => c.name)
    const q = (s: string) => conn.quoteIdent(s)
    const target = `${q(table.schema)}.${q(table.name)}`
    const check = (obj: Record<string, unknown>): void => { for (const k of Object.keys(obj)) if (!names.has(k)) throw new Error(`unknown column '${k}'`) }
    const keyClause = (key: Record<string, unknown>): string => {
      if (pk.length === 0) throw new Error('table has no primary key; edit it with SQL instead')
      return pk.map(k => (key[k] === null || key[k] === undefined) ? `${q(k)} IS NULL` : `${q(k)} = ${conn.literal(key[k])}`).join(' AND ')
    }
    const statements: string[] = []
    for (const change of request.changes) {
      if (change.kind === 'update') {
        check(change.values); check(change.key)
        const sets = Object.entries(change.values).map(([k, v]) => `${q(k)} = ${conn.literal(v)}`)
        if (sets.length === 0) continue
        statements.push(`UPDATE ${target} SET ${sets.join(', ')} WHERE ${keyClause(change.key)}`)
      } else if (change.kind === 'insert') {
        check(change.values)
        const entries = Object.entries(change.values).filter(([, v]) => v !== undefined)
        statements.push(entries.length === 0
          ? conn.insertDefaults(target)
          : `INSERT INTO ${target} (${entries.map(([k]) => q(k)).join(', ')}) VALUES (${entries.map(([, v]) => conn.literal(v)).join(', ')})`)
      } else {
        check(change.key)
        statements.push(`DELETE FROM ${target} WHERE ${keyClause(change.key)}`)
      }
    }
    if (!request.apply) return { statements, applied: false }
    try {
      const affected = await conn.transaction(statements.map(sql => ({ sql, params: [] })), { maxRows: 1, timeoutMs: DEFAULT_TIMEOUT_MS })
      return { statements, applied: true, affected }
    } catch (error) {
      return { statements, applied: false, error: errorText(error) }
    }
  }

  async dispose(): Promise<void> {
    clearInterval(this.sweeper)
    for (const id of [...this.conns.keys()]) await this.drop(id)
  }
}

/** CSV encoding for exports. */
export function toCsv(columns: { name: string }[], rows: unknown[][]): string {
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return ''
    const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v)
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  return [columns.map(c => cell(c.name)).join(','), ...rows.map(r => r.map(cell).join(','))].join('\r\n') + '\r\n'
}

export type { RowFilter }
