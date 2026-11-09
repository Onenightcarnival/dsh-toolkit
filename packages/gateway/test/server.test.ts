import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { KeyStore } from '../src/keys.ts'
import { ModelCatalog } from '../src/models.ts'
import { UsageStore } from '../src/usage.ts'
import { close, createGatewayServer, listen } from '../src/server.ts'

const settings = { enabled: true, host: '127.0.0.1', port: 0, aliases: { 'gpt-4o': 'echo:fast' }, pricing: {} }

/** Echo adapter: streams the last user text back, one tool call when a tool is declared, then usage. */
async function* echo(options: GenerateOptions): AsyncIterable<StreamChunk> {
  const last = options.messages[options.messages.length - 1]
  const text = (last.content as Array<{ type: string; text?: string }>).filter(block => block.type === 'text').map(block => block.text ?? '').join('')
  if (options.signal?.aborted) throw new Error('aborted before start')
  yield { type: 'block-start', index: 0, blockType: 'text' }
  for (const part of [`${options.model}:`, text]) {
    yield { type: 'text-delta', index: 0, text: part }
    await new Promise(resolve => setTimeout(resolve, 5))
    if (options.signal?.aborted) return
  }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: `${options.model}:${text}` } }
  if (options.tools && options.tools.length > 0) {
    const id = ToolCallId('call_echo')
    yield { type: 'block-start', index: 1, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 1, id, name: options.tools[0].name, argumentsDelta: '{}' }
    yield { type: 'block-end', index: 1, block: { type: 'tool-call', id, name: options.tools[0].name, arguments: '{}' } }
  }
  yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }
  yield { type: 'finish', reason: { kind: options.tools && options.tools.length > 0 ? 'tool-calls' : 'stop' } }
}

async function* failing(): AsyncIterable<StreamChunk> {
  yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'quota exceeded', status: 429 } } }
}

