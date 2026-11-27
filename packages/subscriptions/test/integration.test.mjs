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

test('subscription host registers the ChatGPT provider and its RPC endpoints', { timeout: 20000 }, async () => {
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
  const runtime = ctx.plugin({ name: 'subscriptions-under-test', inject: ['llm'], apply }, {})
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
    assert.deepEqual([...routes.keys()].sort(), ['cancel', 'login', 'logout', 'manual', 'modelDefaults', 'providerSettings', 'proxyGet', 'proxySet', 'proxyTest', 'setDefault', 'setModelDefault', 'setProviderSettings', 'status']
      .map(endpoint => `/api/subscriptions-auth.${endpoint}`))
    assert.deepEqual([...adapters.keys()], ['chatgpt'])
    assert.equal(adapters.get('chatgpt').providerInfo('chatgpt').name, 'ChatGPT')
    assert.deepEqual(await adapters.get('chatgpt').listModels('chatgpt'), [])
    assert.deepEqual([...tools.keys()], [])
    for (const provider of ['claude', 'copilot', 'codex', 'grok', 'antigravity']) {
      for (const method of ['login', 'manual', 'cancel', 'logout', 'setDefault', 'providerSettings', 'setProviderSettings', 'setModelDefault']) {
        await assert.rejects(api.call(method, { provider }), /payload.provider must be one of chatgpt$/)
      }
    }
    assert.deepEqual(Object.keys((await api.call('status')).providers), ['chatgpt'])
    assert.deepEqual((await api.status()).accounts, [])

    // Starting and cancelling OAuth is local; no account or token exchange is involved.
    const login = await api.login()
    assert.match(login.authorizeUrl, /^https:\/\/auth.openai.com\/api\/accounts\/authorize\?/)
    assert.equal(new URL(login.authorizeUrl).searchParams.get('client_id'), 'dynamic_agent_client')
    const pending = await api.status()
    assert.equal(pending.busy, true)
    assert.equal(pending.manualOnly, login.manualOnly)
    await api.cancel()
    assert.equal((await api.status()).busy, false)

    // Fixture credentials and catalogs exist only in the isolated test home; fresh catalog snapshots keep discovery local.
    const dir = join(home, 'plugins', 'subscriptions')
    await mkdir(dir, { recursive: true })
    const session = key => ({ accessToken: 'test-secret', refreshToken: 'test-refresh', expiresAt: Date.now() + 3600000, clientId: key,
      subject: `subject-${key}`, hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000', idToken: 'test-id-token', emailAddress: `${key}@example.test`,
      scopes: ['openid', 'chatgpt.tokens.use.direct'] })
    const stale = { default: 'stale', accounts: { stale: { accessToken: 'stale-secret', refreshToken: 'stale-refresh', expiresAt: Date.now() + 3600000 } } }
    await writeFile(join(dir, 'auth.json'), JSON.stringify({
      unownedSection: { keep: true }, codex: stale, grok: stale, antigravity: stale,
      chatgpt: { default: 'oaiapp_first', accounts: { oaiapp_first: session('oaiapp_first'), oaiapp_second: session('oaiapp_second') } },
    }))
    const snapshot = { at: Date.now(), models: [{ id: 'gpt-fixture', name: 'Fixture model', contextWindow: 272000, inputModalities: ['text', 'image'] }] }
    await writeFile(join(dir, 'models.json'), JSON.stringify({ codex: snapshot, accounts: { codex: { stale: snapshot }, chatgpt: { oaiapp_first: snapshot, oaiapp_second: snapshot } } }))
    const status = await api.status()
    assert.deepEqual(status.accounts.map(account => [account.key, account.account, account.isDefault, account.connected, account.planEnabled]),
      [['oaiapp_first', 'oaiapp_first@example.test', true, true, true], ['oaiapp_second', 'oaiapp_second@example.test', false, true, true]])
    assert.doesNotMatch(JSON.stringify(status), /test-secret|test-refresh|test-id-token|stale/)
    const catalog = await api.catalog()
    assert.deepEqual(catalog.models.map(m => m.id), ['gpt-fixture'])
    assert.deepEqual(catalog.accounts.map(account => account.key), ['oaiapp_first', 'oaiapp_second'])
    assert.deepEqual((await adapters.get('chatgpt').listModels('chatgpt')).map(m => m.id), ['gpt-fixture'])
    await api.save({ contextWindows: { 'gpt-fixture': 1_000_000 } })
    assert.equal((await adapters.get('chatgpt').resolveModel('chatgpt', 'gpt-fixture')).context.contextWindow, 1_000_000, 'a default window is not an implicit maximum')
    assert.equal((await api.catalog()).settings.contextWindows['gpt-fixture'], 1_000_000)
    assert.equal(JSON.parse(await readFile(join(dir, 'provider-settings.json'), 'utf8')).providers.chatgpt.contextWindows['gpt-fixture'], 1_000_000)
    await api.save({ contextWindows: { 'gpt-fixture': 256_000 } })
    assert.equal((await adapters.get('chatgpt').resolveModel('chatgpt', 'gpt-fixture')).context.contextWindow, 256_000)
    await api.save({})
    assert.equal((await adapters.get('chatgpt').resolveModel('chatgpt', 'gpt-fixture')).context.contextWindow, catalog.models[0].contextWindow, 'clearing restores provider default')
    await api.save({ visibleModels: [] })
    assert.deepEqual(await adapters.get('chatgpt').listModels('chatgpt'), [])
    assert.equal((await api.catalog()).models.length, 1, 'hidden models must remain editable')
    await api.save({})
    assert.deepEqual((await adapters.get('chatgpt').listModels('chatgpt')).map(m => m.id), ['gpt-fixture'])
    await assert.rejects(api.save({ visibleModels: 'gpt-fixture' }), /visibleModels must be an array/)

    // The next credential write keeps unowned sections and omits credentials of providers outside the served set.
    await api.setDefault('oaiapp_second')
    const stored = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8'))
    assert.deepEqual(Object.keys(stored), ['unownedSection', 'chatgpt'])
    assert.deepEqual(stored.unownedSection, { keep: true })
    assert.equal(stored.chatgpt.default, 'oaiapp_second')
    assert.deepEqual((await api.status()).accounts.map(account => [account.key, account.isDefault]), [['oaiapp_second', true], ['oaiapp_first', false]])
  } finally {
    await runtime.dispose()
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('login rejects unexpected authorization origins and surfaces business failures', async () => {
  for (const authorizeUrl of ['https://example.test/api/accounts/authorize', 'https://auth.openai.com/other', 'https://user@auth.openai.com/api/accounts/authorize']) {
    await assert.rejects(new SubscriptionsApi({ call: async () => ({ ok: true, value: { authorizeUrl } }) }).login(), /Invalid ChatGPT/)
  }
  const failed = new SubscriptionsApi({ call: async () => ({ ok: false, error: { message: 'Authorization cancelled' } }) })
  await assert.rejects(failed.login(), /Authorization cancelled/)
  const calls = []
  const valid = new SubscriptionsApi({ call: async (...args) => { calls.push(args); return { ok: true, value: { authorizeUrl: 'https://auth.openai.com/api/accounts/authorize?state=fixture' } } } })
  assert.match((await valid.login()).authorizeUrl, /^https:\/\/auth.openai.com\//)
  assert.deepEqual(calls[0], ['/api', 'subscriptions-auth.login', { provider: 'chatgpt' }])
})
