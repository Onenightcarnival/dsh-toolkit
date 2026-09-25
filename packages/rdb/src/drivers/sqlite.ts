/**
 * SQLite through Node's built-in `node:sqlite` (Node 22.5+). No native
 * add-on: dsh under the desktop shell runs on Electron's Node, whose ABI
 * rejects prebuilt binaries built for plain Node.
 */
import { createRequire } from 'node:module'
import type { ColumnInfo, IndexInfo, QueryResult, TableRef } from '../protocol.ts'
import type { DbConnection, QueryOptions } from './types.ts'
import { sqlLiteral } from './literal.ts'

interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[]
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  columns?(): { name: string; type: string | null }[]
  readonly sourceSQL?: string
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement
  exec(sql: string): void
  close(): void
}

function loadSqlite(): new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase {
  const require = createRequire(import.meta.url)
  const mod = require('node:sqlite') as { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase }
  return mod.DatabaseSync
}

function toJs(value: unknown): unknown {
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  if (value instanceof Uint8Array) return { $bytes: value.length }
  return value
}

const READ_RE = /^\s*(select|with|explain|pragma|values)\b/i

export class SqliteConnection implements DbConnection {
  readonly defaultSchema = 'main'
  private readonly db: SqliteDatabase

  constructor(file: string) {
    const DatabaseSync = loadSqlite()
    this.db = new DatabaseSync(file)
  }

  quoteIdent(name: string): string { return '"' + name.replace(/"/g, '""') + '"' }
  placeholder(): string { return '?' }
  castToText(expr: string): string { return `CAST(${expr} AS TEXT)` }
  insertDefaults(target: string): string { return `INSERT INTO ${target} DEFAULT VALUES` }
  literal(value: unknown): string { return sqlLiteral(value) }

  async query(sql: string, params: unknown[], options: QueryOptions): Promise<QueryResult> {
    const started = Date.now()
    const command = (sql.match(/^\s*([a-z]+)/i)?.[1] ?? 'SQL').toUpperCase()
    const stmt = this.db.prepare(sql)
    if (READ_RE.test(sql)) {
      const all = stmt.all(...params)
      const truncated = all.length > options.maxRows
      const rows = truncated ? all.slice(0, options.maxRows) : all
      const names = rows.length > 0 ? Object.keys(rows[0]) : (stmt.columns?.().map(c => c.name) ?? [])
      const types = stmt.columns?.() ?? []
      return {
        columns: names.map(name => ({ name, type: types.find(c => c.name === name)?.type ?? '' })),
        rows: rows.map(r => names.map(n => toJs(r[n]))),
        rowCount: rows.length,
        truncated,
        durationMs: Date.now() - started,
        command,
      }
    }
    const out = stmt.run(...params)
    return { columns: [], rows: [], rowCount: Number(out.changes), truncated: false, durationMs: Date.now() - started, command }
  }

  async transaction(statements: { sql: string; params: unknown[] }[], options: QueryOptions): Promise<number> {
    this.db.exec('BEGIN')
    let affected = 0
    try {
      for (const s of statements) affected += (await this.query(s.sql, s.params, options)).rowCount
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw error
    }
    return affected
  }

  async listSchemas(): Promise<string[]> {
    const rows = this.db.prepare('PRAGMA database_list').all()
    return rows.map(r => String(r.name))
  }

  async listTables(schema: string): Promise<TableRef[]> {
    const rows = this.db.prepare(`SELECT name, type FROM ${this.quoteIdent(schema)}.sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name`).all()
    return rows.map(r => ({ schema, name: String(r.name), kind: r.type === 'view' ? 'view' : 'table' }))
  }

  async columns(table: TableRef): Promise<ColumnInfo[]> {
    const rows = this.db.prepare(`PRAGMA ${this.quoteIdent(table.schema)}.table_info(${this.quoteIdent(table.name)})`).all()
    return rows.map(r => ({
      name: String(r.name),
      type: String(r.type ?? ''),
      nullable: Number(r.notnull) === 0,
      defaultValue: r.dflt_value === null || r.dflt_value === undefined ? null : String(r.dflt_value),
      primaryKey: Number(r.pk) > 0,
      position: Number(r.cid) + 1,
    }))
  }

  async indexes(table: TableRef): Promise<IndexInfo[]> {
    const list = this.db.prepare(`PRAGMA ${this.quoteIdent(table.schema)}.index_list(${this.quoteIdent(table.name)})`).all()
    const out: IndexInfo[] = []
    for (const idx of list) {
      const cols = this.db.prepare(`PRAGMA ${this.quoteIdent(table.schema)}.index_info(${this.quoteIdent(String(idx.name))})`).all()
      out.push({ name: String(idx.name), columns: cols.map(c => String(c.name)), unique: Number(idx.unique) === 1, primary: idx.origin === 'pk' })
    }
    return out
  }

  async ddl(table: TableRef): Promise<string> {
    const row = this.db.prepare(`SELECT sql FROM ${this.quoteIdent(table.schema)}.sqlite_master WHERE name = ?`).all(table.name)[0]
    const idx = this.db.prepare(`SELECT sql FROM ${this.quoteIdent(table.schema)}.sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`).all(table.name)
    return [row?.sql ? String(row.sql) + ';' : '', ...idx.map(i => String(i.sql) + ';')].filter(Boolean).join('\n')
  }

  async estimatedRows(table: TableRef): Promise<number | undefined> {
    try {
      const row = this.db.prepare(`SELECT count(*) AS n FROM ${this.quoteIdent(table.schema)}.${this.quoteIdent(table.name)}`).all()[0]
      return Number(row?.n ?? 0)
    } catch { return undefined }
  }

  async serverVersion(): Promise<string> {
    const row = this.db.prepare('SELECT sqlite_version() AS v').all()[0]
    return `SQLite ${String(row?.v ?? '')}`
  }

  async close(): Promise<void> { this.db.close() }
}
