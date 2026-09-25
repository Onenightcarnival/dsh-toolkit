/**
 * Wire contract shared by the host half (routes/tools) and the browser half
 * (panel). Dependency-free: the client bundle imports it.
 */

export const RDB_API = {
  profiles: '/api/dsh-rdb/profiles',
  settings: '/api/dsh-rdb/settings',
  test: '/api/dsh-rdb/test',
  schemas: '/api/dsh-rdb/schemas',
  tables: '/api/dsh-rdb/tables',
  columns: '/api/dsh-rdb/columns',
  ddl: '/api/dsh-rdb/ddl',
  rows: '/api/dsh-rdb/rows',
  query: '/api/dsh-rdb/query',
  execute: '/api/dsh-rdb/execute',
  changes: '/api/dsh-rdb/changes',
  exportCsv: '/api/dsh-rdb/export.csv',
} as const

export type DbKind = 'sqlite' | 'postgres' | 'gaussdb' | 'mysql'

/** Quote one identifier the way `kind` expects: backticks for MySQL, double quotes elsewhere. */
export function quoteIdentifier(kind: DbKind, name: string): string {
  return kind === 'mysql' ? '`' + name.replace(/`/g, '``') + '`' : '"' + name.replace(/"/g, '""') + '"'
}

/** libpq target_session_attrs, same names and semantics. */
export type TargetSessionAttrs = 'any' | 'read-write' | 'read-only' | 'primary' | 'standby' | 'prefer-standby'
export const TARGET_SESSION_ATTRS: TargetSessionAttrs[] = ['any', 'read-write', 'read-only', 'primary', 'standby', 'prefer-standby']

/** Node entries of a profile as `host:port` strings; every node shares `port`. */
export function hostEntries(host: string, port: number): string[] {
  return host.split(/[\s,]+/).filter(h => h !== '').map(h => `${h.includes(':') && !h.startsWith('[') ? `[${h}]` : h}:${port}`)
}

/** One connection as stored on disk (password included). */
export interface DbProfile {
  id: string
  name: string
  kind: DbKind
  /** SQLite: database file path (":memory:" allowed). */
  file: string
  /** One or more hosts, comma-separated; every node listens on `port`. */
  host: string
  port: number
  database: string
  user: string
  password: string
  ssl: boolean
  /** Which node qualifies (libpq target_session_attrs). */
  targetSessionAttrs: TargetSessionAttrs
  /** Try nodes in random order instead of listed order (libpq load_balance_hosts=random). */
  loadBalanceHosts: boolean
  /** Agent tools may run writes on this connection (the panel always may). */
  allowWrite: boolean
  createdAt: number
  updatedAt: number
}

/** Secret-free projection. */
export interface DbProfileSummary {
  id: string
  name: string
  kind: DbKind
  file: string
  host: string
  port: number
  database: string
  user: string
  ssl: boolean
  targetSessionAttrs: TargetSessionAttrs
  loadBalanceHosts: boolean
  allowWrite: boolean
  createdAt: number
  updatedAt: number
}

export interface DbProfilePayload {
  name?: string
  kind?: DbKind
  file?: string
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  ssl?: boolean
  targetSessionAttrs?: TargetSessionAttrs
  loadBalanceHosts?: boolean
  allowWrite?: boolean
}

export interface RdbSettings {
  agentTools: boolean
}

export interface DbTestResult {
  ok: boolean
  latencyMs: number
  serverVersion?: string
  /** `host:port` of the node that answered. */
  node?: string
  error?: string
}

export interface TableRef {
  schema: string
  name: string
  kind: 'table' | 'view'
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  defaultValue: string | null
  primaryKey: boolean
  /** 1-based ordinal. */
  position: number
}

export interface IndexInfo {
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
}

export interface TableInfo {
  table: TableRef
  columns: ColumnInfo[]
  indexes: IndexInfo[]
  primaryKey: string[]
  /** Approximate row count when cheap to obtain. */
  estimatedRows?: number
}

export interface ResultColumn {
  name: string
  type: string
}

/** One statement's result. Rows are arrays aligned with `columns`. */
export interface QueryResult {
  columns: ResultColumn[]
  rows: unknown[][]
  /** Rows affected for writes; row count for reads. */
  rowCount: number
  truncated: boolean
  durationMs: number
  /** First keyword of the statement as classified by the engine. */
  command: string
}

export interface RowFilter {
  column: string
  op: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'like' | 'is null' | 'is not null'
  value?: string
}

export interface RowsRequest {
  schema: string
  table: string
  offset: number
  limit: number
  sort?: { column: string; desc: boolean }
  filters?: RowFilter[]
}

export interface RowsPage extends QueryResult {
  /** Exact count for the filter; undefined when counting was skipped. */
  total?: number
  primaryKey: string[]
}

/** One pending grid change; `key` maps primary-key column → value of the ORIGINAL row. */
export type RowChange =
  | { kind: 'update'; key: Record<string, unknown>; values: Record<string, unknown> }
  | { kind: 'insert'; values: Record<string, unknown> }
  | { kind: 'delete'; key: Record<string, unknown> }

export interface ChangesRequest {
  schema: string
  table: string
  changes: RowChange[]
  /** false = only render the SQL; true = run inside one transaction. */
  apply: boolean
}

export interface ChangesResult {
  statements: string[]
  applied: boolean
  affected?: number
  error?: string
}
