import { randomUUID } from 'node:crypto'
import type { WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { AntigravitySession } from '../auth/store.js'
import type { AccountTokenManager } from './accounts.js'
import { antigravityBaseURL, antigravityHeaders, ANTIGRAVITY_DEFAULT_BASE_URL, ANTIGRAVITY_FALLBACK_BASE_URL, type AntigravityRuntimeConfig } from './antigravity.js'
import { httpLlmError, type FetchFn } from './common.js'
import { proxiedFetch } from '../http.js'
import type { GeneratedImage, ImageGenerateArgs } from '../tools/image-generate.js'

export const ANTIGRAVITY_SEARCH_MODEL = 'gemini-3-flash'
export const ANTIGRAVITY_IMAGE_MODEL = 'gemini-3.1-flash-image'

export interface AntigravityToolOptions {
  tokens: Pick<AccountTokenManager<AntigravitySession>, 'session' | 'defaultAccount'>
  runtime?: AntigravityRuntimeConfig
  fetchFn?: FetchFn
  enabled?: () => boolean
  defaultEffort?: () => string | undefined
}

type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value)

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error('Antigravity returned an empty response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) throw new Error('Antigravity response exceeds size limit')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

export class AntigravityToolClient {
  constructor(private readonly options: AntigravityToolOptions) {}

  available(): boolean { return this.options.enabled?.() ?? true }

  private async generate(model: string, request: RecordValue, signal?: AbortSignal, image = false): Promise<unknown> {
    if (!this.available()) throw new Error('Antigravity tool is disabled')
    const runtime = this.options.runtime ?? {}
    const endpoints = runtime.baseURL?.trim() ? [antigravityBaseURL(runtime.baseURL)] : [ANTIGRAVITY_DEFAULT_BASE_URL, ANTIGRAVITY_FALLBACK_BASE_URL]
    const fetchFn = this.options.fetchFn ?? proxiedFetch
    const boundedSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(image ? 180_000 : 60_000)])
    const account = await this.options.tokens.defaultAccount()
    let session = await this.options.tokens.session(account)
    let refreshed = false
    for (const [index, endpoint] of endpoints.entries()) {
      while (true) {
        boundedSignal.throwIfAborted()
        const response = await fetchFn(`${endpoint}/v1internal:generateContent`, {
          method: 'POST', headers: antigravityHeaders(session.accessToken, runtime.userAgent), signal: boundedSignal,
          body: JSON.stringify({
            project: runtime.projectId ?? session.projectId, model, requestId: randomUUID(),
            userAgent: 'antigravity', requestType: 'agent', request: { ...request, sessionId: randomUUID() },
          }),
        })
        if (response.status === 401 && !refreshed) {
          await response.body?.cancel()
          session = await this.options.tokens.session(account, true)
          refreshed = true
          continue
        }
        if ([403, 404].includes(response.status) && index < endpoints.length - 1) {
          await response.body?.cancel()
          break
        }
        if (!response.ok) throw await httpLlmError(response, 'Antigravity tool')
        return readJson(response, image ? 48 * 1024 * 1024 : 2 * 1024 * 1024)
      }
    }
    throw new Error('Antigravity endpoints are unavailable')
  }

  async search(request: { query: string }, signal?: AbortSignal): Promise<WebSearchResult> {
    const query = request.query.trim()
    if (!query || query.length > 16_384) throw new Error('Antigravity search query must contain 1–16384 characters')
    const payload = await this.generate(ANTIGRAVITY_SEARCH_MODEL, {
      contents: [{ role: 'user', parts: [{ text: query }] }],
      tools: [{ googleSearch: {} }],
    }, signal)
    return parseAntigravitySearch(payload)
  }

  async images(args: ImageGenerateArgs, references: string[] | undefined, signal: AbortSignal): Promise<GeneratedImage[]> {
    const effort = args.reasoningEffort ?? this.options.defaultEffort?.()
    const payload = await this.generate(ANTIGRAVITY_IMAGE_MODEL, {
      contents: [{ role: 'user', parts: [
        { text: args.prompt.trim() },
        ...(references ?? []).map(url => {
          const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(url)
          if (!match) throw new Error('Invalid Antigravity reference image')
          return { inlineData: { mimeType: match[1], data: match[2] } }
        }),
      ] }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        ...effort === 'minimal' || effort === 'high' ? { thinkingConfig: { thinkingLevel: effort.toUpperCase(), includeThoughts: true } } : {},
      },
    }, signal, true)
    return parseAntigravityImages(payload)
  }
}

function candidates(payload: unknown): RecordValue[] {
  if (!record(payload)) throw new Error('Invalid Antigravity response')
  const root = record(payload.response) ? payload.response : payload
  if (!Array.isArray(root.candidates) || root.candidates.length === 0) throw new Error('Antigravity returned no candidates')
  return root.candidates.filter(record)
}

function parts(candidate: RecordValue): RecordValue[] {
  return record(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts.filter(record) : []
}

export function parseAntigravitySearch(payload: unknown): WebSearchResult {
  const content: string[] = []
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  for (const candidate of candidates(payload)) {
    for (const part of parts(candidate)) if (!part.thought && typeof part.text === 'string') content.push(part.text)
    const metadata = candidate.groundingMetadata ?? candidate.grounding_metadata
    if (!record(metadata)) continue
    const chunks = metadata.groundingChunks ?? metadata.grounding_chunks
    if (!Array.isArray(chunks)) continue
    for (const chunk of chunks) {
      if (!record(chunk) || !record(chunk.web) || typeof chunk.web.uri !== 'string') continue
      let url: URL
      try { url = new URL(chunk.web.uri) } catch { continue }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue
      seen.add(url.href)
      sources.push({ url: url.href, ...(typeof chunk.web.title === 'string' ? { title: chunk.web.title.slice(0, 1000) } : {}) })
    }
  }
  if (!sources.length) throw new Error('Antigravity returned no grounded web sources; search may be unavailable for this account or model')
  const text = content.join('\n')
  return { content: text.slice(0, 64 * 1024), sources: sources.slice(0, 8), truncated: sources.length > 8 || text.length > 64 * 1024 }
}

export function parseAntigravityImages(payload: unknown): GeneratedImage[] {
  const images: GeneratedImage[] = []
  for (const candidate of candidates(payload)) for (const part of parts(candidate)) {
    if (part.thought) continue
    const inline = part.inlineData ?? part.inline_data
    if (!record(inline) || typeof inline.data !== 'string') continue
    const data = Buffer.from(inline.data, 'base64')
    const png = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const jpeg = data[0] === 255 && data[1] === 216 && data[2] === 255
    const webp = data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
    if (!png && !jpeg && !webp) throw new Error('Antigravity returned an unsupported image format')
    if (data.byteLength > 20 * 1024 * 1024 || images.length >= 4) throw new Error('Antigravity image output exceeds limits')
    images.push({ data })
  }
  if (!images.length) throw new Error('Antigravity returned no image; the request may have been blocked or the model is unavailable')
  return images
}
