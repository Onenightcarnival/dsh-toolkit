import test from 'node:test'
import assert from 'node:assert/strict'
import { SseParser, isEventStream, parseSse } from '../src/protocol.ts'

test('parseSse: fields, default type, multi-line data, comments, id and retry', () => {
  const events = parseSse(': comment\n\nevent: start\ndata: {"a":1}\n\ndata: one\ndata: two\nid: 42\nretry: 3000\n\ndata:no-space\ndata:  two spaces\n\nevent: named\n\nunknown: x\n\ndata\n\n')
  assert.deepEqual(events, [
    { event: 'start', data: '{"a":1}' },
    { event: '', data: 'one\ntwo', id: '42', retry: 3000 },
    { event: '', data: 'no-space\n two spaces' },
    { event: 'named', data: '' },
    { event: '', data: '' },
  ])
})

test('SseParser: events complete across arbitrary chunk boundaries and every line ending', () => {
  const text = 'event: a\r\ndata: 1\r\n\r\ndata: 2\rdata: 3\r\rdata: 4\n\n'
  const expected = [{ event: 'a', data: '1' }, { event: '', data: '2\n3' }, { event: '', data: '4' }]
  assert.deepEqual(parseSse(text), expected)
  for (let size = 1; size <= 7; size++) {
    const parser = new SseParser()
    const out = []
    for (let i = 0; i < text.length; i += size) out.push(...parser.push(text.slice(i, i + size)))
    out.push(...parser.flush())
    assert.deepEqual(out, expected, `chunk size ${size}`)
  }
})

test('SseParser: flush dispatches an unterminated last event; retry must be digits; id with NUL is ignored', () => {
  const parser = new SseParser()
  assert.deepEqual(parser.push('data: partial'), [])
  assert.deepEqual(parser.flush(), [{ event: '', data: 'partial' }])
  assert.deepEqual(parser.flush(), [])
  assert.deepEqual(parseSse('retry: soon\ndata: x\n\nid: a\0b\ndata: y\n\n'), [{ event: '', data: 'x' }, { event: '', data: 'y' }])
})

test('isEventStream matches the media type only', () => {
  assert.equal(isEventStream('text/event-stream'), true)
  assert.equal(isEventStream('Text/Event-Stream; charset=utf-8'), true)
  assert.equal(isEventStream('application/json'), false)
  assert.equal(isEventStream(''), false)
})

test('sseRows pairs parsed events with recorded arrival times', async () => {
  const { sseRows } = await import('../src/client/sse.ts')
  assert.deepEqual(sseRows('data: a\n\nevent: e\ndata: b\n\n', [10, 25]), [{ event: '', data: 'a', at: 10 }, { event: 'e', data: 'b', at: 25 }])
  assert.deepEqual(sseRows('data: a\n\ndata: b\n\n', [10]), [{ event: '', data: 'a', at: 10 }, { event: '', data: 'b' }])
  assert.deepEqual(sseRows('', undefined), [])
})

test('deltaText reads the text increment of common model output streams', async () => {
  const { deltaText } = await import('../src/client/sse.ts')
  assert.equal(deltaText('{"choices":[{"delta":{"content":"Hel"}}]}'), 'Hel')
  assert.equal(deltaText('{"choices":[{"delta":{"role":"assistant"}}]}'), '')
  assert.equal(deltaText('{"choices":[{"text":"lo"}]}'), 'lo')
  assert.equal(deltaText('{"type":"response.output_text.delta","delta":" wor"}'), ' wor')
  assert.equal(deltaText('{"type":"response.completed","delta":"ignored"}'), '')
  assert.equal(deltaText('{"type":"content_block_delta","delta":{"type":"text_delta","text":"ld"}}'), 'ld')
  assert.equal(deltaText('{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{"}}'), '')
  assert.equal(deltaText('{"candidates":[{"content":{"parts":[{"text":"!"}]}}]}'), '!')
  assert.equal(deltaText('[DONE]'), '')
  assert.equal(deltaText('{broken'), '')
  assert.equal(deltaText(''), '')
})
