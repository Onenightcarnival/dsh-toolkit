/**
 * The gateway's own HTTP listener: bearer-key authentication, the three
 * protocol endpoints, model listing, streaming relay and the usage ledger entry
 * of every authenticated request.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { KeyStore } from './keys.ts'
import { presentedKey } from './keys.ts'
import { ModelCatalog, ModelResolutionError, type ResolvedModel } from './models.ts'
import type { ApiKeyView } from './protocol.ts'
import type { UsageStore } from './usage.ts'
import { GatewayError, finishFailure, fullUsage, materialize, type ImageResolver, type ParsedRequest, type Protocol, type StreamEncoder } from './translate/common.ts'
import { ChatStreamEncoder, chatCompletion, chatErrorBody, parseChatRequest } from './translate/openai-chat.ts'
import { ResponsesStreamEncoder, parseResponsesRequest, responsesCompletion, responsesErrorBody } from './translate/openai-responses.ts'
import { AnthropicStreamEncoder, anthropicErrorBody, anthropicMessage, parseMessagesRequest } from './translate/anthropic.ts'

export interface GatewayLog {
  info(message: string): void
  warn(message: string): void
}

export interface GatewayServerDeps {
  llm: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> }
  catalog: ModelCatalog
  keys: KeyStore
  usage: UsageStore
  resolveImage: ImageResolver
  maxBodyBytes: number
  log: GatewayLog
}

export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024

const PROTOCOL_PATHS: Record<string, Protocol> = {
  '/v1/chat/completions': 'chat',
  '/v1/responses': 'responses',
  '/v1/messages': 'messages',
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta, openai-beta',
  'access-control-max-age': '600',
}

interface Failure { status: number; code: string; message: string; param?: string }

/** Status, code and message of any failure raised while serving a request. */
export function describeFailure(error: unknown, aborted: boolean): Failure {
  if (error instanceof GatewayError) return { status: error.status, code: error.code, message: error.message, param: error.param }
  if (error instanceof ModelResolutionError) return { status: 404, code: 'model_not_found', message: error.message, param: 'model' }
  if (aborted) return { status: 499, code: 'client_closed_request', message: 'the client closed the connection' }
  if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string') {
    const failure = (error as { failure?: { status?: number } }).failure
    const upstream = failure?.status
    const status = upstream !== undefined && upstream >= 400 && upstream <= 599 ? upstream : 502
    return { status, code: (error as { code: string }).code, message: error instanceof Error ? error.message : String(error) }
  }
  return { status: 500, code: 'internal_error', message: error instanceof Error ? error.message : String(error) }
}

function errorBody(protocol: Protocol | 'models', failure: Failure, anthropicShape: boolean): Record<string, unknown> {
  if (protocol === 'messages' || (protocol === 'models' && anthropicShape)) return anthropicErrorBody(failure.code, failure.message)
  if (protocol === 'responses') return responsesErrorBody(failure.code, failure.message, failure.param)
  return chatErrorBody(failure.code, failure.message, failure.param)
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS_HEADERS })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) {
      req.destroy()
      throw new GatewayError(413, 'request_too_large', `request body exceeds ${maxBytes} bytes`)
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') throw new GatewayError(400, 'invalid_request_error', 'request body is empty')
  try {
    return JSON.parse(text)
  } catch {
    throw new GatewayError(400, 'invalid_request_error', 'request body is not valid JSON')
  }
}

function parse(protocol: Protocol, body: unknown): ParsedRequest {
  if (protocol === 'chat') return parseChatRequest(body)
  if (protocol === 'responses') return parseResponsesRequest(body)
  return parseMessagesRequest(body)
}

function encoderFor(protocol: Protocol, modelId: string, includeUsage: boolean): StreamEncoder {
  if (protocol === 'chat') return new ChatStreamEncoder(modelId, includeUsage)
  if (protocol === 'responses') return new ResponsesStreamEncoder(modelId)
  return new AnthropicStreamEncoder(modelId)
}

function completion(protocol: Protocol, modelId: string, assembler: BlockAssembler): Record<string, unknown> {
  const blocks = assembler.blocks()
  if (protocol === 'chat') return chatCompletion(modelId, blocks, assembler.usage, assembler.finish)
  if (protocol === 'responses') return responsesCompletion(modelId, blocks, assembler.usage, assembler.finish)
  return anthropicMessage(modelId, blocks, assembler.usage, assembler.finish)
}

function isContentDelta(chunk: StreamChunk): boolean {
  return chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta'
}

