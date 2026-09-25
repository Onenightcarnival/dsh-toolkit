/**
 * Agent tools (db_*), registered only while the panel switch is on. Writes
 * additionally require the connection's "allow write" flag and confirm=true.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { errorText, type RdbEngine } from './engine.ts'
import { hostEntries, type DbProfileSummary, type QueryResult, type TableInfo, type TableRef } from './protocol.ts'

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
import type { ProfileStore } from './store.ts'

function text(value: string): ContentBlock[] { return [{ type: 'text', text: value }] }

const CONN_PARAM = { type: 'string', required: true, description: 'Connection name (or id) from db_connections.' } as const
const TOOL_MAX_ROWS = 500

/** Fixed-width text table for model-facing renders. */
export function renderTable(result: QueryResult): string {
  if (result.columns.length === 0) return `${result.command}: ${result.rowCount} row(s) affected (${result.durationMs} ms)`
  const cell = (v: unknown): string => v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  const rows = result.rows.map(r => r.map(cell).map(s => s.length > 80 ? s.slice(0, 77) + '…' : s))
  const widths = result.columns.map((c, i) => Math.max(c.name.length, ...rows.map(r => r[i]?.length ?? 0)))
  const line = (cells: string[]) => cells.map((s, i) => s.padEnd(widths[i])).join(' | ')
  const out = [line(result.columns.map(c => c.name)), widths.map(w => '-'.repeat(w)).join('-+-'), ...rows.map(line)]
  out.push(`(${result.rowCount} row(s)${result.truncated ? ', truncated — add WHERE/LIMIT' : ''}, ${result.durationMs} ms)`)
  return out.join('\n')
}

export function dbConnectionsTool(store: ProfileStore) {
  return defineTool({
    name: 'db_connections',
    description: 'List the database connections configured in the dsh database panel (name, kind, host, database, whether writes are allowed). Every other db_* tool takes one of these names. Triggers: database, SQL, table, query, PostgreSQL, MySQL, MariaDB, GaussDB, SQLite, 数据库, 查表.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          connections: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true }, name: { type: 'string', required: true }, kind: { type: 'string', required: true },
                file: { type: 'string', required: true }, host: { type: 'string', required: true }, port: { type: 'integer', required: true },
                database: { type: 'string', required: true }, user: { type: 'string', required: true }, ssl: { type: 'boolean', required: true },
                targetSessionAttrs: { type: 'string', required: true }, loadBalanceHosts: { type: 'boolean', required: true },
                allowWrite: { type: 'boolean', required: true }, createdAt: { type: 'integer', required: true }, updatedAt: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: { connections?: unknown[] }) => {
        const list = (value.connections ?? []) as DbProfileSummary[]
        if (list.length === 0) return text('no database connections configured (the user adds them in the database panel)')
        return text(['name | kind | target | writes', '--- | --- | --- | ---',
          ...list.map(c => `${c.name} | ${c.kind} | ${c.kind === 'sqlite' ? c.file : `${c.user}@${hostEntries(c.host, c.port).join(',')}/${c.database}${c.targetSessionAttrs !== 'any' ? ` (target ${c.targetSessionAttrs})` : ''}`} | ${c.allowWrite ? 'allowed' : 'read-only'}`)].join('\n'))
      },
    },
    async execute() { return { connections: store.list().map(p => store.summarize(p)) } },
  })
}

export function dbSchemaTool(engine: RdbEngine) {
  return defineTool({
    name: 'db_schema',
    description: 'Inspect structure: without `table`, list schemas and the tables/views of one schema (default schema when omitted); with `table`, return its columns (type, nullable, default, primary key), indexes and DDL. Call this before writing SQL against a table you have not seen.',
    parameters: {
      connection: CONN_PARAM,
      schema: { type: 'string', description: 'Schema name (PostgreSQL/GaussDB: default "public"; MySQL: the database, default the connection\'s database; SQLite: "main").' },
      table: { type: 'string', description: 'Table or view name to describe.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          schemas: { type: 'array', items: { type: 'string' } },
          tables: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { schema: { type: 'string', required: true }, name: { type: 'string', required: true }, kind: { type: 'string', required: true } } } },
          info: { type: 'json' },
          ddl: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, raw: { ok: boolean; schemas?: string[]; tables?: unknown[]; info?: unknown; ddl?: string; error?: string }) => {
        const value = raw as { ok: boolean; schemas?: string[]; tables?: TableRef[]; info?: TableInfo; ddl?: string; error?: string }
        if (!value.ok) return text(`schema lookup failed: ${value.error ?? 'unknown error'}`)
        if (value.info !== undefined) {
          const info = value.info
          const lines = [`${info.table.schema}.${info.table.name} (${info.table.kind}${info.estimatedRows !== undefined ? `, ~${info.estimatedRows} rows` : ''})`,
            'column | type | nullable | default | pk', '--- | --- | --- | --- | ---',
            ...info.columns.map(c => `${c.name} | ${c.type} | ${c.nullable ? 'yes' : 'no'} | ${c.defaultValue ?? ''} | ${c.primaryKey ? 'PK' : ''}`)]
          if (info.indexes.length > 0) lines.push('', 'indexes: ' + info.indexes.map(i => `${i.name}(${i.columns.join(', ')})${i.unique ? ' UNIQUE' : ''}`).join('; '))
          if (value.ddl) lines.push('', value.ddl)
          return text(lines.join('\n'))
        }
        return text([`schemas: ${(value.schemas ?? []).join(', ')}`, '', ...(value.tables ?? []).map(t => `${t.kind === 'view' ? '[view] ' : ''}${t.schema}.${t.name}`)].join('\n'))
      },
    },
    async execute(args) {
      try {
        if (args.table) {
          const info = await engine.tableInfo(args.connection, { schema: args.schema, name: args.table })
          const ddl = await engine.ddl(args.connection, { schema: args.schema, name: args.table, kind: info.table.kind }).catch(() => '')
          return { ok: true, info: JSON.parse(JSON.stringify(info)) as JsonValue, ddl }
        }
        const { schemas, defaultSchema } = await engine.schemas(args.connection)
        const tables = await engine.tables(args.connection, args.schema || defaultSchema)
        return { ok: true, schemas, tables }
      } catch (error) { return { ok: false, error: errorText(error) } }
    },
  })
}

