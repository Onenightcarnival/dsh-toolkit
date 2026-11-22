import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HttpEngine, isExpired } from '../src/engine.ts'
import { DIRECT_TARGET_ID, blankCapture, referencedVariables, requestInputOf, type HttpCapture, type HttpCaptureRefresh } from '../src/protocol.ts'
import { HistoryStore, RequestStore, TargetStore, ValueStore } from '../src/store.ts'
import { httpRequestTool, httpTargetsTool, renderExchange, toOutput } from '../src/tools.ts'

let server: Server
let origin = ''
const dir = mkdtempSync(join(tmpdir(), 'dsh-http-refresh-'))
const store = new TargetStore(join(dir, 'targets.json'))
const requests = new RequestStore(join(dir, 'requests.json'))
const history = new HistoryStore(join(dir, 'history.jsonl'), () => 500)
const values = new ValueStore(join(dir, 'values.json'))
const engine = new HttpEngine(store, history, undefined, requests, values)

/** What the stub API saw and how it answers. */
const api = { tokenCalls: 0, tokenBodies: [] as string[], apiCalls: 0, pairCalls: 0, issued: 0, valid: new Set<string>(), tokenStatus: 200, tokenDelayMs: 0, seen: [] as Array<{ path: string; headers: Record<string, string | string[] | undefined> }> }

function reset(): void {
  Object.assign(api, { tokenCalls: 0, tokenBodies: [], apiCalls: 0, pairCalls: 0, issued: 0, tokenStatus: 200, tokenDelayMs: 0, seen: [] })
  api.valid.clear()
}

/** Headers the stub API received on its latest request to a path. */
function seenAt(path: string): Record<string, string | string[] | undefined> {
  return api.seen.filter(entry => entry.path.split('?')[0] === path).pop()?.headers ?? {}
}

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      api.seen.push({ path: req.url ?? '', headers: req.headers })
      const json = (status: number, value: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (url.pathname === '/token') {
        api.tokenCalls++
        api.tokenBodies.push(body)
        const answer = (): void => {
          if (api.tokenStatus !== 200) { json(api.tokenStatus, { error: 'nope' }); return }
          const token = `access-token-${++api.issued}`
          api.valid.add(token)
          json(200, { access_token: token, expires_in: 7200, echo: body })
        }
        if (api.tokenDelayMs > 0) setTimeout(answer, api.tokenDelayMs)
        else answer()
        return
      }
      if (url.pathname === '/echo') { json(200, { headers: req.headers, url: req.url }); return }
      if (url.pathname === '/pair') {
        api.pairCalls++
        json(200, { first: 'pair-first-value', second: 'pair-second-value' })
        return
      }
      if (url.pathname === '/sse-401') {
        res.writeHead(401, { 'content-type': 'text/event-stream' })
        res.end('data: denied\n\n')
        return
      }
      if (url.pathname === '/a' || url.pathname === '/b') {
        json(200, { value: `${url.pathname.slice(1)}-value-1` })
        return
      }
      api.apiCalls++
      if (url.pathname === '/always-401') { json(401, { error: 'never' }); return }
      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
      const token = bearer !== '' ? bearer : url.searchParams.get('access_token') ?? ''
      if (!api.valid.has(token)) { json(401, { error: 'invalid token', got: token }); return }
      json(200, { ok: true, path: url.pathname, got: token })
    })
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

function rule(name: string, path: string, refresh: HttpCaptureRefresh, extra: Partial<HttpCapture> = {}): HttpCapture {
  return { ...blankCapture(), name, path, refresh, ...extra }
}

/** A target whose bearer token is the captured variable, with the token request that renews it. */
function tokenTarget(name: string, refresh: HttpCaptureRefresh): { id: string; tokenRequestId: string } {
  const target = store.create({ name, baseUrl: origin, allowPrivate: true, auth: { type: 'bearer', token: '{{access_token}}' }, secrets: { client_secret: 'app-secret-value' } })
  const tokenRequest = requests.create({
    targetId: target.id, name: 'get token', method: 'POST', path: '/token', bodyMode: 'json', body: '{"secret":"{{client_secret}}"}',
    // The token request authenticates with the secret, not with the token it obtains.
    headers: [{ key: 'Authorization', value: 'Basic x', enabled: true }],
    captures: [rule('access_token', 'access_token', refresh, { ttlPath: 'expires_in' })],
  })
  return { id: target.id, tokenRequestId: tokenRequest.id }
}

