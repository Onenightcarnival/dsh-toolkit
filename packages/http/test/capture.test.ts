import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseJsonPath, readPath, runCaptures } from '../src/capture.ts'
import { HttpEngine } from '../src/engine.ts'
import { DIRECT_TARGET_ID, blankCapture, type HttpCapture } from '../src/protocol.ts'
import { HistoryStore, RequestStore, TargetStore, ValueStore } from '../src/store.ts'

test('parseJsonPath: dots, indexes, quoted names and the optional root', () => {
  assert.deepEqual(parseJsonPath('data.token'), ['data', 'token'])
  assert.deepEqual(parseJsonPath('$.items[0].id'), ['items', 0, 'id'])
  assert.deepEqual(parseJsonPath('$["a.b"][\'c d\']'), ['a.b', 'c d'])
  assert.deepEqual(parseJsonPath('[2]'), [2])
  for (const bad of ['', '$', 'a..b', 'a[', 'a[x]', '$a']) assert.throws(() => parseJsonPath(bad), new RegExp('.'), bad)
})

test('readPath: missing steps and inherited properties are undefined', () => {
  const root = { data: { token: 't', list: [{ id: 7 }] } }
  assert.equal(readPath(root, ['data', 'token']), 't')
  assert.equal(readPath(root, ['data', 'list', 0, 'id']), 7)
  assert.equal(readPath(root, ['data', 'list', 3, 'id']), undefined)
  assert.equal(readPath(root, ['data', 'constructor']), undefined)
  assert.equal(readPath(root, ['data', 'token', 'length']), undefined)
})

function rule(name: string, path: string, source: HttpCapture['source'] = 'body', enabled = true): HttpCapture {
  return { ...blankCapture(), name, source, path, enabled }
}

test('runCaptures: body paths, headers, scalars and the reasons for a miss', () => {
  const headers = new Headers({ 'x-session': 'sess-1', 'content-type': 'application/json' })
  const body = JSON.stringify({ data: { access_token: 'tok-123', expires: 3600, nested: { a: 1 }, empty: '' } })
  const run = runCaptures([
    rule('token', 'data.access_token'),
    rule('ttl', '$.data.expires'),
    rule('session', 'X-Session', 'header'),
    rule('off', 'data.access_token', 'body', false),
    rule('', 'data.access_token'),
    rule('missing', 'data.nope'),
    rule('object', 'data.nested'),
    rule('blank', 'data.empty'),
    rule('bad name', 'data.access_token'),
    rule('badpath', 'data..x'),
    rule('nohdr', 'x-none', 'header'),
  ], { status: 200, headers, body, truncated: false })
  assert.deepEqual(run.values, { token: 'tok-123', ttl: '3600', session: 'sess-1' })
  assert.deepEqual(run.results.map(r => [r.name, r.ok]), [['token', true], ['ttl', true], ['session', true], ['missing', false], ['object', false], ['blank', false], ['bad name', false], ['badpath', false], ['nohdr', false]])
  assert.match(run.results.find(r => r.name === 'missing')?.error ?? '', /not found/)

  const failed = runCaptures([rule('token', 'data.access_token')], { status: 401, headers, body, truncated: false })
  assert.deepEqual(failed.values, {})
  assert.match(failed.results[0]!.error ?? '', /401/)
  assert.match(runCaptures([rule('token', 'a')], { status: 200, headers, body: 'plain', truncated: false }).results[0]!.error ?? '', /not JSON/)
  assert.match(runCaptures([rule('token', 'a')], { status: 200, headers, body, truncated: true }).results[0]!.error ?? '', /truncated/)
  // A header rule does not need a JSON body.
  assert.deepEqual(runCaptures([rule('session', 'x-session', 'header')], { status: 204, headers, body: '', truncated: false }).values, { session: 'sess-1' })
})

