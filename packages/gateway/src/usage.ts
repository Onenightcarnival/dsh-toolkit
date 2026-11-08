/** Per-request usage ledger in `node:sqlite` with range aggregates by model and key. */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { DETAIL_LIMIT } from './protocol.ts'
import type { ModelPrice, UsageFacets, UsageFilter, UsageGroup, UsageRange, UsageRecordView, UsageSummary, UsageTotals } from './protocol.ts'

interface Statement { get(...params: unknown[]): Record<string, unknown> | undefined; all(...params: unknown[]): Record<string, unknown>[]; run(...params: unknown[]): unknown }
interface Database { exec(sql: string): void; prepare(sql: string): Statement; close(): void }

/** `node:sqlite` is built into the host's Node; no native add-on is involved. */
function openDatabase(path: string): Database {
  const require = createRequire(import.meta.url)
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => Database }
  return new DatabaseSync(path)
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  time INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  key_name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  model_id TEXT NOT NULL,
  stream INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  ttft_ms INTEGER,
  duration_ms INTEGER NOT NULL,
  status INTEGER NOT NULL,
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS requests_time ON requests (time);
`

/** One finished gateway request. */
export interface UsageRecord {
  time: number
  keyId: string
  keyName: string
  protocol: 'chat' | 'responses' | 'messages'
  provider: string
  model: string
  modelId: string
  stream: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  ttftMs: number | null
  durationMs: number
  status: number
  errorCode: string | null
}

export { DETAIL_LIMIT }
/** Rows older than this are deleted on each insert. */
export const RETENTION_MS = 400 * 24 * 60 * 60_000

/** Start of a range relative to `now` (local midnight for `today`). */
export function rangeStart(range: UsageRange, now: number = Date.now()): number {
  if (range === 'today') {
    const date = new Date(now)
    date.setHours(0, 0, 0, 0)
    return date.getTime()
  }
  return now - (range === '7d' ? 7 : 30) * 24 * 60 * 60_000
}

export function isUsageRange(value: unknown): value is UsageRange {
  return value === 'today' || value === '7d' || value === '30d'
}

/** Filter from query parameters; empty and unknown values are ignored. */
export function parseUsageFilter(params: URLSearchParams): UsageFilter {
  const filter: UsageFilter = {}
  const text = (name: string): string | undefined => {
    const value = params.get(name)?.trim()
    return value === undefined || value === '' || value.length > 253 ? undefined : value
  }
  const keyId = text('key')
  const modelId = text('model')
  const protocol = text('protocol')
  const outcome = params.get('outcome')
  if (keyId !== undefined) filter.keyId = keyId
  if (modelId !== undefined) filter.modelId = modelId
  if (protocol === 'chat' || protocol === 'responses' || protocol === 'messages') filter.protocol = protocol
  if (outcome === 'ok' || outcome === 'error') filter.outcome = outcome
  return filter
}

function matches(row: Record<string, unknown>, filter: UsageFilter): boolean {
  if (filter.keyId !== undefined && String(row.key_id) !== filter.keyId) return false
  if (filter.modelId !== undefined && String(row.model_id) !== filter.modelId) return false
  if (filter.protocol !== undefined && String(row.protocol) !== filter.protocol) return false
  if (filter.outcome === 'ok' && Number(row.status) >= 400) return false
  if (filter.outcome === 'error' && Number(row.status) < 400) return false
  return true
}

function facetsOf(rows: Record<string, unknown>[]): UsageFacets {
  const keys = new Map<string, string>()
  const models = new Set<string>()
  const protocols = new Set<string>()
  for (const row of rows) {
    if (!keys.has(String(row.key_id))) keys.set(String(row.key_id), String(row.key_name))
    models.add(String(row.model_id))
    protocols.add(String(row.protocol))
  }
  return {
    keys: [...keys].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    models: [...models].sort(),
    protocols: [...protocols].sort(),
  }
}

function cost(price: ModelPrice | undefined, inputTokens: number, outputTokens: number): number | null {
  if (price === undefined) return null
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000
}

function groupRows(rows: Record<string, unknown>[], keyField: string, labelField: string, pricing: Record<string, ModelPrice>): UsageGroup[] {
  const groups = new Map<string, UsageGroup>()
  for (const row of rows) {
    const key = String(row[keyField])
    const group = groups.get(key) ?? { key, label: String(row[labelField]), requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, cost: null }
    addRow(group, row, pricing)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => b.requests - a.requests)
}

function addRow(totals: UsageTotals, row: Record<string, unknown>, pricing: Record<string, ModelPrice>): void {
  const input = Number(row.input_tokens)
  const output = Number(row.output_tokens)
  totals.requests += 1
  if (Number(row.status) >= 400) totals.errors += 1
  totals.inputTokens += input
  totals.outputTokens += output
  totals.cacheReadTokens += Number(row.cache_read_tokens)
  totals.reasoningTokens += Number(row.reasoning_tokens)
  const rowCost = cost(pricing[String(row.model_id)], input, output)
  if (rowCost !== null) totals.cost = (totals.cost ?? 0) + rowCost
}

/** SQLite-backed ledger bound to one file; opened on first use. */
export class UsageStore {
  private db?: Database
  constructor(readonly path: string) {}

  close(): void { this.db?.close(); this.db = undefined }

  private open(): Database {
    if (this.db) return this.db
    mkdirSync(dirname(this.path), { recursive: true })
    const db = openDatabase(this.path)
    try {
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;')
      db.exec(SCHEMA)
      this.db = db
      return db
    } catch (error) { db.close(); throw error }
  }

  record(entry: UsageRecord): void {
    const db = this.open()
    db.prepare(`INSERT INTO requests (time, key_id, key_name, protocol, provider, model, model_id, stream, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, ttft_ms, duration_ms, status, error_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      entry.time, entry.keyId, entry.keyName, entry.protocol, entry.provider, entry.model, entry.modelId, entry.stream ? 1 : 0,
      entry.inputTokens, entry.outputTokens, entry.cacheReadTokens, entry.cacheWriteTokens, entry.reasoningTokens,
      entry.ttftMs, entry.durationMs, entry.status, entry.errorCode,
    )
    db.prepare('DELETE FROM requests WHERE time < ?').run(entry.time - RETENTION_MS)
  }

  /**
   * Aggregates and detail rows of a range. Facets describe the whole range;
   * totals, groups and rows describe the filtered part.
   */
  summary(range: UsageRange, pricing: Record<string, ModelPrice>, filter: UsageFilter = {}, now: number = Date.now()): UsageSummary {
    const db = this.open()
    const since = rangeStart(range, now)
    const all = db.prepare('SELECT * FROM requests WHERE time >= ? ORDER BY time DESC').all(since)
    const rows = all.filter(row => matches(row, filter))
    const totals: UsageTotals = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, cost: null }
    for (const row of rows) addRow(totals, row, pricing)
    const detail: UsageRecordView[] = rows.slice(0, DETAIL_LIMIT).map(row => ({
      time: Number(row.time),
      keyId: String(row.key_id),
      keyName: String(row.key_name),
      protocol: String(row.protocol),
      provider: String(row.provider),
      model: String(row.model),
      modelId: String(row.model_id),
      stream: Number(row.stream) === 1,
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      reasoningTokens: Number(row.reasoning_tokens),
      ttftMs: row.ttft_ms === null ? null : Number(row.ttft_ms),
      durationMs: Number(row.duration_ms),
      status: Number(row.status),
      errorCode: row.error_code === null ? null : String(row.error_code),
    }))
    return {
      range,
      since,
      filter,
      facets: facetsOf(all),
      totals,
      byModel: groupRows(rows, 'model_id', 'model_id', pricing),
      byKey: groupRows(rows, 'key_id', 'key_name', pricing),
      rows: detail,
      matched: rows.length,
    }
  }
}
