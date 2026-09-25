/**
 * MySQL and MariaDB through `mysql2` (pure JS). A "schema" is a database on
 * the same server; unqualified names resolve to the profile's database.
 */
import mysql from 'mysql2/promise'
import type { ColumnInfo, DbProfile, IndexInfo, QueryResult, TableRef, TargetSessionAttrs } from '../protocol.ts'
import type { DbConnection, QueryOptions } from './types.ts'
import { nodeText, parseHosts, type HostNode } from '../store.ts'
import { sessionMatches, shuffled } from './postgres.ts'

/** mysql2 column type codes → readable names. */
const TYPE_NAMES: Record<number, string> = {
  0: 'decimal', 1: 'tinyint', 2: 'smallint', 3: 'int', 4: 'float', 5: 'double', 6: 'null', 7: 'timestamp', 8: 'bigint',
  9: 'mediumint', 10: 'date', 11: 'time', 12: 'datetime', 13: 'year', 14: 'date', 15: 'varchar', 16: 'bit',
  245: 'json', 246: 'decimal', 247: 'enum', 248: 'set', 249: 'tinyblob', 250: 'mediumblob', 251: 'longblob',
  252: 'blob', 253: 'varchar', 254: 'char', 255: 'geometry',
}
const BINARY_FLAG = 128

interface FieldPacket { name: string; columnType?: number; type?: number; flags?: number }
interface ResultSetHeader { affectedRows?: number }
interface MysqlClient {
  query(sql: string, values?: unknown[]): Promise<[unknown, FieldPacket[] | undefined]>
  end(): Promise<void>
  destroy(): void
  on(event: 'error' | 'end', handler: (error?: Error) => void): void
}

function toJs(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return { $bytes: value.length }
  if (typeof value === 'bigint') return value.toString()
  return value
}

function typeName(f: FieldPacket): string {
  const code = f.columnType ?? f.type ?? -1
  const binary = ((f.flags ?? 0) & BINARY_FLAG) !== 0
  // TEXT columns arrive as BLOB codes with a non-binary charset; BINARY/VARBINARY as CHAR/VARCHAR codes with the binary flag
  if (code === 252 && !binary) return 'text'
  if ((code === 253 || code === 254) && binary) return code === 253 ? 'varbinary' : 'binary'
  return TYPE_NAMES[code] ?? `type:${code}`
}

export class MysqlConnection implements DbConnection {
  readonly defaultSchema: string
  private client!: MysqlClient
  private readonly profile: DbProfile
  node = ''
  alive = false

  constructor(profile: DbProfile) {
    this.profile = profile
    this.defaultSchema = profile.database
  }

  private open(node: HostNode): Promise<MysqlClient> {
    return mysql.createConnection({
      host: node.host,
      port: node.port,
      database: this.profile.database || undefined,
      user: this.profile.user,
      password: this.profile.password,
      ssl: this.profile.ssl ? { rejectUnauthorized: false } : undefined,
      connectTimeout: 15000,
      rowsAsArray: true,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      multipleStatements: false,
    }) as unknown as Promise<MysqlClient>
  }

  /**
   * Node role for target_session_attrs: a replica (SHOW REPLICA STATUS has a
   * row; SHOW SLAVE STATUS on older servers) counts as "in recovery"; a
   * read_only / super_read_only (MySQL only) server counts as read-only.
   * Without the REPLICATION CLIENT privilege the replica check is skipped
   * and read_only decides both.
   */
  private async sessionState(client: MysqlClient): Promise<{ inRecovery: boolean; readOnly: boolean }> {
    const flag = async (name: string): Promise<boolean> => {
      try {
        const [rows] = await client.query(`SELECT @@global.${name}`) as [unknown[][], unknown]
        return Number(rows[0]?.[0] ?? 0) === 1
      } catch { return false } // MariaDB has no super_read_only
    }
    const readOnly = (await flag('read_only')) || (await flag('super_read_only'))
    let inRecovery = readOnly
    for (const sql of ['SHOW REPLICA STATUS', 'SHOW SLAVE STATUS']) {
      try {
        const [rows] = await client.query(sql) as [unknown[][], unknown]
        inRecovery = rows.length > 0
        break
      } catch { /* unsupported statement or missing privilege: try the next form */ }
    }
    return { inRecovery, readOnly }
  }

