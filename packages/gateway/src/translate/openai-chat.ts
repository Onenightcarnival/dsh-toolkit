/** OpenAI Chat Completions: request parsing, streaming chunks and the complete object. */
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  argumentsText, finishFailure, fullUsage, imageFromDataUrl, invalid, isRecord, joinSystem, optionalBoolean, optionalInteger,
  optionalNumber, optionalString, parameterSchema, requestId, sse, stopSequences, toolName, unsupported,
  type DraftBlock, type DraftMessage, type ParsedRequest, type StreamEncoder,
} from './common.ts'

function contentBlocks(content: unknown, param: string, allowImages: boolean): DraftBlock[] {
  if (content === undefined || content === null) return []
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  if (!Array.isArray(content)) throw invalid(`"${param}" must be a string or a list of content parts`, param)
  const blocks: DraftBlock[] = []
  content.forEach((part: unknown, index) => {
    const where = `${param}[${index}]`
    if (!isRecord(part)) throw invalid(`"${where}" must be an object`, where)
    if (part.type === 'text') {
      if (typeof part.text !== 'string') throw invalid(`"${where}.text" must be a string`, where)
      blocks.push({ type: 'text', text: part.text })
    } else if (part.type === 'image_url' && allowImages) {
      const url = typeof part.image_url === 'string' ? part.image_url : isRecord(part.image_url) ? part.image_url.url : undefined
      if (typeof url !== 'string' || url === '') throw invalid(`"${where}.image_url" must carry a URL`, where)
      blocks.push(imageFromDataUrl(url))
    } else {
      throw unsupported(`${where}.type=${String(part.type)}`)
    }
  })
  return blocks
}

function tools(value: unknown): ToolSchema[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw invalid('"tools" must be a list', 'tools')
  return value.map((tool: unknown, index) => {
    const where = `tools[${index}]`
    if (!isRecord(tool)) throw invalid(`"${where}" must be an object`, where)
    if (tool.type !== 'function') throw unsupported(`${where}.type=${String(tool.type)}`)
    const fn = isRecord(tool.function) ? tool.function : undefined
    if (fn === undefined) throw invalid(`"${where}.function" must be an object`, where)
    return {
      name: toolName(fn.name, `${where}.function.name`),
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: parameterSchema(fn.parameters, `${where}.function.parameters`),
    }
  })
}

function pushAssistant(messages: DraftMessage[], content: DraftBlock[]): void {
  const last = messages[messages.length - 1]
  if (last?.role === 'assistant') last.content.push(...content)
  else messages.push({ role: 'assistant', content })
}

