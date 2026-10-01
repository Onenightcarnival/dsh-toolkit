import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = await build({
  stdin: { contents: `export * from './auth/chatgpt.ts'; export * from './providers/chatgpt.ts'; export * from './auth/oauth-flow.ts'; export * from './auth/store.ts'; export * from './providers/accounts.ts'; export * from './providers/chatgpt-tokens.ts'; export * from './auth/chatgpt-lock.ts';`, resolveDir: fileURLToPath(new URL('../src/backend', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'host-imports', setup(build) {
    build.onResolve({ filter: /^(@deepseek-ai\/|undici$)/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }))
  } }],
})
const mod = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', use: 'sig', alg: 'RS256' }
const jwt = (patch = {}, key = privateKey, headerPatch = {}) => {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid, ...headerPatch })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: 'oaiapp_fixture', sub: 'user-1', nonce: 'fixture-nonce', exp: Math.floor(Date.now() / 1000) + 3600, email: 'user@example.test', ...patch })).toString('base64url')
  return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url')}`
}
const session = { clientId: 'oaiapp_fixture', subject: 'user-1', hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000', emailAddress: 'user@example.test', idToken: jwt(), accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600000, scopes: mod.CHATGPT_SCOPE.split(' ') }
const keys = async () => Response.json({ keys: [jwk] })
const tokens = (overrides = {}) => ({ ...session, ...overrides })
const tokenBody = (overrides = {}) => ({ access_token: 'new-access', refresh_token: 'new-refresh', id_token: jwt(), token_type: 'Bearer', expires_in: 3600, scope: mod.CHATGPT_SCOPE, ...overrides })
const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const complete = [{ type: 'response.output_text.delta', delta: 'hello' }, { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }]

async function isolated(action) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-'))
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try { await action(home) } finally { if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old; await rm(home, { recursive: true, force: true }) }
}

test('ChatGPT validates signature, issuer, client, nonce, expiration and subject', async () => {
  assert.deepEqual(await mod.validateChatGptIdentity(jwt(), 'oaiapp_fixture', 'fixture-nonce', keys), { subject: 'user-1', emailAddress: 'user@example.test' })
  for (const patch of [{ iss: 'https://other.test' }, { aud: 'other' }, { nonce: 'wrong' }, { exp: 1 }, { sub: '' }, { aud: ['oaiapp_fixture', 'other'] }, { nbf: Date.now() / 1000 + 1000 }]) {
    await assert.rejects(mod.validateChatGptIdentity(jwt(patch), 'oaiapp_fixture', 'fixture-nonce', keys), /claims/)
  }
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
  await assert.rejects(mod.validateChatGptIdentity(jwt({}, other.privateKey), 'oaiapp_fixture', 'fixture-nonce', keys), /signature/)
  await assert.rejects(mod.validateChatGptIdentity(jwt({}, privateKey, { alg: 'none' }), 'oaiapp_fixture', 'fixture-nonce', keys), /signature/)
})

test('dynamic registration keeps the host and issued client, and exchange uses granted scopes', async () => isolated(async home => {
  const registration = await mod.prepareChatGptRegistration()
  assert.equal((await mod.prepareChatGptRegistration()).hostId, registration.hostId)
  const spec = mod.chatGptFlow(registration)
  const input = { redirectUri: 'http://127.0.0.1:1457/auth/callback', state: 'state', nonce: 'fixture-nonce', pkce: { verifier: 'verifier', challenge: 'challenge' } }
  const url = new URL(spec.buildAuthorizeUrl(input))
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client')
  assert.equal(url.searchParams.get('resource'), mod.CHATGPT_RESOURCE)
  assert.equal(url.searchParams.get('agent_name_hint'), 'DeepSeek Harness Toolkit')
  assert.throws(() => spec.validateCallback(new URLSearchParams('code=x')), /client ID/)
  spec.validateCallback(new URLSearchParams('client_id=issued-client.v2'))
  for (const client of ['dynamic_agent_client', '__proto__', '']) assert.throws(() => spec.validateCallback(new URLSearchParams({ client_id: client })), /client ID/)
  const callbackParams = new URLSearchParams({ code: 'code', state: 'state', client_id: 'oaiapp_fixture' })
  spec.validateCallback(callbackParams)
  const result = await mod.exchangeChatGptCode('code', { ...input, callbackParams }, registration, async (url, init) => {
    if (url.endsWith('/jwks.json')) return keys()
    assert.equal(url, mod.CHATGPT_TOKEN_URL)
    assert.equal(init.body.get('client_id'), 'oaiapp_fixture')
    assert.equal(init.body.get('redirect_uri'), input.redirectUri)
    assert.equal(init.body.get('code_verifier'), 'verifier')
    assert.equal(init.body.get('client_secret'), null)
    return Response.json(tokenBody())
  })
  assert.equal(result.clientId, 'oaiapp_fixture')
  await mod.saveAccountSession('chatgpt', result.clientId, result)
  assert.equal((await mod.getAccountSession('chatgpt', result.clientId)).subject, 'user-1')
  await mod.deleteAccountSession('chatgpt', result.clientId)
  const saved = await mod.prepareChatGptRegistration(result.clientId)
  assert.equal(saved.subject, 'user-1')
  const returning = mod.chatGptFlow(saved)
  const again = new URL(returning.buildAuthorizeUrl(input))
  assert.equal(again.searchParams.get('client_id'), result.clientId)
  assert.equal(again.searchParams.has('agent_name_hint'), false)
  returning.validateCallback(new URLSearchParams('code=x'))
  assert.throws(() => returning.validateCallback(new URLSearchParams('client_id=oaiapp_other')), /client ID/)
  const path = join(home, 'plugins/subscriptions/chatgpt-registrations.json')
  assert.doesNotMatch(await readFile(path, 'utf8'), /new-access|new-refresh|eyJ/)
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
}))

