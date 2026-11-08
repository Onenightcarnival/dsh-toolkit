/**
 * Protocol-independent request model: every inbound protocol parses into a
 * {@link ParsedRequest}; the server resolves the model, stores images and
 * materializes host messages from it.
 */
import { createAssistantMessage, createToolResultMessage, createUserMessage, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, RequestMessage, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

export type Protocol = 'chat' | 'responses' | 'messages'

/** Request-level failure with the HTTP status the protocol reports it under. */
export class GatewayError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly param?: string) {
    super(message)
    this.name = 'GatewayError'
  }
}

export function invalid(message: string, param?: string): GatewayError {
  return new GatewayError(400, 'invalid_request_error', message, param)
}

export function unsupported(param: string): GatewayError {
  return new GatewayError(400, 'unsupported_parameter', `"${param}" is not supported by this gateway`, param)
}

/** Image carried by a request before it is stored as a host attachment. */
export interface PendingImage {
  type: 'pending-image'
  source: { kind: 'url'; url: string } | { kind: 'base64'; mediaType: string; data: string }
}

export type DraftBlock =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | PendingImage

export type DraftMessage =
  | { role: 'user'; content: DraftBlock[] }
  | { role: 'assistant'; content: DraftBlock[] }
  | { role: 'tool'; callId: string; content: DraftBlock[]; isError: boolean }

export interface ParsedRequest {
  /** Model name as requested; undefined follows the default model. */
  model: string | undefined
  stream: boolean
  /** Chat Completions only: `stream_options.include_usage`; other protocols always carry usage. */
  includeUsage: boolean
  system: string | undefined
  messages: DraftMessage[]
  tools: ToolSchema[] | undefined
  temperature: number | undefined
  maxTokens: number | undefined
  stop: string[] | undefined
  reasoningEffort: string | undefined
}

export type ImageResolver = (image: PendingImage) => Promise<ImageAttachmentRef>

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function optionalString(value: unknown, param: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw invalid(`"${param}" must be a string`, param)
  return value
}

export function optionalNumber(value: unknown, param: string, min?: number, max?: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`"${param}" must be a number`, param)
  if ((min !== undefined && value < min) || (max !== undefined && value > max)) throw invalid(`"${param}" is out of range`, param)
  return value
}

export function optionalInteger(value: unknown, param: string, min = 1): number | undefined {
  const number = optionalNumber(value, param, min)
  if (number !== undefined && !Number.isInteger(number)) throw invalid(`"${param}" must be an integer`, param)
  return number
}

export function optionalBoolean(value: unknown, param: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw invalid(`"${param}" must be a boolean`, param)
  return value
}

export function stopSequences(value: unknown, param: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  const list = typeof value === 'string' ? [value] : value
  if (!Array.isArray(list) || list.some(entry => typeof entry !== 'string')) throw invalid(`"${param}" must be a string or a list of strings`, param)
  return list.length === 0 ? undefined : list as string[]
}

/** JSON Schema object of tool parameters; an absent schema becomes an empty object schema. */
export function parameterSchema(value: unknown, param: string): Record<string, unknown> {
  if (value === undefined || value === null) return { type: 'object', properties: {} }
  if (!isRecord(value)) throw invalid(`"${param}" must be a JSON Schema object`, param)
  return value
}

export function toolName(value: unknown, param: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`"${param}" must be a non-empty string`, param)
  return value
}

/** Serialize tool-call arguments: strings pass through, objects are encoded. */
export function argumentsText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return '{}'
  return JSON.stringify(value)
}

/** Parse a tool-call argument string into an object; invalid JSON becomes `{}`. */
export function argumentsObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text === '' ? '{}' : text)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function imageFromDataUrl(url: string): PendingImage {
  const match = /^data:([^;,]+)(;[^,]*)?,(.*)$/s.exec(url)
  if (!match) return { type: 'pending-image', source: { kind: 'url', url } }
  const base64 = match[2]?.split(';').includes('base64') ?? false
  if (!base64) throw invalid('data URLs of images must be base64 encoded')
  return { type: 'pending-image', source: { kind: 'base64', mediaType: match[1], data: match[3] } }
}

