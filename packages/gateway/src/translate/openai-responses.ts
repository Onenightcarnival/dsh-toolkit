/** OpenAI Responses: request parsing, the semantic event stream and the complete response object. */
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  argumentsText, finishFailure, fullUsage, imageFromDataUrl, invalid, isRecord, joinSystem, optionalBoolean, optionalInteger,
  optionalNumber, optionalString, parameterSchema, requestId, sse, toolName, unsupported,
  type DraftBlock, type DraftMessage, type ParsedRequest, type StreamEncoder,
} from './common.ts'

function partBlocks(content: unknown, param: string, allowImages: boolean): DraftBlock[] {
  if (content === undefined || content === null) return []
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  if (!Array.isArray(content)) throw invalid(`"${param}" must be a string or a list of content parts`, param)
  const blocks: DraftBlock[] = []
  content.forEach((part: unknown, index) => {
    const where = `${param}[${index}]`
    if (!isRecord(part)) throw invalid(`"${where}" must be an object`, where)
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      if (typeof part.text !== 'string') throw invalid(`"${where}.text" must be a string`, where)
      blocks.push({ type: 'text', text: part.text })
    } else if (part.type === 'input_image' && allowImages) {
      const url = typeof part.image_url === 'string' ? part.image_url : isRecord(part.image_url) ? part.image_url.url : undefined
      if (typeof url !== 'string' || url === '') throw invalid(`"${where}.image_url" must carry a URL`, where)
      blocks.push(imageFromDataUrl(url))
    } else if (part.type === 'refusal') {
      // Refusal text of an earlier turn is replayed as plain text.
      if (typeof part.refusal === 'string') blocks.push({ type: 'text', text: part.refusal })
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
    return {
      name: toolName(tool.name, `${where}.name`),
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: parameterSchema(tool.parameters, `${where}.parameters`),
    }
  })
}

function pushAssistant(messages: DraftMessage[], content: DraftBlock[]): void {
  const last = messages[messages.length - 1]
  if (last?.role === 'assistant') last.content.push(...content)
  else messages.push({ role: 'assistant', content })
}

/** @throws {GatewayError} 400 for malformed or unsupported requests. */
export function parseResponsesRequest(body: unknown): ParsedRequest {
  if (!isRecord(body)) throw invalid('request body must be a JSON object')
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) throw unsupported('previous_response_id')
  const text = isRecord(body.text) ? body.text : undefined
  const format = text !== undefined && isRecord(text.format) ? text.format : undefined
  if (format !== undefined && format.type !== 'text' && format.type !== undefined) throw unsupported(`text.format.type=${String(format.type)}`)
  const system: string[] = []
  const instructions = optionalString(body.instructions, 'instructions')
  if (instructions !== undefined) system.push(instructions)
  const messages: DraftMessage[] = []
  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: [{ type: 'text', text: body.input }] })
  } else if (Array.isArray(body.input)) {
    body.input.forEach((item: unknown, index) => {
      const where = `input[${index}]`
      if (!isRecord(item)) throw invalid(`"${where}" must be an object`, where)
      const type = item.type ?? (item.role === undefined ? undefined : 'message')
      switch (type) {
        case 'message': {
          const role = item.role
          if (role === 'system' || role === 'developer') {
            system.push(partBlocks(item.content, `${where}.content`, false).map(block => block.type === 'text' ? block.text : '').join(''))
          } else if (role === 'user') {
            messages.push({ role: 'user', content: partBlocks(item.content, `${where}.content`, true) })
          } else if (role === 'assistant') {
            pushAssistant(messages, partBlocks(item.content, `${where}.content`, false))
          } else {
            throw invalid(`"${where}.role" must be system, developer, user or assistant`, where)
          }
          break
        }
        case 'function_call': {
          if (typeof item.call_id !== 'string' || item.call_id === '') throw invalid(`"${where}.call_id" must be a string`, where)
          pushAssistant(messages, [{ type: 'tool-call', id: item.call_id, name: toolName(item.name, `${where}.name`), arguments: argumentsText(item.arguments) }])
          break
        }
        case 'function_call_output': {
          if (typeof item.call_id !== 'string' || item.call_id === '') throw invalid(`"${where}.call_id" must be a string`, where)
          const output = typeof item.output === 'string' ? [{ type: 'text', text: item.output } as DraftBlock] : partBlocks(item.output, `${where}.output`, false)
          messages.push({ role: 'tool', callId: item.call_id, content: output, isError: false })
          break
        }
        case 'reasoning':
          break
        default:
          throw unsupported(`${where}.type=${String(type)}`)
      }
    })
  } else {
    throw invalid('"input" must be a string or a list of items', 'input')
  }
  const declared = tools(body.tools)
  const reasoning = isRecord(body.reasoning) ? body.reasoning : undefined
  return {
    model: optionalString(body.model, 'model'),
    stream: optionalBoolean(body.stream, 'stream') ?? false,
    includeUsage: true,
    system: joinSystem(system),
    messages,
    tools: body.tool_choice === 'none' ? undefined : declared,
    temperature: optionalNumber(body.temperature, 'temperature', 0, 2),
    maxTokens: optionalInteger(body.max_output_tokens, 'max_output_tokens'),
    stop: undefined,
    reasoningEffort: optionalString(reasoning?.effort, 'reasoning.effort'),
  }
}

