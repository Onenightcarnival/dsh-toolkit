/**
 * Agent tools (http_*), registered while the panel's agent-tools switch is on.
 * Requests go through the same engine as the panel: targets are addressed by
 * name, auth is injected by the host and never returned, non-safe methods
 * need the target's mutation switch and confirm=true.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { HttpPolicyError, humanBytes, type HttpEngine } from './engine.ts'
import { DIRECT_TARGET_ID, SAFE_METHODS, isHttpMethod, type HttpExchange, type HttpTargetSummary } from './protocol.ts'
import type { HistoryStore, TargetStore } from './store.ts'

function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

function err(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name && error.name !== 'Error' && error.name !== 'HttpPolicyError' ? `${error.name}: ` : ''
    return name + error.message
  }
  return String(error)
}

/** Response body cap handed to the model. */
export const TOOL_BODY_BYTES = 64 * 1024
const TOOL_HISTORY_MAX = 50

const TARGET_PARAM = { type: 'string', required: true, description: 'Target name (or id) from http_targets.' } as const

const EXCHANGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    error: { type: 'string' },
    url: { type: 'string' },
    status: { type: 'integer' },
    statusText: { type: 'string' },
    headers: { type: 'object', additionalProperties: true },
    contentType: { type: 'string' },
    bodyBytes: { type: 'integer' },
    body: { type: 'string' },
    bodyTruncated: { type: 'boolean' },
    binary: { type: 'boolean' },
    durationMs: { type: 'integer' },
    redirects: { type: 'array', items: { type: 'string' } },
  },
} as const

interface ExchangeOutput {
  ok: boolean
  error?: string
  url?: string
  status?: number
  statusText?: string
  headers?: Record<string, string>
  contentType?: string
  bodyBytes?: number
  body?: string
  bodyTruncated?: boolean
  binary?: boolean
  durationMs?: number
  redirects?: string[]
}

function truncateBody(body: string, max: number): { body: string; truncated: boolean } {
  if (Buffer.byteLength(body, 'utf8') <= max) return { body, truncated: false }
  return { body: Buffer.from(body, 'utf8').subarray(0, max).toString('utf8').replace(/�$/, ''), truncated: true }
}

/** Model-facing projection of an exchange. */
export function toOutput(exchange: HttpExchange): ExchangeOutput {
  if (exchange.error !== undefined || exchange.response === undefined) return { ok: false, error: exchange.error ?? 'no response', url: exchange.request.url || undefined }
  const response = exchange.response
  const { body, truncated } = truncateBody(response.body, TOOL_BODY_BYTES)
  return {
    ok: true,
    url: exchange.request.url,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    contentType: response.contentType,
    bodyBytes: response.bodyBytes,
    body,
    bodyTruncated: response.bodyTruncated || truncated,
    binary: response.binary,
    durationMs: response.durationMs,
    redirects: response.redirects,
  }
}

/** Fixed text render of an exchange output. */
export function renderExchange(method: string, value: ExchangeOutput): string {
  if (!value.ok) return `request failed${value.url !== undefined ? ` (${method} ${value.url})` : ''}: ${value.error ?? 'unknown error'}`
  const lines = [`${method} ${value.url ?? ''} → ${value.status ?? 0} ${value.statusText ?? ''} (${value.durationMs ?? 0} ms)`]
  if ((value.redirects?.length ?? 0) > 0) lines.push(`redirected via: ${value.redirects!.join(' → ')}`)
  lines.push(`${value.contentType !== '' && value.contentType !== undefined ? value.contentType : 'no content-type'} · ${humanBytes(value.bodyBytes ?? 0)}${value.bodyTruncated ? ' (truncated)' : ''}`)
  if (value.binary) lines.push('[binary body omitted]')
  else if ((value.body ?? '') !== '') lines.push('', value.body as string)
  return lines.join('\n')
}