export function dbQueryTool(engine: RdbEngine) {
  return defineTool({
    name: 'db_query',
    description: `Run ONE read-only SQL statement (SELECT / WITH / EXPLAIN / SHOW) and return the rows. Anything that writes is refused — use db_execute. Results are capped (default 200 rows, max ${TOOL_MAX_ROWS}); add WHERE/LIMIT for large tables.`,
    parameters: {
      connection: CONN_PARAM,
      sql: { type: 'string', required: true, description: 'A single read-only statement.' },
      maxRows: { type: 'integer', description: `Row cap (default 200, max ${TOOL_MAX_ROWS}).` },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          columns: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, type: { type: 'string', required: true } } } },
          rows: { type: 'array', items: { type: 'array' } },
          rowCount: { type: 'integer' }, truncated: { type: 'boolean' }, durationMs: { type: 'integer' }, command: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value: { ok: boolean; error?: string; rows?: unknown[][] }) => value.ok
        ? text(renderTable(value as unknown as QueryResult))
        : text(`query failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      try {
        const result = await engine.query(args.connection, args.sql, { allowWrite: false, maxRows: Math.min(TOOL_MAX_ROWS, args.maxRows ?? 200) })
        return { ok: true, ...result, rows: result.rows.map(r => r.map(v => (v === undefined ? null : v) as JsonValue)) }
      } catch (error) { return { ok: false, error: errorText(error) } }
    },
  })
}

export function dbExecuteTool(engine: RdbEngine) {
  return defineTool({
    name: 'db_execute',
    description: 'Run write statements (INSERT / UPDATE / DELETE / DDL) inside ONE transaction; all succeed or none apply. Only works on connections where the user enabled writes, and only with confirm=true — show the user the exact SQL and get agreement first. Prefer WHERE clauses on primary keys; check with db_query before and after.',
    parameters: {
      connection: CONN_PARAM,
      statements: { type: 'array', required: true, items: { type: 'string' }, description: 'Statements to run in order, one per entry.' },
      confirm: { type: 'boolean', required: true, description: 'Must be true; set only after the user explicitly confirmed these statements.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, affected: { type: 'integer' }, error: { type: 'string' } } },
      render: (args, value: { ok: boolean; affected?: number; error?: string }) => text(value.ok
        ? `executed ${args.statements.length} statement(s) in one transaction, ${value.affected ?? 0} row(s) affected`
        : `execute failed (rolled back): ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      if (args.confirm !== true) return { ok: false, error: 'refused: confirm must be true (ask the user first)' }
      try {
        const profile = engine.profile(args.connection)
        if (!profile.allowWrite) return { ok: false, error: `refused: connection '${profile.name}' is read-only for the agent (the user can enable writes in the database panel)` }
        const affected = await engine.transaction(args.connection, args.statements)
        return { ok: true, affected }
      } catch (error) { return { ok: false, error: errorText(error) } }
    },
  })
}

export function dbExplainTool(engine: RdbEngine) {
  return defineTool({
    name: 'db_explain',
    description: 'Show the execution plan of one SELECT (EXPLAIN; PostgreSQL/GaussDB use EXPLAIN (FORMAT TEXT), MySQL uses EXPLAIN, SQLite uses EXPLAIN QUERY PLAN). Read-only.',
    parameters: {
      connection: CONN_PARAM,
      sql: { type: 'string', required: true, description: 'The statement to explain.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, plan: { type: 'string' }, error: { type: 'string' } } },
      render: (_args, value: { ok: boolean; plan?: string; error?: string }) => text(value.ok ? (value.plan ?? '') : `explain failed: ${value.error ?? 'unknown error'}`),
    },
    async execute(args) {
      try {
        const profile = engine.profile(args.connection)
        const prefix = profile.kind === 'sqlite' ? 'EXPLAIN QUERY PLAN ' : 'EXPLAIN '
        const result = await engine.query(args.connection, prefix + args.sql.replace(/^\s*explain(\s+query\s+plan)?\s+/i, ''), { allowWrite: false, maxRows: TOOL_MAX_ROWS })
        return { ok: true, plan: result.rows.map(r => r.map(v => v === null ? '' : String(v)).join(' | ')).join('\n') }
      } catch (error) { return { ok: false, error: errorText(error) } }
    },
  })
}

export function allTools(store: ProfileStore, engine: RdbEngine) {
  return [dbConnectionsTool(store), dbSchemaTool(engine), dbQueryTool(engine), dbExplainTool(engine), dbExecuteTool(engine)]
}