test('referencedVariables, requestInputOf and isExpired', () => {
  assert.deepEqual([...referencedVariables(['/x/{{ a }}?b={{b}}', 'Bearer {{a}}', '{{ not valid }}'])], ['a', 'b'])
  const input = requestInputOf({ method: 'POST', path: '/p', query: [{ key: 'q', value: '1' }, { key: 'off', value: '2', enabled: false }, { key: ' ', value: 'x' }], headers: [{ key: 'X-A', value: 'a' }], auth: { type: 'none' }, bodyMode: 'form', body: 'ignored', form: [{ key: 'f', value: 'v w' }] })
  assert.deepEqual(input, { method: 'POST', path: '/p', query: [['q', '1']], headers: { 'X-A': 'a', 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, body: 'f=v+w' })
  assert.equal(requestInputOf({ method: 'GET', path: '/p', query: [], headers: [], auth: { type: 'bearer', token: 't' }, bodyMode: 'json', body: '{}', form: [] }).body, undefined)
  const now = 1_000_000
  assert.equal(isExpired({ at: now }, now), false)
  // A value counts as expired 30 s before its expiry, or a tenth of its lifetime when that is shorter.
  assert.equal(isExpired({ at: now - 7_200_000 + 31_000, expiresAt: now + 31_000 }, now), false)
  assert.equal(isExpired({ at: now - 7_200_000 + 29_000, expiresAt: now + 29_000 }, now), true)
  assert.equal(isExpired({ at: now - 800, expiresAt: now + 200 }, now), false)
  assert.equal(isExpired({ at: now - 950, expiresAt: now + 50 }, now), true)
})

test('secret variables: kept on the host, substituted, masked, and required once referenced', async () => {
  reset()
  const target = store.create({ name: 'secrets', baseUrl: origin, allowPrivate: true, variables: { org: 'acme' }, secrets: { client_secret: 'app-secret-value' } })
  assert.deepEqual(store.summarize(target).secrets, { client_secret: 'app…ue' })
  assert.doesNotMatch(JSON.stringify(store.summarize(target)), /app-secret-value/)
  assert.throws(() => store.update(target.id, { variables: { client_secret: 'x' } }), /both a variable and a secret variable/)
  assert.throws(() => store.update(target.id, { secrets: { client_secret: '', other: '' } }), /"other" is required/)
  // An empty value keeps the stored one; a name left out is removed.
  assert.deepEqual(store.update(target.id, { secrets: { client_secret: '', extra: 'second-secret' } }).secrets, { client_secret: 'app-secret-value', extra: 'second-secret' })
  assert.deepEqual(store.update(target.id, { secrets: { client_secret: '' } }).secrets, { client_secret: 'app-secret-value' })

  const sent = await engine.send('secrets', { method: 'POST', path: '/token', body: '{"secret":"{{client_secret}}","org":"{{org}}"}' }, { source: 'agent' })
  assert.equal(api.tokenBodies[0], '{"secret":"app-secret-value","org":"acme"}')
  // The server echoes the secret; it is masked in the response, the stored request keeps the reference.
  assert.doesNotMatch(JSON.stringify(sent), /app-secret-value/)
  assert.match(sent.response?.body ?? '', /••••••/)
  assert.equal(sent.request.body, '{"secret":"{{client_secret}}","org":"{{org}}"}')
  assert.doesNotMatch(readFileSync(history.path, 'utf8'), /app-secret-value/)

  const listed = await (httpTargetsTool(store, values) as unknown as { execute(args: object, ctx: never): Promise<{ targets: Array<{ name: string; variables: string[] }> }> }).execute({}, {} as never)
  assert.deepEqual(listed.targets.find(t => t.name === 'secrets')?.variables, ['org', 'client_secret'])
  assert.doesNotMatch(JSON.stringify(listed), /app-secret-value/)

  // A secret variable without a stored value (an imported target) stops the requests that reference it, and only those.
  store.replaceAll(store.list().map(t => (t.id === target.id ? { ...t, secrets: { client_secret: '' } } : t)))
  assert.equal(store.summarize(store.find('secrets')!).secrets.client_secret, '')
  const calls = api.tokenCalls
  const refused = await engine.send('secrets', { method: 'POST', path: '/token', body: '{{client_secret}}' }, { source: 'panel' })
  assert.match(refused.error ?? '', /secret variable \{\{client_secret\}\} of target 'secrets' is not filled in/)
  assert.equal(api.tokenCalls, calls)
  assert.equal((await engine.send('secrets', { method: 'POST', path: '/token', body: '{}' }, { source: 'panel' })).error, undefined)
})

test('refresh: a missing value is obtained with the saved request before the agent\'s request is sent', async () => {
  reset()
  const { id, tokenRequestId } = tokenTarget('auto', 'expired')
  // An authentication value that is a variable reference is shown as written.
  assert.deepEqual(store.summarize(store.find('auto')!).auth, { type: 'bearer', hint: '{{access_token}}' })
  const first = await engine.send('auto', { method: 'GET', path: '/orders' }, { source: 'agent' })
  assert.equal(first.response?.status, 200)
  assert.equal(api.tokenCalls, 1)
  assert.equal(api.tokenBodies[0], '{"secret":"app-secret-value"}')
  assert.deepEqual(first.refreshed?.map(r => [r.requestId, r.requestName, r.variables, r.reason, r.ok]), [[tokenRequestId, 'get token', ['access_token'], 'missing', true]])
  // Neither the token nor the secret reaches the agent or the history.
  assert.doesNotMatch(JSON.stringify(first), /access-token-1|app-secret-value/)
  assert.doesNotMatch(JSON.stringify(history.list(id)), /access-token-\d|app-secret-value/)
  assert.equal(first.request.sentHeaders?.authorization, 'Bearer ••••••')

  // The refresh is recorded as its own exchange, attributed to the sender that caused it.
  const recorded = history.list(id)
  assert.deepEqual(recorded.map(e => [e.request.path, e.source, e.refreshOf]), [['/orders', 'agent', undefined], ['/token', 'agent', ['access_token']]])
  assert.equal(recorded[1]!.id, first.refreshed?.[0]!.exchangeId)
  assert.equal(recorded[1]!.captures?.[0]!.ok, true)
  // The token request obtains the token, so the target's bearer authentication is not put on it: its own header stays.
  assert.equal(recorded[1]!.request.sentHeaders?.authorization, 'Basic x')

  // The value carries the lifetime the response states, and is used as it is while it lasts.
  const entry = values.entry(id, 'access_token')
  assert.equal(entry?.value, 'access-token-1')
  assert.equal((entry?.expiresAt ?? 0) - (entry?.at ?? 0), 7_200_000)
  assert.equal(values.list(id)[0]!.expiresAt, entry?.expiresAt)
  const second = await engine.send('auto', { method: 'GET', path: '/orders' }, { source: 'agent' })
  assert.equal(second.response?.status, 200)
  assert.equal(second.refreshed, undefined)
  assert.equal(api.tokenCalls, 1)

  const output = toOutput(first)
  assert.deepEqual(output.refreshed, [{ request: 'get token', variables: ['access_token'], ok: true }])
  assert.match(renderExchange('GET', output), /host refreshed \{\{access_token\}\} with the saved request "get token" first/)
})

test('refresh: an expired value is renewed; a rule that is off or switched off leaves the request alone', async () => {
  reset()
  const { id, tokenRequestId } = tokenTarget('expiry', 'expired')
  api.valid.add('old-token')
  values.set(id, { access_token: 'old-token' }, tokenRequestId, { access_token: 20 })
  await new Promise(resolve => setTimeout(resolve, 30))
  const renewed = await engine.send(id, { method: 'GET', path: '/orders' }, { source: 'panel' })
  assert.equal(renewed.refreshed?.[0]!.reason, 'expired')
  assert.match(renewed.response?.body ?? '', /"ok":true/)
  assert.notEqual(values.entry(id, 'access_token')?.value, 'old-token')

  // With the rule off the expired value is still sent as it is.
  const off = tokenTarget('expiry-off', 'off')
  values.set(off.id, { access_token: 'old-token' }, off.tokenRequestId, { access_token: 1 })
  await new Promise(resolve => setTimeout(resolve, 5))
  const calls = api.tokenCalls
  const stale = await engine.send(off.id, { method: 'GET', path: '/orders' }, { source: 'panel' })
  assert.equal(stale.response?.status, 200)
  assert.equal(stale.refreshed, undefined)
  assert.equal(api.tokenCalls, calls)
  values.delete(off.id)
  assert.equal((await engine.send(off.id, { method: 'GET', path: '/orders' }, { source: 'panel' })).response?.status, 401)
  assert.equal(api.tokenCalls, calls)

  // Sending the token request itself runs no refresh first.
  values.delete(id)
  const own = await engine.send(id, { ...requestInputOf(requests.get(tokenRequestId)!), requestId: tokenRequestId }, { source: 'panel' })
  assert.equal(own.refreshed, undefined)
  assert.equal(own.refreshOf, undefined)
  assert.equal(own.captures?.[0]!.ok, true)
})

test('refresh: concurrent requests share one refresh', async () => {
  reset()
  api.tokenDelayMs = 60
  const { id } = tokenTarget('shared', 'expired')
  const results = await Promise.all([1, 2, 3, 4, 5].map(n => engine.send(id, { method: 'GET', path: `/orders/${n}` }, { source: n % 2 === 0 ? 'agent' : 'panel' })))
  assert.deepEqual(results.map(r => r.response?.status), [200, 200, 200, 200, 200])
  assert.equal(api.tokenCalls, 1)
  assert.equal(new Set(results.map(r => r.refreshed?.[0]!.exchangeId)).size, 1)
  assert.equal(history.list(id).filter(e => e.refreshOf !== undefined).length, 1)
})

test('refresh: a failed refresh stops the request and is reported; cancelling stops the wait', async () => {
  reset()
  api.tokenStatus = 500
  const { id } = tokenTarget('failing', 'expired')
  const failed = await engine.send(id, { method: 'DELETE', path: '/orders/1' }, { source: 'agent' })
  assert.equal(failed.response, undefined)
  assert.match(failed.error ?? '', /refresh of \{\{access_token\}\} by request 'get token' failed: \{\{access_token\}\} was not captured: response status 500/)
  assert.equal(failed.refreshed?.[0]!.ok, false)
  assert.equal(api.apiCalls, 0)
  assert.equal(api.tokenCalls, 1)
  const output = toOutput(failed)
  assert.equal(output.ok, false)
  assert.equal(output.refreshed?.[0]!.ok, false)
  // The next request tries again; nothing is retried within one request.
  await engine.send(id, { method: 'GET', path: '/orders' }, { source: 'agent' })
  assert.equal(api.tokenCalls, 2)

  api.tokenStatus = 200
  api.tokenDelayMs = 300
  const cancel = new AbortController()
  const started = Date.now()
  const pending = engine.send(id, { method: 'GET', path: '/orders' }, { source: 'panel', signal: cancel.signal })
  setTimeout(() => { cancel.abort() }, 30)
  const cancelled = await pending
  assert.equal(cancelled.error, 'cancelled')
  assert.ok(Date.now() - started < 250)
  assert.equal(api.apiCalls, 0)
  // The refresh that was under way completes and its value is kept.
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.match(values.entry(id, 'access_token')?.value ?? '', /^access-token-/)
})

test('refresh: a 401 renews the variable and sends the request once more when the rule asks for it', async () => {
  reset()
  const { id, tokenRequestId } = tokenTarget('rejected', 'rejected')
  values.set(id, { access_token: 'revoked-token' }, tokenRequestId, { access_token: 7_200_000 })
  const before = history.list(id).length
  const retried = await engine.send(id, { method: 'GET', path: '/orders' }, { source: 'agent' })
  assert.equal(retried.response?.status, 200)
  assert.deepEqual(retried.refreshed?.map(r => [r.reason, r.ok]), [['rejected', true]])
  assert.equal(api.apiCalls, 2)
  assert.equal(api.tokenCalls, 1)
  // The rejected attempt, the refresh and the second attempt are three records.
  assert.deepEqual(history.list(id).slice(0, history.list(id).length - before).map(e => [e.request.path, e.response?.status]), [['/orders', 200], ['/token', 200], ['/orders', 401]])

  // A 401 that follows a refresh made for this request is returned as it is.
  values.delete(id)
  const denied = await engine.send(id, { method: 'GET', path: '/always-401' }, { source: 'agent' })
  assert.equal(denied.response?.status, 401)
  assert.deepEqual(denied.refreshed?.map(r => r.reason), ['missing'])
  assert.equal(api.tokenCalls, 2)
  // A refresh that fails after a 401 leaves the 401 as the result, with the failure noted.
  api.tokenStatus = 500
  const kept = await engine.send(id, { method: 'GET', path: '/always-401' }, { source: 'agent' })
  assert.equal(kept.response?.status, 401)
  assert.deepEqual(kept.refreshed?.map(r => [r.reason, r.ok]), [['rejected', false]])
  api.tokenStatus = 200

  // A rule that only renews on expiry returns the 401 as it is.
  const plain = tokenTarget('rejected-plain', 'expired')
  values.set(plain.id, { access_token: 'revoked-token' }, plain.tokenRequestId, { access_token: 7_200_000 })
  const calls = api.tokenCalls
  const unauthorized = await engine.send(plain.id, { method: 'GET', path: '/orders' }, { source: 'agent' })
  assert.equal(unauthorized.response?.status, 401)
  assert.equal(unauthorized.refreshed, undefined)
  assert.equal(api.tokenCalls, calls)
})

test('refresh: a refreshed request may need a refresh itself; a cycle and a long chain are refused', async () => {
  reset()
  // b is obtained with a; a is obtained with nothing.
  const chain = store.create({ name: 'chain', baseUrl: origin, allowPrivate: true })
  requests.create({ targetId: chain.id, name: 'get a', path: '/a', captures: [rule('a', 'value', 'expired')] })
  requests.create({ targetId: chain.id, name: 'get b', path: '/b', query: [{ key: 'with', value: '{{a}}', enabled: true }], captures: [rule('b', 'value', 'expired')] })
  api.valid.add('b-value-1')
  const ok = await engine.send(chain.id, { method: 'GET', path: '/orders', query: { access_token: '{{b}}' } }, { source: 'agent' })
  assert.equal(ok.response?.status, 200)
  assert.deepEqual(values.map(chain.id), { a: 'a-value-1', b: 'b-value-1' })
  const nested = history.list(chain.id).find(e => e.request.path === '/b')
  assert.deepEqual(nested?.refreshed?.map(r => [r.requestName, r.ok]), [['get a', true]])
  assert.match(nested?.request.url ?? '', /with=%E2%80%A2|with=••••••/)

  // a needs b and b needs a.
  const cycle = store.create({ name: 'cycle', baseUrl: origin, allowPrivate: true })
  requests.create({ targetId: cycle.id, name: 'get a', path: '/a', headers: [{ key: 'X-B', value: '{{b}}', enabled: true }], captures: [rule('a', 'value', 'expired')] })
  requests.create({ targetId: cycle.id, name: 'get b', path: '/b', headers: [{ key: 'X-A', value: '{{a}}', enabled: true }], captures: [rule('b', 'value', 'expired')] })
  const looped = await engine.send(cycle.id, { method: 'GET', path: '/orders', headers: { 'X-A': '{{a}}' } }, { source: 'agent' })
  assert.match(looped.error ?? '', /depends on a variable it refreshes/)
  assert.equal(looped.response, undefined)

  // v0 ← v1 ← v2 ← v3 ← v4: a chain holds three refreshes.
  const deep = store.create({ name: 'deep', baseUrl: origin, allowPrivate: true })
  for (let i = 0; i < 4; i++) requests.create({ targetId: deep.id, name: `get v${i}`, path: '/a', query: [{ key: 'with', value: `{{v${i + 1}}}`, enabled: true }], captures: [rule(`v${i}`, 'value', 'expired')] })
  requests.create({ targetId: deep.id, name: 'get v4', path: '/a', captures: [rule('v4', 'value', 'expired')] })
  const tooDeep = await engine.send(deep.id, { method: 'GET', path: '/orders', headers: { 'X-V': '{{v1}}' } }, { source: 'agent' })
  assert.match(tooDeep.error ?? '', /more than 3 refreshes in a chain/)
  assert.deepEqual(values.map(deep.id), {})
  const fits = await engine.send(deep.id, { method: 'GET', path: '/orders', headers: { 'X-V': '{{v2}}' } }, { source: 'agent' })
  assert.equal(fits.error, undefined)
  assert.deepEqual(Object.keys(values.map(deep.id)).sort(), ['v2', 'v3', 'v4'])
})

test('stores: capture rules take defaults and limits; value expiry survives a reload', () => {
  const saved = requests.create({ targetId: 'x', path: '/', captures: [
    { name: 'a', source: 'body', path: 'p', enabled: true } as HttpCapture,
    { ...blankCapture(), name: 'b', ttlSeconds: 10 ** 12, refresh: 'sometimes' as never },
    { ...blankCapture(), name: 'c', ttlSeconds: -5, ttlPath: 'data.expires_in', refresh: 'rejected' },
  ] })
  assert.deepEqual(saved.captures.map(c => [c.ttlSeconds, c.ttlPath, c.refresh]), [[0, '', 'off'], [366 * 86400, '', 'off'], [0, 'data.expires_in', 'rejected']])
  assert.deepEqual(new RequestStore(requests.path).get(saved.id)?.captures, saved.captures)
  values.set('reload', { t: 'value-1', forever: 'value-2' }, saved.id, { t: 5000 })
  const reloaded = new ValueStore(values.path)
  const entry = reloaded.entry('reload', 't')
  assert.equal((entry?.expiresAt ?? 0) - (entry?.at ?? 0), 5000)
  assert.equal(reloaded.entry('reload', 'forever')?.expiresAt, undefined)
  assert.equal(reloaded.entry('reload', 'none'), undefined)
})

test('variables in the target\'s fixed headers and authentication; a request does not carry the variable it obtains', async () => {
  reset()
  const target = store.create({
    name: 'fixed', baseUrl: origin, allowPrivate: true, variables: { region: 'eu' }, secrets: { api_key: 'key-secret-123' },
    headers: { 'X-Region': '{{region}}', 'X-Key': '{{api_key}}', 'X-Sid': 'sid {{sid}}', 'X-Unknown': '{{nope}}' },
    auth: { type: 'query', name: 'k', value: '{{api_key}}' },
  })
  requests.create({ targetId: target.id, name: 'get sid', path: '/a', captures: [rule('sid', 'value', 'expired')] })
  const sent = await engine.send('fixed', { method: 'GET', path: '/echo' }, { source: 'agent' })
  assert.equal(sent.response?.status, 200)
  assert.deepEqual(sent.refreshed?.map(r => [r.requestName, r.variables, r.ok]), [['get sid', ['sid'], true]])
  // The server received the values; an undefined name stays as written.
  const got = seenAt('/echo')
  assert.deepEqual([got['x-region'], got['x-key'], got['x-sid'], got['x-unknown']], ['eu', 'key-secret-123', 'sid a-value-1', '{{nope}}'])
  assert.match(api.seen.at(-1)?.path ?? '', /\/echo\?k=key-secret-123$/)
  // The exchange shows the secret and the captured value masked, the plain variable as it is.
  assert.doesNotMatch(JSON.stringify(sent), /key-secret-123|a-value-1/)
  assert.equal(sent.request.sentHeaders?.['x-region'], 'eu')
  assert.equal(sent.request.sentHeaders?.['x-sid'], 'sid ••••••')
  assert.match(sent.request.url, /k=%E2%80%A2|k=••••••/)
  // The request that obtains {{sid}} is sent without the fixed header that carries it, and with the others.
  const refresh = seenAt('/a')
  assert.equal(refresh['x-sid'], undefined)
  assert.deepEqual([refresh['x-region'], refresh['x-key']], ['eu', 'key-secret-123'])

  // Header and basic authentication take variables too.
  store.update(target.id, { auth: { type: 'header', name: 'X-Token', value: 'T-{{region}}-{{api_key}}' } })
  const header = await engine.send('fixed', { method: 'GET', path: '/echo' }, { source: 'agent' })
  assert.equal(seenAt('/echo')['x-token'], 'T-eu-key-secret-123')
  assert.doesNotMatch(JSON.stringify(header), /key-secret-123/)
  store.update(target.id, { auth: { type: 'basic', username: 'svc-{{region}}', password: '{{api_key}}' } })
  const basic = await engine.send('fixed', { method: 'GET', path: '/echo' }, { source: 'agent' })
  assert.equal(seenAt('/echo').authorization, `Basic ${Buffer.from('svc-eu:key-secret-123').toString('base64')}`)
  assert.doesNotMatch(JSON.stringify(basic), /key-secret-123/)
  assert.doesNotMatch(JSON.stringify(basic), new RegExp(Buffer.from('svc-eu:key-secret-123').toString('base64')))
})

test('refresh: requests without a target refresh within their own scope', async () => {
  reset()
  values.delete(DIRECT_TARGET_ID)
  const tokenRequest = requests.create({ targetId: DIRECT_TARGET_ID, name: 'direct token', method: 'POST', path: `${origin}/token`, bodyMode: 'json', body: '{}', captures: [rule('direct_token', 'access_token', 'expired', { ttlSeconds: 600 })] })
  const sent = await engine.send(DIRECT_TARGET_ID, { method: 'GET', path: `${origin}/orders`, headers: { Authorization: 'Bearer {{direct_token}}' } }, { source: 'panel' })
  assert.equal(sent.response?.status, 200)
  assert.deepEqual(sent.refreshed?.map(r => [r.requestId, r.reason, r.ok]), [[tokenRequest.id, 'missing', true]])
  assert.equal((values.entry(DIRECT_TARGET_ID, 'direct_token')?.expiresAt ?? 0) - (values.entry(DIRECT_TARGET_ID, 'direct_token')?.at ?? 0), 600_000)
  assert.doesNotMatch(JSON.stringify(sent), /access-token-1/)
  // A rule of another scope does not refresh here.
  const elsewhere = store.create({ name: 'elsewhere', baseUrl: origin, allowPrivate: true })
  const calls = api.tokenCalls
  const other = await engine.send(elsewhere.id, { method: 'GET', path: '/orders', headers: { Authorization: 'Bearer {{direct_token}}' } }, { source: 'panel' })
  assert.equal(other.response?.status, 401)
  assert.equal(other.refreshed, undefined)
  assert.equal(api.tokenCalls, calls)
  requests.delete(tokenRequest.id)
})

test('refresh: one request provides several variables in one send; of several sources the value\'s own is sent', async () => {
  reset()
  const target = store.create({ name: 'sources', baseUrl: origin, allowPrivate: true })
  requests.create({ targetId: target.id, name: 'pair', path: '/pair', captures: [rule('first', 'first', 'expired'), rule('second', 'second', 'expired'), rule('unused', 'first', 'expired')] })
  const both = await engine.send(target.id, { method: 'GET', path: '/echo', headers: { 'X-One': '{{first}}', 'X-Two': '{{second}}' } }, { source: 'agent' })
  assert.equal(api.pairCalls, 1)
  assert.deepEqual(both.refreshed?.map(r => [r.variables, r.ok]), [[['first', 'second'], true]])
  assert.deepEqual([seenAt('/echo')['x-one'], seenAt('/echo')['x-two']], ['pair-first-value', 'pair-second-value'])

  const fromA = requests.create({ targetId: target.id, name: 'from a', path: '/a', captures: [rule('shared', 'value', 'expired')] })
  const fromB = requests.create({ targetId: target.id, name: 'from b', path: '/b', captures: [rule('shared', 'value', 'expired')] })
  // Without a value the request created first is sent.
  const first = await engine.send(target.id, { method: 'GET', path: '/echo', headers: { 'X-S': '{{shared}}' } }, { source: 'agent' })
  assert.deepEqual(first.refreshed?.map(r => r.requestId), [fromA.id])
  assert.equal(values.entry(target.id, 'shared')?.value, 'a-value-1')
  // A value that came from the other request is renewed by that request.
  values.set(target.id, { shared: 'stale' }, fromB.id, { shared: 1 })
  await new Promise(resolve => setTimeout(resolve, 5))
  const second = await engine.send(target.id, { method: 'GET', path: '/echo', headers: { 'X-S': '{{shared}}' } }, { source: 'agent' })
  assert.deepEqual(second.refreshed?.map(r => [r.requestId, r.reason]), [[fromB.id, 'expired']])
  assert.equal(values.entry(target.id, 'shared')?.value, 'b-value-1')

  // A rule switched off, and a rule whose request is gone, refresh nothing.
  requests.update(fromA.id, { captures: [{ ...rule('shared', 'value', 'expired'), enabled: false }] })
  requests.delete(fromB.id)
  values.delete(target.id, 'shared')
  const none = await engine.send(target.id, { method: 'GET', path: '/echo', headers: { 'X-S': '{{shared}}' } }, { source: 'agent' })
  assert.equal(none.refreshed, undefined)
  assert.equal(seenAt('/echo')['x-s'], '{{shared}}')
})

test('refresh: the agent tool and the connection test go through it; an event stream 401 is not retried', async () => {
  reset()
  const { id } = tokenTarget('via-tool', 'rejected')
  assert.equal(store.find('via-tool')?.allowMutations, false)
  const tool = httpRequestTool(engine) as unknown as { execute(args: Record<string, unknown>, ctx: never): Promise<Record<string, unknown>> }
  // A variable the host refreshes is listed for the agent before it has a value.
  const listing = await (httpTargetsTool(store, values, requests) as unknown as { execute(args: object, ctx: never): Promise<{ targets: Array<{ name: string; variables: string[] }> }> }).execute({}, {} as never)
  assert.deepEqual(listing.targets.find(t => t.name === 'via-tool')?.variables, ['client_secret', 'access_token'])
  assert.equal(values.entry(id, 'access_token'), undefined)
  // The host's refresh is a POST; the agent's GET needs neither the mutation switch nor confirm for it.
  const got = await tool.execute({ target: 'via-tool', method: 'GET', path: '/orders' }, {} as never)
  assert.equal(got.ok, true)
  assert.equal(got.status, 200)
  assert.deepEqual(got.refreshed, [{ request: 'get token', variables: ['access_token'], ok: true }])
  assert.equal(api.tokenCalls, 1)
  assert.doesNotMatch(JSON.stringify(got), /access-token-1|app-secret-value/)
  // The agent's own POST is still refused, and it cannot send the token request itself.
  const refused = await tool.execute({ target: 'via-tool', method: 'POST', path: '/token', body: '{}' }, {} as never)
  assert.match(String(refused.error), /GET\/HEAD\/OPTIONS only/)
  assert.equal(api.tokenCalls, 1)

  // A failed refresh comes back as a tool failure the pipeline accepts: lossless JSON, the refresh listed.
  values.delete(id)
  api.tokenStatus = 500
  const failed = await tool.execute({ target: 'via-tool', method: 'GET', path: '/orders' }, {} as never)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(failed)), failed)
  assert.equal(failed.ok, false)
  assert.match(String(failed.error), /refresh of \{\{access_token\}\} by request 'get token' failed/)
  assert.deepEqual((failed.refreshed as Array<{ ok: boolean }>).map(r => r.ok), [false])
  assert.match(renderExchange('GET', failed as never), /^request failed: refresh of/)
  api.tokenStatus = 200
  api.tokenCalls = 1

  // The connection test of a target with a token from a variable obtains the token first.
  values.delete(id)
  const tested = await engine.test(id)
  assert.deepEqual([tested.ok, tested.status], [true, 200])
  assert.equal(api.tokenCalls, 2)

  // A 401 that is an event stream is returned as it is.
  const stream = await engine.send(id, { method: 'GET', path: '/sse-401' }, { source: 'panel' })
  assert.equal(stream.response?.status, 401)
  assert.equal(stream.refreshed, undefined)
  assert.equal(api.tokenCalls, 2)
})

