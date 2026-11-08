import test from 'node:test'
import assert from 'node:assert/strict'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { parseChatRequest, ChatStreamEncoder, chatCompletion } from '../src/translate/openai-chat.ts'
import { parseResponsesRequest, ResponsesStreamEncoder, responsesCompletion } from '../src/translate/openai-responses.ts'
import { parseMessagesRequest, AnthropicStreamEncoder, anthropicMessage } from '../src/translate/anthropic.ts'
import { GatewayError, materialize, type PendingImage } from '../src/translate/common.ts'

const usage: TokenUsage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, reasoningTokens: 1 }
const callId = ToolCallId('call_1')

/** A text block, a tool call and usage, as the host streams them. */
const sampleChunks: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text: 'thinking' },
  { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } },
  { type: 'block-start', index: 1, blockType: 'text' },
  { type: 'text-delta', index: 1, text: 'Hel' },
  { type: 'text-delta', index: 1, text: 'lo' },
  { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello' } },
  { type: 'block-start', index: 2, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 2, id: callId, name: 'get_weather', argumentsDelta: '{"city":' },
  { type: 'tool-call-delta', index: 2, id: callId, argumentsDelta: '"Paris"}' },
  { type: 'block-end', index: 2, block: { type: 'tool-call', id: callId, name: 'get_weather', arguments: '{"city":"Paris"}' } },
  { type: 'usage', usage },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

function frames(text: string): Array<{ event?: string; data: unknown }> {
  return text.split('\n\n').filter(part => part.trim() !== '').map(part => {
    const lines = part.split('\n')
    const event = lines.find(line => line.startsWith('event: '))?.slice(7)
    const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
    return { event, data: data === '[DONE]' ? '[DONE]' : JSON.parse(data) }
  })
}

const noImages = async (_image: PendingImage) => { throw new Error('no images expected') }

test('chat completions: parse, materialize and reject unsupported parameters', async () => {
  const parsed = parseChatRequest({
    model: 'deepseek:deepseek-chat',
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.5,
    max_completion_tokens: 200,
    stop: 'END',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'developer', content: [{ type: 'text', text: 'Reply in English.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Weather?' }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'Sunny' },
    ],
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
  })
  assert.equal(parsed.system, 'Be brief.\n\nReply in English.')
  assert.equal(parsed.includeUsage, true)
  assert.deepEqual(parsed.stop, ['END'])
  assert.equal(parsed.maxTokens, 200)
  assert.equal(parsed.messages.length, 3)
  assert.deepEqual(parsed.messages[1], { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' }] })
  const options = await materialize(parsed, { provider: 'deepseek', model: 'deepseek-chat' }, noImages, new AbortController().signal)
  assert.equal(options.provider, 'deepseek')
  assert.equal(options.system, parsed.system)
  assert.equal(options.tools?.[0].name, 'get_weather')
  assert.equal(options.messages[0].role, 'user')
  assert.equal(options.messages[1].role, 'assistant')
  assert.deepEqual((options.messages[1] as { source: unknown }).source, { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' })
  assert.equal(options.messages[2].role, 'tool')
  assert.equal((options.messages[2] as { toolCallId: string }).toolCallId, 'call_1')

  const base = { messages: [{ role: 'user', content: 'hi' }] }
  for (const body of [
    { ...base, n: 2 },
    { ...base, logprobs: true },
    { ...base, response_format: { type: 'json_schema', json_schema: {} } },
    { ...base, tools: [{ type: 'web_search' }] },
    { messages: [] },
    { messages: [{ role: 'function', content: 'x' }] },
  ]) {
    assert.throws(() => parseChatRequest(body), (error: unknown) => error instanceof GatewayError && error.status === 400, JSON.stringify(body))
  }
  const images = parseChatRequest({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'image_url', image_url: 'https://example.com/a.png' }] }] })
  assert.deepEqual(images.messages[0].content, [
    { type: 'pending-image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAAA' } },
    { type: 'pending-image', source: { kind: 'url', url: 'https://example.com/a.png' } },
  ])
})