function responsesUsage(usage: TokenUsage | undefined): Record<string, unknown> {
  const full = fullUsage(usage)
  return {
    input_tokens: full.inputTokens,
    input_tokens_details: { cached_tokens: full.cacheReadTokens },
    output_tokens: full.outputTokens,
    output_tokens_details: { reasoning_tokens: full.reasoningTokens },
    total_tokens: full.totalTokens,
  }
}

export function responsesErrorBody(code: string, message: string, param?: string): Record<string, unknown> {
  return { error: { type: code === 'invalid_request_error' || code === 'unsupported_parameter' ? 'invalid_request_error' : 'server_error', code, message, param: param ?? null } }
}

/** Output items of finished blocks, in block order. */
export function responsesOutput(blocks: readonly ContentBlock[]): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      output.push({ id: requestId('msg_'), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: block.text, annotations: [] }] })
    } else if (block.type === 'reasoning') {
      output.push({ id: requestId('rs_'), type: 'reasoning', summary: block.text === '' ? [] : [{ type: 'summary_text', text: block.text }] })
    } else if (block.type === 'tool-call') {
      output.push({ id: requestId('fc_'), type: 'function_call', status: 'completed', call_id: String(block.id), name: block.name, arguments: block.arguments })
    }
  }
  return output
}

function responseObject(id: string, created: number, model: string, status: string, output: Record<string, unknown>[], usage: TokenUsage | undefined, finish: FinishReason | undefined): Record<string, unknown> {
  return {
    id,
    object: 'response',
    created_at: created,
    status,
    model,
    output,
    error: null,
    incomplete_details: finish?.kind === 'max-tokens' ? { reason: 'max_output_tokens' } : null,
    usage: status === 'in_progress' ? null : responsesUsage(usage),
  }
}

/** The complete `response` object of a finished generation. */
export function responsesCompletion(model: string, blocks: readonly ContentBlock[], usage: TokenUsage | undefined, finish: FinishReason): Record<string, unknown> {
  return responseObject(requestId('resp_'), Math.floor(Date.now() / 1000), model, finish.kind === 'max-tokens' ? 'incomplete' : 'completed', responsesOutput(blocks), usage, finish)
}

interface OpenItem {
  outputIndex: number
  itemId: string
  kind: 'message' | 'reasoning' | 'function_call'
  text: string
  callId: string
  name: string
}

/** Responses semantic events with sequence numbers; items open per host block. */
export class ResponsesStreamEncoder implements StreamEncoder {
  private readonly id = requestId('resp_')
  private readonly created = Math.floor(Date.now() / 1000)
  private readonly items = new Map<number, OpenItem>()
  private readonly done: Record<string, unknown>[] = []
  private sequence = 0
  private nextOutputIndex = 0
  private usage: TokenUsage | undefined

  constructor(private readonly model: string) {}

  private event(type: string, payload: Record<string, unknown>): string {
    return sse({ type, sequence_number: this.sequence++, ...payload }, type)
  }