test('upgrade: files written before secret variables, lifetimes and refresh load with defaults', async () => {
  reset()
  const old = mkdtempSync(join(tmpdir(), 'dsh-http-upgrade-'))
  try {
    mkdirSync(old, { recursive: true })
    const targetId = 'aaaaaaaaaaaa'
    const requestId = 'bbbbbbbbbbbb'
    writeFileSync(join(old, 'targets.json'), JSON.stringify({ version: 1, settings: { agentTools: true, historyLimit: 200 }, targets: [
      { id: targetId, name: 'legacy', baseUrl: origin, auth: { type: 'none' }, headers: { 'X-Fixed': 'yes' }, variables: { org: 'acme' }, allowedHosts: [], allowMutations: false, allowPrivate: true, timeoutMs: 30000, createdAt: 1, updatedAt: 1 },
    ] }))
    writeFileSync(join(old, 'requests.json'), JSON.stringify({ version: 1, requests: [
      { id: requestId, targetId, name: 'login', method: 'POST', path: '/token', query: [], headers: [], auth: { type: 'none' }, bodyMode: 'json', body: '{}', form: [], captures: [{ name: 'token', source: 'body', path: 'access_token', enabled: true }], createdAt: 1, updatedAt: 1 },
    ] }))
    writeFileSync(join(old, 'values.json'), JSON.stringify({ version: 1, scopes: { [targetId]: { token: { value: 'kept-token-value', requestId, at: 5 } } } }))
    const oldStore = new TargetStore(join(old, 'targets.json'))
    const oldRequests = new RequestStore(join(old, 'requests.json'))
    const oldValues = new ValueStore(join(old, 'values.json'))
    const oldEngine = new HttpEngine(oldStore, new HistoryStore(join(old, 'history.jsonl'), () => 100), undefined, oldRequests, oldValues)

    assert.deepEqual(oldStore.find('legacy')?.secrets, {})
    assert.deepEqual(oldStore.summarize(oldStore.find('legacy')!).secrets, {})
    assert.deepEqual(oldRequests.get(requestId)?.captures, [{ name: 'token', source: 'body', path: 'access_token', enabled: true, ttlSeconds: 0, ttlPath: '', refresh: 'off' }])
    assert.deepEqual(oldValues.list(targetId).map(v => [v.name, v.expiresAt]), [['token', undefined]])
    // The stored value is used as before: no refresh, no expiry.
    api.valid.add('kept-token-value')
    const sent = await oldEngine.send('legacy', { method: 'GET', path: '/orders', headers: { Authorization: 'Bearer {{token}}' } }, { source: 'agent' })
    assert.equal(sent.response?.status, 200)
    assert.equal(sent.refreshed, undefined)
    assert.equal(api.tokenCalls, 0)
    // The target takes secret variables and the rule a refresh setting from here on.
    assert.deepEqual(oldStore.update(targetId, { secrets: { key: 'new-secret-value' } }).secrets, { key: 'new-secret-value' })
    assert.equal(oldStore.find('legacy')?.variables.org, 'acme')
    oldRequests.update(requestId, { captures: [{ ...oldRequests.get(requestId)!.captures[0]!, refresh: 'expired' }] })
    oldValues.delete(targetId)
    const renewed = await oldEngine.send('legacy', { method: 'GET', path: '/orders', headers: { Authorization: 'Bearer {{token}}' } }, { source: 'agent' })
    assert.deepEqual(renewed.refreshed?.map(r => r.ok), [true])
    assert.equal(renewed.response?.status, 200)
  } finally { rmSync(old, { recursive: true, force: true }) }
})