export function textOnly(blocks: readonly DraftBlock[]): string {
  return blocks.map(block => block.type === 'text' ? block.text : '').join('')
}

/** Combine system texts into the request's single system prompt. */
export function joinSystem(parts: readonly string[]): string | undefined {
  const texts = parts.filter(part => part.trim() !== '')
  return texts.length === 0 ? undefined : texts.join('\n\n')
}

export interface Target {
  provider: string
  model: string
}

/**
 * Build the host request from a parsed request: images are stored, assistant
 * messages take the resolved route as their source, tool results keep their call ids.
 */
export async function materialize(parsed: ParsedRequest, target: Target, resolveImage: ImageResolver, signal: AbortSignal): Promise<GenerateOptions> {
  const messages: RequestMessage[] = []
  for (const draft of parsed.messages) {
    const content: ContentBlock[] = []
    for (const block of draft.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text })
      } else if (block.type === 'tool-call') {
        content.push({ type: 'tool-call', id: ToolCallId(block.id), name: block.name, arguments: block.arguments })
      } else {
        content.push({ type: 'image', attachment: await resolveImage(block) })
      }
    }
    if (draft.role === 'user') {
      if (content.length === 0) content.push({ type: 'text', text: '' })
      messages.push(createUserMessage({ content, source: { kind: 'user' } }))
    } else if (draft.role === 'assistant') {
      if (content.length === 0) continue
      messages.push(createAssistantMessage({ content, source: { provider: target.provider, model: target.model } }))
    } else {
      messages.push(createToolResultMessage({ callId: ToolCallId(draft.callId), content: content.length === 0 ? [{ type: 'text', text: '' }] : content, isError: draft.isError }))
    }
  }
  if (messages.length === 0) throw invalid('the request carries no messages')
  return {
    provider: target.provider,
    model: target.model,
    messages,
    signal,
    ...parsed.system === undefined ? {} : { system: parsed.system },
    ...parsed.tools === undefined || parsed.tools.length === 0 ? {} : { tools: parsed.tools },
    ...parsed.temperature === undefined ? {} : { temperature: parsed.temperature },
    ...parsed.maxTokens === undefined ? {} : { maxTokens: parsed.maxTokens },
    ...parsed.stop === undefined ? {} : { stop: parsed.stop },
    ...parsed.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(parsed.reasoningEffort) },
  }
}

/** Usage with every optional counter present. */
export interface FullUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

export function fullUsage(usage: TokenUsage | undefined): FullUsage {
  const inputTokens = usage?.inputTokens ?? 0
  const outputTokens = usage?.outputTokens ?? 0
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage?.totalTokens ?? inputTokens + outputTokens,
    cacheReadTokens: usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
    reasoningTokens: usage?.reasoningTokens ?? 0,
  }
}

/** Failure carried by a finish chunk, or undefined for a normal finish. */
export function finishFailure(finish: FinishReason): { code: string; message: string; status: number } | undefined {
  if (finish.kind !== 'error' && finish.kind !== 'aborted') return undefined
  const status = finish.failure.status !== undefined && finish.failure.status >= 400 && finish.failure.status <= 599 ? finish.failure.status : 502
  return { code: finish.failure.code, message: finish.failure.message, status }
}

/** One SSE frame. */
export function sse(data: unknown, event?: string): string {
  return `${event === undefined ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`
}

export function requestId(prefix: string): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let id = ''
  for (let i = 0; i < 24; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)]
  return `${prefix}${id}`
}

/** Shared structure of a streaming encoder; the server feeds every host chunk and ends it once. */
export interface StreamEncoder {
  /** Frames to send before the first host chunk. */
  start(): string
  /** Frames for one host chunk. */
  push(chunk: import('@deepseek-ai/dsh-llm').StreamChunk): string
  /** Frames closing a normal stream (the finish chunk has been pushed). */
  end(): string
  /** Frames reporting a failure after the stream started. */
  fail(error: { code: string; message: string }): string
}