/** Create the listener; `listen` is left to the caller. */
export function createGatewayServer(deps: GatewayServerDeps): Server {
  const server = createServer((req, res) => {
    handle(deps, req, res).catch((error: unknown) => {
      deps.log.warn(`gateway: unhandled failure: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) writeJson(res, 500, chatErrorBody('internal_error', 'internal error'))
      else res.end()
    })
  })
  server.keepAliveTimeout = 65_000
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  return server
}

export function listen(server: Server, host: string, port: number): Promise<{ host: string; port: number }> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { server.off('listening', onListening); reject(error) }
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      resolve({ host, port: typeof address === 'object' && address !== null ? address.port : port })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

export function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections()
    server.close(error => { if (error === undefined) resolve(); else reject(error) })
  })
}

async function handle(deps: GatewayServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? '/').split('?')[0]
  const anthropicShape = req.headers['anthropic-version'] !== undefined || typeof req.headers['x-api-key'] === 'string'
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }
  const protocol: Protocol | 'models' | undefined = path === '/v1/models' ? 'models' : PROTOCOL_PATHS[path]
  if (protocol === undefined) {
    writeJson(res, 404, errorBody('chat', { status: 404, code: 'not_found', message: `no route for ${req.method ?? ''} ${path}` }, anthropicShape))
    return
  }
  const key = deps.keys.verify(presentedKey(req.headers))
  if (key === undefined) {
    const code = protocol === 'messages' || (protocol === 'models' && anthropicShape) ? 'authentication_error' : 'invalid_api_key'
    res.setHeader('www-authenticate', 'Bearer')
    writeJson(res, 401, errorBody(protocol, { status: 401, code, message: 'missing or invalid API key' }, anthropicShape))
    return
  }
  if (protocol === 'models') {
    if (req.method !== 'GET') {
      writeJson(res, 405, errorBody('models', { status: 405, code: 'method_not_allowed', message: 'use GET' }, anthropicShape))
      return
    }
    const models = (await deps.catalog.list()).filter(model => key.models === null || key.models.includes(model.id))
    const created = Math.floor(Date.now() / 1000)
    writeJson(res, 200, anthropicShape
      ? { data: models.map(model => ({ id: model.id, type: 'model', display_name: model.name, created_at: new Date(created * 1000).toISOString() })), has_more: false, first_id: models[0]?.id ?? null, last_id: models[models.length - 1]?.id ?? null }
      : { object: 'list', data: models.map(model => ({ id: model.id, object: 'model', created, owned_by: model.provider })) })
    return
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, errorBody(protocol, { status: 405, code: 'method_not_allowed', message: 'use POST' }, anthropicShape))
    return
  }
  await serve(deps, protocol, key, req, res)
}

async function serve(deps: GatewayServerDeps, protocol: Protocol, key: ApiKeyView, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now()
  const controller = new AbortController()
  let settled = false
  res.on('close', () => { if (!settled) controller.abort() })
  let target: ResolvedModel | undefined
  let parsed: ParsedRequest | undefined
  let usage: TokenUsage | undefined
  let finish: FinishReason | undefined
  let ttft: number | null = null
  let failure: Failure | undefined
  let streamed = false
  try {
    const body = await readBody(req, deps.maxBodyBytes)
    parsed = parse(protocol, body)
    target = deps.catalog.resolve(parsed.model)
    if (key.models !== null && !key.models.includes(target.id)) {
      throw new GatewayError(403, protocol === 'messages' ? 'permission_error' : 'model_not_allowed', `this API key may not use model "${target.id}"`, 'model')
    }
    const options = await materialize(parsed, target, deps.resolveImage, controller.signal)
    if (parsed.stream) {
      streamed = true
      const encoder = encoderFor(protocol, target.id, parsed.includeUsage)
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', ...CORS_HEADERS })
      res.write(encoder.start())
      for await (const chunk of deps.llm.stream(options)) {
        if (ttft === null && isContentDelta(chunk)) ttft = Date.now() - started
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish') finish = chunk.reason
        res.write(encoder.push(chunk))
      }
      if (finish === undefined) {
        finish = { kind: 'stop' }
        res.write(encoder.push({ type: 'finish', reason: finish }))
      }
      res.write(encoder.end())
      res.end()
      const finishFail = finishFailure(finish)
      if (finishFail !== undefined) failure = finishFail
    } else {
      const assembler = new BlockAssembler()
      for await (const chunk of deps.llm.stream(options)) {
        if (ttft === null && isContentDelta(chunk)) ttft = Date.now() - started
        if (chunk.type === 'usage') usage = chunk.usage
        assembler.push(chunk)
      }
      finish = assembler.finish
      usage = assembler.usage ?? usage
      const finishFail = finishFailure(finish)
      if (finishFail !== undefined) {
        failure = finishFail
        writeJson(res, failure.status, errorBody(protocol, failure, false))
      } else {
        writeJson(res, 200, completion(protocol, target.id, assembler))
      }
    }
  } catch (error) {
    failure = describeFailure(error, controller.signal.aborted)
    if (!res.headersSent) {
      writeJson(res, failure.status, errorBody(protocol, failure, false))
    } else if (streamed && !res.writableEnded) {
      const encoder = encoderFor(protocol, target?.id ?? '', false)
      res.write(encoder.fail(failure))
      res.write(encoder.end())
      res.end()
    }
  } finally {
    settled = true
    const counted = fullUsage(usage)
    try {
      deps.usage.record({
        time: started,
        keyId: key.id,
        keyName: key.name,
        protocol,
        provider: target?.provider ?? '',
        model: target?.model ?? '',
        modelId: target?.id ?? (parsed?.model ?? ''),
        stream: parsed?.stream ?? false,
        inputTokens: counted.inputTokens,
        outputTokens: counted.outputTokens,
        cacheReadTokens: counted.cacheReadTokens,
        cacheWriteTokens: counted.cacheWriteTokens,
        reasoningTokens: counted.reasoningTokens,
        ttftMs: ttft,
        durationMs: Date.now() - started,
        status: failure?.status ?? 200,
        errorCode: failure?.code ?? null,
      })
      deps.keys.touch(key.id)
    } catch (error) {
      deps.log.warn(`gateway: usage record failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
