import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedEnvironment, EnvironmentMissingError, verifyArchive, UV_VERSION } from '../src/environment.ts'
import { parsePatch, renderPatch, upsertMcp, listMcp } from '../src/patch-document.ts'

const server = { serverName: 'python', transport: 'stdio', command: 'uvx', enabled: true, args: ['example-mcp'], env: { API_KEY: 'explicit-value' } }

test('missing managed environment refuses a bare uvx even if system PATH has uv', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-env-missing-'))
  try {
    const manager = new ManagedEnvironment(home)
    assert.equal((await manager.status()).ready, false)
    await assert.rejects(manager.prepare(server), EnvironmentMissingError)
    const explicit = { ...server, command: join(home, 'custom', process.platform === 'win32' ? 'uvx.exe' : 'uvx') }
    assert.equal(await manager.prepare(explicit), explicit)
    const http = { serverName: 'remote', transport: 'streamable-http', url: 'https://example.test/mcp', enabled: true }
    assert.equal(await manager.prepare(http), http)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('persisted managed invocation survives a new manager without changing PATH', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh env spaces-'))
  try {
    const beforePath = process.env.PATH
    const manager = new ManagedEnvironment(home)
    const prepared = await manager.prepare(server, false)
    assert.ok(prepared.command.startsWith(manager.root))
    assert.ok(prepared.command.includes(UV_VERSION))
    assert.equal(prepared.env.UV_PYTHON_PREFERENCE, 'only-managed')
    assert.equal(prepared.env.API_KEY, 'explicit-value')
    for (const key of ['UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR', 'UV_TOOL_DIR', 'UV_TOOL_BIN_DIR']) assert.ok(prepared.env[key].startsWith(manager.root))
    const document = parsePatch('[]')
    upsertMcp(document, prepared)
    const saved = listMcp(parsePatch(renderPatch(document)))[0].server
    assert.deepEqual(saved, prepared)
    const restarted = new ManagedEnvironment(home)
    assert.deepEqual(restarted.editable(saved), server)
    assert.deepEqual(restarted.invocation(restarted.editable(saved)), prepared)
    assert.equal(process.env.PATH, beforePath)
    assert.equal(manager.tool(join(manager.root, 'uv', '..', '..', 'custom', 'uvx')), undefined)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('checksum mismatch stops before extraction, deduplicates requests and permits retry', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-env-checksum-'))
  try {
    let downloads = 0
    const manager = new ManagedEnvironment(home, async () => {
      downloads++
      return new Response('corrupt archive', { status: 200 })
    })
    manager.install()
    manager.install()
    await manager.settled()
    assert.equal(downloads, 1)
    const status = await manager.status()
    assert.equal(status.state, 'error')
    assert.match(status.error, /校验失败/)
    assert.equal(status.ready, false)
    assert.deepEqual(await readdir(manager.root), [])
    manager.install()
    await manager.settled()
    assert.equal(downloads, 2)
    const bytes = Buffer.from('known artifact')
    verifyArchive(bytes, createHash('sha256').update(bytes).digest('hex'))
    assert.throws(() => verifyArchive(bytes, '0'.repeat(64)), /校验失败/)
  } finally { await rm(home, { recursive: true, force: true }) }
})
