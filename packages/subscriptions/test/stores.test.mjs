import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = await build({
  stdin: { contents: `export * from './auth/store.ts'; export * from './provider-settings.ts'; export * from './model-defaults.ts'; export * from './providers/catalog-store.ts';`, resolveDir: fileURLToPath(new URL('../src/backend', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'host-imports', setup(build) {
    build.onResolve({ filter: /^@deepseek-ai\// }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }))
  } }],
})
const mod = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)

/** Run an action in the plugin data directory of a temporary DSH home. */
async function isolated(action) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-subscriptions-stores-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const dir = join(home, 'plugins', 'subscriptions')
  await mkdir(dir, { recursive: true })
  try { await action(dir) } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

const session = { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 1, clientId: 'oaiapp_fixture', subject: 'user-1',
  hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000', idToken: 'fixture-id-token', scopes: ['chatgpt.tokens.use.direct'] }
/** Sections written for providers outside the served set: one accounts map and one bare session. */
const unserved = {
  codex: { default: 'stale', accounts: { stale: { accessToken: 'stale-access', refreshToken: 'stale-refresh', expiresAt: 1, accountId: 'stale' } } },
  grok: { default: 'stale', accounts: { stale: { accessToken: 'stale-access', refreshToken: 'stale-refresh', expiresAt: 1, tokenEndpoint: 'https://example.test/token' } } },
  antigravity: { accessToken: 'stale-access', refreshToken: 'stale-refresh', expiresAt: 1, projectId: 'stale' },
}

test('auth store discards credential sections outside its providers on read and omits them from the next write', () => isolated(async (dir) => {
  const path = join(dir, 'auth.json')
  await writeFile(path, JSON.stringify({ unownedSection: { keep: true }, ...unserved, chatgpt: { default: 'oaiapp_fixture', accounts: { oaiapp_fixture: session } } }))
  assert.deepEqual(await mod.loadStore(path), { unownedSection: { keep: true }, chatgpt: { default: 'oaiapp_fixture', accounts: { oaiapp_fixture: session } } })
  for (const provider of Object.keys(unserved)) assert.deepEqual(await mod.listAccounts(provider, path), [])
  assert.match(await readFile(path, 'utf8'), /stale-refresh/, 'reads leave the file unchanged')
  const renewed = { ...session, accessToken: 'renewed-access' }
  await mod.saveAccountSession('chatgpt', 'oaiapp_fixture', renewed, path)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { unownedSection: { keep: true }, chatgpt: { default: 'oaiapp_fixture', accounts: { oaiapp_fixture: renewed } } })
}))

test('provider settings ignore providers outside the served set and omit them from the next write', () => isolated(async (dir) => {
  const path = join(dir, 'provider-settings.json')
  await writeFile(path, JSON.stringify({
    providers: { codex: { tools: { web_search: false } }, grok: { tools: { x_search: false } }, antigravity: { visibleModels: ['stale'] }, chatgpt: { contextWindows: { 'gpt-fixture': 256000 } } },
    toolHistory: [{ at: 1, provider: 'codex', tools: { web_search: false } }, { at: 2, provider: 'antigravity', tools: { image_generate: false } }],
  }))
  const store = new mod.ProviderSettingsStore(path)
  assert.equal(store.contextWindow('chatgpt', 'gpt-fixture'), 256000)
  await store.set('chatgpt', { contextWindows: { 'gpt-fixture': 128000 } })
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { providers: { chatgpt: { contextWindows: { 'gpt-fixture': 128000 } } } })
}))

test('model defaults ignore providers outside the served set and omit them from the next write', () => isolated(async (dir) => {
  const path = join(dir, 'model-defaults.json')
  await mod.resetModelDefaultsForTests()
  try {
    await writeFile(path, JSON.stringify({ codex: { 'stale-model': 'high' }, grok: { 'stale-model': 'low' }, antigravity: { 'stale-model': 'high' }, chatgpt: { 'gpt-fixture': 'low' } }))
    await mod.loadModelDefaults()
    assert.equal(mod.modelDefaultsLoadError(), undefined)
    assert.deepEqual(structuredClone(mod.modelDefaultsSnapshot()), { chatgpt: { 'gpt-fixture': 'low' } })
    await mod.setDefaultEffort('chatgpt', 'gpt-other', 'high')
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { chatgpt: { 'gpt-fixture': 'low', 'gpt-other': 'high' } })
  } finally { await mod.resetModelDefaultsForTests() }
}))

test('catalog store reads account snapshots beside entries of providers outside the served set', () => isolated(async (dir) => {
  const path = join(dir, 'models.json')
  const snapshot = { at: 1, models: [{ id: 'gpt-fixture', name: 'Fixture model', fastTier: true, maxOutputTokens: 1 }] }
  await writeFile(path, JSON.stringify({ codex: snapshot, grok: snapshot, accounts: { codex: { stale: snapshot }, chatgpt: { oaiapp_fixture: snapshot } } }))
  const store = mod.accountCatalogStore('chatgpt', 'oaiapp_fixture', path)
  assert.deepEqual(await store.load(), { at: 1, models: [{ id: 'gpt-fixture', name: 'Fixture model' }] })
  await store.save({ at: 2, models: [{ id: 'gpt-other', name: 'Other model' }] })
  assert.deepEqual(await mod.accountCatalogStore('chatgpt', 'oaiapp_fixture', path).load(), { at: 2, models: [{ id: 'gpt-other', name: 'Other model' }] })
}))