export function httpTargetsTool(store: TargetStore) {
  return defineTool({
    name: 'http_targets',
    description: 'List the HTTP API targets the user configured in the dsh HTTP panel: name, base URL, auth type (credentials are injected by the host and never shown), fixed headers, {{variables}}, extra allowed hosts and whether non-GET methods are allowed. Every other http_* tool takes one of these names. Triggers: API, HTTP request, REST, endpoint, webhook, curl, Postman, 接口, 调接口, 请求.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          targets: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                baseUrl: { type: 'string', required: true },
                authType: { type: 'string', required: true },
                headers: { type: 'object', additionalProperties: true, required: true },
                variables: { type: 'array', items: { type: 'string' }, required: true },
                allowedHosts: { type: 'array', items: { type: 'string' }, required: true },
                allowMutations: { type: 'boolean', required: true },
                allowPrivate: { type: 'boolean', required: true },
                timeoutMs: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: { targets?: Array<{ name: string; baseUrl: string; authType: string; allowMutations: boolean; variables: string[]; allowedHosts: string[] }> }) => {
        const targets = value.targets ?? []
        if (targets.length === 0) return text('no HTTP targets configured (the user adds them in the HTTP panel)')
        return text(['name | base URL | auth | mutations | variables | extra hosts', '--- | --- | --- | --- | --- | ---',
          ...targets.map(t => `${t.name} | ${t.baseUrl} | ${t.authType} | ${t.allowMutations ? 'allowed (confirm required)' : 'GET/HEAD/OPTIONS only'} | ${t.variables.length > 0 ? t.variables.map(v => `{{${v}}}`).join(' ') : '-'} | ${t.allowedHosts.length > 0 ? t.allowedHosts.join(', ') : '-'}`)].join('\n'))
      },
    },
    async execute() {
      return {
        targets: store.list().map(store.summarize.bind(store)).map((t: HttpTargetSummary) => ({
          id: t.id, name: t.name, baseUrl: t.baseUrl, authType: t.auth.type, headers: t.headers, variables: Object.keys(t.variables),
          allowedHosts: t.allowedHosts, allowMutations: t.allowMutations, allowPrivate: t.allowPrivate, timeoutMs: t.timeoutMs,
        })),
      }
    },
  })
}

export function httpRequestTool(engine: HttpEngine) {
  return defineTool({
    name: 'http_request',
    description: `Send an HTTP request to a configured target. The host joins \`path\` below the target base URL, applies the target's {{variables}}, fixed headers and auth, and returns status, headers and the decoded body (capped at ${TOOL_BODY_BYTES / 1024} KiB). GET / HEAD / OPTIONS run directly. POST / PUT / PATCH / DELETE change server state: they only work on targets where the user enabled mutations, and only with confirm=true after you showed the user the exact request and they agreed. A server-sent event stream is read until it ends, the body cap or the target timeout, and returned as its text. Never put credentials in headers or query — the target auth does that.`,
    parameters: {
      target: TARGET_PARAM,
      method: { type: 'string', required: true, description: 'GET, POST, PUT, PATCH, DELETE, HEAD or OPTIONS.' },
      path: { type: 'string', required: true, description: 'Path below the base URL, e.g. "/users/42?expand=1"; an absolute https URL is accepted on allowed hosts.' },
      query: { type: 'object', additionalProperties: true, description: 'Query parameters appended to the URL (string values).' },
      headers: { type: 'object', additionalProperties: true, description: 'Extra request headers (string values); content-type defaults to application/json for a JSON body.' },
      body: { type: 'string', description: 'Raw request body for POST / PUT / PATCH / DELETE (JSON as a string).' },
      confirm: { type: 'boolean', description: 'Required true for POST / PUT / PATCH / DELETE; set only after the user explicitly confirmed this exact request.' },
    },
    output: {
      schema: EXCHANGE_SCHEMA,
      render: (args, value: ExchangeOutput) => text(renderExchange(String(args.method ?? 'GET').toUpperCase(), value)),
    },
    async execute(args) {
      const method = String(args.method ?? 'GET').toUpperCase()
      if (!isHttpMethod(method)) return { ok: false, error: `unsupported method '${String(args.method)}'` }
      let target
      try {
        target = engine.target(args.target)
      } catch (error) {
        return { ok: false, error: err(error) }
      }
      if (!SAFE_METHODS.includes(method)) {
        if (!target.allowMutations) return { ok: false, error: `refused: target '${target.name}' allows GET/HEAD/OPTIONS only for the agent (the user can enable mutations in the HTTP panel)` }
        if (args.confirm !== true) return { ok: false, error: 'refused: confirm must be true for a state-changing request (show the user the exact request and ask first)' }
      }
      try {
        const exchange = await engine.send(target.id, {
          method,
          path: args.path,
          query: args.query as Record<string, string> | undefined,
          headers: args.headers as Record<string, string> | undefined,
          body: args.body,
        }, { source: 'agent', maxBodyBytes: TOOL_BODY_BYTES })
        return toOutput(exchange)
      } catch (error) {
        return { ok: false, error: err(error instanceof HttpPolicyError ? error : error) }
      }
    },
  })
}

