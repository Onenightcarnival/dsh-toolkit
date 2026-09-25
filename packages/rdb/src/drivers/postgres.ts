/**
 * PostgreSQL and GaussDB. Both use the node-postgres API shape: `pg` for
 * PostgreSQL, Huawei's pure-JS `gaussdb-node` (SHA256/MD5_SHA256 auth,
 * openGauss protocol details) for GaussDB. One implementation, two clients.
 */
import pgModule from 'pg'
import gaussModule from 'gaussdb-node'
import type { ColumnInfo, DbKind, DbProfile, IndexInfo, QueryResult, TableRef, TargetSessionAttrs } from '../protocol.ts'
import type { DbConnection, QueryOptions } from './types.ts'
import { nodeText, parseHosts, type HostNode } from '../store.ts'
import { sqlLiteral } from './literal.ts'

interface PgLikeResult {
  rows: unknown[][]
  rowCount: number | null
  command: string
  fields: { name: string; dataTypeID: number }[]
}
interface PgLikeClient {
  connect(): Promise<void>
  query(config: { text: string; values?: unknown[]; rowMode?: 'array' }): Promise<PgLikeResult>
  end(): Promise<void>
  on(event: 'error' | 'end', handler: (error?: Error) => void): void
}
interface PgLikeModule {
  Client: new (config: Record<string, unknown>) => PgLikeClient
  types?: { setTypeParser(oid: number, parser: (value: string) => unknown): void }
}

/** Common OID → readable type names (both servers share the PostgreSQL catalog OIDs). */
const TYPE_NAMES: Record<number, string> = {
  16: 'bool', 17: 'bytea', 18: 'char', 19: 'name', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 26: 'oid',
  114: 'json', 142: 'xml', 700: 'float4', 701: 'float8', 790: 'money', 1042: 'bpchar', 1043: 'varchar',
  1082: 'date', 1083: 'time', 1114: 'timestamp', 1184: 'timestamptz', 1186: 'interval', 1266: 'timetz',
  1700: 'numeric', 2950: 'uuid', 3802: 'jsonb', 1007: 'int4[]', 1009: 'text[]', 1015: 'varchar[]',
}

function toJs(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return { $bytes: value.length }
  if (typeof value === 'bigint') return value.toString()
  return value
}

/** What one node reports about itself, for target_session_attrs matching. */
interface SessionState { inRecovery: boolean; readOnly: boolean }

/** libpq's acceptance rule per target_session_attrs value ('prefer-standby' is handled as two passes). */
export function sessionMatches(want: Exclude<TargetSessionAttrs, 'prefer-standby'>, state: SessionState): boolean {
  switch (want) {
    case 'any': return true
    case 'read-write': return !state.inRecovery && !state.readOnly
    case 'read-only': return state.inRecovery || state.readOnly
    case 'primary': return !state.inRecovery
    case 'standby': return state.inRecovery
  }
}

