import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KeyStore, KeyError, presentedKey } from '../src/keys.ts'
import { UsageStore, parseUsageFilter, rangeStart } from '../src/usage.ts'
import { SettingsStore, SettingsError } from '../src/settings.ts'
import { ModelCatalog, ModelResolutionError } from '../src/models.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-gateway-'))
}

test('keys: create, verify, disable, remove and persist with mode 0600', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'keys.json')
    const store = new KeyStore(file)
    assert.deepEqual(store.list(), [])
    const first = store.ensureOne('default')
    assert.ok(first)
    assert.equal(store.ensureOne('default'), undefined)
    const created = store.create('cli', ['deepseek:deepseek-chat'])
    assert.match(created.key, /^dshg_[0-9a-f]{48}$/)
    assert.deepEqual(created.record.models, ['deepseek:deepseek-chat'])
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(store.verify(created.key)?.id, created.record.id)
    assert.equal(store.verify(created.key.slice(0, -1) + 'x'), undefined)
    assert.equal(store.verify(undefined), undefined)
    store.update(created.record.id, { enabled: false })
    assert.equal(store.verify(created.key), undefined)
    store.update(created.record.id, { enabled: true, models: null, name: 'renamed' })
    assert.equal(store.verify(created.key)?.name, 'renamed')
    assert.equal(store.verify(created.key)?.models, null)
    const reloaded = new KeyStore(file)
    assert.equal(reloaded.list().length, 2)
    assert.equal(reloaded.reveal(created.record.id), created.key)
    reloaded.remove(created.record.id)
    assert.equal(new KeyStore(file).list().length, 1)
    assert.throws(() => reloaded.remove('nope'), (error: unknown) => error instanceof KeyError && error.code === 'missing')
    assert.throws(() => reloaded.create('', null), (error: unknown) => error instanceof KeyError && error.code === 'invalid')
    assert.throws(() => reloaded.create('x', ['bad id']), (error: unknown) => error instanceof KeyError && error.code === 'invalid')
    assert.equal(presentedKey({ authorization: 'Bearer abc' }), 'abc')
    assert.equal(presentedKey({ 'x-api-key': ' xyz ' }), 'xyz')
    assert.equal(presentedKey({ authorization: 'Basic abc' }), undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('usage: records aggregate by range, model and key with optional pricing', () => {
  const dir = tempDir()
  try {
    const store = new UsageStore(join(dir, 'usage.sqlite'))
    const now = Date.UTC(2026, 10, 9, 12, 0, 0)
    const base = { keyId: 'k1', keyName: 'default', protocol: 'chat' as const, provider: 'deepseek', model: 'deepseek-chat', modelId: 'deepseek:deepseek-chat', stream: true, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, ttftMs: 100, durationMs: 500, status: 200, errorCode: null }
    store.record({ ...base, time: now - 1000, inputTokens: 1000, outputTokens: 500 })
    store.record({ ...base, time: now - 2000, inputTokens: 2000, outputTokens: 1000, keyId: 'k2', keyName: 'cli', modelId: 'x:y', provider: 'x', model: 'y', status: 502, errorCode: 'QUOTA' })
    store.record({ ...base, time: now - 10 * 24 * 60 * 60_000, inputTokens: 7, outputTokens: 7 })
    const summary = store.summary('7d', { 'deepseek:deepseek-chat': { input: 1, output: 2 } }, now)
    assert.equal(summary.totals.requests, 2)
    assert.equal(summary.totals.errors, 1)
    assert.equal(summary.totals.inputTokens, 3000)
    assert.equal(summary.totals.outputTokens, 1500)
    assert.equal(summary.totals.cost, (1000 * 1 + 500 * 2) / 1_000_000)
    assert.deepEqual(summary.byModel.map(group => [group.key, group.requests, group.cost]), [['deepseek:deepseek-chat', 1, 0.002], ['x:y', 1, null]])
    assert.deepEqual(summary.byKey.map(group => [group.label, group.requests]), [['default', 1], ['cli', 1]])
    assert.equal(summary.rows.length, 2)
    assert.equal(summary.matched, 2)
    assert.equal(summary.rows[0].modelId, 'deepseek:deepseek-chat')
    assert.equal(summary.rows[1].errorCode, 'QUOTA')
    assert.deepEqual(summary.facets, { keys: [{ id: 'k2', name: 'cli' }, { id: 'k1', name: 'default' }], models: ['deepseek:deepseek-chat', 'x:y'], protocols: ['chat'] })
    assert.equal(store.summary('30d', {}, {}, now).totals.requests, 3)
    assert.equal(store.summary('30d', {}, {}, now).totals.cost, null)
    // filters narrow totals and rows but keep the range's facets
    const errors = store.summary('7d', {}, { outcome: 'error' }, now)
    assert.equal(errors.totals.requests, 1)
    assert.equal(errors.rows[0].keyName, 'cli')
    assert.equal(errors.facets.models.length, 2)
    const byKey = store.summary('30d', {}, { keyId: 'k1', protocol: 'chat' }, now)
    assert.equal(byKey.matched, 2)
    assert.equal(store.summary('30d', {}, { modelId: 'x:y', outcome: 'ok' }, now).matched, 0)
    assert.deepEqual(parseUsageFilter(new URLSearchParams('key=k1&model=&protocol=bogus&outcome=error')), { keyId: 'k1', outcome: 'error' })
    const today = new Date(now)
    today.setHours(0, 0, 0, 0)
    assert.equal(rangeStart('today', now), today.getTime())
    store.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('settings: defaults, validation and persistence', () => {
  const dir = tempDir()
  try {
    const file = join(dir, 'settings.json')
    const store = new SettingsStore(file, { port: 24000 })
    assert.deepEqual(store.get(), { enabled: true, host: '127.0.0.1', port: 24000, defaultModel: null, aliases: {}, pricing: {} })
    store.save({ enabled: false, host: '0.0.0.0', port: 8080, defaultModel: 'deepseek:deepseek-chat', aliases: { 'gpt-4o': 'deepseek:deepseek-chat' }, pricing: { 'deepseek:deepseek-chat': { input: 0.28, output: 0.42 } } })
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).port, 8080)
    assert.equal(new SettingsStore(file).get().aliases['gpt-4o'], 'deepseek:deepseek-chat')
    assert.throws(() => store.save({ port: 70000 }), (error: unknown) => error instanceof SettingsError && error.field === 'port')
    assert.throws(() => store.save({ aliases: { a: 'no-separator' } }), (error: unknown) => error instanceof SettingsError && error.field === 'aliases')
    assert.throws(() => store.save({ pricing: { 'x:y': { input: -1, output: 0 } } }), (error: unknown) => error instanceof SettingsError && error.field === 'pricing')
    assert.throws(() => store.save({ host: 'bad host' }), (error: unknown) => error instanceof SettingsError && error.field === 'host')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('models: catalog ids, aliases and default fallback', async () => {
  let settings = { enabled: true, host: '127.0.0.1', port: 1, defaultModel: null as string | null, aliases: { 'gpt-4o': 'deepseek:deepseek-chat' }, pricing: {} }
  let hostDefault: { provider: string; model: string } | undefined = { provider: 'deepseek', model: 'deepseek-reasoner' }
  const catalog = new ModelCatalog({
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'broken', name: 'Broken' }],
    listModels: async provider => {
      if (provider === 'broken') throw new Error('offline')
      return [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }]
    },
  }, () => settings, () => hostDefault)
  assert.deepEqual((await catalog.list()).map(model => model.id), ['deepseek:deepseek-chat', 'deepseek:deepseek-reasoner'])
  assert.equal(catalog.resolve('deepseek:deepseek-chat').model, 'deepseek-chat')
  assert.equal(catalog.resolve('gpt-4o').id, 'deepseek:deepseek-chat')
  assert.equal(catalog.resolve('unknown-model').id, 'deepseek:deepseek-reasoner')
  assert.equal(catalog.resolve(undefined).id, 'deepseek:deepseek-reasoner')
  assert.equal(catalog.resolve('other:model').id, 'deepseek:deepseek-reasoner')
  settings = { ...settings, defaultModel: 'deepseek:deepseek-chat' }
  assert.equal(catalog.resolve(undefined).id, 'deepseek:deepseek-chat')
  settings = { ...settings, defaultModel: null }
  hostDefault = undefined
  assert.throws(() => catalog.resolve(undefined), ModelResolutionError)
  assert.throws(() => catalog.resolve('nope'), ModelResolutionError)
})