/** @throws {GatewayError} 400 for malformed or unsupported requests. */
export function parseChatRequest(body: unknown): ParsedRequest {
  if (!isRecord(body)) throw invalid('request body must be a JSON object')
  if (optionalInteger(body.n, 'n') !== undefined && body.n !== 1) throw unsupported('n')
  if (body.logprobs === true || body.top_logprobs !== undefined && body.top_logprobs !== null) throw unsupported('logprobs')
  if (isRecord(body.response_format) && body.response_format.type !== 'text' && body.response_format.type !== undefined) {
    throw unsupported(`response_format.type=${String(body.response_format.type)}`)
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw invalid('"messages" must be a non-empty list', 'messages')
  const system: string[] = []
  const messages: DraftMessage[] = []
  body.messages.forEach((message: unknown, index) => {
    const where = `messages[${index}]`
    if (!isRecord(message)) throw invalid(`"${where}" must be an object`, where)
    switch (message.role) {
      case 'system':
      case 'developer':
        system.push(contentBlocks(message.content, `${where}.content`, false).map(block => block.type === 'text' ? block.text : '').join(''))
        break
      case 'user':
        messages.push({ role: 'user', content: contentBlocks(message.content, `${where}.content`, true) })
        break
      case 'assistant': {
        const content = contentBlocks(message.content, `${where}.content`, false)
        if (message.tool_calls !== undefined && message.tool_calls !== null) {
          if (!Array.isArray(message.tool_calls)) throw invalid(`"${where}.tool_calls" must be a list`, where)
          message.tool_calls.forEach((call: unknown, callIndex) => {
            const callWhere = `${where}.tool_calls[${callIndex}]`
            if (!isRecord(call) || !isRecord(call.function)) throw invalid(`"${callWhere}" must carry a function`, callWhere)
            if (typeof call.id !== 'string' || call.id === '') throw invalid(`"${callWhere}.id" must be a string`, callWhere)
            content.push({ type: 'tool-call', id: call.id, name: toolName(call.function.name, `${callWhere}.function.name`), arguments: argumentsText(call.function.arguments) })
          })
        }
        pushAssistant(messages, content)
        break
      }
      case 'tool': {
        if (typeof message.tool_call_id !== 'string' || message.tool_call_id === '') throw invalid(`"${where}.tool_call_id" must be a string`, where)
        messages.push({ role: 'tool', callId: message.tool_call_id, content: contentBlocks(message.content, `${where}.content`, false), isError: false })
        break
      }
      default:
        throw unsupported(`${where}.role=${String(message.role)}`)
    }
  })
  const declared = tools(body.tools)
  const streamOptions = isRecord(body.stream_options) ? body.stream_options : undefined
  return {
    model: optionalString(body.model, 'model'),
    stream: optionalBoolean(body.stream, 'stream') ?? false,
    includeUsage: optionalBoolean(streamOptions?.include_usage, 'stream_options.include_usage') ?? false,
    system: joinSystem(system),
    messages,
    tools: body.tool_choice === 'none' ? undefined : declared,
    temperature: optionalNumber(body.temperature, 'temperature', 0, 2),
    maxTokens: optionalInteger(body.max_completion_tokens, 'max_completion_tokens') ?? optionalInteger(body.max_tokens, 'max_tokens'),
    stop: stopSequences(body.stop, 'stop'),
    reasoningEffort: optionalString(body.reasoning_effort, 'reasoning_effort'),
  }
}

export function chatFinishReason(finish: FinishReason): string {
  switch (finish.kind) {
    case 'tool-calls': return 'tool_calls'
    case 'max-tokens': return 'length'
    default: return 'stop'
  }
}

function chatUsage(usage: TokenUsage | undefined): Record<string, unknown> {
  const full = fullUsage(usage)
  return {
    prompt_tokens: full.inputTokens,
    completion_tokens: full.outputTokens,
    total_tokens: full.totalTokens,
    prompt_tokens_details: { cached_tokens: full.cacheReadTokens },
    completion_tokens_details: { reasoning_tokens: full.reasoningTokens },
  }
}

export function chatErrorBody(code: string, message: string, param?: string): Record<string, unknown> {
  return { error: { message, type: code === 'invalid_request_error' || code === 'unsupported_parameter' ? 'invalid_request_error' : 'server_error', code, param: param ?? null } }
}

/** The complete `chat.completion` object of a finished generation. */
export function chatCompletion(model: string, blocks: readonly ContentBlock[], usage: TokenUsage | undefined, finish: FinishReason): Record<string, unknown> {
  let content = ''
  let reasoning = ''
  const toolCalls: Record<string, unknown>[] = []
  for (const block of blocks) {
    if (block.type === 'text') content += block.text
    else if (block.type === 'reasoning') reasoning += block.text
    else if (block.type === 'tool-call') toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } })
  }
  return {
    id: requestId('chatcmpl-'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content === '' && toolCalls.length > 0 ? null : content,
        ...reasoning === '' ? {} : { reasoning_content: reasoning },
        ...toolCalls.length === 0 ? {} : { tool_calls: toolCalls },
      },
      logprobs: null,
      finish_reason: chatFinishReason(finish),
    }],
    usage: chatUsage(usage),
  }
}

/** `chat.completion.chunk` SSE frames; usage rides a final choices-less chunk when requested. */
export class ChatStreamEncoder implements StreamEncoder {
  private readonly id = requestId('chatcmpl-')
  private readonly created = Math.floor(Date.now() / 1000)
  private readonly toolOrdinal = new Map<number, number>()
  private readonly announced = new Set<number>()
  private roleSent = false
  private usage: TokenUsage | undefined

  constructor(private readonly model: string, private readonly includeUsage: boolean) {}

  private chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
    const payload: Record<string, unknown> = this.roleSent ? delta : { role: 'assistant', ...delta }
    this.roleSent = true
    return sse({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta: payload, logprobs: null, finish_reason: finishReason }] })
  }

  start(): string { return '' }

  push(chunk: StreamChunk): string {
    switch (chunk.type) {
      case 'block-start':
        if (chunk.blockType === 'tool-call') this.toolOrdinal.set(chunk.index, this.toolOrdinal.size)
        return ''
      case 'text-delta':
        return chunk.text === '' ? '' : this.chunk({ content: chunk.text })
      case 'reasoning-delta':
        return chunk.text === '' ? '' : this.chunk({ reasoning_content: chunk.text })
      case 'tool-call-delta': {
        if (!this.toolOrdinal.has(chunk.index)) this.toolOrdinal.set(chunk.index, this.toolOrdinal.size)
        const ordinal = this.toolOrdinal.get(chunk.index) as number
        const first = !this.announced.has(chunk.index)
        this.announced.add(chunk.index)
        const call: Record<string, unknown> = { index: ordinal, function: { arguments: chunk.argumentsDelta, ...first || chunk.name !== undefined ? { name: chunk.name ?? '' } : {} } }
        if (first) { call.id = String(chunk.id); call.type = 'function' }
        return this.chunk({ tool_calls: [call] })
      }
      case 'usage':
        this.usage = chunk.usage
        return ''
      case 'finish': {
        const failure = finishFailure(chunk.reason)
        if (failure !== undefined) return this.fail(failure)
        let frames = this.chunk({}, chatFinishReason(chunk.reason))
        if (this.includeUsage) {
          frames += sse({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [], usage: chatUsage(this.usage) })
        }
        return frames
      }
      default:
        return ''
    }
  }

  end(): string { return 'data: [DONE]\n\n' }

  fail(error: { code: string; message: string }): string {
    return sse({ error: { message: error.message, type: 'server_error', code: error.code } })
  }
}