/** Fisher-Yates shuffle (libpq load_balance_hosts=random). */
export function shuffled<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export class PgConnection implements DbConnection {
  readonly defaultSchema = 'public'
  private client!: PgLikeClient
  private readonly kind: DbKind
  private readonly profile: DbProfile
  /** `host:port` of the node in use; set by connect(). */
  node = ''
  /** Cleared when the socket errors or ends; the engine then reconnects (possibly to another node). */
  alive = false

  constructor(profile: DbProfile) {
    this.kind = profile.kind
    this.profile = profile
  }

  private open(node: HostNode): PgLikeClient {
    const mod = (this.kind === 'gaussdb' ? gaussModule : pgModule) as unknown as PgLikeModule
    return new mod.Client({
      host: node.host,
      port: node.port,
      database: this.profile.database,
      user: this.profile.user,
      password: this.profile.password,
      ssl: this.profile.ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 15000,
      application_name: 'dsh-rdb',
    })
  }

  private async sessionState(client: PgLikeClient): Promise<SessionState> {
    const res = await client.query({ text: 'SELECT pg_is_in_recovery() AS in_recovery, current_setting(\'transaction_read_only\') AS read_only', rowMode: 'array' })
    const row = res.rows[0] ?? []
    return { inRecovery: row[0] === true || row[0] === 't', readOnly: String(row[1]).toLowerCase() === 'on' }
  }

  /**
   * Node selection with libpq semantics: hosts are tried in listed (or random)
   * order; a node is kept only if its session state satisfies
   * target_session_attrs, otherwise it is closed and the next one is tried.
   * 'prefer-standby' first looks for a standby across all nodes, then accepts any.
   */
  async connect(): Promise<void> {
    const nodes = parseHosts(this.profile.host, this.profile.port)
    const ordered = this.profile.loadBalanceHosts ? shuffled(nodes) : nodes
    const passes: Exclude<TargetSessionAttrs, 'prefer-standby'>[] = this.profile.targetSessionAttrs === 'prefer-standby' ? ['standby', 'any'] : [this.profile.targetSessionAttrs]
    const failures: string[] = []
    for (const want of passes) {
      for (const node of ordered) {
        const label = nodeText(node)
        const client = this.open(node)
        client.on('error', () => { this.alive = false })
        client.on('end', () => { this.alive = false })
        try {
          await client.connect()
        } catch (error) {
          failures.push(`${label}: ${(error as Error).message}`)
          continue
        }
        try {
          if (want === 'any' || sessionMatches(want, await this.sessionState(client))) {
            this.client = client
            this.node = label
            this.alive = true
            return
          }
          failures.push(`${label}: session does not satisfy '${want}'`)
        } catch (error) {
          failures.push(`${label}: ${(error as Error).message}`)
        }
        await client.end().catch(() => undefined)
      }
    }
    throw new Error(`no node accepted the connection (target ${this.profile.targetSessionAttrs}): ${failures.join('; ')}`)
  }

  quoteIdent(name: string): string { return '"' + name.replace(/"/g, '""') + '"' }
  placeholder(index: number): string { return `$${index + 1}` }
  castToText(expr: string): string { return `CAST(${expr} AS TEXT)` }
  insertDefaults(target: string): string { return `INSERT INTO ${target} DEFAULT VALUES` }
  literal(value: unknown): string { return sqlLiteral(value) }

  /** Statements from concurrent GUI requests run one at a time so the timeout SET/RESET pair stays scoped. */
  private chain: Promise<unknown> = Promise.resolve()
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => undefined)
    return next
  }

  query(sql: string, params: unknown[], options: QueryOptions): Promise<QueryResult> {
    return this.locked(() => this.runOne(sql, params, options))
  }

  private async runOne(sql: string, params: unknown[], options: QueryOptions): Promise<QueryResult> {
    const started = Date.now()
    // statement_timeout scopes the cap to this session; SET LOCAL needs a
    // transaction, so a plain SET is applied and reset around the statement.
    if (options.timeoutMs > 0) await this.client.query({ text: `SET statement_timeout = ${Math.floor(options.timeoutMs)}` }).catch(() => undefined)
    try {
      const res = await this.client.query({ text: sql, values: params, rowMode: 'array' })
      const truncated = res.rows.length > options.maxRows
      const rows = truncated ? res.rows.slice(0, options.maxRows) : res.rows
      return {
        columns: (res.fields ?? []).map(f => ({ name: f.name, type: TYPE_NAMES[f.dataTypeID] ?? `oid:${f.dataTypeID}` })),
        rows: rows.map(r => r.map(toJs)),
        rowCount: res.fields && res.fields.length > 0 ? rows.length : (res.rowCount ?? 0),
        truncated,
        durationMs: Date.now() - started,
        command: res.command || (sql.match(/^\s*([a-z]+)/i)?.[1] ?? 'SQL').toUpperCase(),
      }
    } finally {
      if (options.timeoutMs > 0) await this.client.query({ text: 'SET statement_timeout = DEFAULT' }).catch(() => undefined)
    }
  }

  transaction(statements: { sql: string; params: unknown[] }[], options: QueryOptions): Promise<number> {
    return this.locked(() => this.runTransaction(statements, options))
  }

  private async runTransaction(statements: { sql: string; params: unknown[] }[], options: QueryOptions): Promise<number> {
    await this.client.query({ text: 'BEGIN' })
    let affected = 0
    try {
      for (const s of statements) affected += (await this.runOne(s.sql, s.params, options)).rowCount
      await this.client.query({ text: 'COMMIT' })
    } catch (error) {
      await this.client.query({ text: 'ROLLBACK' }).catch(() => undefined)
      throw error
    }
    return affected
  }

  private async rows(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const res = await this.client.query({ text: sql, values: params }) as unknown as { rows: Record<string, unknown>[] }
    return res.rows
  }

  async listSchemas(): Promise<string[]> {
    const rows = await this.rows(`SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND nspname NOT LIKE 'pg_temp%' AND nspname NOT LIKE 'pg_toast%' ORDER BY (nspname <> 'public'), nspname`)
    return rows.map(r => String(r.nspname))
  }

  async listTables(schema: string): Promise<TableRef[]> {
    const rows = await this.rows(`SELECT c.relname AS name, c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') ORDER BY (c.relkind IN ('v','m')), c.relname`, [schema])
    return rows.map(r => ({ schema, name: String(r.name), kind: r.kind === 'v' || r.kind === 'm' ? 'view' : 'table' }))
  }

  async columns(table: TableRef): Promise<ColumnInfo[]> {
    const rows = await this.rows(`
      SELECT a.attnum AS position, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
             pg_get_expr(d.adbin, d.adrelid) AS default_value,
             EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS primary_key
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`, [table.schema, table.name])
    return rows.map(r => ({
      name: String(r.name), type: String(r.type), nullable: r.nullable === true,
      defaultValue: r.default_value === null || r.default_value === undefined ? null : String(r.default_value),
      primaryKey: r.primary_key === true, position: Number(r.position),
    }))
  }

  async indexes(table: TableRef): Promise<IndexInfo[]> {
    // indkey is read as text ("1 3") and mapped through pg_attribute in JS:
    // portable across PostgreSQL and GaussDB without array-type parsing or
    // WITH ORDINALITY.
    const rows = await this.rows(`
      SELECT ic.relname AS name, i.indisunique AS "unique", i.indisprimary AS "primary", i.indkey::text AS keys
      FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 ORDER BY i.indisprimary DESC, ic.relname`, [table.schema, table.name])
    const attrs = await this.rows(`
      SELECT a.attnum, a.attname::text AS name FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped`, [table.schema, table.name])
    const byNum = new Map(attrs.map(a => [Number(a.attnum), String(a.name)]))
    return rows.map(r => ({
      name: String(r.name),
      columns: String(r.keys ?? '').split(/\s+/).filter(Boolean).map(k => byNum.get(Number(k)) ?? `expr#${k}`),
      unique: r.unique === true,
      primary: r.primary === true,
    }))
  }

  async ddl(table: TableRef): Promise<string> {
    const q = (s: string) => this.quoteIdent(s)
    if (table.kind === 'view') {
      const rows = await this.rows(`SELECT pg_get_viewdef(($1 || '.' || $2)::regclass, true) AS def`, [q(table.schema), q(table.name)])
      return `CREATE OR REPLACE VIEW ${q(table.schema)}.${q(table.name)} AS\n${String(rows[0]?.def ?? '')}`
    }
    const cols = await this.columns(table)
    const idx = await this.indexes(table)
    const lines = cols.map(c => `  ${q(c.name)} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.defaultValue !== null ? ` DEFAULT ${c.defaultValue}` : ''}`)
    const pk = idx.find(i => i.primary)
    if (pk !== undefined) lines.push(`  PRIMARY KEY (${pk.columns.map(q).join(', ')})`)
    const body = `CREATE TABLE ${q(table.schema)}.${q(table.name)} (\n${lines.join(',\n')}\n);`
    const indexDefs = await this.rows(`SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname NOT IN (SELECT ic.relname FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid WHERE i.indisprimary)`, [table.schema, table.name])
    return [body, ...indexDefs.map(r => String(r.indexdef) + ';')].join('\n')
  }

  async estimatedRows(table: TableRef): Promise<number | undefined> {
    try {
      const rows = await this.rows(`SELECT c.reltuples::bigint AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`, [table.schema, table.name])
      const n = Number(rows[0]?.n ?? -1)
      return n >= 0 ? n : undefined
    } catch { return undefined }
  }

  async serverVersion(): Promise<string> {
    const rows = await this.rows('SELECT version() AS v')
    const v = String(rows[0]?.v ?? '')
    return this.kind === 'gaussdb' ? v.slice(0, 80) : (v.match(/^PostgreSQL [^ ]+/)?.[0] ?? v.slice(0, 80))
  }

  async close(): Promise<void> {
    this.alive = false
    if (this.client !== undefined) await this.client.end().catch(() => undefined)
  }
}
