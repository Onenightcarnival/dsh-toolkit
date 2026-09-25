import type { ColumnInfo, IndexInfo, QueryResult, TableRef } from '../protocol.ts'

export interface QueryOptions {
  /** Cap on returned rows; extra rows are dropped and `truncated` set. */
  maxRows: number
  timeoutMs: number
}

/** One open connection to one database. */
export interface DbConnection {
  /** Run one statement; `params` are positional. */
  query(sql: string, params: unknown[], options: QueryOptions): Promise<QueryResult>
  /** Run several statements inside one transaction; rolls back on the first failure. */
  transaction(statements: { sql: string; params: unknown[] }[], options: QueryOptions): Promise<number>
  listSchemas(): Promise<string[]>
  listTables(schema: string): Promise<TableRef[]>
  columns(table: TableRef): Promise<ColumnInfo[]>
  indexes(table: TableRef): Promise<IndexInfo[]>
  ddl(table: TableRef): Promise<string>
  estimatedRows(table: TableRef): Promise<number | undefined>
  serverVersion(): Promise<string>
  /** Quote one identifier for this dialect. */
  quoteIdent(name: string): string
  /** Positional placeholder for parameter index (0-based). */
  placeholder(index: number): string
  /** Expression casting `expr` to a string type of this dialect (filters compare text). */
  castToText(expr: string): string
  /** INSERT of one all-defaults row into `target` (already quoted). */
  insertDefaults(target: string): string
  /** One value as a literal in this dialect (grid edits are rendered as SQL text). */
  literal(value: unknown): string
  /** Default schema for unqualified names. */
  defaultSchema: string
  /** `host:port` of the node in use (network databases only). */
  node?: string
  /** False once the underlying socket is gone; the engine reconnects on the next use. */
  alive?: boolean
  close(): Promise<void>
}
