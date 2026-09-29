// Installs the built packages into isolated homes, boots the actual DSH web host and drives the route family.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const require = createRequire(join(root, 'package.json'))
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const fixture = fileURLToPath(new URL('./fixtures/mcp-stdio.mjs', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'dsh-config-center-host-'))
const home = join(temporary, 'standalone')
const profilePatch = join(home, 'profiles/web/cordis.patch.yml')
// An Electron binary runs scripts only in its Node mode.
const nodeEnv = process.versions.electron === undefined ? undefined : { ELECTRON_RUN_AS_NODE: '1' }

/** Streamable HTTP MCP fixture: JSON replies, one session id. */
const remote = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    // The client also opens a GET stream and closes its session with DELETE.
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    const message = JSON.parse(body)
    if (req.headers.authorization !== 'Bearer fixture') {
      res.writeHead(401).end()
      return
    }
    if (message.id === undefined) {
      res.writeHead(202).end()
      return
    }
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'remote-fixture', version: '2.0.0' } }
      : { tools: [{ name: 'a', inputSchema: { type: 'object' } }, { name: 'b', inputSchema: { type: 'object' } }] }
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
})
remote.listen(0, '127.0.0.1')
await once(remote, 'listening')
const remoteUrl = `http://127.0.0.1:${remote.address().port}/mcp`

let log = ''

const shell = process.platform === 'win32'

async function run(command, args, options) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, `${command} ${args.join(' ')}\n${output}`)
}

/**
 * Install a package the way users do (`dsh plugin add file:<tgz>`) into the
 * mode's own home, then start the host; resolves once the browser session is
 * open. `config` overrides the package's entry through a command-line overlay.
 */
