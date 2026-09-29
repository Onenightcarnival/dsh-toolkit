import type { InferArgs, ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'

const query = {
  type: 'object', additionalProperties: false,
  properties: {
    q: { type: 'string', required: true },
    domains: { type: 'array', items: { type: 'string' } },
    recency: { type: 'integer', description: 'Filter by age in days.' },
  },
} as const
const ref = { type: 'string', required: true, description: 'Reference ID from this conversation or an HTTP(S) URL.' } as const

/** Native Codex web.run commands. */
export const codexSearchParameters = {
  search_query: { type: 'array', items: query, description: 'Web searches; at most four per call.' },
  image_query: { type: 'array', items: query, description: 'Image searches.' },
  open: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    ref_id: ref, lineno: { type: 'integer', description: 'Line to position the page at.' },
  } } },
  click: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    ref_id: ref, id: { type: 'integer', required: true, description: 'Numbered link in an opened page.' },
  } } },
  find: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    ref_id: ref, pattern: { type: 'string', required: true },
  } } },
  screenshot: { type: 'array', description: 'PDF page screenshots; availability and returned media depend on the subscription endpoint.', items: { type: 'object', additionalProperties: false, properties: {
    ref_id: ref, pageno: { type: 'integer', required: true, description: 'Zero-based PDF page number.' },
  } } },
  finance: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    ticker: { type: 'string', required: true },
    type: { type: 'string', enum: ['equity', 'fund', 'crypto', 'index'], required: true },
    market: { type: 'string', description: 'ISO 3166-1 alpha-3 country code, OTC, or empty for cryptocurrency.' },
  } } },
  weather: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    location: { type: 'string', required: true },
    start: { type: 'string', description: 'YYYY-MM-DD; defaults to today.' },
    duration: { type: 'integer', description: 'Forecast days; defaults to seven.' },
  } } },
  sports: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    fn: { type: 'string', enum: ['schedule', 'standings'], required: true },
    league: { type: 'string', enum: ['nba', 'wnba', 'nfl', 'nhl', 'mlb', 'epl', 'ncaamb', 'ncaawb', 'ipl'], required: true },
    team: { type: 'string' }, opponent: { type: 'string' },
    date_from: { type: 'string' }, date_to: { type: 'string' },
    num_games: { type: 'integer' }, locale: { type: 'string' },
    tool: { type: 'string', enum: ['sports'] },
  } } },
  time: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    utc_offset: { type: 'string', required: true, description: 'UTC offset, for example +08:00.' },
  } } },
  response_length: { type: 'string', enum: ['short', 'medium', 'long'], description: 'Response length; four search queries require medium or long.' },
} as const satisfies ParameterSchemaSpec

export type CodexSearchCommands = InferArgs<typeof codexSearchParameters>

export function validateCodexSearchCommands(commands: CodexSearchCommands): void {
  const operations = Object.entries(commands).filter(([key]) => key !== 'response_length')
  if (!operations.some(([, entries]) => Array.isArray(entries) && entries.length)) {
    throw new Error('codex_web_search: provide at least one web command')
  }
  if ((commands.search_query?.length ?? 0) > 4) throw new Error('codex_web_search: at most four search queries per call')
  if (commands.search_query?.length === 4 && (commands.response_length ?? 'short') === 'short') {
    throw new Error('codex_web_search: four search queries require response_length medium or long')
  }
  for (const [, entries] of operations) {
    if (!Array.isArray(entries) || entries.length === 0) throw new Error('codex_web_search: omit empty command arrays')
    for (const entry of entries) for (const [key, value] of Object.entries(entry)) {
      if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
        throw new Error(`codex_web_search: ${key} must be a non-negative safe integer`)
      }
      if (typeof value === 'string' && key !== 'market' && !value.trim()) {
        throw new Error(`codex_web_search: ${key} must not be empty`)
      }
      if (key === 'domains' && Array.isArray(value) && value.some(domain => !domain.trim())) {
        throw new Error('codex_web_search: domains must not contain empty strings')
      }
    }
  }
}