test('chat completions: stream chunks and the complete object', () => {
  const encoder = new ChatStreamEncoder('deepseek:deepseek-chat', true)
  const out = frames(encoder.start() + sampleChunks.map(chunk => encoder.push(chunk)).join('') + encoder.end())
  const deltas = out.filter(frame => frame.data !== '[DONE]').map(frame => frame.data as { choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>; usage?: unknown })
  assert.equal(deltas[0].choices[0].delta.role, 'assistant')
  assert.equal(deltas[0].choices[0].delta.reasoning_content, 'thinking')
  assert.equal(deltas.map(d => d.choices[0]?.delta.content ?? '').join(''), 'Hello')
  const toolDeltas = deltas.flatMap(d => (d.choices[0]?.delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? [])
  assert.equal(toolDeltas[0].id, 'call_1')
  assert.equal(toolDeltas[0].index, 0)
  assert.equal((toolDeltas[0].function as { name: string }).name, 'get_weather')
  assert.equal(toolDeltas.map(d => (d.function as { arguments: string }).arguments).join(''), '{"city":"Paris"}')
  assert.equal(deltas.at(-2)?.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual((deltas.at(-1) as { usage: Record<string, unknown> }).usage.prompt_tokens, 10)
  assert.equal(out.at(-1)?.data, '[DONE]')

  const complete = chatCompletion('deepseek:deepseek-chat', [{ type: 'text', text: 'Hello' }, { type: 'tool-call', id: callId, name: 'get_weather', arguments: '{}' }], usage, { kind: 'tool-calls' }) as { choices: Array<{ message: Record<string, unknown>; finish_reason: string }>; usage: Record<string, unknown> }
  assert.equal(complete.choices[0].finish_reason, 'tool_calls')
  assert.equal(complete.choices[0].message.content, 'Hello')
  assert.equal((complete.choices[0].message.tool_calls as unknown[]).length, 1)
  assert.equal(complete.usage.total_tokens, 15)
})

test('responses: parse input items and stream semantic events', () => {
  const parsed = parseResponsesRequest({
    model: 'x:y',
    instructions: 'Be helpful.',
    input: [
      { role: 'user', content: 'Weather?' },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'Sunny' },
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Thanks' }, { type: 'input_image', image_url: 'https://example.com/a.png' }] },
    ],
    tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }],
    reasoning: { effort: 'high' },
    max_output_tokens: 50,
  })
  assert.equal(parsed.system, 'Be helpful.')
  assert.equal(parsed.reasoningEffort, 'high')
  assert.equal(parsed.maxTokens, 50)
  assert.equal(parsed.messages.length, 4)
  assert.equal(parsed.messages[1].role, 'assistant')
  assert.equal(parsed.messages[2].role, 'tool')
  assert.equal(parsed.messages[3].content.length, 2)
  assert.throws(() => parseResponsesRequest({ input: 'hi', previous_response_id: 'resp_1' }), (error: unknown) => error instanceof GatewayError && error.status === 400)
  assert.throws(() => parseResponsesRequest({ input: 'hi', tools: [{ type: 'web_search_preview' }] }), (error: unknown) => error instanceof GatewayError && error.status === 400)
  assert.throws(() => parseResponsesRequest({ input: 'hi', text: { format: { type: 'json_schema' } } }), (error: unknown) => error instanceof GatewayError && error.status === 400)

  const encoder = new ResponsesStreamEncoder('x:y')
  const out = frames(encoder.start() + sampleChunks.map(chunk => encoder.push(chunk)).join('') + encoder.end())
  const events = out.map(frame => frame.event)
  assert.equal(events[0], 'response.created')
  assert.ok(events.includes('response.output_item.added'))
  assert.ok(events.includes('response.reasoning_summary_text.delta'))
  assert.ok(events.includes('response.output_text.delta'))
  assert.ok(events.includes('response.function_call_arguments.delta'))
  assert.ok(events.includes('response.function_call_arguments.done'))
  assert.equal(events.at(-1), 'response.completed')
  const sequence = out.map(frame => (frame.data as { sequence_number: number }).sequence_number)
  assert.deepEqual(sequence, sequence.map((_, index) => index))
  const completed = (out.at(-1)?.data as { response: { output: Array<Record<string, unknown>>; usage: Record<string, unknown>; status: string } }).response
  assert.equal(completed.status, 'completed')
  assert.deepEqual(completed.output.map(item => item.type), ['reasoning', 'message', 'function_call'])
  assert.equal(completed.output[2].arguments, '{"city":"Paris"}')
  assert.equal(completed.usage.total_tokens, 15)

  const object = responsesCompletion('x:y', [{ type: 'text', text: 'Hi' }], usage, { kind: 'max-tokens' }) as { status: string; incomplete_details: unknown }
  assert.equal(object.status, 'incomplete')
  assert.deepEqual(object.incomplete_details, { reason: 'max_output_tokens' })
})

