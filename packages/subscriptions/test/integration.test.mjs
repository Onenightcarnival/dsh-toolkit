import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { build } from 'esbuild'

// Tests compile the source even when the package has not been built yet.
const output = await build({ entryPoints: [new URL('../src/client/api.ts', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')], bundle: true, write: false, platform: 'node', format: 'esm' })
const { SubscriptionsApi } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`)

test('subscription host registers three providers and independent subscription tools', { timeout: 20000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-subscriptions-test-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const { apply } = await import('../lib/index.js')
  const ctx = new Context()
  const fibers = []
  ctx.on('internal/plugin', fiber => fibers.push(fiber))
  const routes = new Map()
  const adapters = new Map()
  const tools = new Map()
  ctx.provide('llm', { registerAdapter(ids, adapter) {
    for (const id of ids) adapters.set(id, adapter)
    return Object.assign(() => { for (const id of ids) adapters.delete(id) }, { replace() {} })
  } })
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
  ctx.provide('connection', { fetch: { register(route) {
    assert.ok(!routes.has(route.path), `duplicate route ${route.path}`)
    routes.set(route.path, route)
    return async () => { routes.delete(route.path) }
  } } })
  const runtime = ctx.plugin({ name: 'subscriptions-under-test', inject: ['llm'], apply }, {
    codexClientVersion: '0.153.4', models: [{ id: 'gpt-5.4', name: 'Fixture model' }],
    antigravity: { models: [{ id: 'gemini-fixture', name: 'Google fixture', contextWindow: 1048576 }] },
  })
  const api = new SubscriptionsApi({ async call(channel, method, payload) {
    assert.equal(channel, '/api')
    const route = routes.get(`${channel}/${method}`)
    assert.ok(route, `missing RPC ${method}`)
    const response = await route.fetch(new Request(`http://127.0.0.1${route.path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload }),
    }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.type, 'server-response')
    assert.equal(body.rpcId, 'test')
    return body.result
  } })
  try {
    await runtime.await()
    for (let i = 0; i < fibers.length; i++) await fibers[i].await()
    for (let i = 0; i < 100 && !routes.size; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(routes.size > 0, 'RPC registration did not start')
    assert.ok(adapters.has('codex'))
    assert.ok(adapters.has('chatgpt'))
    assert.equal(adapters.get('codex').providerInfo('codex').name, 'Codex')
    assert.equal(adapters.get('chatgpt').providerInfo('chatgpt').name, 'ChatGPT')
    assert.deepEqual(await adapters.get('chatgpt').listModels('chatgpt'), [])
    assert.ok(adapters.has('antigravity'))
    assert.deepEqual(await adapters.get('antigravity').listModels('antigravity'), [])
    for (const provider of ['claude', 'grok', 'copilot']) {
      assert.ok(!adapters.has(provider))
      for (const method of ['login', 'manual', 'cancel', 'logout', 'setDefault', 'usage', 'providerSettings', 'setProviderSettings', 'setModelDefault']) {
        await assert.rejects(api.call(method, { provider }), /payload.provider must be one of codex/)
      }
    }
    assert.deepEqual(Object.keys((await api.call('status')).providers), ['codex', 'chatgpt', 'antigravity'])
    assert.ok(!routes.has('/api/subscriptions-auth.video'))
    assert.deepEqual([...tools.keys()], ['codex_web_search', 'codex_image_generate', 'antigravity_web_search', 'antigravity_image_generate'])
    assert.doesNotMatch(JSON.stringify(tools.get('codex_image_generate')), /grok|x_search|video_generate/i)
    assert.ok(!tools.has('web_search'))
    assert.ok(!tools.has('image_generate'))
    assert.deepEqual((await api.status()).accounts, [])
    assert.deepEqual(await adapters.get('codex').listModels('codex'), [])

    // Starting/cancelling OAuth is entirely local, including on Windows where
    // both callback ports may be excluded. No account or token exchange needed.
    const login = await api.login()
    assert.match(login.authorizeUrl, /^https:\/\/auth.openai.com\/oauth\/authorize/)
    const pending = await api.status()
    assert.equal(pending.busy, true)
    assert.equal(pending.manualOnly, login.manualOnly)
    await api.cancel()
    assert.equal((await api.status()).busy, false)

    // Fixture credentials exist only in the isolated test home; never contact OpenAI.
    const dir = join(home, 'plugins', 'subscriptions')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ unownedSection: { keep: true }, codex: { default: 'fixture', accounts: {
      fixture: { accessToken: 'test-secret', refreshToken: 'test-refresh', expiresAt: Date.now() + 3600000, accountId: 'fixture', emailAddress: 'fixture@example.test', planType: 'plus' },
    } } }))
    const status = await api.status()
    assert.equal(status.accounts.length, 1)
    assert.ok(!JSON.stringify(status).includes('test-secret'))
    assert.ok(!JSON.stringify(status).includes('test-refresh'))
    const catalog = await api.catalog()
    assert.deepEqual(catalog.models.map(m => m.id), ['gpt-5.4'])
    await api.save({ contextWindows: { 'gpt-5.4': 1_000_000 }, tools: { web_search: true } })
    assert.equal((await adapters.get('codex').resolveModel('codex', 'gpt-5.4')).context.contextWindow, 1_000_000, 'a default window is not an implicit maximum')
    assert.equal((await api.catalog()).settings.contextWindows['gpt-5.4'], 1_000_000)
    assert.equal(JSON.parse(await readFile(join(dir, 'provider-settings.json'), 'utf8')).providers.codex.contextWindows['gpt-5.4'], 1_000_000)
    await api.save({ contextWindows: { 'gpt-5.4': 256_000 } })
    assert.equal((await adapters.get('codex').resolveModel('codex', 'gpt-5.4')).context.contextWindow, 256_000)
    await api.save({})
    assert.equal((await adapters.get('codex').resolveModel('codex', 'gpt-5.4')).context.contextWindow, catalog.models[0].contextWindow, 'clearing restores provider default')
    await api.save({ visibleModels: [], tools: { web_search: false, image_generate: false } })
    await assert.rejects(tools.get('codex_web_search').execute({ query: 'fixture' }, { signal: new AbortController().signal }), /codex_web_search: disabled/)
    assert.deepEqual(await adapters.get('codex').listModels('codex'), [])
    assert.equal((await api.catalog()).models.length, 1, 'hidden models must remain editable')
    const denied = []
    ctx.emit('agent/created', { agent: { session: { header: { createdAt: Date.now() + 1000 } }, ctx: { tools: { restrict({ deny }) { denied.push(...deny) } } } } })
    assert.deepEqual(denied, ['codex_web_search', 'codex_image_generate'])
    assert.equal(JSON.parse(await readFile(join(dir, 'provider-settings.json'), 'utf8')).providers.codex.tools.web_search, false)
    await api.save({})
    const enabledDenied = []
    ctx.emit('agent/created', { agent: { session: { header: { createdAt: Date.now() + 1000 } }, ctx: { tools: { restrict({ deny }) { enabledDenied.push(...deny) } } } } })
    assert.deepEqual(enabledDenied, [])
    assert.deepEqual((await adapters.get('codex').listModels('codex')).map(m => m.id), ['gpt-5.4'])
    await assert.rejects(api.call('setProviderSettings', { provider: 'codex', settings: { tools: { video_generate: true } } }), /unsupported tool/)
    await api.logout(status.accounts[0].key)
    assert.deepEqual((await api.status()).accounts, [])
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')).unownedSection, { keep: true })
    const google = api.forProvider('antigravity')
    await writeFile(join(dir, 'antigravity-oauth-client.json'), JSON.stringify({ clientId: 'fixture-client', clientSecret: 'fixture-client-secret' }))
    assert.ok(!routes.has('/api/subscriptions-auth.importLegacy'))
    const stored = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))
    stored.antigravity = { default: 'google-fixture', accounts: { 'google-fixture': { accessToken: 'google-fixture-access', refreshToken: 'google-fixture-refresh', expiresAt: Date.now() + 3600000, projectId: 'fixture-project', account: 'google@example.test' } } }
    await writeFile(join(dir, 'auth.json'), JSON.stringify(stored))
    const googleStatus = await google.status()
    assert.equal(googleStatus.accounts[0].account, 'google@example.test')
    assert.doesNotMatch(JSON.stringify(googleStatus), /google-fixture-access|google-fixture-refresh|fixture-client-secret/)
    assert.deepEqual((await google.catalog()).models.map(model => model.id), ['gemini-fixture'])
    assert.deepEqual((await google.catalog()).tools, ['image_generate', 'web_search'])
    await google.save({ contextWindows: { 'gemini-fixture': 1000000 }, visibleModels: [] })
    assert.equal((await adapters.get('antigravity').resolveModel('antigravity', 'gemini-fixture')).context.contextWindow, 1000000)
    assert.equal((await api.catalog()).settings.contextWindows, undefined)
    await google.save({ tools: { web_search: false, image_generate: false } })
    await assert.rejects(tools.get('antigravity_web_search').execute({ query: 'fixture' }, { signal: new AbortController().signal }), /disabled/)
    const googleDenied = []
    ctx.emit('agent/created', { agent: { session: { header: { createdAt: Date.now() + 1000 } }, ctx: { tools: { restrict({ deny }) { googleDenied.push(...deny) } } } } })
    assert.deepEqual(googleDenied, ['antigravity_web_search', 'antigravity_image_generate'])
    const googleLogin = await google.login()
    assert.equal(new URL(googleLogin.authorizeUrl).origin, 'https://accounts.google.com')
    assert.equal(new URL(googleLogin.authorizeUrl).searchParams.get('client_id'), 'fixture-client')
    await google.cancel()
    await google.logout(googleStatus.accounts[0].key)
    assert.deepEqual((await google.status()).accounts, [])
  } finally {
    await runtime.dispose()
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('login rejects unexpected authorization origins and surfaces business failures', async () => {
  const bad = new SubscriptionsApi({ call: async () => ({ ok: true, value: { authorizeUrl: 'https://example.test/oauth/authorize' } }) })
  await assert.rejects(bad.login(), /Invalid ChatGPT/)
  const failed = new SubscriptionsApi({ call: async () => ({ ok: false, error: { message: 'Authorization cancelled' } }) })
  await assert.rejects(failed.login(), /Authorization cancelled/)
  const calls = []
  const valid = new SubscriptionsApi({ call: async (...args) => { calls.push(args); return { ok: true, value: { authorizeUrl: 'https://auth.openai.com/oauth/authorize?state=fixture' } } } })
  assert.match((await valid.login()).authorizeUrl, /^https:\/\/auth.openai.com\//)
  assert.deepEqual(calls[0], ['/api', 'subscriptions-auth.login', { provider: 'codex' }])
})
