/**
 * `grok_x_search` tool: xAI's hosted X search through the Grok subscription's
 * OAuth session. The wire call is a non-streaming Responses request carrying
 * the built-in `x_search` tool; the output is `{ answer, citations }`.
 */

import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { GrokSession } from '../auth/store.js'
import { proxiedFetch } from '../http.js'
import { AccountTokenManager } from '../providers/accounts.js'
import { httpLlmError } from '../providers/common.js'
import type { FetchFn } from '../providers/common.js'
import { GROK_API_URL } from '../providers/grok.js'

/** Tool name owned by this plugin. */
export const X_SEARCH_TOOL_NAME = 'grok_x_search'
/** Grok model the search runs on. */
export const X_SEARCH_MODEL = 'grok-4'
/** xAI caps each handle filter list at ten entries. */
const MAX_HANDLES = 10

/** Dependencies of the `grok_x_search` tool. */
export interface XSearchToolOptions {
  /** Grok session source; a missing session throws the log-in hint. */
  tokens: AccountTokenManager<GrokSession>
  /** Fetch implementation (injectable for tests). */
  fetchFn?: FetchFn
  /** Creation-independent switch; false rejects every call immediately. */
  enabled?: () => boolean
}

/** Normalized, validated arguments of one search call. */
export interface XSearchRequest {
  query: string
  tool: Record<string, unknown>
}

/** Tool arguments as the schema admits them. */
export interface XSearchArgs {
  query: string
  allowed_x_handles?: string[]
  excluded_x_handles?: string[]
  from_date?: string
  to_date?: string
  enable_image_understanding?: boolean
  enable_video_understanding?: boolean
}

/**
 * Validate and assemble the request facts from tool arguments.
 * @param args - raw tool arguments.
 * @returns the query and the built-in tool definition.
 * @throws on an empty query, oversized handle lists, or both handle filters at once.
 */
export function buildXSearchRequest(args: XSearchArgs): XSearchRequest {
  const query = args.query.trim()
  if (query.length === 0) throw new Error(`${X_SEARCH_TOOL_NAME}: query must be a non-empty string`)
  const allowed = normalizeHandles(args.allowed_x_handles, 'allowed_x_handles')
  const excluded = normalizeHandles(args.excluded_x_handles, 'excluded_x_handles')
  if (allowed.length > 0 && excluded.length > 0) {
    throw new Error(`${X_SEARCH_TOOL_NAME}: allowed_x_handles and excluded_x_handles cannot be used together`)
  }
  const tool: Record<string, unknown> = { type: 'x_search' }
  if (allowed.length > 0) tool.allowed_x_handles = allowed
  if (excluded.length > 0) tool.excluded_x_handles = excluded
  if (args.from_date !== undefined && args.from_date.trim().length > 0) tool.from_date = args.from_date.trim()
  if (args.to_date !== undefined && args.to_date.trim().length > 0) tool.to_date = args.to_date.trim()
  if (args.enable_image_understanding === true) tool.enable_image_understanding = true
  if (args.enable_video_understanding === true) tool.enable_video_understanding = true
  return { query, tool }
}

/** Strip `@` prefixes, drop blanks, and enforce the provider's handle cap. */
function normalizeHandles(value: string[] | undefined, field: string): string[] {
  if (value === undefined) return []
  const handles = value.map(handle => handle.trim().replace(/^@+/, '')).filter(handle => handle.length > 0)
  if (handles.length > MAX_HANDLES) throw new Error(`${X_SEARCH_TOOL_NAME}: ${field} supports at most ${MAX_HANDLES} handles`)
  return handles
}