  async connect(): Promise<void> {
    const nodes = parseHosts(this.profile.host, this.profile.port)
    const ordered = this.profile.loadBalanceHosts ? shuffled(nodes) : nodes
    const passes: Exclude<TargetSessionAttrs, 'prefer-standby'>[] = this.profile.targetSessionAttrs === 'prefer-standby' ? ['standby', 'any'] : [this.profile.targetSessionAttrs]
    const failures: string[] = []
    for (const want of passes) {
      for (const node of ordered) {
        const label = nodeText(node)
        let client: MysqlClient
        try {
          client = await this.open(node)
        } catch (error) {
          failures.push(`${label}: ${(error as Error).message}`)
          continue
        }
        client.on('error', () => { this.alive = false })
        client.on('end', () => { this.alive = false })
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

  quoteIdent(name: string): string { return '`' + name.replace(/`/g, '``') + '`' }
  placeholder(): string { return '?' }
  castToText(expr: string): string { return `CAST(${expr} AS CHAR)` }
  insertDefaults(target: string): string { return `INSERT INTO ${target} () VALUES ()` }
  /** MySQL strings take backslash escapes; mysql2's escaper doubles both quotes and backslashes. */
  literal(value: unknown): string {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'number' || typeof value === 'bigint') return String(value)
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
    return mysql.escape(typeof value === 'string' ? value : JSON.stringify(value))
  }

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
    // max_execution_time (MySQL 5.7.8+, milliseconds, SELECT only) and
    // max_statement_time (MariaDB, seconds); whichever the server knows.
    if (options.timeoutMs > 0) {
      const ms = Math.floor(options.timeoutMs)
      await this.client.query(`SET SESSION max_execution_time = ${ms}`).catch(() => this.client.query(`SET SESSION max_statement_time = ${(ms / 1000).toFixed(3)}`).catch(() => undefined))
    }
    try {
      const [result, fields] = await this.client.query(sql, params)
      const command = (sql.replace(/^(?:\s|--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)*/, '').match(/^([a-z]+)/i)?.[1] ?? 'SQL').toUpperCase()
      if (fields === undefined || !Array.isArray(result)) {
        const header = (result ?? {}) as ResultSetHeader
        return { columns: [], rows: [], rowCount: header.affectedRows ?? 0, truncated: false, durationMs: Date.now() - started, command }
      }
      const all = result as unknown[][]
      const truncated = all.length > options.maxRows
      const rows = truncated ? all.slice(0, options.maxRows) : all
      return {
        columns: fields.map(f => ({ name: f.name, type: typeName(f) })),
        rows: rows.map(r => r.map(toJs)),
        rowCount: rows.length,
        truncated,
        durationMs: Date.now() - started,
        command,
      }
    } finally {
      if (options.timeoutMs > 0) await this.client.query('SET SESSION max_execution_time = DEFAULT').catch(() => this.client.query('SET SESSION max_statement_time = DEFAULT').catch(() => undefined))
    }
  }

  transaction(statements: { sql: string; params: unknown[] }[], options: QueryOptions): Promise<number> {
    return this.locked(() => this.runTransaction(statements, options))
  }

  private async runTransaction(statements: { sql: string; params: unknown[] }[], options: QueryOptions): Promise<number> {
    await this.client.query('START TRANSACTION')
    let affected = 0
    try {
      for (const s of statements) affected += (await this.runOne(s.sql, s.params, options)).rowCount
      await this.client.query('COMMIT')
    } catch (error) {
      await this.client.query('ROLLBACK').catch(() => undefined)
      throw error
    }
    return affected
  }

  /** Rows as objects (catalog queries). */
  private async rows(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const [result, fields] = await this.client.query(sql, params)
    if (fields === undefined || !Array.isArray(result)) return []
    return (result as unknown[][]).map(r => Object.fromEntries(fields.map((f, i) => [f.name, r[i]])))
  }

  async listSchemas(): Promise<string[]> {
    const rows = await this.rows(`SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys') ORDER BY (SCHEMA_NAME <> ?), SCHEMA_NAME`, [this.defaultSchema])
    return rows.map(r => String(r.name))
  }

  async listTables(schema: string): Promise<TableRef[]> {
    const rows = await this.rows(`SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY (TABLE_TYPE <> 'BASE TABLE'), TABLE_NAME`, [schema])
    return rows.map(r => ({ schema, name: String(r.name), kind: /view/i.test(String(r.type)) ? 'view' : 'table' }))
  }

  async columns(table: TableRef): Promise<ColumnInfo[]> {
    const rows = await this.rows(`
      SELECT ORDINAL_POSITION AS position, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
             COLUMN_DEFAULT AS default_value, COLUMN_KEY AS col_key, EXTRA AS extra
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [table.schema, table.name])
    return rows.map(r => ({
      name: String(r.name),
      type: String(r.type) + (/auto_increment/i.test(String(r.extra ?? '')) ? ' AUTO_INCREMENT' : ''),
      nullable: String(r.nullable).toUpperCase() === 'YES',
      // MariaDB reports a missing default as the text 'NULL'
      defaultValue: r.default_value === null || r.default_value === undefined || (String(r.default_value).toUpperCase() === 'NULL' && String(r.nullable).toUpperCase() === 'YES') ? null : String(r.default_value),
      primaryKey: String(r.col_key) === 'PRI',
      position: Number(r.position),
    }))
  }

  async indexes(table: TableRef): Promise<IndexInfo[]> {
    const rows = await this.rows(`
      SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq, COLUMN_NAME AS col
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY (INDEX_NAME <> 'PRIMARY'), INDEX_NAME, SEQ_IN_INDEX`, [table.schema, table.name])
    const byName = new Map<string, IndexInfo>()
    for (const r of rows) {
      const name = String(r.name)
      const idx = byName.get(name) ?? { name, columns: [], unique: Number(r.non_unique) === 0, primary: name === 'PRIMARY' }
      idx.columns.push(String(r.col ?? `expr#${r.seq}`))
      byName.set(name, idx)
    }
    return [...byName.values()]
  }

  async ddl(table: TableRef): Promise<string> {
    const rows = await this.rows(`SHOW CREATE ${table.kind === 'view' ? 'VIEW' : 'TABLE'} ${this.quoteIdent(table.schema)}.${this.quoteIdent(table.name)}`)
    const row = rows[0] ?? {}
    const text = row['Create Table'] ?? row['Create View'] ?? Object.values(row)[1]
    return text === undefined ? '' : String(text) + ';'
  }

  async estimatedRows(table: TableRef): Promise<number | undefined> {
    try {
      const rows = await this.rows(`SELECT TABLE_ROWS AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [table.schema, table.name])
      const n = rows[0]?.n
      return n === null || n === undefined ? undefined : Number(n)
    } catch { return undefined }
  }

  async serverVersion(): Promise<string> {
    const rows = await this.rows('SELECT VERSION() AS v')
    const v = String(rows[0]?.v ?? '')
    return (/mariadb/i.test(v) ? 'MariaDB ' : 'MySQL ') + v.slice(0, 60)
  }

  async close(): Promise<void> {
    this.alive = false
    if (this.client !== undefined) await this.client.end().catch(() => this.client.destroy())
  }
}
