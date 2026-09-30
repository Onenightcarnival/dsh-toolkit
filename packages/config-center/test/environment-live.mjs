// Opt-in network test: real uv download and managed Python; all state is isolated.
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { ManagedEnvironment } from '../src/environment.ts'
import { testServer } from '../src/probe.ts'

const home = process.env.DSH_ENV_TEST_HOME || await mkdtemp(join(tmpdir(), 'dsh-managed-uv-'))
const manager = new ManagedEnvironment(home)
const phases = new Set()
const timer = setInterval(async () => {
  const status = await manager.status()
  if (!phases.has(status.state)) { phases.add(status.state); console.log(status.state, status.progress ?? '') }
}, 1000)
try {
  manager.install()
  await manager.settled()
  const installed = await manager.status()
  assert.equal(installed.ready, true, JSON.stringify(installed))
  const fixture = join(home, 'fixture')
  await mkdir(fixture, { recursive: true })
  for (const name of ['managed_mcp.py', 'pyproject.toml']) {
    await copyFile(fileURLToPath(new URL(`./fixtures/python-mcp/${name}`, import.meta.url)), join(fixture, name))
  }
  const observation = join(home, 'python-observation.json')
  const source = { serverName: 'managed-python', enabled: true, transport: 'stdio', command: 'uvx',
    args: ['--python', '3.12', '--from', fixture, 'managed-mcp'], env: { MCP_FIXTURE_OUTPUT: observation } }
  const prepared = await manager.prepare(source)
  const probe = await testServer(prepared, { stdioTimeoutMs: 300_000 })
  assert.equal(probe.ok, true, JSON.stringify(probe))
  assert.equal(probe.tools, 1)
  const info = JSON.parse(await readFile(observation, 'utf8'))
  assert.ok(resolve(info.base).startsWith(resolve(manager.root, 'python')), JSON.stringify(info))
  assert.equal(info.preference, 'only-managed')
  assert.equal(info.cache, join(manager.root, 'cache'))
  const restarted = new ManagedEnvironment(home)
  assert.equal((await restarted.status()).ready, true)
  assert.deepEqual(await restarted.prepare(source), prepared)
  await writeFile(join(home, 'prepared-mcp.json'), JSON.stringify(prepared, null, 2))
  console.log('PASS: verified uv archive, independent Python, uvx MCP handshake, durable invocation after restart')
  console.log('Test home:', home)
} finally { clearInterval(timer) }