test('runCaptures: a lifetime comes from the response path, else from the fixed seconds', () => {
  const headers = new Headers()
  const body = JSON.stringify({ access_token: 'tok-123', expires_in: 7200, text: '90', bad: 'soon', session: 's-1' })
  const run = runCaptures([
    { ...rule('fixed', 'access_token'), ttlSeconds: 600 },
    { ...rule('fromPath', 'access_token'), ttlSeconds: 600, ttlPath: 'expires_in' },
    { ...rule('numericText', 'access_token'), ttlPath: '$.text' },
    { ...rule('unreadable', 'access_token'), ttlPath: 'bad' },
    { ...rule('absent', 'access_token'), ttlPath: 'nope' },
    rule('forever', 'session'),
  ], { status: 200, headers, body, truncated: false })
  assert.deepEqual(run.lifetimes, { fixed: 600_000, fromPath: 7_200_000, numericText: 90_000 })
  assert.deepEqual(Object.keys(run.values), ['fixed', 'fromPath', 'numericText', 'unreadable', 'absent', 'forever'])
  assert.deepEqual(run.results.map(r => [r.name, r.ok, r.warning !== undefined]), [['fixed', true, false], ['fromPath', true, false], ['numericText', true, false], ['unreadable', true, true], ['absent', true, true], ['forever', true, false]])
  // A header value takes its lifetime from the JSON body too.
  const header = runCaptures([{ ...rule('sid', 'x-sid', 'header'), ttlPath: 'expires_in' }], { status: 200, headers: new Headers({ 'x-sid': 'abc' }), body, truncated: false })
  assert.deepEqual(header.lifetimes, { sid: 7_200_000 })
})

test('lifetime field: digits are seconds, other text is a path, and the text reads back', async () => {
  const { lifetimeText, parseLifetime } = await import('../src/client/lifetime.ts')
  assert.deepEqual(parseLifetime(' 7200 '), { ttlSeconds: 7200, ttlPath: '' })
  assert.deepEqual(parseLifetime('expires_in'), { ttlSeconds: 0, ttlPath: 'expires_in' })
  assert.deepEqual(parseLifetime('data.expires[0]'), { ttlSeconds: 0, ttlPath: 'data.expires[0]' })
  assert.deepEqual(parseLifetime('1.5'), { ttlSeconds: 0, ttlPath: '1.5' })
  assert.deepEqual(parseLifetime(''), { ttlSeconds: 0, ttlPath: '' })
  assert.deepEqual(parseLifetime('0'), { ttlSeconds: 0, ttlPath: '' })
  assert.equal(parseLifetime('99999999999').ttlSeconds, 366 * 86400)
  for (const text of ['7200', 'expires_in', '']) assert.equal(lifetimeText(parseLifetime(text)), text)
  // The path wins when a stored rule carries both.
  assert.equal(lifetimeText({ ttlSeconds: 60, ttlPath: 'expires_in' }), 'expires_in')
})

let server: Server
let origin = ''
const dir = mkdtempSync(join(tmpdir(), 'dsh-http-capture-'))
const store = new TargetStore(join(dir, 'targets.json'))
const requests = new RequestStore(join(dir, 'requests.json'))
const history = new HistoryStore(join(dir, 'history.jsonl'), () => 100)
const values = new ValueStore(join(dir, 'values.json'))
const engine = new HttpEngine(store, history, undefined, requests, values)
let issued = 0

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/login') {
      issued++
      res.writeHead(200, { 'content-type': 'application/json', 'x-session': `sess-${issued}` })
      res.end(JSON.stringify({ data: { access_token: `secret-token-${issued}` } }))
      return
    }
    if (url.pathname === '/denied') {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { access_token: 'never' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ authorization: req.headers.authorization ?? null, session: req.headers['x-session'] ?? null, query: url.search }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
})