test('declined plan permission retains identity without permitting inference', async () => isolated(async () => {
  const registration = await mod.prepareChatGptRegistration()
  const attempt = { callbackParams: new URLSearchParams('client_id=oaiapp_fixture'), nonce: 'fixture-nonce', pkce: { verifier: 'v' }, redirectUri: 'http://127.0.0.1:1455/auth/callback' }
  await assert.rejects(mod.exchangeChatGptCode('code', attempt, registration, async url => url.endsWith('/jwks.json') ? keys() : Response.json(tokenBody({ scope: 'openid email profile', refresh_token: undefined }))), /not enabled/)
  const saved = await mod.prepareChatGptRegistration('oaiapp_fixture')
  assert.equal(saved.subject, 'user-1')
  assert.equal(saved.planEnabled, false)
  assert.equal(await mod.getAccountSession('chatgpt', saved.clientId), undefined)
  let fetched = false
  await assert.rejects(mod.fetchChatGptModels(tokens({ scopes: ['openid'] }), async () => { fetched = true }), /disabled/)
  assert.equal(fetched, false)
}))

test('failed code exchange retains issued registration and changed identity cannot replace it', async () => isolated(async () => {
  const registration = await mod.prepareChatGptRegistration()
  const attempt = { callbackParams: new URLSearchParams('client_id=oaiapp_fixture'), nonce: 'fixture-nonce', pkce: { verifier: 'v' }, redirectUri: 'http://127.0.0.1:1455/auth/callback' }
  await assert.rejects(mod.exchangeChatGptCode('code', attempt, registration, async () => Response.json({ error: 'invalid_grant' }, { status: 400 })), /invalid_grant/)
  assert.equal((await mod.prepareChatGptRegistration('oaiapp_fixture')).clientId, 'oaiapp_fixture')
  await assert.rejects(mod.exchangeChatGptCode('code', attempt, { ...registration, clientId: 'oaiapp_fixture', subject: 'other-user' }, async url => url.endsWith('/jwks.json') ? keys() : Response.json(tokenBody())), /identity changed/)
}))

test('refresh rotates credentials and preserves omitted scopes', async () => {
  const renewed = await mod.refreshChatGpt(session, async (url, init) => {
    assert.equal(url, mod.CHATGPT_TOKEN_URL)
    assert.equal(init.body.get('grant_type'), 'refresh_token')
    assert.equal(init.body.get('client_id'), session.clientId)
    assert.equal(init.body.get('resource'), mod.CHATGPT_RESOURCE)
    assert.equal(init.body.get('scope'), null)
    return Response.json(tokenBody({ id_token: undefined, scope: undefined }))
  })
  assert.equal(renewed.refreshToken, 'new-refresh')
  assert.deepEqual(renewed.scopes, session.scopes)
  assert.equal(renewed.idToken, session.idToken)
  await assert.rejects(mod.refreshChatGpt(session, async () => Response.json(tokenBody({ refresh_token: undefined }))), /replacement/)
  await assert.rejects(mod.refreshChatGpt(session, async () => Response.json({ error: 'invalid_grant' }, { status: 400 })), mod.isChatGptPermanentRefreshError)
  await assert.rejects(mod.refreshChatGpt(session, async () => new Response('', { status: 503 })), error => !mod.isChatGptPermanentRefreshError(error))
})

test('revocation uses the issued client and a trusted discovered endpoint', async () => {
  const visited = []
  await mod.revokeChatGpt(session, async (url, init) => {
    visited.push(url)
    if (url.endsWith('openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', revocation_endpoint: 'https://auth.openai.com/oauth/revoke' })
    assert.equal(init.body.get('token'), session.refreshToken)
    assert.equal(init.body.get('client_id'), session.clientId)
    return new Response('', { status: 200 })
  })
  assert.equal(visited.length, 2)
  await assert.rejects(mod.revokeChatGpt(session, async () => Response.json({ issuer: 'https://auth.openai.com', revocation_endpoint: 'https://evil.test/revoke' })), /Invalid/)
})