function readSse(text: string): Array<{ event?: string; data: string }> {
  return text.split('\n\n').filter(part => part.trim() !== '').map(part => {
    const lines = part.split('\n')
    return { event: lines.find(line => line.startsWith('event: '))?.slice(7), data: lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n') }
  })
}

test('gateway server: auth, models, three protocols, usage ledger', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gateway-server-'))
  const keys = new KeyStore(join(dir, 'keys.json'))
  const usage = new UsageStore(join(dir, 'usage.sqlite'))
  const full = keys.create('full', null).key
  const limited = keys.create('limited', ['echo:fast']).key
  let streamImpl: (options: GenerateOptions) => AsyncIterable<StreamChunk> = echo
  const catalog = new ModelCatalog({ listProviders: () => [{ id: 'echo', name: 'Echo' }], listModels: async () => [{ id: 'fast', name: 'Fast' }, { id: 'slow', name: 'Slow' }] }, () => settings, () => undefined)
  const server = createGatewayServer({ llm: { stream: options => streamImpl(options) }, catalog, keys, usage, resolveImage: async () => { throw new Error('no images') }, maxBodyBytes: 1024 * 1024, log: { info() {}, warn() {} } })
  const { port } = await listen(server, '127.0.0.1', 0)
  const base = `http://127.0.0.1:${port}`
  t.after(async () => { await close(server); usage.close(); rmSync(dir, { recursive: true, force: true }) })
  const post = (path: string, body: unknown, key = full, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

  // authentication
  assert.equal((await fetch(`${base}/v1/models`)).status, 401)
  assert.equal((await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer nope' } })).status, 401)
  const anthropic401 = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'nope', 'anthropic-version': '2023-06-01' }, body: '{}' })
  assert.equal(anthropic401.status, 401)
  assert.equal(((await anthropic401.json()) as { type: string }).type, 'error')
  assert.equal((await fetch(`${base}/v1/unknown`, { headers: { authorization: `Bearer ${full}` } })).status, 404)
  assert.equal((await fetch(`${base}/v1/models`, { method: 'OPTIONS' })).status, 204)

  // model listing per key
  const models = await (await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${full}` } })).json() as { data: Array<{ id: string }> }
  assert.deepEqual(models.data.map(model => model.id), ['echo:fast', 'echo:slow'])
  const limitedModels = await (await fetch(`${base}/v1/models`, { headers: { 'x-api-key': limited, 'anthropic-version': '2023-06-01' } })).json() as { data: Array<{ id: string; type: string }> }
  assert.deepEqual(limitedModels.data.map(model => [model.id, model.type]), [['echo:fast', 'model']])

  // chat completions, non-stream, alias
  const chat = await post('/v1/chat/completions', { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(chat.status, 200)
  const chatBody = await chat.json() as { model: string; choices: Array<{ message: { content: string }; finish_reason: string }>; usage: { total_tokens: number } }
  assert.equal(chatBody.model, 'echo:fast')
  assert.equal(chatBody.choices[0].message.content, 'fast:hi')
  assert.equal(chatBody.usage.total_tokens, 5)

  // chat completions, stream with usage, tool call
  const stream = await post('/v1/chat/completions', { model: 'echo:slow', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'yo' }], tools: [{ type: 'function', function: { name: 'ping', parameters: {} } }] })
  assert.equal(stream.status, 200)
  assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/)
  const chatFrames = readSse(await stream.text())
  assert.equal(chatFrames.at(-1)?.data, '[DONE]')
  const chunks = chatFrames.slice(0, -1).map(frame => JSON.parse(frame.data) as { choices: Array<{ delta: { content?: string; tool_calls?: unknown[] }; finish_reason: string | null }>; usage?: { total_tokens: number } })
  assert.equal(chunks.map(chunk => chunk.choices[0]?.delta.content ?? '').join(''), 'slow:yo')
  assert.ok(chunks.some(chunk => chunk.choices[0]?.delta.tool_calls))
  assert.ok(chunks.some(chunk => chunk.choices[0]?.finish_reason === 'tool_calls'))
  assert.equal(chunks.at(-1)?.usage?.total_tokens, 5)

  // key model restriction
  const denied = await post('/v1/chat/completions', { model: 'echo:slow', messages: [{ role: 'user', content: 'x' }] }, limited)
  assert.equal(denied.status, 403)

  // unsupported parameter and malformed body
  assert.equal((await post('/v1/chat/completions', { model: 'echo:fast', n: 3, messages: [{ role: 'user', content: 'x' }] })).status, 400)
  const badJson = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${full}` }, body: '{oops' })
  assert.equal(badJson.status, 400)

  // responses, stream
  const responses = await post('/v1/responses', { model: 'echo:fast', stream: true, input: 'ping' })
  assert.equal(responses.status, 200)
  const events = readSse(await responses.text()).map(frame => frame.event)
  assert.equal(events[0], 'response.created')
  assert.equal(events.at(-1), 'response.completed')

  // responses, non-stream
  const responsesObject = await (await post('/v1/responses', { model: 'echo:fast', input: [{ role: 'user', content: [{ type: 'input_text', text: 'pong' }] }] })).json() as { output: Array<{ type: string; content: Array<{ text: string }> }> }
  assert.equal(responsesObject.output[0].content[0].text, 'fast:pong')

  // anthropic messages, stream and non-stream
  const messages = await post('/v1/messages', { model: 'echo:fast', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'hey' }] }, full, { 'anthropic-version': '2023-06-01' })
  const anthropicEvents = readSse(await messages.text()).map(frame => frame.event)
  assert.equal(anthropicEvents[0], 'message_start')
  assert.equal(anthropicEvents.at(-1), 'message_stop')
  const message = await (await post('/v1/messages', { model: 'echo:fast', max_tokens: 10, messages: [{ role: 'user', content: 'hey' }] })).json() as { content: Array<{ text: string }>; stop_reason: string; usage: { input_tokens: number } }
  assert.equal(message.content[0].text, 'fast:hey')
  assert.equal(message.stop_reason, 'end_turn')
  assert.equal(message.usage.input_tokens, 3)

  // upstream failure surfaces with the provider status
  streamImpl = failing
  const quota = await post('/v1/chat/completions', { model: 'echo:fast', messages: [{ role: 'user', content: 'x' }] })
  assert.equal(quota.status, 429)
  assert.equal(((await quota.json()) as { error: { code: string } }).error.code, 'QUOTA')
  const quotaStream = await post('/v1/messages', { model: 'echo:fast', max_tokens: 5, stream: true, messages: [{ role: 'user', content: 'x' }] })
  assert.equal(quotaStream.status, 200)
  assert.equal(readSse(await quotaStream.text()).at(-1)?.event, 'error')
  streamImpl = echo

  // ledger: every authenticated POST is recorded
  const summary = usage.summary('today', {})
  assert.ok(summary.totals.requests >= 10, String(summary.totals.requests))
  assert.ok(summary.totals.errors >= 4)
  assert.equal(summary.byKey.find(group => group.label === 'limited')?.requests, 1)
  assert.ok(summary.rows.some(row => row.status === 429 && row.errorCode === 'QUOTA'))
  assert.ok(summary.rows.some(row => row.protocol === 'messages' && row.stream))
  assert.equal(keys.list().find(key => key.name === 'full')?.lastUsedAt !== null, true)
})