  private open(index: number, kind: OpenItem['kind'], callId = '', name = ''): { item: OpenItem; frames: string } {
    const item: OpenItem = { outputIndex: this.nextOutputIndex++, itemId: requestId(kind === 'message' ? 'msg_' : kind === 'reasoning' ? 'rs_' : 'fc_'), kind, text: '', callId, name }
    this.items.set(index, item)
    let frames = ''
    if (kind === 'message') {
      frames += this.event('response.output_item.added', { output_index: item.outputIndex, item: { id: item.itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } })
      frames += this.event('response.content_part.added', { item_id: item.itemId, output_index: item.outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
    } else if (kind === 'reasoning') {
      frames += this.event('response.output_item.added', { output_index: item.outputIndex, item: { id: item.itemId, type: 'reasoning', summary: [] } })
    } else {
      frames += this.event('response.output_item.added', { output_index: item.outputIndex, item: { id: item.itemId, type: 'function_call', status: 'in_progress', call_id: callId, name, arguments: '' } })
    }
    return { item, frames }
  }

  private close(index: number): string {
    const item = this.items.get(index)
    if (item === undefined) return ''
    this.items.delete(index)
    let frames = ''
    let finished: Record<string, unknown>
    if (item.kind === 'message') {
      finished = { id: item.itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: item.text, annotations: [] }] }
      frames += this.event('response.output_text.done', { item_id: item.itemId, output_index: item.outputIndex, content_index: 0, text: item.text })
      frames += this.event('response.content_part.done', { item_id: item.itemId, output_index: item.outputIndex, content_index: 0, part: { type: 'output_text', text: item.text, annotations: [] } })
    } else if (item.kind === 'reasoning') {
      finished = { id: item.itemId, type: 'reasoning', summary: item.text === '' ? [] : [{ type: 'summary_text', text: item.text }] }
      if (item.text !== '') frames += this.event('response.reasoning_summary_text.done', { item_id: item.itemId, output_index: item.outputIndex, summary_index: 0, text: item.text })
    } else {
      finished = { id: item.itemId, type: 'function_call', status: 'completed', call_id: item.callId, name: item.name, arguments: item.text }
      frames += this.event('response.function_call_arguments.done', { item_id: item.itemId, output_index: item.outputIndex, arguments: item.text })
    }
    frames += this.event('response.output_item.done', { output_index: item.outputIndex, item: finished })
    this.done[item.outputIndex] = finished
    return frames
  }

  start(): string {
    const response = responseObject(this.id, this.created, this.model, 'in_progress', [], undefined, undefined)
    return this.event('response.created', { response }) + this.event('response.in_progress', { response })
  }

  push(chunk: StreamChunk): string {
    switch (chunk.type) {
      case 'block-start':
        if (chunk.blockType === 'text') return this.open(chunk.index, 'message').frames
        if (chunk.blockType === 'reasoning') return this.open(chunk.index, 'reasoning').frames
        return ''
      case 'text-delta': {
        const opened = this.items.get(chunk.index) ?? this.open(chunk.index, 'message').item
        opened.text += chunk.text
        return chunk.text === '' ? '' : this.event('response.output_text.delta', { item_id: opened.itemId, output_index: opened.outputIndex, content_index: 0, delta: chunk.text })
      }
      case 'reasoning-delta': {
        const opened = this.items.get(chunk.index) ?? this.open(chunk.index, 'reasoning').item
        opened.text += chunk.text
        return chunk.text === '' ? '' : this.event('response.reasoning_summary_text.delta', { item_id: opened.itemId, output_index: opened.outputIndex, summary_index: 0, delta: chunk.text })
      }
      case 'tool-call-delta': {
        let frames = ''
        let opened = this.items.get(chunk.index)
        if (opened === undefined) {
          const result = this.open(chunk.index, 'function_call', String(chunk.id), chunk.name ?? '')
          opened = result.item
          frames += result.frames
        } else if (chunk.name !== undefined && opened.name === '') {
          opened.name = chunk.name
        }
        opened.text += chunk.argumentsDelta
        if (chunk.argumentsDelta !== '') frames += this.event('response.function_call_arguments.delta', { item_id: opened.itemId, output_index: opened.outputIndex, delta: chunk.argumentsDelta })
        return frames
      }
      case 'block-end':
        return this.close(chunk.index)
      case 'usage':
        this.usage = chunk.usage
        return ''
      case 'finish': {
        const failure = finishFailure(chunk.reason)
        if (failure !== undefined) return this.fail(failure)
        let frames = ''
        for (const index of [...this.items.keys()]) frames += this.close(index)
        const output = this.done.filter((item): item is Record<string, unknown> => item !== undefined)
        const status = chunk.reason.kind === 'max-tokens' ? 'incomplete' : 'completed'
        frames += this.event(status === 'completed' ? 'response.completed' : 'response.incomplete', { response: responseObject(this.id, this.created, this.model, status, output, this.usage, chunk.reason) })
        return frames
      }
      default:
        return ''
    }
  }

  end(): string { return '' }

  fail(error: { code: string; message: string }): string {
    const response = { ...responseObject(this.id, this.created, this.model, 'failed', this.done.filter(item => item !== undefined), this.usage, undefined), error: { code: error.code, message: error.message } }
    return this.event('response.failed', { response }) + this.event('error', { code: error.code, message: error.message, param: null })
  }
}
