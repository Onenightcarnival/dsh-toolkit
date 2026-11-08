/** Anthropic Messages: request parsing, the content-block event stream and the complete message object. */
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  argumentsObject, argumentsText, finishFailure, fullUsage, invalid, isRecord, joinSystem, optionalBoolean, optionalInteger, optionalNumber,
  optionalString, parameterSchema, requestId, sse, stopSequences, toolName, unsupported,
  type DraftBlock, type DraftMessage, type ParsedRequest, type PendingImage, type StreamEncoder,
} from './common.ts'

function image(source: unknown, where: string): PendingImage {
  if (!isRecord(source)) throw invalid(`"${where}.source" must be an object`, where)
  if (source.type === 'base64') {
    if (typeof source.media_type !== 'string' || typeof source.data !== 'string') throw invalid(`"${where}.source" must carry media_type and data`, where)
    return { type: 'pending-image', source: { kind: 'base64', mediaType: source.media_type, data: source.data } }
  }
  if (source.type === 'url') {
    if (typeof source.url !== 'string' || source.url === '') throw invalid(`"${where}.source.url" must be a string`, where)
    return { type: 'pending-image', source: { kind: 'url', url: source.url } }
  }
  throw unsupported(`${where}.source.type=${String(source.type)}`)
}

/** Text and image blocks of one content value; tool blocks are handled by the caller. */
function plainBlocks(content: unknown, where: string, allowImages: boolean): DraftBlock[] {
  if (content === undefined || content === null) return []
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  if (!Array.isArray(content)) throw invalid(`"${where}" must be a string or a list of blocks`, where)
  const blocks: DraftBlock[] = []
  content.forEach((block: unknown, index) => {
    const at = `${where}[${index}]`
    if (!isRecord(block)) throw invalid(`"${at}" must be an object`, at)
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw invalid(`"${at}.text" must be a string`, at)
      blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'image' && allowImages) {
      blocks.push(image(block.source, at))
    } else {
      throw unsupported(`${at}.type=${String(block.type)}`)
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
    if (tool.type !== undefined && tool.type !== 'custom') throw unsupported(`${where}.type=${String(tool.type)}`)
    return {
      name: toolName(tool.name, `${where}.name`),
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: parameterSchema(tool.input_schema, `${where}.input_schema`),
    }
  })
}

/** @throws {GatewayError} 400 for malformed or unsupported requests. */
export function parseMessagesRequest(body: unknown): ParsedRequest {
  if (!isRecord(body)) throw invalid('request body must be a JSON object')
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw invalid('"messages" must be a non-empty list', 'messages')
  const system: string[] = []
  if (typeof body.system === 'string') system.push(body.system)
  else if (body.system !== undefined && body.system !== null) {
    system.push(plainBlocks(body.system, 'system', false).map(block => block.type === 'text' ? block.text : '').join(''))
  }
  const messages: DraftMessage[] = []
  body.messages.forEach((message: unknown, index) => {
    const where = `messages[${index}]`
    if (!isRecord(message)) throw invalid(`"${where}" must be an object`, where)
    if (message.role !== 'user' && message.role !== 'assistant') throw invalid(`"${where}.role" must be user or assistant`, where)
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content === '' ? [] : [{ type: 'text', text: message.content }] })
      return
    }
    if (!Array.isArray(message.content)) throw invalid(`"${where}.content" must be a string or a list of blocks`, where)
    const content: DraftBlock[] = []
    const toolResults: DraftMessage[] = []
    message.content.forEach((block: unknown, blockIndex) => {
      const at = `${where}.content[${blockIndex}]`
      if (!isRecord(block)) throw invalid(`"${at}" must be an object`, at)
      switch (block.type) {
        case 'text':
          if (typeof block.text !== 'string') throw invalid(`"${at}.text" must be a string`, at)
          content.push({ type: 'text', text: block.text })
          break
        case 'image':
          if (message.role !== 'user') throw unsupported(`${at}.type=image in an assistant message`)
          content.push(image(block.source, at))
          break
        case 'tool_use':
          if (message.role !== 'assistant') throw invalid(`"${at}" tool_use belongs to assistant messages`, at)
          if (typeof block.id !== 'string' || block.id === '') throw invalid(`"${at}.id" must be a string`, at)
          content.push({ type: 'tool-call', id: block.id, name: toolName(block.name, `${at}.name`), arguments: argumentsText(block.input) })
          break
        case 'tool_result': {
          if (message.role !== 'user') throw invalid(`"${at}" tool_result belongs to user messages`, at)
          if (typeof block.tool_use_id !== 'string' || block.tool_use_id === '') throw invalid(`"${at}.tool_use_id" must be a string`, at)
          toolResults.push({ role: 'tool', callId: block.tool_use_id, content: plainBlocks(block.content, `${at}.content`, true), isError: block.is_error === true })
          break
        }
        case 'thinking':
        case 'redacted_thinking':
          break
        default:
          throw unsupported(`${at}.type=${String(block.type)}`)
      }
    })
    messages.push(...toolResults)
    if (content.length > 0 || toolResults.length === 0) messages.push({ role: message.role, content })
  })
  const declared = tools(body.tools)
  const toolChoice = isRecord(body.tool_choice) ? body.tool_choice.type : undefined
  return {
    model: optionalString(body.model, 'model'),
    stream: optionalBoolean(body.stream, 'stream') ?? false,
    includeUsage: true,
    system: joinSystem(system),
    messages,
    tools: toolChoice === 'none' ? undefined : declared,
    temperature: optionalNumber(body.temperature, 'temperature', 0, 1),
    maxTokens: optionalInteger(body.max_tokens, 'max_tokens'),
    stop: stopSequences(body.stop_sequences, 'stop_sequences'),
    reasoningEffort: undefined,
  }
}

