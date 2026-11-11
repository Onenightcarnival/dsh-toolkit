import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpEngine, buildUrl, hostMatches, isPrivateAddress, isTextual, maskSecrets, substitute } from '../src/engine.ts'
import { HistoryStore, TargetStore } from '../src/store.ts'
import type { HttpTarget } from '../src/protocol.ts'

let server: Server
let origin = ''
const dir = mkdtempSync(join(tmpdir(), 'dsh-http-engine-'))
const store = new TargetStore(join(dir, 'targets.json'))
const history = new HistoryStore(join(dir, 'history.jsonl'), () => 100)
const engine = new HttpEngine(store, history)

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      switch (url.pathname) {
        case '/v1/redirect':
          res.writeHead(302, { location: '/v1/echo?from=redirect' })
          res.end()
          return
        case '/v1/redirect-out':
          res.writeHead(302, { location: 'https://other.invalid/x' })
          res.end()
          return
        case '/v1/redirect-post':
          res.writeHead(303, { location: '/v1/echo' })
          res.end()
          return
        case '/v1/big':
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('x'.repeat(5000))
          return
        case '/v1/binary':
          res.writeHead(200, { 'content-type': 'application/octet-stream' })
          res.end(Buffer.from([0, 1, 2, 3]))
          return
        case '/v1/sse': {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
          const auth = String(req.headers.authorization ?? '')
          const frames = [': hello\n\n', 'event: start\ndata: {"n":0}\n\n', `data: token ${auth}\n\n`, 'id: 7\ndata: line one\ndata: line two\n\n', 'data: [DONE]\n\n']
          let index = 0
          const tick = setInterval(() => {
            if (index < frames.length) { res.write(frames[index++]); return }
            clearInterval(tick)
            res.end()
          }, 15)
          return
        }
        case '/v1/sse-forever': {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          let n = 0
          const tick = setInterval(() => { res.write(`data: tick ${n++}\n\n`) }, 40)
          res.on('close', () => { clearInterval(tick) })
          return
        }
        case '/v1/slow':
          setTimeout(() => { res.writeHead(200); res.end('late') }, 1500)
          return
        case '/v1/gbk':
          res.writeHead(200, { 'content-type': 'text/plain; charset=gbk' })
          res.end(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))
          return
        default:
          res.writeHead(url.pathname === '/v1/echo' ? 200 : 404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }))
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  origin = typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : ''
})

