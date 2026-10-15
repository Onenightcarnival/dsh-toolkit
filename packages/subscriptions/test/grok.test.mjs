import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = await build({
  stdin: { contents: `export * from './providers/grok.ts'; export * from './tools/x-search.ts'; export * from './auth/store.ts'; export * from './providers/accounts.ts'; export { OAuthEndpointError } from './providers/common.ts';`, resolveDir: fileURLToPath(new URL('../src/backend', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'host-imports', setup(build) {
    build.onResolve({ filter: /^(@deepseek-ai\/|undici$)/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }))
  } }],
})
const mod = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)

// Unsigned fixture tokens: claim reads never verify signatures.
const jwt = claims => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`
const session = { accessToken: jwt({ sub: 'grok-user', tier: 1 }), refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600000, tokenEndpoint: 'https://auth.x.ai/oauth2/token', account: 'grok@example.test' }
/** Token manager over an in-memory store; `null` starts logged out. */
const tokens = (initial = session) => {
  let stored = initial ?? undefined
  return new mod.AccountTokenManager({
    provider: 'grok', displayName: 'Grok',
    makeOptions: () => ({ preemptMs: 0, refresh: async current => current, isPermanent: () => false }),
    io: { list: async () => stored ? [{ key: 'grok@example.test', session: stored }] : [], get: async () => stored, save: async (_key, value) => { stored = value }, remove: async () => { stored = undefined } },
  })
}
const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const complete = [{ type: 'response.output_text.delta', delta: 'hello' }, { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }]
const consume = async iterable => { const result = []; for await (const value of iterable) result.push(value); return result }
const signal = () => new AbortController().signal

test('Grok OIDC discovery accepts x.ai endpoints only; the flow, exchange and refresh follow the Grok CLI contract', async () => {
  await assert.rejects(mod.grokDiscovery(async () => Response.json({ authorization_endpoint: 'https://evil.test/authorize', token_endpoint: 'https://auth.x.ai/oauth2/token' })), /non-x.ai/)
  await assert.rejects(mod.grokDiscovery(async () => Response.json({ authorization_endpoint: 'https://auth.x.ai/oauth2/authorize' })), /missing endpoints/)
  const discovery = await mod.grokDiscovery(async () => Response.json({ authorization_endpoint: 'https://auth.x.ai/oauth2/authorize', token_endpoint: 'https://auth.x.ai/oauth2/token' }))
  assert.deepEqual(discovery, { authorizationEndpoint: 'https://auth.x.ai/oauth2/authorize', tokenEndpoint: 'https://auth.x.ai/oauth2/token' })
  assert.deepEqual(await mod.grokDiscovery(async () => { throw new Error('offline') }), discovery, 'discovery is cached')
  const spec = await mod.grokFlow()
  assert.deepEqual(spec.listen, { host: '127.0.0.1', ports: [mod.GROK_CALLBACK_PORT] })
  assert.equal(spec.callbackPath, '/callback')
  const url = new URL(spec.buildAuthorizeUrl({ redirectUri: 'http://127.0.0.1:56121/callback', state: 'state', nonce: 'nonce', pkce: { verifier: 'verifier', challenge: 'challenge' } }))
  assert.equal(url.origin + url.pathname, discovery.authorizationEndpoint)
  assert.equal(url.searchParams.get('client_id'), mod.GROK_CLIENT_ID)
  assert.equal(url.searchParams.get('code_challenge'), 'challenge')
  assert.equal(url.searchParams.get('nonce'), 'nonce')
  assert.equal(url.searchParams.get('state'), 'state')
  await assert.rejects(mod.exchangeGrokCode('code', 'verifier', 'http://127.0.0.1:56121/callback', 'challenge', async (target, init) => {
    assert.equal(target, discovery.tokenEndpoint)
    const body = new URLSearchParams(init.body)
    assert.equal(body.get('code_verifier'), 'verifier')
    assert.equal(body.get('code_challenge'), 'challenge')
    assert.equal(body.get('client_id'), mod.GROK_CLIENT_ID)
    return new Response('', { status: 403 })
  }), /API OAuth entitlement/)
  const exchanged = await mod.exchangeGrokCode('code', 'verifier', 'http://127.0.0.1:56121/callback', 'challenge', async () =>
    Response.json({ access_token: jwt({ tier: 3 }), refresh_token: 'refresh', expires_in: 3600, id_token: jwt({ email: 'Grok@Example.test' }), scope: 'openid' }))
  assert.equal(exchanged.account, 'Grok@Example.test')
  assert.equal(exchanged.tokenEndpoint, discovery.tokenEndpoint)
  assert.equal(exchanged.scopes, 'openid')
  const refreshed = await mod.refreshGrok(exchanged, async target => { assert.equal(target, discovery.tokenEndpoint); return Response.json({ access_token: 'next', expires_in: 60 }) })
  assert.equal(refreshed.accessToken, 'next')
  assert.equal(refreshed.refreshToken, 'refresh', 'a rotation-less refresh keeps the stored refresh token')
  assert.equal(refreshed.account, 'Grok@Example.test')
  assert.equal(refreshed.scopes, 'openid')
  assert.equal(mod.isGrokPermanentRefreshError(new mod.OAuthEndpointError('gone', 400, 'invalid_grant')), true)
  assert.equal(mod.isGrokPermanentRefreshError(new mod.OAuthEndpointError('busy', 503)), false)
})

test('Grok account keys use the lowercased account and fall back to a token hash', () => {
  assert.equal(mod.accountKeyOf('grok', { ...session, account: 'Grok@Example.test' }), 'grok@example.test')
  const hashed = mod.accountKeyOf('grok', { ...session, account: undefined })
  assert.match(hashed, /^token-[0-9a-f]{16}$/)
  assert.equal(mod.accountKeyOf('grok', { ...session, account: ' ' }), hashed)
  assert.equal(mod.grokTierName(session.accessToken), 'SuperGrok')
  assert.equal(mod.grokTierName(jwt({ tier: 9 })), '9')
  assert.equal(mod.grokTierName('opaque'), undefined)
})

test('Grok discovery lists chat models only and enriches them from the CLI catalog', async () => {
  const warnings = []
  const models = await mod.fetchGrokModels(session, async (url, init) => {
    if (url === mod.GROK_MODELS_URL) {
      assert.equal(init.headers['x-xai-token-auth'], undefined)
      return Response.json({ data: [{ id: 'grok-4' }, { id: 'grok-imagine-image-2.0' }, { id: 'grok-imagine-video-1.5' }, { id: 'grok-embed-1' }, { id: 'grok-code-fast-1' }, { id: 'grok-4' }] })
    }
    assert.equal(url, mod.GROK_CLI_MODELS_URL)
    assert.equal(init.headers['x-xai-token-auth'], 'xai-grok-cli')
    return Response.json({ data: [{ id: 'grok-4', name: 'Grok 4', context_window: 256000, supports_reasoning_effort: true, reasoning_effort: 'high', reasoning_efforts: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High', description: 'Deep' }] }] })
  }, message => warnings.push(message))
  assert.deepEqual(models.map(model => model.id), ['grok-4', 'grok-code-fast-1'])
  assert.equal(models[0].name, 'Grok 4')
  assert.equal(models[0].contextWindow, 256000)
  assert.deepEqual(models[0].reasoning, { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High', description: 'Deep' }], defaultEffort: 'high' })
  assert.deepEqual(models[0].inputModalities, ['text', 'image'])
  assert.deepEqual(models[1].inputModalities, ['text'])
  assert.equal(models[1].reasoning, undefined)
  assert.deepEqual(warnings, [])
  const degraded = await mod.fetchGrokModels(session, async url => url === mod.GROK_MODELS_URL ? Response.json({ data: [{ id: 'grok-4' }] }) : new Response('down', { status: 503 }), message => warnings.push(message), models)
  assert.deepEqual(degraded[0].reasoning, models[0].reasoning, 'a CLI catalog outage keeps last-known efforts')
  assert.equal(degraded[0].name, 'Grok 4')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /last-known/)
  await assert.rejects(mod.fetchGrokModels(session, async () => Response.json({ data: [{ id: 'grok-imagine-image-2.0' }] })), /empty catalog/)
  await assert.rejects(mod.fetchGrokModels(session, async url => url === mod.GROK_MODELS_URL ? new Response('nope', { status: 401 }) : Response.json({ data: [] })))
})

test('Grok usage maps the credits window and names the plan from the billing response or the token tier', async () => {
  const usage = await mod.fetchGrokUsage(session, async (url, init) => {
    assert.equal(url, mod.GROK_BILLING_URL)
    assert.equal(init.headers['x-xai-token-auth'], 'xai-grok-cli')
    assert.equal(init.headers.authorization, `Bearer ${session.accessToken}`)
    return Response.json({ config: { creditUsagePercent: 42.5, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-10-20T00:00:00Z' } } })
  })
  assert.deepEqual(usage, { supported: true, plan: 'SuperGrok', windows: [{ kind: 'weekly', usedPercent: 42.5, resetsAt: Date.parse('2026-10-20T00:00:00Z') }] })
  const legacy = await mod.fetchGrokUsage(session, async () => Response.json({ subscriptionTier: 'X Premium+', config: { monthlyLimit: { val: 2000 }, used: { val: 500 }, billingPeriodEnd: '2026-11-01T00:00:00Z' } }))
  assert.equal(legacy.plan, 'X Premium+')
  assert.deepEqual(legacy.windows, [{ kind: 'other', usedPercent: 25, resetsAt: Date.parse('2026-11-01T00:00:00Z') }])
  assert.deepEqual(await mod.fetchGrokUsage({ ...session, accessToken: 'opaque' }, async () => Response.json({ config: null })), { supported: true, windows: [] })
  await assert.rejects(mod.fetchGrokUsage(session, async () => new Response('expired', { status: 401 })))
})

test('Grok request bodies carry tool controls, efforts and the cache key only when supplied', () => {
  const resolved = { instructions: 'Be concise', input: [{ role: 'user', content: 'hi' }] }
  assert.deepEqual(mod.grokRequestBody({ provider: 'grok', model: 'grok-4', messages: [] }, resolved),
    { model: 'grok-4', instructions: 'Be concise', input: resolved.input, store: false, stream: true })
  const full = mod.grokRequestBody({ provider: 'grok', model: 'grok-4', messages: [], sessionId: 'sess-1', maxTokens: 1000, reasoningEffort: 'high',
    tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } }] }, resolved)
  assert.equal(full.prompt_cache_key, 'sess-1')
  assert.equal(full.max_output_tokens, 1000)
  assert.deepEqual(full.reasoning, { effort: 'high' })
  assert.equal(full.tool_choice, 'auto')
  assert.equal(full.parallel_tool_calls, true)
  assert.deepEqual(full.tools, [{ type: 'function', name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } }])
})

test('Grok streams through the xAI Responses endpoint, retries a rejected token once and resolves the static catalog', async () => {
  const requests = []
  const adapter = new mod.GrokAdapter({
    models: [{ id: 'grok-4', name: 'Grok 4' }], streamIdleTimeoutMs: 5000, tokens: tokens(), discovery: false,
    contextWindowOf: model => (model === 'grok-4' ? 128000 : undefined),
    fetchFn: async (url, init) => {
      assert.equal(url, mod.GROK_API_URL)
      requests.push({ headers: init.headers, body: JSON.parse(init.body) })
      return requests.length === 1 ? new Response('', { status: 401 }) : sse(complete)
    },
  })
  const chunks = await consume(adapter.stream({ provider: 'grok', model: 'grok-4', messages: [], system: 'Be concise', sessionId: 'sess-1', signal: signal() }))
  assert.equal(requests.length, 2)
  assert.equal(requests[1].headers.authorization, `Bearer ${session.accessToken}`)
  assert.equal(requests[1].headers.accept, 'text/event-stream')
  assert.equal(requests[1].body.prompt_cache_key, 'sess-1')
  assert.equal(requests[1].body.instructions, 'Be concise')
  assert.equal(requests[1].body.stream, true)
  assert.ok(chunks.some(chunk => chunk.type === 'finish'))
  assert.deepEqual((await adapter.listModels('grok')).map(model => model.id), ['grok-4'])
  const info = await adapter.resolveModel('grok', 'grok-4')
  assert.equal(info.name, 'Grok 4')
  assert.equal(info.context.contextWindow, 128000, 'the preference override wins over the built-in window')
  assert.deepEqual(info.inputModalities, ['text', 'image'])
  assert.deepEqual(await adapter.contextLimits('grok-4'), { default: 256000 })
  assert.deepEqual((await adapter.resolveModel('grok', 'grok-code-fast-1')).inputModalities, ['text'])
  assert.equal(adapter.providerInfo('grok').name, 'Grok')
  let calls = 0
  await assert.rejects(consume(new mod.GrokAdapter({ models: [], streamIdleTimeoutMs: 5000, tokens: tokens(), discovery: false,
    fetchFn: async () => { calls++; return new Response('{"error":"quota"}', { status: 403 }) } }).stream({ provider: 'grok', model: 'grok-4', messages: [], signal: signal() })))
  assert.equal(calls, 1, 'a 403 is not retried')
})

test('grok_x_search validates filters, posts the hosted tool through the Grok session and parses the answer', async () => {
  assert.throws(() => mod.buildXSearchRequest({ query: ' ' }), /non-empty/)
  assert.throws(() => mod.buildXSearchRequest({ query: 'q', allowed_x_handles: ['a'], excluded_x_handles: ['b'] }), /cannot be used together/)
  assert.throws(() => mod.buildXSearchRequest({ query: 'q', allowed_x_handles: Array.from({ length: 11 }, (_, index) => `h${index}`) }), /at most 10/)
  assert.deepEqual(mod.buildXSearchRequest({ query: ' xai ', allowed_x_handles: ['@xai', ' '], from_date: '2026-01-01', enable_image_understanding: true }),
    { query: 'xai', tool: { type: 'x_search', allowed_x_handles: ['xai'], from_date: '2026-01-01', enable_image_understanding: true } })
  assert.deepEqual(mod.parseXSearchResponse({ citations: ['https://x.com/b', 'https://x.com/a'], output: [{ type: 'message', content: [{ type: 'output_text', text: 'Answer', annotations: [{ type: 'url_citation', url: 'https://x.com/a' }] }] }] }),
    { answer: 'Answer', citations: ['https://x.com/b', 'https://x.com/a'] })
  let enabled = false
  const requests = []
  const tool = mod.createXSearchTool({ tokens: tokens(), enabled: () => enabled, fetchFn: async (url, init) => {
    assert.equal(url, mod.GROK_API_URL)
    assert.equal(init.headers.authorization, `Bearer ${session.accessToken}`)
    requests.push(JSON.parse(init.body))
    return Response.json({ output_text: 'Posts say hi', citations: ['https://x.com/post'] })
  } })
  assert.equal(tool.name, mod.X_SEARCH_TOOL_NAME)
  await assert.rejects(tool.execute({ query: 'hi' }, { signal: signal() }), /grok_x_search: disabled/)
  assert.equal(requests.length, 0)
  enabled = true
  assert.deepEqual(await tool.execute({ query: 'hi', excluded_x_handles: ['@spam'] }, { signal: signal() }), { answer: 'Posts say hi', citations: ['https://x.com/post'] })
  assert.deepEqual(requests[0], { model: mod.X_SEARCH_MODEL, input: [{ role: 'user', content: 'hi' }], tools: [{ type: 'x_search', excluded_x_handles: ['spam'] }], store: false })
  await assert.rejects(mod.createXSearchTool({ tokens: tokens(null), fetchFn: async () => { throw new Error('unreachable') } }).execute({ query: 'hi' }, { signal: signal() }), /Grok/)
})