after(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

test('engine: a saved request captures values that later requests of the scope substitute, masked everywhere', async () => {
  const target = store.create({ name: 'chain', baseUrl: origin, allowPrivate: true, variables: { token: 'static-value' } })
  const login = requests.create({ targetId: target.id, method: 'POST', path: '/login', captures: [rule('token', 'data.access_token'), rule('session', 'x-session', 'header'), rule('gone', 'data.nope')] })

  const first = await engine.send(target.id, { method: 'POST', path: '/login', requestId: login.id }, { source: 'panel' })
  assert.deepEqual(first.captures?.map(c => [c.name, c.ok]), [['token', true], ['session', true], ['gone', false]])
  // The captured values are masked in the response they came from.
  assert.doesNotMatch(first.response?.body ?? '', /secret-token-1/)
  assert.doesNotMatch(JSON.stringify(first.response?.headers), /sess-1/)
  assert.deepEqual(values.map(target.id), { token: 'secret-token-1', session: 'sess-1' })
  assert.deepEqual(values.list(target.id).map(v => [v.name, v.requestId]), [['session', login.id], ['token', login.id]])
  assert.doesNotMatch(JSON.stringify(values.list(target.id)), /secret-token-1/)
  assert.equal(statSync(values.path).mode & 0o777, 0o600)

  // The captured value takes the place of the target variable of the same name; the agent's requests use it too.
  const me = await engine.send('chain', { method: 'GET', path: '/me', query: { s: '{{session}}' }, headers: { Authorization: 'Bearer {{token}}', 'X-Session': '{{session}}' } }, { source: 'agent' })
  assert.equal(me.captures, undefined)
  assert.match(me.response?.body ?? '', /"authorization":"Bearer ••••••"/)
  assert.doesNotMatch(JSON.stringify(me), /secret-token-1|sess-1/)
  assert.equal(me.request.headers.Authorization, 'Bearer {{token}}')
  assert.doesNotMatch(readFileSync(history.path, 'utf8'), /secret-token-1|sess-1/)

  // Sending the source request again refreshes the value.
  await engine.send(target.id, { method: 'POST', path: '/login', requestId: login.id }, { source: 'panel' })
  assert.equal(values.map(target.id).token, 'secret-token-2')

  // A response outside 2xx keeps the stored value; the agent's sends and other scopes run no rules.
  const denied = requests.create({ targetId: target.id, path: '/denied', captures: [rule('token', 'data.access_token')] })
  const refused = await engine.send(target.id, { method: 'GET', path: '/denied', requestId: denied.id }, { source: 'panel' })
  assert.equal(refused.captures?.[0]!.ok, false)
  assert.equal(values.map(target.id).token, 'secret-token-2')
  await engine.send('chain', { method: 'POST', path: '/login', requestId: login.id }, { source: 'agent' })
  assert.equal(values.map(target.id).token, 'secret-token-2')
})

test('engine: requests without a target capture and substitute within their own scope', async () => {
  const login = requests.create({ targetId: DIRECT_TARGET_ID, path: `${origin}/login`, captures: [rule('direct_token', 'data.access_token')] })
  const first = await engine.send(DIRECT_TARGET_ID, { method: 'GET', path: `${origin}/login`, requestId: login.id }, { source: 'panel' })
  assert.equal(first.captures?.[0]!.ok, true)
  const me = await engine.send(DIRECT_TARGET_ID, { method: 'GET', path: `${origin}/me`, headers: { 'X-Session': '{{direct_token}}' } }, { source: 'panel' })
  assert.match(me.response?.body ?? '', /"session":"••••••"/)
  assert.equal(values.delete(DIRECT_TARGET_ID, 'direct_token'), 1)
  const after = await engine.send(DIRECT_TARGET_ID, { method: 'GET', path: `${origin}/me`, headers: { 'X-Session': '{{direct_token}}' } }, { source: 'panel' })
  assert.match(after.response?.body ?? '', /\{\{direct_token\}\}/)
})

test('engine: a target whose secret is not stored refuses to send', async () => {
  const target = store.create({ name: 'needs-auth', baseUrl: origin, allowPrivate: true, auth: { type: 'bearer', token: 'temp' } })
  store.replaceAll(store.list().map(t => (t.id === target.id ? { ...t, auth: { type: 'bearer' as const, token: '' } } : t)))
  assert.equal(store.summarize(store.find('needs-auth')!).auth.type === 'bearer' && (store.summarize(store.find('needs-auth')!).auth as { missing?: boolean }).missing, true)
  const exchange = await engine.send('needs-auth', { method: 'GET', path: '/me' }, { source: 'panel', record: false })
  assert.match(exchange.error ?? '', /not filled in/)
  // Saving the form without a secret is refused; with one the target works again.
  assert.throws(() => store.update(target.id, { auth: { type: 'bearer' } }), /required/)
  store.update(target.id, { auth: { type: 'bearer', token: 'filled-in' } })
  assert.equal((await engine.send('needs-auth', { method: 'GET', path: '/me' }, { source: 'panel', record: false })).response?.status, 200)
})