test('public catalog keeps visible models in server order and reads capabilities', async () => {
  const models = await mod.fetchChatGptModels(session, async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/models')
    assert.deepEqual(init.headers, { authorization: 'Bearer fixture-access', accept: 'application/json' })
    return Response.json({ models: [
      { slug: 'second', display_name: 'Second', visibility: 'list', priority: 9, context_window: 200000, input_modalities: ['text', 'image'] },
      { slug: 'first', visibility: 'list', priority: 0, supported_reasoning_levels: [{ effort: 'high' }], default_reasoning_level: 'high' },
      { slug: 'hidden', visibility: 'hide' }, { slug: 'unknown' },
    ] })
  })
  assert.deepEqual(models.map(model => model.id), ['second', 'first'])
  assert.deepEqual(models[0].inputModalities, ['text', 'image'])
  assert.equal(models[0].contextWindow, 200000)
  assert.equal(models[1].reasoning.defaultEffort, 'high')
  assert.deepEqual(await mod.fetchChatGptModels(session, async () => Response.json({ models: [] })), [])
})

function adapter(fetchFn, sessionFn = async () => session) {
  return new mod.ChatGptAdapter({ tokens: { session: sessionFn }, models: [], streamIdleTimeoutMs: 5000, fetchFn })
}
const options = { provider: 'chatgpt', model: 'fixture-model', messages: [], signal: new AbortController().signal, system: 'Be concise', tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } }] }
const consume = async iterable => { const result = []; for await (const value of iterable) result.push(value); return result }

test('ChatGPT streams through public Responses, namespaces tools and retries a rejected token once', async () => {
  const forced = [], requests = []
  const a = adapter(async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses')
    requests.push(JSON.parse(init.body))
    assert.equal(init.headers['chatgpt-account-id'], undefined)
    if (requests.length === 1) return new Response('', { status: 401 })
    return sse(complete)
  }, async (_account, force) => { forced.push(force); return session })
  const chunks = await consume(a.streamAccount(options, session.clientId))
  assert.deepEqual(forced, [false, true])
  assert.equal(requests[1].tools[0].type, 'namespace')
  assert.equal(requests[1].tools[0].name, 'dsh')
  assert.equal(requests[1].tools[0].tools[0].name, 'read_file')
  assert.equal(requests[1].instructions, 'Be concise')
  assert.equal(requests[1].store, false)
  assert.equal(requests[1].stream, true)
  for (const key of ['max_output_tokens', 'temperature', 'previous_response_id', 'service_tier', 'metadata']) assert.equal(key in requests[1], false)
  assert.ok(chunks.some(chunk => chunk.type === 'finish'))
})

test('stream failures, truncation, denied scope and admission errors never report completion or retry billing', async () => {
  for (const response of [sse([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'App limit reached' } } }]), sse([{ type: 'response.output_text.delta', delta: 'partial' }]), new Response('{"detail":"Permission denied"}', { status: 403 })]) {
    let count = 0
    await assert.rejects(consume(adapter(async () => { count++; return response }).streamAccount(options, session.clientId)))
    assert.equal(count, 1)
  }
  let called = false
  await assert.rejects(consume(adapter(async () => { called = true }, async () => tokens({ scopes: [] })).streamAccount(options, session.clientId)), /disabled/)
  assert.equal(called, false)
})

test('two token managers serialize rotating refresh and logout cannot be undone by a late write', async () => isolated(async () => {
  let stored = { ...session, expiresAt: 0 }, refreshes = 0
  const io = { list: async () => stored ? [{ key: session.clientId, session: stored }] : [], get: async () => stored,
    save: async (_key, value) => { stored = value }, remove: async () => { stored = undefined } }
  const config = { provider: 'chatgpt', displayName: 'ChatGPT', io,
    makeOptions: () => ({ preemptMs: 300000, isPermanent: () => false, refresh: async old => {
      refreshes++; await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(old.refreshToken, session.refreshToken)
      return { ...old, accessToken: 'rotated-access', refreshToken: 'rotated-refresh', expiresAt: Date.now() + 3600000 }
    } }) }
  const first = new mod.ChatGptTokenManager(config), second = new mod.ChatGptTokenManager(config)
  const results = await Promise.all([first.session(session.clientId, true), second.session(session.clientId, true)])
  assert.equal(refreshes, 1)
  assert.equal(results[1].refreshToken, 'rotated-refresh')
  await mod.withChatGptLock('sessions', () => io.remove())
  await assert.rejects(second.session(session.clientId), /not logged in/)
  assert.equal(stored, undefined)
}))