/** The output of one successful search. */
export interface XSearchOutput {
  answer: string
  citations: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Extract the answer text and citation URLs from a Responses payload: the
 * `output_text` shortcut or message output parts for the answer, and both
 * top-level `citations` and inline `url_citation` annotations for sources.
 * @param payload - the parsed JSON response.
 * @returns answer and deduplicated citations.
 */
export function parseXSearchResponse(payload: unknown): XSearchOutput {
  const body = isRecord(payload) ? payload : {}
  let answer = typeof body.output_text === 'string' ? body.output_text.trim() : ''
  const citations: string[] = []
  const push = (url: unknown): void => {
    if (typeof url === 'string' && url.length > 0 && !citations.includes(url)) citations.push(url)
  }
  if (Array.isArray(body.citations)) for (const citation of body.citations) push(citation)
  const parts: string[] = []
  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue
      for (const part of item.content) {
        if (!isRecord(part)) continue
        if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string' && part.text.trim().length > 0) {
          parts.push(part.text.trim())
        }
        if (Array.isArray(part.annotations)) {
          for (const annotation of part.annotations) {
            if (isRecord(annotation) && annotation.type === 'url_citation') push(annotation.url)
          }
        }
      }
    }
  }
  if (answer.length === 0) answer = parts.join('\n\n')
  return { answer, citations }
}

/** Bound a call-card title's query. */
function truncate(text: string, max = 60): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * Build the `grok_x_search` tool definition.
 * @param options - Grok session source, fetch implementation and switch.
 * @returns the tool to register on `ctx.tools`.
 */
export function createXSearchTool(options: XSearchToolOptions): ToolDefinition {
  return defineTool({
    name: X_SEARCH_TOOL_NAME,
    description: 'Search X (Twitter) posts, profiles, and threads through the Grok subscription\'s hosted xAI x_search. '
      + 'Use this for current discussion, reactions, or claims on X rather than general web pages.',
    parameters: {
      query: { type: 'string', required: true, description: 'What to look up on X.' },
      allowed_x_handles: { type: 'array', items: { type: 'string' }, description: 'X handles to include exclusively (max 10).' },
      excluded_x_handles: { type: 'array', items: { type: 'string' }, description: 'X handles to exclude (max 10).' },
      from_date: { type: 'string', description: 'Optional start date in YYYY-MM-DD format.' },
      to_date: { type: 'string', description: 'Optional end date in YYYY-MM-DD format.' },
      enable_image_understanding: { type: 'boolean', description: 'Whether xAI should analyze images attached to matching posts.' },
      enable_video_understanding: { type: 'boolean', description: 'Whether xAI should analyze videos attached to matching posts.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          answer: { type: 'string', required: true },
          citations: { type: 'array', items: { type: 'string' }, required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.citations.length > 0
          ? `${value.answer}\n\nSources:\n${value.citations.map(citation => `- ${citation}`).join('\n')}`
          : value.answer,
      }],
      presentationMeta: (_args, value) => ({ answer: value.answer, citations: value.citations }),
    },
    presentCall: args => ({ card: 'generic', title: `${X_SEARCH_TOOL_NAME}: ${truncate(args.query)}`, kind: 'search' }),
    presentResult: (_args, result) => {
      if (result.isError || !isRecord(result.meta)) return undefined
      const citations = Array.isArray(result.meta.citations) ? result.meta.citations : []
      return {
        card: 'web',
        kind: 'search',
        sources: citations.filter((citation): citation is string => typeof citation === 'string').map(url => ({ url })),
        ...typeof result.meta.answer === 'string' && result.meta.answer.length > 0 ? { answer: result.meta.answer } : {},
        truncated: false,
      }
    },
    async execute(args, exec) {
      if (options.enabled !== undefined && !options.enabled()) throw new Error(`${X_SEARCH_TOOL_NAME}: disabled`)
      const request = buildXSearchRequest(args)
      const session = await options.tokens.session()
      const response = await (options.fetchFn ?? proxiedFetch)(GROK_API_URL, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          ...attributionHeaders(),
        },
        body: JSON.stringify({
          model: X_SEARCH_MODEL,
          input: [{ role: 'user', content: request.query }],
          tools: [request.tool],
          store: false,
        }),
        signal: exec.signal,
      })
      if (!response.ok) throw await httpLlmError(response, X_SEARCH_TOOL_NAME)
      return parseXSearchResponse(await response.json())
    },
  })
}