test('anthropic messages: parse blocks, drop thinking, stream events', () => {
  const parsed = parseMessagesRequest({
    model: 'x:y',
    max_tokens: 1024,
    system: [{ type: 'text', text: 'Be brief.' }],
    stop_sequences: ['END'],
    messages: [
      { role: 'user', content: 'Weather?' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Sunny', is_error: false }, { type: 'text', text: 'And tomorrow?' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/' } }] },
    ],
    tools: [{ name: 'get_weather', description: 'Weather', input_schema: { type: 'object' } }],
  })
  assert.equal(parsed.system, 'Be brief.')
  assert.equal(parsed.maxTokens, 1024)
  assert.deepEqual(parsed.stop, ['END'])
  assert.deepEqual(parsed.messages.map(message => message.role), ['user', 'assistant', 'tool', 'user'])
  assert.deepEqual(parsed.messages[1].content, [{ type: 'tool-call', id: 'toolu_1', name: 'get_weather', arguments: '{"city":"Paris"}' }])
  assert.equal(parsed.messages[3].content.length, 2)
  assert.throws(() => parseMessagesRequest({ messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'web_search_20250305', name: 'web_search' }] }), (error: unknown) => error instanceof GatewayError && error.status === 400)

  const encoder = new AnthropicStreamEncoder('x:y')
  const out = frames(encoder.start() + sampleChunks.map(chunk => encoder.push(chunk)).join('') + encoder.end())
  const events = out.map(frame => frame.event)
  assert.equal(events[0], 'message_start')
  assert.deepEqual(events.filter(event => event === 'content_block_start').length, 3)
  const starts = out.filter(frame => frame.event === 'content_block_start').map(frame => (frame.data as { index: number; content_block: { type: string } }))
  assert.deepEqual(starts.map(start => [start.index, start.content_block.type]), [[0, 'thinking'], [1, 'text'], [2, 'tool_use']])
  const deltas = out.filter(frame => frame.event === 'content_block_delta').map(frame => (frame.data as { delta: Record<string, string> }).delta)
  assert.equal(deltas.filter(delta => delta.type === 'input_json_delta').map(delta => delta.partial_json).join(''), '{"city":"Paris"}')
  const messageDelta = out.find(frame => frame.event === 'message_delta')?.data as { delta: { stop_reason: string }; usage: { input_tokens: number; output_tokens: number } }
  assert.equal(messageDelta.delta.stop_reason, 'tool_use')
  assert.equal(messageDelta.usage.output_tokens, 5)
  assert.equal(events.at(-1), 'message_stop')

  const object = anthropicMessage('x:y', [{ type: 'text', text: 'Hi' }, { type: 'tool-call', id: callId, name: 'get_weather', arguments: '{"city":"Paris"}' }], usage, { kind: 'tool-calls' }) as { content: Array<Record<string, unknown>>; stop_reason: string }
  assert.equal(object.stop_reason, 'tool_use')
  assert.deepEqual(object.content[1], { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } })
})

test('stream encoders report upstream failures after the stream started', () => {
  const failure: StreamChunk = { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'quota exceeded', status: 429 } } }
  const chat = frames(new ChatStreamEncoder('x:y', false).push(failure))
  assert.equal((chat[0].data as { error: { code: string } }).error.code, 'QUOTA')
  const responses = frames(new ResponsesStreamEncoder('x:y').push(failure)).map(frame => frame.event)
  assert.deepEqual(responses, ['response.failed', 'error'])
  const anthropic = frames(new AnthropicStreamEncoder('x:y').push(failure))
  assert.equal(anthropic[0].event, 'error')
})
