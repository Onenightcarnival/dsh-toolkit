import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { zstdCompressSync } from 'node:zlib'

const root = fileURLToPath(new URL('../', import.meta.url))
const bridge = join(root, 'packages/browser-bridge')
const require = createRequire(join(root, 'package.json'))
const expectedVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies['@deepseek-ai/dsh']
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const bridgeRequire = createRequire(join(bridge, 'package.json'))
const { default: WebSocket } = await import(pathToFileURL(bridgeRequire.resolve('ws')).href)
const temp = await mkdtemp(join(tmpdir(), 'dsh-runtime-smoke-'))
const home = join(temp, 'home')
const marker = join(temp, 'observation.json')
const patch = join(temp, 'smoke.patch.yml')
const sessionId = `session-${randomUUID()}`
// Deleted while this process's Agent still owns it → archived now, purged next start.
const deferredPurgeId = `session-${randomUUID()}`
// Deleted after a restart, before anything resumes it → purged immediately.
const coldPurgeId = `session-${randomUUID()}`
const pendingPurgeFile = join(home, 'ext-bridge-pending-purge.json')
const legacySessionId = `session-${randomUUID()}`
const legacyProject = temp.replace(/[\\/:]+/g, '-').replace(/[^A-Za-z0-9._-]/g,
  char => `~${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`).replace(/^-+/, '')
const legacyDirectory = join(home, 'sessions', `--${legacyProject.slice(0, 251)}--`, legacySessionId)
const legacyFile = join(legacyDirectory, 'session.v2.jsonl.zstd')
// A released V2 envelope, read through the production migration catalog and
// the bridge. Keep the original bytes so the smoke also checks preservation.
const legacyLog = [
  { type: 'session', version: 2, id: legacySessionId, cwd: temp, createdAt: 1, isSeeded: false, delegationDepth: 0 },
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  { type: 'user/message', surfaceOp: 'append', data: { id: 'legacy-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Saved browser conversation' }] } },
  { type: 'step/end', data: { turn: 1, step: 1 } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
].map((row, index) => JSON.stringify(index === 0 ? row : { ...row, seq: index - 1, time: index + 10 })).join('\n') + '\n'
// The JSONL container requires its header in a separate Zstandard frame.
const legacyBytes = Buffer.concat(legacyLog.trimEnd().split('\n').map(line => zstdCompressSync(Buffer.from(line + '\n'))))
const token = randomUUID()
// Beacon on a free port instead of the default 43189: no collision with a
// running desktop app or CLI host.
const discoveryPort = await new Promise((resolve, reject) => {
  const probe = createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
// Do not inherit bridge settings or credentials from the developer's shell.
delete env.DSH_EXT_TOKEN
delete env.DSH_BROWSER_SESSION_WORKSPACE
let host
let socket
let hostLog = ''
let succeeded = false

async function waitFor(check, label, timeout = 60_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (host && (host.exitCode !== null || host.signalCode !== null)) {
      throw new Error(`DSH exited (${host.exitCode ?? host.signalCode}) while waiting for ${label}`)
    }
    const value = await check()
    if (value) return value
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function command(args) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000)
  try {
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, output)
  } finally { clearTimeout(timeout) }
}

