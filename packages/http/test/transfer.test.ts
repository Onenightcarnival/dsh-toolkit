import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIRECT_TARGET_ID, type HttpBundle } from '../src/protocol.ts'
import { RequestStore, TargetStore } from '../src/store.ts'
import { exportBundle, planImport } from '../src/transfer.ts'

function stores(): { dir: string; store: TargetStore; requests: RequestStore } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-http-transfer-'))
  return { dir, store: new TargetStore(join(dir, 'targets.json')), requests: new RequestStore(join(dir, 'requests.json')) }
}

function seed(store: TargetStore, requests: RequestStore): void {
  const api = store.create({ name: 'api', baseUrl: 'https://api.example.com/v1', auth: { type: 'bearer', token: 'super-secret-token' }, headers: { 'X-API-Key': 'literal-key', 'X-Trace': 'on', Authorization: 'Bearer {{token}}' }, variables: { org: 'acme' }, allowMutations: true })
  const basic = store.create({ name: 'legacy', baseUrl: 'https://legacy.example.com', auth: { type: 'basic', username: 'svc', password: 'pw-secret' } })
  requests.create({ targetId: api.id, name: 'login', method: 'POST', path: '/login', bodyMode: 'json', body: '{"user":"a"}', captures: [{ name: 'token', source: 'body', path: 'data.token', enabled: true }] })
  requests.create({ targetId: api.id, name: 'me', path: '/me', headers: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true }, { key: 'Cookie', value: 'sid=literal-cookie', enabled: true }] })
  requests.create({ targetId: basic.id, path: '/ping', auth: { type: 'header', name: 'X-Key', value: 'request-secret' } })
  requests.create({ targetId: DIRECT_TARGET_ID, path: 'https://example.org/health' })
}