export function anthropicStopReason(finish: FinishReason): string {
  switch (finish.kind) {
    case 'tool-calls': return 'tool_use'
    case 'max-tokens': return 'max_tokens'
    default: return 'end_turn'
  }
}

function anthropicUsage(usage: TokenUsage | undefined): Record<string, unknown> {
  const full = fullUsage(usage)
  return { input_tokens: full.inputTokens, output_tokens: full.outputTokens, cache_read_input_tokens: full.cacheReadTokens, cache_creation_input_tokens: full.cacheWriteTokens }
}

export function anthropicErrorBody(code: string, message: string): Record<string, unknown> {
  const type = code === 'invalid_request_error' || code === 'unsupported_parameter' ? 'invalid_request_error'
    : code === 'authentication_error' ? 'authentication_error'
    : code === 'permission_error' ? 'permission_error'
    : code === 'not_found_error' ? 'not_found_error' : 'api_error'
  return { type: 'error', error: { type, message } }
}

export function anthropicContent(blocks: readonly ContentBlock[]): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = []
  for (const block of blocks) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text })
    else if (block.type === 'reasoning') content.push({ type: 'thinking', thinking: block.text, signature: '' })
    else if (block.type === 'tool-call') content.push({ type: 'tool_use', id: String(block.id), name: block.name, input: argumentsObject(block.arguments) })
  }
  return content
}

/** The complete `message` object of a finished generation. */
export function anthropicMessage(model: string, blocks: readonly ContentBlock[], usage: TokenUsage | undefined, finish: FinishReason): Record<string, unknown> {
  return { id: requestId('msg_'), type: 'message', role: 'assistant', model, content: anthropicContent(blocks), stop_reason: anthropicStopReason(finish), stop_sequence: null, usage: anthropicUsage(usage) }
}

interface OpenBlock { index: number; started: boolean; kind: 'text' | 'thinking' | 'tool_use' }

/** Anthropic event stream; `tool_use` blocks open on their first delta, when id and name are known. */
export class AnthropicStreamEncoder implements StreamEncoder {
  private readonly id = requestId('msg_')
  private readonly blocks = new Map<number, OpenBlock>()
  private nextIndex = 0
  private usage: TokenUsage | undefined

  constructor(private readonly model: string) {}

  private event(type: string, payload: Record<string, unknown>): string {
    return sse({ type, ...payload }, type)
  }

  private allocate(hostIndex: number, kind: OpenBlock['kind']): OpenBlock {
    let block = this.blocks.get(hostIndex)
    if (block === undefined) {
      block = { index: this.nextIndex++, started: false, kind }
      this.blocks.set(hostIndex, block)
    }
    return block
  }

  private begin(block: OpenBlock, contentBlock: Record<string, unknown>): string {
    if (block.started) return ''
    block.started = true
    return this.event('content_block_start', { index: block.index, content_block: contentBlock })
  }

  start(): string {
    return this.event('message_start', { message: { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })
  }

  push(chunk: StreamChunk): string {
    switch (chunk.type) {
      case 'block-start':
        if (chunk.blockType === 'text') return this.begin(this.allocate(chunk.index, 'text'), { type: 'text', text: '' })
        if (chunk.blockType === 'reasoning') return this.begin(this.allocate(chunk.index, 'thinking'), { type: 'thinking', thinking: '' })
        if (chunk.blockType === 'tool-call') this.allocate(chunk.index, 'tool_use')
        return ''
      case 'text-delta': {
        const block = this.allocate(chunk.index, 'text')
        return this.begin(block, { type: 'text', text: '' }) + (chunk.text === '' ? '' : this.event('content_block_delta', { index: block.index, delta: { type: 'text_delta', text: chunk.text } }))
      }
      case 'reasoning-delta': {
        const block = this.allocate(chunk.index, 'thinking')
        return this.begin(block, { type: 'thinking', thinking: '' }) + (chunk.text === '' ? '' : this.event('content_block_delta', { index: block.index, delta: { type: 'thinking_delta', thinking: chunk.text } }))
      }
      case 'tool-call-delta': {
        const block = this.allocate(chunk.index, 'tool_use')
        return this.begin(block, { type: 'tool_use', id: String(chunk.id), name: chunk.name ?? '', input: {} })
          + (chunk.argumentsDelta === '' ? '' : this.event('content_block_delta', { index: block.index, delta: { type: 'input_json_delta', partial_json: chunk.argumentsDelta } }))
      }
      case 'block-end': {
        const block = this.blocks.get(chunk.index)
        if (block === undefined) return ''
        this.blocks.delete(chunk.index)
        if (!block.started) return ''
        return this.event('content_block_stop', { index: block.index })
      }
      case 'usage':
        this.usage = chunk.usage
        return ''
      case 'finish': {
        const failure = finishFailure(chunk.reason)
        if (failure !== undefined) return this.fail(failure)
        let frames = ''
        for (const [hostIndex, block] of [...this.blocks]) {
          this.blocks.delete(hostIndex)
          if (block.started) frames += this.event('content_block_stop', { index: block.index })
        }
        frames += this.event('message_delta', { delta: { stop_reason: anthropicStopReason(chunk.reason), stop_sequence: null }, usage: anthropicUsage(this.usage) })
        frames += this.event('message_stop', {})
        return frames
      }
      default:
        return ''
    }
  }

  end(): string { return '' }

  fail(error: { code: string; message: string }): string {
    return this.event('error', { error: { type: 'api_error', message: `${error.code}: ${error.message}` } })
  }
}