async function start(reopen) {
  await rm(marker, { force: true })
  // The production bridge is registered through the normal profile command;
  // only test settings and the observation probe are additional patch rows.
  await writeFile(patch, [
    '- id: bridge-browser',
    '  config:',
    `    token: ${JSON.stringify(token)}`,
    '    sessionWorkspacePath: ""',
    '    deferSessionCreate: false',
    `    discoveryPort: ${discoveryPort}`,
    '- insert:',
    '    - id: runtime-smoke-probe',
    `      name: ${JSON.stringify(pathToFileURL(join(root, 'scripts/fixtures/runtime-probe.mjs')).href)}`,
    '      config:',
    `        sessionId: ${JSON.stringify(sessionId)}`,
    `        marker: ${JSON.stringify(marker)}`,
    `        reopen: ${reopen}`,
    '',
  ].join('\n'))
  hostLog = ''
  host = spawn(process.execPath, [cli, 'web', '--patch', patch, '--no-open', '--port', '0'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  host.stdout.on('data', data => { hostLog += data })
  host.stderr.on('data', data => { hostLog += data })
  let spawnError
  host.on('error', error => { spawnError = error })
  const base = await waitFor(() => {
    if (spawnError) throw spawnError
    return hostLog.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)?.[1]
  }, 'host readiness')
  const response = await fetch(`${base}/ext/bridge-config`, { signal: AbortSignal.timeout(10_000) })
  assert.equal(response.status, 200)
  const config = await response.json()
  assert.equal(config.wsUrl, base.replace('http:', 'ws:') + '/ext/bridge')
  // The beacon must advertise the host route's URL and serve nothing else.
  const beacon = await waitFor(async () => {
    try {
      const reply = await fetch(`http://127.0.0.1:${discoveryPort}/ext/bridge-config`, { signal: AbortSignal.timeout(2_000) })
      return reply.status === 200 ? await reply.json() : undefined
    } catch { return undefined }
  }, 'discovery beacon', 15_000)
  assert.equal(beacon.wsUrl, config.wsUrl, 'beacon must advertise the host bridge URL')
  const beaconOther = await fetch(`http://127.0.0.1:${discoveryPort}/ext/bridge`, { signal: AbortSignal.timeout(2_000) })
  assert.equal(beaconOther.status, 404, 'beacon must serve nothing but the config route')
  console.log(`Discovery beacon on 127.0.0.1:${discoveryPort} -> ${beacon.wsUrl}`)
  // The profile carries plugins only; every dsh package resolves from the runtime that runs the CLI.
  assert.ok(!existsSync(join(home, 'profiles/web/node_modules/@deepseek-ai')), 'profile must not carry its own dsh copy')
  const resolve = createRequire(cli)
  for (const name of ['dsh-session-query', 'dsh-session-projection-cache']) {
    const path = resolve.resolve(`@deepseek-ai/${name}/package.json`)
    const { version } = JSON.parse(await readFile(path, 'utf8'))
    console.log(`Host ${name}@${version}: ${path}`)
    assert.equal(version, expectedVersion, `Runtime resolved an incompatible ${name} at ${path}`)
  }
  // Firefox-style origin requires a valid token even on loopback.
  socket = new WebSocket(config.wsUrl, { origin: 'moz-extension://runtime-smoke', handshakeTimeout: 10_000 })
  const frames = []
  let socketError
  socket.on('error', error => { socketError = error })
  socket.on('message', data => { frames.push(JSON.parse(data.toString())) })
  await once(socket, 'open')
  async function frame(predicate) {
    return waitFor(() => {
      if (socketError) throw socketError
      const found = frames.find(predicate)
      if (found) return found
      if (socket.readyState === WebSocket.CLOSED) throw new Error(`Bridge closed: ${JSON.stringify(frames)}`)
    }, 'bridge response', 15_000)
  }
  socket.send(JSON.stringify({ t: 'hello', token, caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } }))
  await frame(value => value.t === 'hello.ok')
  const rpc = async (method, payload) => {
    const id = randomUUID()
    socket.send(JSON.stringify({ t: 'rpc', id, method, payload }))
    const result = await frame(value => value.t === 'rpc.result' && value.id === id)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.result?.result?.ok, true, JSON.stringify(result))
    return result.result.result.value
  }
  // Bridge-internal methods answer with a flat result instead of a gateway envelope.
  rpc.internal = async (method, payload) => {
    const id = randomUUID()
    socket.send(JSON.stringify({ t: 'rpc', id, method, payload }))
    const result = await frame(value => value.t === 'rpc.result' && value.id === id)
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.result
  }
  return rpc
}