test('export: targets, requests and the history limit, without secrets', () => {
  const { dir, store, requests } = stores()
  try {
    seed(store, requests)
    store.setSettings({ agentTools: true, historyLimit: 300 })
    const bundle = exportBundle(store.list(), requests.list(), store.settings(), 1)
    const text = JSON.stringify(bundle)
    assert.equal(bundle.format, 'dsh-http')
    assert.deepEqual(bundle.settings, { historyLimit: 300 })
    assert.doesNotMatch(text, /super-secret-token|pw-secret|literal-key|literal-cookie|request-secret|agentTools/)
    const api = bundle.targets.find(t => t.name === 'api')
    assert.deepEqual(api?.auth, { type: 'bearer', token: '' })
    // A credential header that references a variable is configuration, not a secret.
    assert.deepEqual(api?.headers, { 'X-API-Key': '', 'X-Trace': 'on', Authorization: 'Bearer {{token}}' })
    assert.deepEqual(bundle.targets.find(t => t.name === 'legacy')?.auth, { type: 'basic', username: 'svc', password: '' })
    const me = bundle.requests.find(r => r.name === 'me')
    assert.deepEqual(me?.headers.map(h => h.value), ['Bearer {{token}}', ''])
    assert.deepEqual(bundle.requests.find(r => r.name === 'login')?.captures, [{ name: 'token', source: 'body', path: 'data.token', enabled: true }])
    assert.equal(bundle.requests.length, 4)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('import into an empty configuration: targets need their secrets again', () => {
  const source = stores()
  const empty = stores()
  try {
    seed(source.store, source.requests)
    const bundle = JSON.parse(JSON.stringify(exportBundle(source.store.list(), source.requests.list(), source.store.settings()))) as HttpBundle
    const plan = planImport(bundle, { targets: [], requests: [] }, 'skip')
    assert.deepEqual(plan.result, { conflicts: [], created: ['api', 'legacy'], overwritten: [], skipped: [], needAuth: ['api', 'legacy'], requests: 4 })
    const api = plan.targets.find(t => t.name === 'api')
    assert.deepEqual(api?.auth, { type: 'bearer', token: '' })
    assert.deepEqual(api?.headers, { 'X-Trace': 'on', Authorization: 'Bearer {{token}}' })
    assert.notEqual(api?.id, source.store.find('api')?.id)
    // Requests follow their target under its new id and keep their own ids.
    assert.deepEqual(plan.requests.filter(r => r.targetId === api?.id).map(r => r.name), ['login', 'me'])
    assert.deepEqual(plan.requests.map(r => r.id).sort(), source.requests.list().map(r => r.id).sort())
    assert.equal(plan.requests.filter(r => r.targetId === DIRECT_TARGET_ID).length, 1)
    empty.requests.replaceAll(plan.requests)
    empty.store.replaceAll(plan.targets, plan.historyLimit)
    assert.equal(empty.store.summarize(empty.store.find('api')!).auth.type, 'bearer')
    assert.equal(empty.requests.list().length, 4)
  } finally {
    rmSync(source.dir, { recursive: true, force: true })
    rmSync(empty.dir, { recursive: true, force: true })
  }
})

test('import over an existing configuration: overwrite keeps stored secrets, skip leaves the target alone', () => {
  const { dir, store, requests } = stores()
  try {
    seed(store, requests)
    const bundle = JSON.parse(JSON.stringify(exportBundle(store.list(), requests.list(), store.settings()))) as HttpBundle
    bundle.targets[0].baseUrl = 'https://api.example.com/v2'
    bundle.targets.push({ id: 'file-new', name: 'fresh', baseUrl: 'https://fresh.example.com', auth: { type: 'none' }, headers: {}, variables: {}, allowedHosts: [], allowMutations: false, allowPrivate: false, timeoutMs: 30_000 })
    bundle.requests = bundle.requests.filter(r => r.name !== 'me')
    bundle.requests.push({ id: 'zzzz', targetId: 'file-new', name: 'first', method: 'GET', path: '/', query: [], headers: [], auth: { type: 'none' }, bodyMode: 'none', body: '', form: [], captures: [] })
    const local = requests.create({ targetId: store.find('api')!.id, name: 'local only', path: '/local' })
    const current = { targets: store.list(), requests: requests.list() }

    const skip = planImport(bundle, current, 'skip')
    assert.deepEqual(skip.result.conflicts, ['api', 'legacy', DIRECT_TARGET_ID])
    assert.deepEqual([skip.result.created, skip.result.skipped, skip.result.overwritten], [['fresh'], ['api', 'legacy'], []])
    assert.equal(skip.result.requests, 1)
    assert.equal(skip.targets.find(t => t.name === 'api')?.baseUrl, 'https://api.example.com/v1')
    assert.ok(skip.requests.some(r => r.id === local.id))
    assert.equal(skip.requests.filter(r => r.targetId === DIRECT_TARGET_ID).length, 1)

    const over = planImport(bundle, current, 'overwrite')
    assert.deepEqual([over.result.created, over.result.skipped, over.result.overwritten, over.result.needAuth], [['fresh'], [], ['api', 'legacy'], []])
    const api = over.targets.find(t => t.name === 'api')
    assert.equal(api?.id, store.find('api')?.id)
    assert.equal(api?.baseUrl, 'https://api.example.com/v2')
    assert.deepEqual(api?.auth, { type: 'bearer', token: 'super-secret-token' })
    assert.equal(api?.headers['X-API-Key'], 'literal-key')
    // The request list of an overwritten target is the file's.
    assert.deepEqual(over.requests.filter(r => r.targetId === api?.id).map(r => r.name), ['login'])
    assert.equal(over.requests.filter(r => r.targetId === DIRECT_TARGET_ID).length, 1)
    assert.equal(over.requests.find(r => r.name === 'first')?.id.length, 12)
    // The plan is computed without touching the stores.
    assert.equal(store.find('api')?.baseUrl, 'https://api.example.com/v1')
    assert.equal(requests.list().length, 5)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('import: a malformed file is refused as a whole', () => {
  const base = { format: 'dsh-http', version: 1, exportedAt: 0, settings: { historyLimit: 200 }, targets: [], requests: [] }
  const current = { targets: [], requests: [] }
  assert.throws(() => planImport(null, current, 'skip'), /not a dsh-http export/)
  assert.throws(() => planImport({ ...base, format: 'postman' }, current, 'skip'), /not a dsh-http export/)
  assert.throws(() => planImport({ ...base, version: 99 }, current, 'skip'), /unsupported export version/)
  assert.throws(() => planImport({ ...base, targets: [{ id: 'a', name: 'x', baseUrl: 'ftp://nope' }] }, current, 'skip'), /target 'x'/)
  assert.throws(() => planImport({ ...base, targets: [{ id: 'a', name: 'x', baseUrl: 'https://a.example' }, { id: 'b', name: 'X', baseUrl: 'https://b.example' }] }, current, 'skip'), /twice/)
  assert.throws(() => planImport({ ...base, targets: [{ id: 'a', name: 'x', baseUrl: 'https://a.example' }], requests: [{ targetId: 'a', method: 'TRACE', path: '/' }] }, current, 'skip'), /unsupported method/)
  // Requests of a target the file does not define are left out.
  assert.equal(planImport({ ...base, requests: [{ targetId: 'ghost', path: '/' }] }, current, 'skip').result.requests, 0)
  assert.equal(planImport({ ...base, settings: { historyLimit: 5 } }, current, 'skip').historyLimit, undefined)
})