export function httpHistoryTool(store: TargetStore, history: HistoryStore) {
  return defineTool({
    name: 'http_history',
    description: 'Recent requests sent to a configured target, by the user from the HTTP panel or by the agent: method, URL, status, duration and a body preview. Use it to see how the user called an endpoint before composing a similar request.',
    parameters: {
      target: { type: 'string', description: 'Target name (or id); omit for every target.' },
      limit: { type: 'integer', description: `Entries to return (default 20, cap ${TOOL_HISTORY_MAX}).` },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          entries: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                at: { type: 'integer', required: true },
                source: { type: 'string', required: true },
                target: { type: 'string', required: true },
                method: { type: 'string', required: true },
                url: { type: 'string', required: true },
                status: { type: 'integer' },
                durationMs: { type: 'integer' },
                error: { type: 'string' },
                requestBody: { type: 'string' },
                responsePreview: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value: { ok: boolean; error?: string; entries?: Array<{ at: number; source: string; target: string; method: string; url: string; status?: number; durationMs?: number; error?: string; responsePreview?: string }> }) => {
        if (!value.ok) return text(`history failed: ${value.error ?? 'unknown error'}`)
        const entries = value.entries ?? []
        if (entries.length === 0) return text('no requests recorded yet')
        return text(entries.map(e => `${new Date(e.at).toISOString()} [${e.source}] ${e.target}: ${e.method} ${e.url} → ${e.error !== undefined ? `error: ${e.error}` : `${e.status ?? 0} (${e.durationMs ?? 0} ms)`}${e.responsePreview ? `\n    ${e.responsePreview}` : ''}`).join('\n'))
      },
    },
    async execute(args) {
      let targetId: string | undefined
      if (args.target !== undefined && args.target !== '') {
        const target = store.find(args.target)
        if (target === undefined) return { ok: false, error: `target '${args.target}' not found` }
        targetId = target.id
      }
      const limit = Math.min(TOOL_HISTORY_MAX, Math.max(1, args.limit ?? 20))
      // Requests the user sent without a target stay out of the agent's view.
      const pool = targetId === undefined
        ? history.list(undefined, Number.MAX_SAFE_INTEGER).filter(e => e.targetId !== DIRECT_TARGET_ID).slice(0, limit)
        : history.list(targetId, limit)
      const entries = pool.map(e => ({
        at: e.at,
        source: e.source,
        target: e.targetName,
        method: e.request.method,
        url: e.request.url,
        status: e.response?.status,
        durationMs: e.response?.durationMs,
        error: e.error,
        requestBody: e.request.body !== '' ? truncateBody(e.request.body, 2048).body : undefined,
        responsePreview: e.response !== undefined && e.response.body !== '' ? truncateBody(e.response.body.replace(/\s+/g, ' '), 200).body : undefined,
      }))
      return { ok: true, entries }
    },
  })
}

export function allTools(store: TargetStore, engine: HttpEngine, history: HistoryStore) {
  return [httpTargetsTool(store), httpRequestTool(engine), httpHistoryTool(store, history)]
}