async function sessionFiles(id) {
  const workspaces = await readdir(join(home, 'sessions'))
  const files = []
  for (const workspace of workspaces) {
    try { files.push(...(await readdir(join(home, 'sessions', workspace, id))).filter(name => name !== 'session.lock')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return files
}

async function observation() {
  return waitFor(async () => {
    try { return JSON.parse(await readFile(marker, 'utf8')) } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  }, 'persisted session observation')
}

async function stop() {
  socket?.terminate()
  socket = undefined
  if (!host || host.exitCode !== null || host.signalCode !== null) return
  const exited = once(host, 'exit')
  host.kill('SIGTERM')
  const timeout = setTimeout(() => host.kill('SIGKILL'), 10_000)
  try { await exited } finally { clearTimeout(timeout) }
  host = undefined
}

try {
  await mkdir(home, { recursive: true })
  await mkdir(legacyDirectory, { recursive: true })
  await writeFile(legacyFile, legacyBytes)
  await command(['plugin', '--profile', 'web', 'add', '-w', `@onenightcarnival/dsh-bridge-browser@link:${bridge}`])
  let rpc = await start(false)
  const created = await rpc('session.create', { sessionId, cwd: temp })
  assert.equal(created.sessionId, sessionId)
  assert.equal((await observation()).sessionId, sessionId)
  assert.ok((await rpc('session.list', {})).items.some(item => item.sessionId === sessionId))
  // Model picker: the catalog and a selection of its default route go through
  // the same gateway methods the desktop web UI uses.
  const catalog = await rpc('session.modelCatalog', {})
  assert.equal(typeof catalog.default?.provider, 'string', JSON.stringify(catalog))
  assert.equal(typeof catalog.default?.model, 'string')
  assert.ok(Array.isArray(catalog.groups) && Array.isArray(catalog.routableProviders))
  console.log(`Model catalog: default ${catalog.default.provider}/${catalog.default.model}, ${catalog.groups.length} provider group(s), routable: ${catalog.routableProviders.join(', ') || '(none)'}`)
  const selected = await rpc('session.selectModel', { sessionId, ...catalog.default })
  assert.equal(selected.selected?.provider, catalog.default.provider, JSON.stringify(selected))
  assert.equal(selected.selected?.model, catalog.default.model)
  const projectedSelection = (await rpc('session.history', { sessionId })).projections?.values?.modelSelection
  assert.ok(projectedSelection !== undefined, 'history must carry the modelSelection projection')
  assert.equal((projectedSelection.next ?? projectedSelection.lastUsed)?.model, catalog.default.model)
  const history = await rpc('session.history', { sessionId })
  assert.ok(Array.isArray(history.events))
  const migrated = await rpc('session.history', { sessionId: legacySessionId })
  assert.ok(migrated.events.some(({ event }) => event.type === 'system/message'), 'V2 migration must insert the V3 system head')
  assert.equal(migrated.events.find(({ event }) => event.type === 'user/message')?.event.data.content[0].text, 'Saved browser conversation')
  assert.deepEqual(await readFile(legacyFile), legacyBytes, 'migration must preserve the original V2 log')
  // Deletion: a session created through the gateway stays owned by this
  // process's idle Agent, so the bridge can only archive it now and must
  // purge its files on the next start.
  assert.equal((await rpc('session.create', { sessionId: deferredPurgeId, cwd: temp })).sessionId, deferredPurgeId)
  assert.equal((await rpc('session.create', { sessionId: coldPurgeId, cwd: temp })).sessionId, coldPurgeId)
  assert.ok((await sessionFiles(deferredPurgeId)).length > 0, 'deferred-purge session must have durable files')
  assert.deepEqual(await rpc.internal('bridge.session.purge', { sessionId: deferredPurgeId }), { purged: false, deferred: true })
  assert.ok(!(await rpc('session.list', {})).items.some(item => item.sessionId === deferredPurgeId), 'deferred session must leave session.list at once')
  assert.ok((await sessionFiles(deferredPurgeId)).length > 0, 'deferred session keeps its files while owned')
  assert.deepEqual(JSON.parse(await readFile(pendingPurgeFile, 'utf8')), { sessionIds: [deferredPurgeId] })
  await stop()
  rpc = await start(true)
  await waitFor(async () => (await sessionFiles(deferredPurgeId)).length === 0, 'deferred purge after restart', 15_000)
  assert.deepEqual(JSON.parse(await readFile(pendingPurgeFile, 'utf8')), { sessionIds: [] })
  assert.ok(!(await rpc('session.list', {})).items.some(item => item.sessionId === deferredPurgeId))
  // A session nothing has resumed since the restart is purged on the spot.
  assert.deepEqual(await rpc.internal('bridge.session.purge', { sessionId: coldPurgeId }), { purged: true })
  assert.deepEqual(await sessionFiles(coldPurgeId), [])
  assert.equal((await observation()).source, 'prepared')
  assert.ok((await rpc('session.list', {})).items.some(item => item.sessionId === sessionId))
  assert.deepEqual((await rpc('session.history', { sessionId })).events, history.events)
  const reopenedLegacy = await rpc('session.history', { sessionId: legacySessionId })
  // Following a cold Session activates it after the opening snapshot and may
  // append seed/permission metadata. The migrated history prefix stays exact.
  assert.deepEqual(reopenedLegacy.events.slice(0, migrated.events.length), migrated.events)
  assert.deepEqual(await readFile(legacyFile), legacyBytes)
  console.log('Real DSH smoke passed: discovery, token authentication, create/list/history, deferred and immediate deletion, V2 migration, and prepared projections after restart')
  succeeded = true
} catch (error) {
  console.error(hostLog)
  console.error(`Smoke artifacts retained at ${temp}`)
  throw error
} finally {
  await stop()
  if (succeeded) await rm(temp, { recursive: true, force: true, maxRetries: 3 })
}
