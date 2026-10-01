import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalLogStore, redactLog } from '../src/logs.ts'
import { makeRoutes } from '../src/routes.ts'

test('fixed log sources redact credentials and bound tail reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-log-test-'))
  const file = join(directory, 'dsh-server.log')
  const original = 'x'.repeat(300000) + '\nhttps://host/?token=private-token\nAuthorization: Bearer private-auth\n原始日志\n'
  await writeFile(file, original)
  const store = new LocalLogStore(file)
  const result = await store.read('server')
  assert.equal(await readFile(file, 'utf8'), original)
  assert(result.text.includes('原始日志'))
  assert.equal(result.truncated, true)
  assert.equal(result.sources.length, 1)
  assert(!result.text.includes('private-'))
  assert(result.text.includes('[REDACTED]'))
  await assert.rejects(store.read('../../secret'))
  assert(!redactLog('https://user:pw@host password="private-pw"').includes('private-pw'))
  const standalone = new LocalLogStore('')
  assert.deepEqual((await standalone.read()).sources.map(s => s.id), [])
})

test('log route requires a loopback browser session', async () => {
  const route = makeRoutes({ rejection: () => 401 }).find(route => route.path.endsWith('/logs'))
  const response = () => ({ statusCode: 0, writeHead(status) { this.statusCode = status }, end(value) { this.body = value } })
  const res = response()
  await route.handler({ method: 'GET', url: '/api/dsh-config-center/logs', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } }, res)
  assert.equal(res.statusCode, 401)
})

test('UTF-8 snapshots retain complete characters across live file and tail boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-log-utf8-'))
  const file = join(directory, 'dsh-server.log')
  const reader = new LocalLogStore(file)
  const text = Buffer.from('\uFEFF中文 ▀▄ 🐋')
  for (let split = 3; split < text.length; split++) {
    await writeFile(file, text.subarray(0, split))
    assert(!(await reader.read()).text.includes('\uFFFD'))
    await appendFile(file, text.subarray(split))
    assert.equal((await reader.read()).text, '中文 ▀▄ 🐋')
  }
  await writeFile(file, '中文'.repeat(50000) + '\n尾部 ▀ 🐋\n')
  const tail = await reader.read()
  assert.equal(tail.text, '尾部 ▀ 🐋\n')
  assert.equal(tail.truncated, true)
})