after(async () => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

function target(overrides: Partial<HttpTarget> = {}): HttpTarget {
  return store.create({ baseUrl: `${origin}/v1`, allowPrivate: true, ...overrides } as never)
}

test('substitute, hostMatches, isPrivateAddress, isTextual, maskSecrets', () => {
  assert.equal(substitute('/users/{{ id }}/x{{missing}}', { id: '42' }), '/users/42/x{{missing}}')
  assert.equal(hostMatches('api.example.com', 'api.example.com'), true)
  assert.equal(hostMatches('a.b.example.com', '*.example.com'), true)
  assert.equal(hostMatches('example.com', '*.example.com'), false)
  assert.equal(hostMatches('notexample.com', '*.example.com'), false)
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:10.0.0.1', '224.0.0.1']) assert.equal(isPrivateAddress(address), true, address)
  for (const address of ['8.8.8.8', '172.32.0.1', '2606:4700::1', '1.1.1.1']) assert.equal(isPrivateAddress(address), false, address)
  assert.equal(isTextual('application/json', new Uint8Array()), true)
  assert.equal(isTextual('application/vnd.api+json', new Uint8Array()), true)
  assert.equal(isTextual('image/png', new Uint8Array()), false)
  assert.equal(isTextual('', new Uint8Array([104, 105])), true)
  assert.equal(isTextual('', new Uint8Array([104, 0, 105])), false)
  assert.equal(maskSecrets('Bearer tok/123 and tok%2F123 x', ['tok/123']), 'Bearer •••••• and •••••• x')
  assert.equal(maskSecrets('ab', ['ab']), 'ab')
})

test('buildUrl joins below the base path and appends query', () => {
  const t = { baseUrl: 'https://api.example.com/v1', allowedHosts: [] } as unknown as HttpTarget
  assert.equal(buildUrl(t, '/users/42?expand=1', { page: '2' }).toString(), 'https://api.example.com/v1/users/42?expand=1&page=2')
  assert.equal(buildUrl(t, 'users', {}).toString(), 'https://api.example.com/v1/users')
  assert.equal(buildUrl(t, '', {}).toString(), 'https://api.example.com/v1')
  assert.equal(buildUrl({ ...t, baseUrl: 'https://api.example.com' }, '', {}).toString(), 'https://api.example.com/')
  assert.equal(buildUrl(t, 'https://cdn.example.com/a b', {}).toString(), 'https://cdn.example.com/a%20b')
  assert.throws(() => buildUrl(t, 'ftp://x/', {}), /http\(s\)/)
  assert.throws(() => buildUrl(t, 'https://u:p@x/', {}), /credentials/)
})

test('GET with variables, query, fixed headers and bearer auth; secrets masked; history recorded', async () => {
  const t = target({ auth: { type: 'bearer', token: 'super-secret-token' }, headers: { 'X-Fixed': 'yes' }, variables: { id: '42' } } as never)
  const exchange = await engine.send(t.name, { method: 'GET', path: '/echo/{{id}}', query: { q: '{{id}}' }, headers: { 'X-Req': 'r' } }, { source: 'agent' })
  assert.equal(exchange.error, undefined)
  assert.equal(exchange.response?.status, 404)
  const seen = JSON.parse(exchange.response!.body) as { url: string; headers: Record<string, string> }
  assert.equal(seen.url, '/v1/echo/42?q=42')
  assert.equal(seen.headers['x-fixed'], 'yes')
  assert.equal(seen.headers['x-req'], 'r')
  // The echoed Authorization header is masked in the body handed back.
  assert.equal(seen.headers.authorization, 'Bearer ••••••')
  assert.ok(!JSON.stringify(exchange).includes('super-secret-token'))
  assert.equal(exchange.request.url, `${origin}/v1/echo/42?q=42`)
  const [recorded] = history.list(t.id)
  assert.equal(recorded.id, exchange.id)
  assert.equal(recorded.source, 'agent')
})

test('POST defaults content-type to JSON; HEAD drops the body; query auth masked in URL', async () => {
  const t = target({ auth: { type: 'query', name: 'api_key', value: 'qsecret99' } } as never)
  const exchange = await engine.send(t.id, { method: 'POST', path: 'echo', body: '{"a":1}' }, { source: 'panel' })
  const seen = JSON.parse(exchange.response!.body) as { method: string; body: string; headers: Record<string, string>; url: string }
  assert.equal(seen.method, 'POST')
  assert.equal(seen.body, '{"a":1}')
  assert.match(seen.headers['content-type'], /application\/json/)
  assert.equal(seen.url, '/v1/echo?api_key=••••••')
  assert.equal(exchange.request.url, `${origin}/v1/echo?api_key=••••••`)
  const head = await engine.send(t.id, { method: 'HEAD', path: 'echo', body: 'ignored' }, { source: 'panel' })
  assert.equal(head.response?.status, 200)
  assert.equal(head.response?.body, '')
})

test('redirects: same-origin followed, 303 turns POST into GET, other hosts refused', async () => {
  const t = target({ auth: { type: 'bearer', token: 'redirect-token' } } as never)
  const followed = await engine.send(t.id, { method: 'GET', path: 'redirect' }, { source: 'panel' })
  assert.equal(followed.response?.status, 200)
  assert.deepEqual(followed.response?.redirects, [`${origin}/v1/echo?from=redirect`])
  const seen = JSON.parse(followed.response!.body) as { headers: Record<string, string> }
  assert.equal(seen.headers.authorization, 'Bearer ••••••')
  const post = await engine.send(t.id, { method: 'POST', path: 'redirect-post', body: '{"x":1}' }, { source: 'panel' })
  assert.equal((JSON.parse(post.response!.body) as { method: string; body: string }).method, 'GET')
  assert.equal((JSON.parse(post.response!.body) as { body: string }).body, '')
  const out = await engine.send(t.id, { method: 'GET', path: 'redirect-out' }, { source: 'panel' })
  assert.equal(out.response, undefined)
  assert.match(out.error ?? '', /redirect to 'other.invalid' is not allowed/)
})

test('host policy: absolute URL on a foreign host refused; allowed host accepted; private guard', async () => {
  const t = target({ allowedHosts: ['*.invalid'] })
  const refused = await engine.send(t.id, { method: 'GET', path: 'https://example.com/' }, { source: 'panel' })
  assert.match(refused.error ?? '', /not allowed/)
  const same = await engine.send(t.id, { method: 'GET', path: `${origin}/v1/echo` }, { source: 'panel' })
  assert.equal(same.response?.status, 200)
  const guarded = store.create({ baseUrl: `${origin}/v1`, allowPrivate: false })
  const blocked = await engine.send(guarded.id, { method: 'GET', path: 'echo' }, { source: 'panel' })
  assert.match(blocked.error ?? '', /private/)
  const local = store.create({ baseUrl: 'http://localhost:1/v1', allowPrivate: false })
  assert.match((await engine.send(local.id, { method: 'GET', path: '' }, { source: 'panel' })).error ?? '', /loopback/)
})

test('body cap, binary detection, charset decoding, timeout and connection errors', async () => {
  const t = target()
  const capped = await engine.send(t.id, { method: 'GET', path: 'big' }, { source: 'panel', maxBodyBytes: 100 })
  assert.equal(capped.response?.bodyTruncated, true)
  assert.equal(capped.response?.bodyBytes, 100)
  assert.equal(capped.response?.body.length, 100)
  const binary = await engine.send(t.id, { method: 'GET', path: 'binary' }, { source: 'panel' })
  assert.equal(binary.response?.binary, true)
  assert.equal(binary.response?.body, '')
  assert.equal(binary.response?.bodyBytes, 4)
  const gbk = await engine.send(t.id, { method: 'GET', path: 'gbk' }, { source: 'panel' })
  assert.equal(gbk.response?.body, '你好')
  const slow = target({ timeoutMs: 1000 })
  const timedOut = await engine.send(slow.id, { method: 'GET', path: 'slow' }, { source: 'panel' })
  assert.match(timedOut.error ?? '', /timed out after 1000 ms/)
  const dead = store.create({ baseUrl: 'http://127.0.0.1:9/v1', allowPrivate: true })
  const refused = await engine.send(dead.id, { method: 'GET', path: '' }, { source: 'panel' })
  assert.match(refused.error ?? '', /ECONNREFUSED|fetch failed/)
  const test = await engine.test(t.id)
  assert.equal(test.ok, true)
  assert.equal(test.status, 404)
})

test('shape errors and unknown targets throw before anything is sent or recorded', async () => {
  const t = target()
  const before = history.list(t.id).length
  await assert.rejects(engine.send(t.id, { method: 'BREW' as never, path: '/' }, { source: 'panel' }), /unsupported method/)
  await assert.rejects(engine.send(t.id, { method: 'GET', path: '/', headers: { 'X-A': 'a\nb' } }, { source: 'panel' }), /line breaks/)
  await assert.rejects(engine.send(t.id, { method: 'GET', path: '/', query: ['x'] as never }, { source: 'panel' }), /object of strings/)
  await assert.rejects(engine.send('nope', { method: 'GET', path: '/' }, { source: 'panel' }), /not found/)
  assert.equal(history.list(t.id).length, before)
})

test('cancel: an aborted signal ends the request and records `cancelled`; sent headers are recorded masked', async () => {
  const t = target({ auth: { type: 'bearer', token: 'cancel-token-1' }, headers: { 'X-Fixed': 'yes' } } as never)
  const controller = new AbortController()
  setTimeout(() => { controller.abort() }, 100)
  const started = Date.now()
  const cancelled = await engine.send(t.id, { method: 'GET', path: 'slow' }, { source: 'panel', signal: controller.signal })
  assert.equal(cancelled.error, 'cancelled')
  assert.ok(Date.now() - started < 1000)
  assert.equal(history.list(t.id)[0].error, 'cancelled')
  const already = new AbortController()
  already.abort()
  assert.equal((await engine.send(t.id, { method: 'GET', path: 'echo' }, { source: 'panel', signal: already.signal })).error, 'cancelled')
  const sent = await engine.send(t.id, { method: 'POST', path: 'echo', headers: { 'X-Req': 'r' }, body: '{}' }, { source: 'panel' })
  assert.deepEqual(sent.request.headers, { 'X-Req': 'r' })
  assert.equal(sent.request.sentHeaders?.authorization, 'Bearer ••••••')
  assert.equal(sent.request.sentHeaders?.['x-fixed'], 'yes')
  assert.equal(sent.request.sentHeaders?.['x-req'], 'r')
  assert.match(sent.request.sentHeaders?.['content-type'] ?? '', /application\/json/)
})

test('requestId of a saved request is recorded on the exchange; malformed ids are dropped', async () => {
  const t = target()
  const tagged = await engine.send(t.id, { method: 'GET', path: 'echo', requestId: 'abc123def456' }, { source: 'panel' })
  assert.equal(tagged.requestId, 'abc123def456')
  assert.equal(history.list(t.id)[0].requestId, 'abc123def456')
  const dropped = await engine.send(t.id, { method: 'GET', path: 'echo', requestId: '../etc' }, { source: 'panel' })
  assert.equal(dropped.requestId, undefined)
})

test('direct scope: full URL without a target, panel only; typed credential headers are masked', async () => {
  const direct = await engine.send('direct', { method: 'GET', path: `${origin}/v1/echo?x=1`, headers: { Authorization: 'Bearer typed-token-xyz', 'X-Api-Key': 'key-98765' } }, { source: 'panel' })
  assert.equal(direct.error, undefined)
  assert.equal(direct.targetId, 'direct')
  assert.equal(direct.response?.status, 200)
  const seen = JSON.parse(direct.response!.body) as { headers: Record<string, string> }
  assert.equal(seen.headers.authorization, 'Bearer ••••••')
  assert.equal(seen.headers['x-api-key'], '••••••')
  assert.equal(direct.request.headers.Authorization, 'Bearer ••••••')
  assert.equal(direct.request.sentHeaders?.authorization, 'Bearer ••••••')
  assert.ok(!JSON.stringify(direct).includes('typed-token-xyz') && !JSON.stringify(direct).includes('key-98765'))
  assert.equal(history.list('direct')[0].id, direct.id)
  // The agent cannot send through the direct scope.
  await assert.rejects(engine.send('direct', { method: 'GET', path: `${origin}/v1/echo` }, { source: 'agent' }), /not found/)
  // Scheme defaults and malformed input.
  const bare = await engine.send('direct', { method: 'GET', path: origin.replace('http://', '') + '/v1/echo' }, { source: 'panel' })
  assert.equal(bare.response?.status, 200)
  assert.match((await engine.send('direct', { method: 'GET', path: '' }, { source: 'panel' })).error ?? '', /URL is required/)
  assert.match((await engine.send('direct', { method: 'GET', path: '/users' }, { source: 'panel' })).error ?? '', /full URL/)
  // A typed credential on a target request is masked too.
  const t = target()
  const typed = await engine.send(t.id, { method: 'GET', path: 'echo', headers: { Cookie: 'sid=abc123456' } }, { source: 'panel' })
  assert.ok(!JSON.stringify(typed).includes('abc123456'))
})

test('query pairs keep repeated names; request auth applies only for the panel on a target without auth', async () => {
  const open = target()
  const repeated = await engine.send(open.id, { method: 'GET', path: 'echo', query: [['ids', '1'], ['ids', '2'], [' ', 'dropped']] }, { source: 'panel' })
  assert.equal((JSON.parse(repeated.response!.body) as { url: string }).url, '/v1/echo?ids=1&ids=2')
  assert.deepEqual(repeated.request.query, [['ids', '1'], ['ids', '2']])
  await assert.rejects(engine.send(open.id, { method: 'GET', path: 'echo', query: [['a']] as never }, { source: 'panel' }), /pairs/)

  const withAuth = await engine.send(open.id, { method: 'GET', path: 'echo', auth: { type: 'bearer', token: 'request-level-token' } }, { source: 'panel' })
  assert.equal((JSON.parse(withAuth.response!.body) as { headers: Record<string, string> }).headers.authorization, 'Bearer ••••••')
  assert.equal(withAuth.request.sentHeaders?.authorization, 'Bearer ••••••')
  assert.ok(!JSON.stringify(withAuth).includes('request-level-token'))
  const basic = await engine.send('direct', { method: 'GET', path: `${origin}/v1/echo`, auth: { type: 'basic', username: 'u', password: 'pw-secret' } }, { source: 'panel' })
  assert.equal(basic.request.sentHeaders?.authorization, 'Basic ••••••')
  const apiKey = await engine.send(open.id, { method: 'GET', path: 'echo', auth: { type: 'query', name: 'key', value: 'q-secret-1' } }, { source: 'panel' })
  assert.equal(apiKey.request.url, `${origin}/v1/echo?key=••••••`)
  // Incomplete, agent-sent, and shadowed by the target's own auth: not applied.
  const incomplete = await engine.send(open.id, { method: 'GET', path: 'echo', auth: { type: 'bearer', token: '' } }, { source: 'panel' })
  assert.equal(incomplete.request.sentHeaders?.authorization, undefined)
  const agent = await engine.send(open.id, { method: 'GET', path: 'echo', auth: { type: 'bearer', token: 'agent-supplied' } }, { source: 'agent' })
  assert.equal(agent.request.sentHeaders?.authorization, undefined)
  const guarded = target({ auth: { type: 'header', name: 'X-Key', value: 'target-key-1' } } as never)
  const shadowed = await engine.send(guarded.id, { method: 'GET', path: 'echo', auth: { type: 'bearer', token: 'request-level-token' } }, { source: 'panel' })
  assert.equal(shadowed.request.sentHeaders?.authorization, undefined)
  assert.equal(shadowed.request.sentHeaders?.['x-key'], '••••••')
})

test('binary bodies: base64 for the live panel response on request, never in the history', async () => {
  const t = target()
  const kept = await engine.send(t.id, { method: 'GET', path: 'binary' }, { source: 'panel', keepBinary: true })
  assert.equal(kept.response?.bodyBase64, Buffer.from([0, 1, 2, 3]).toString('base64'))
  assert.equal(history.list(t.id)[0].response?.bodyBase64, undefined)
  const plain = await engine.send(t.id, { method: 'GET', path: 'binary' }, { source: 'panel' })
  assert.equal(plain.response?.bodyBase64, undefined)
  const text = await engine.send(t.id, { method: 'GET', path: 'echo' }, { source: 'panel', keepBinary: true })
  assert.equal(text.response?.bodyBase64, undefined)
})

test('event stream: head and events are reported as they arrive, masked; the exchange keeps text and times', async () => {
  const t = target({ auth: { type: 'bearer', token: 'stream-secret-9' } } as never)
  const heads: number[] = []
  const seen: Array<{ event: string; data: string; id?: string; at: number }> = []
  const exchange = await engine.send(t.id, { method: 'GET', path: 'sse' }, { source: 'panel', onStreamStart: (head) => { heads.push(head.status) }, onStreamEvent: (event, at) => { seen.push({ ...event, at }) } })
  assert.equal(exchange.error, undefined)
  assert.deepEqual(heads, [200])
  assert.deepEqual(seen.map(e => [e.event, e.data]), [['start', '{"n":0}'], ['', 'token Bearer ••••••'], ['', 'line one\nline two'], ['', '[DONE]']])
  assert.equal(seen[2].id, '7')
  assert.ok(seen[0].at <= seen[3].at)
  const response = exchange.response!
  assert.equal(response.stream?.ended, 'complete')
  assert.equal(response.stream?.times.length, 4)
  assert.equal(response.binary, false)
  assert.ok(response.body.startsWith(': hello\n\nevent: start'))
  assert.ok(!JSON.stringify(exchange).includes('stream-secret-9'))
  assert.equal(history.list(t.id)[0].response?.stream?.times.length, 4)
})

test('event stream: stop, idle and total deadlines, and the body cap end it with what arrived', async () => {
  const t = target({ timeoutMs: 1000 })
  const stop = new AbortController()
  let count = 0
  const stopped = await engine.send(t.id, { method: 'GET', path: 'sse-forever' }, { source: 'panel', signal: stop.signal, onStreamEvent: () => { if (++count === 3) stop.abort() } })
  assert.equal(stopped.error, undefined)
  assert.equal(stopped.response?.stream?.ended, 'cancelled')
  assert.ok((stopped.response?.stream?.times.length ?? 0) >= 3)
  assert.match(stopped.response?.body ?? '', /^data: tick 0\n\ndata: tick 1/)
  // The panel's deadline restarts with every chunk, so a live stream outlasts the timeout; the cap ends it.
  const capped = await engine.send(t.id, { method: 'GET', path: 'sse-forever' }, { source: 'panel', maxBodyBytes: 500 })
  assert.equal(capped.response?.stream?.ended, 'limit')
  assert.equal(capped.response?.bodyTruncated, true)
  assert.equal(capped.response?.bodyBytes, 500)
  assert.ok((capped.response?.durationMs ?? 0) > 1000)
  // An agent's deadline covers the whole stream.
  const agent = await engine.send(t.id, { method: 'GET', path: 'sse-forever' }, { source: 'agent' })
  assert.equal(agent.error, undefined)
  assert.equal(agent.response?.stream?.ended, 'timeout')
  assert.ok((agent.response?.durationMs ?? 0) < 1600)
})