async function boot(mode, { dir, entry, config }) {
  const env = { ...process.env, DSH_HOME: join(temporary, mode), DSH_TELEMETRY_DISABLED: '1' }
  const packed = join(temporary, `pack-${mode}`)
  await mkdir(packed)
  await run('pnpm', ['pack', '--pack-destination', packed], { cwd: join(root, dir), shell })
  const [tarball] = await readdir(packed)
  await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', `file:${join(packed, tarball)}`], { cwd: root, env })
  const overlay = join(temporary, `${mode}.yml`)
  await writeFile(overlay, config === undefined ? '[]\n' : `- id: ${entry}\n  config: ${JSON.stringify(config)}\n`)
  const child = spawn(process.execPath, [cli, 'web', '--patch', overlay, '--no-open', '--port', '0'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  log = ''
  child.stdout.on('data', data => { log += data })
  child.stderr.on('data', data => { log += data })
  const stop = async () => {
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), delay(5000)])
  }
  try {
    let url
    for (let i = 0; i < 600; i++) {
      url = log.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)/)?.[1]
      if (url) break
      if (child.exitCode !== null) throw new Error(`Host exited ${child.exitCode}`)
      await delay(100)
    }
    assert.ok(url, 'Host startup timed out')
    const bootstrap = await fetch(url, { redirect: 'manual' })
    assert.equal(bootstrap.status, 303)
    const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    return { base: new URL(url).origin, cookie, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

const OTHERS = { rdb: false, s3: false, otel: false, browser: false, subscriptions: false }
let host
let succeeded = false
try {
  host = await boot('standalone', { dir: 'packages/config-center', entry: 'config-center' })
  const { base, cookie } = host

  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  const ok = async (method, path, body) => {
    const reply = await call(method, path, body)
    assert.equal(reply.status, 200, `${method} ${path}: ${JSON.stringify(reply.body)}`)
    return reply.body
  }
  const patchText = () => readFile(profilePatch, 'utf8')

  assert.equal((await fetch(`${base}/api/dsh-config-center/mcp`)).status, 401, 'routes must require the browser session')

  const initial = await ok('GET', '/api/dsh-config-center/mcp')
  assert.deepEqual(initial.servers, [])
  assert.equal(initial.hotReload, true)
  const header = await patchText()

  // stdio server: saved, connected, tools registered under its namespace
  const stdio = { serverName: 'fixture', enabled: true, transport: 'stdio', command: process.execPath, args: [fixture], ...(nodeEnv === undefined ? {} : { env: nodeEnv }) }
  const probe = await ok('POST', '/api/dsh-config-center/mcp/test', { server: stdio })
  assert.deepEqual(probe.result, { ok: true, code: 'handshake', detail: '', server: 'fixture 1.0.0', tools: 1 })
  const saved = await ok('POST', '/api/dsh-config-center/mcp', { server: stdio })
  assert.equal(saved.id, 'mcp-fixture')
  assert.equal(saved.application, 'applied')
  assert.deepEqual(saved.servers.map(server => [server.id, server.status]), [['mcp-fixture', { state: 'connected', tools: 1 }]])
  assert.ok((await patchText()).startsWith(header.replace(/\[\]\n$/, '')), 'the file header stays as written')
  assert.match(await patchText(), /- insert:\n {4}- id: mcp-fixture\n {6}name: "@deepseek-ai\/dsh-mcp-client"/)

  // streamable-http server with a loader expression in its header
  const http = { serverName: 'remote', enabled: true, transport: 'streamable-http', url: remoteUrl, headers: { Authorization: "!!js 'Bearer ' + 'fixture'" } }
  const remoteProbe = await ok('POST', '/api/dsh-config-center/mcp/test', { server: http })
  assert.deepEqual(remoteProbe.result, { ok: true, code: 'handshake', detail: '', server: 'remote-fixture 2.0.0', tools: 2 })
  const denied = await ok('POST', '/api/dsh-config-center/mcp/test', { server: { ...http, headers: {} } })
  assert.deepEqual(denied.result, { ok: false, code: 'http-status', detail: 'HTTP 401' })
  const savedRemote = await ok('POST', '/api/dsh-config-center/mcp', { server: http })
  assert.deepEqual(savedRemote.servers.map(server => [server.id, server.status.state, server.status.tools]), [['mcp-fixture', 'connected', 1], ['mcp-remote', 'connected', 2]])
  assert.match(await patchText(), /Authorization: !!js "?'Bearer ' \+ 'fixture'"?/)
  assert.equal(savedRemote.servers[1].headers.Authorization, "!!js 'Bearer ' + 'fixture'")

  // refused edits leave the file as it was
  const before = await patchText()
  const duplicate = await call('POST', '/api/dsh-config-center/mcp', { server: { ...stdio, serverName: 'remote' } })
  assert.deepEqual([duplicate.status, duplicate.body.issue], [409, 'duplicate-name'])
  const invalid = await call('POST', '/api/dsh-config-center/mcp', { server: { ...stdio, serverName: 'bad name' } })
  assert.deepEqual([invalid.status, invalid.body.issue], [400, 'serverName'])
  assert.equal(await patchText(), before)

  // disable, rename, delete
  const disabled = await ok('POST', '/api/dsh-config-center/mcp', { id: 'mcp-fixture', server: { ...stdio, enabled: false } })
  assert.deepEqual(disabled.servers[0].status, { state: 'disabled', tools: 0 })
  const renamed = await ok('POST', '/api/dsh-config-center/mcp', { id: 'mcp-fixture', server: { ...stdio, serverName: 'local' } })
  assert.equal(renamed.id, 'mcp-local')
  assert.deepEqual(renamed.servers.map(server => [server.id, server.status.state, server.status.tools]), [['mcp-local', 'connected', 1], ['mcp-remote', 'connected', 2]])
  const removed = await ok('DELETE', '/api/dsh-config-center/mcp?id=mcp-local')
  assert.deepEqual(removed.servers.map(server => server.id), ['mcp-remote'])
  assert.equal((await call('DELETE', '/api/dsh-config-center/mcp?id=mcp-local')).status, 409)

  // built-in plugin settings
  const settings = await ok('GET', '/api/dsh-config-center/settings')
  assert.deepEqual(settings.groups, [
    { entryId: 'goal', available: true, options: [{ key: 'goalMaxRounds', type: 'posInt', def: 256 }] },
    { entryId: 'compaction-basic', available: true, options: [{ key: 'compactionEnabled', type: 'bool', def: false }, { key: 'compactionThreshold', type: 'ratio', def: 0.8 }] },
  ])
  const written = await ok('POST', '/api/dsh-config-center/settings', { values: { goalMaxRounds: 64, compactionEnabled: true, compactionThreshold: 0.7 } })
  assert.equal(written.application, 'applied')
  assert.deepEqual(written.groups.flatMap(group => group.options.map(option => option.value)), [64, true, 0.7])
  assert.match(await patchText(), /- id: goal\n {2}config:\n {4}defaultMaxGoalRounds: 64\n- id: compaction-basic\n {2}disabled: false\n {2}config:\n {4}thresholdRatio: 0\.7\n/)
  const dump = spawn(process.execPath, [cli, 'web', '--dump-config'], { cwd: root, env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let composed = ''
  dump.stdout.on('data', data => { composed += data })
  await once(dump, 'exit')
  assert.match(composed, /defaultMaxGoalRounds: 64/)
  assert.match(composed, /thresholdRatio: 0\.7/)
  const bad = await call('POST', '/api/dsh-config-center/settings', { values: { compactionThreshold: 7 } })
  assert.deepEqual([bad.status, bad.body.key], [400, 'compactionThreshold'])
  const cleared = await ok('POST', '/api/dsh-config-center/settings', { values: { goalMaxRounds: null, compactionEnabled: null, compactionThreshold: null } })
  assert.deepEqual(cleared.groups.flatMap(group => group.options.map(option => option.value)), [undefined, undefined, undefined])
  assert.doesNotMatch(await patchText(), /goal|compaction/)
  assert.match(await patchText(), /mcp-remote/)

  // integrated package: the module mounts by default and leaves with `false`
  await host.stop()
  host = await boot('toolkit', { dir: 'packages/toolkit', entry: 'toolkit', config: OTHERS })
  const get = async path => fetch(host.base + path, { headers: { cookie: host.cookie } })
  assert.equal((await (await get('/api/dsh-toolkit/modules')).json()).configCenter, true)
  assert.deepEqual((await (await get('/api/dsh-config-center/mcp')).json()).servers, [])
  assert.equal((await (await get('/api/dsh-config-center/settings')).json()).groups.length, 2)
  await host.stop()
  host = await boot('disabled', { dir: 'packages/toolkit', entry: 'toolkit', config: { ...OTHERS, configCenter: false } })
  assert.equal((await (await get('/api/dsh-toolkit/modules')).json()).configCenter, false)
  assert.equal((await get('/api/dsh-config-center/mcp')).status, 404)

  succeeded = true
  console.log('config-center host smoke: ok')
} finally {
  if (!succeeded) console.error(log.slice(-4000))
  await host?.stop()
  remote.close()
  await rm(temporary, { recursive: true, force: true })
}
