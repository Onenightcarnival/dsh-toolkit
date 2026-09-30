import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preferences } from '../src/preferences.ts'
import { testServer, STDIO_TIMEOUT_MS } from '../src/probe.ts'

test('startup wait defaults to 900 seconds and persists with validation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-timeout-'))
  try {
    const prefs = preferences(dir)
    assert.equal(await prefs.timeout(), 900)
    assert.equal(STDIO_TIMEOUT_MS, 900_000)
    await writeFile(join(dir, 'dsh-config-center.json'), '{"other":true}')
    await prefs.saveTimeout(1800)
    assert.equal(await preferences(dir).timeout(), 1800)
    for (const value of [0, -1, 0.5, 86401, '900', null]) await assert.rejects(prefs.saveTimeout(value))
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'dsh-config-center.json'), 'utf8')), { other: true, stdioTimeoutSeconds: 1800 })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('configured wait permits slow startup and reports the actual timeout', async () => {
  const fixture = new URL('./fixtures/mcp-stdio.mjs', import.meta.url).href
  const server = { serverName: 'delayed', enabled: true, transport: 'stdio', command: process.execPath,
    args: ['--input-type=module', '-e', `await new Promise(r=>setTimeout(r,1300));await import(${JSON.stringify(fixture)})`] }
  const short = await testServer(server, { stdioTimeoutMs: 1000 })
  assert.equal(short.code, 'timeout')
  assert.equal(short.timeoutSeconds, 1)
  const long = await testServer(server, { stdioTimeoutMs: 5000 })
  assert.equal(long.ok, true, JSON.stringify(long))
  assert.equal(long.tools, 1)
})
