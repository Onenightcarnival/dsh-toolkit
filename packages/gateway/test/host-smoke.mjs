// Installs the packed gateway into an isolated home, boots the actual DSH web host
// with an echo model route and drives /v1 plus the management routes.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const require = createRequire(join(root, 'package.json'))
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const adapter = pathToFileURL(fileURLToPath(new URL('./fixtures/echo-adapter.mjs', import.meta.url))).href
const temporary = await mkdtemp(join(tmpdir(), 'dsh-gateway-host-'))
const home = join(temporary, 'home')
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
const shell = process.platform === 'win32'

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
})

async function run(command, args, options) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, `${command} ${args.join(' ')}\n${output}`)
}

let host
let log = ''
let succeeded = false
try {
  const packed = join(temporary, 'pack')
  await mkdir(packed)
  await run('pnpm', ['pack', '--pack-destination', packed], { cwd: join(root, 'packages/gateway'), shell })
  const [tarball] = await readdir(packed)
  await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', `file:${join(packed, tarball)}`], { cwd: root, env })

  const gatewayPort = await freePort()
  const overlay = join(temporary, 'overlay.yml')
  await writeFile(overlay, [
    '- id: gateway',
    `  config: ${JSON.stringify({ port: gatewayPort })}`,
    '- insert:',
    '    - id: gateway-smoke-echo',
    `      name: ${JSON.stringify(adapter)}`,
    '',
  ].join('\n'))
  host = spawn(process.execPath, [cli, 'web', '--patch', overlay, '--no-open', '--port', '0'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  host.stdout.on('data', data => { log += data })
  host.stderr.on('data', data => { log += data })
  let url
  for (let i = 0; i < 900; i++) {
    url = log.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)/)?.[1]
    if (url) break
    if (host.exitCode !== null) throw new Error(`Host exited ${host.exitCode}\n${log}`)
    await delay(100)
  }
  assert.ok(url, `Host startup timed out\n${log}`)
  const bootstrap = await fetch(url, { redirect: 'manual' })
  assert.equal(bootstrap.status, 303)
  const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  const base = new URL(url).origin

  // The first key is generated at boot and stored under the isolated home.
  let keys
  for (let i = 0; i < 100 && keys === undefined; i++) {
    try { keys = JSON.parse(await readFile(join(home, 'gateway', 'keys.json'), 'utf8')).keys } catch { await delay(100) }
  }
  assert.ok(keys?.length === 1, 'one generated key')
  const key = keys[0].key
  const gateway = `http://127.0.0.1:${gatewayPort}`

  // management routes: browser session required, status lists the echo model
  assert.equal((await fetch(`${base}/api/dsh-gateway/status`)).status, 401)
  const status = await (await fetch(`${base}/api/dsh-gateway/status`, { headers: { cookie } })).json()
  assert.deepEqual(status.listening, { host: '127.0.0.1', port: gatewayPort }, JSON.stringify(status))
  assert.ok(status.models.some(model => model.id === 'smoke:echo'), JSON.stringify(status.models))
  assert.equal(status.keys.length, 1)

  // /v1 on the gateway port
  assert.equal((await fetch(`${gateway}/v1/models`)).status, 401)
  const models = await (await fetch(`${gateway}/v1/models`, { headers: { authorization: `Bearer ${key}` } })).json()
  assert.ok(models.data.some(model => model.id === 'smoke:echo'))
  const chat = await fetch(`${gateway}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'smoke:echo', messages: [{ role: 'user', content: 'ping' }] }) })
  const chatText = await chat.text()
  assert.equal(chat.status, 200, chatText)
  const completion = JSON.parse(chatText)
  assert.equal(completion.choices[0].message.content, 'echo:ping')
  assert.equal(completion.usage.prompt_tokens, 4)
  const stream = await fetch(`${gateway}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'smoke:echo', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'pong' }] }) })
  assert.equal(stream.status, 200)
  const frames = (await stream.text()).split('\n\n').filter(Boolean).map(frame => frame.replace(/^data: /, ''))
  assert.equal(frames.at(-1), '[DONE]')
  const text = frames.slice(0, -1).map(frame => JSON.parse(frame)).map(chunk => chunk.choices[0]?.delta?.content ?? '').join('')
  assert.equal(text, 'echo:pong')
  const message = await fetch(`${gateway}/v1/messages`, { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'smoke:echo', max_tokens: 16, messages: [{ role: 'user', content: 'hey' }] }) })
  const messageText = await message.text()
  assert.equal(message.status, 200, messageText)
  assert.equal(JSON.parse(messageText).content[0].text, 'echo:hey')
  const responses = await fetch(`${gateway}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'smoke:echo', input: 'yo' }) })
  const responsesText = await responses.text()
  assert.equal(responses.status, 200, responsesText)
  assert.equal(JSON.parse(responsesText).output[0].content[0].text, 'echo:yo')

  // usage ledger through the management route
  const usage = await (await fetch(`${base}/api/dsh-gateway/usage?range=today`, { headers: { cookie } })).json()
  assert.equal(usage.totals.requests, 4, JSON.stringify(usage.totals))
  assert.equal(usage.byModel[0].key, 'smoke:echo')

  // settings save restarts the listener on another port
  const nextPort = await freePort()
  const saved = await fetch(`${base}/api/dsh-gateway/settings`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ...status.settings, port: nextPort }) })
  const savedText = await saved.text()
  assert.equal(saved.status, 200, savedText)
  assert.equal(JSON.parse(savedText).listening.port, nextPort)
  assert.equal((await fetch(`http://127.0.0.1:${nextPort}/v1/models`, { headers: { authorization: `Bearer ${key}` } })).status, 200)
  await assert.rejects(fetch(`${gateway}/v1/models`))

  assert.ok(!/Uncaught|unhandled/i.test(log), log)
  succeeded = true
  console.log(`gateway host smoke passed (host ${base}, gateway port ${gatewayPort} → ${nextPort})`)
} finally {
  if (host) {
    host.kill('SIGTERM')
    await Promise.race([once(host, 'exit'), delay(5000)])
  }
  if (!succeeded) console.error(log)
  await rm(temporary, { recursive: true, force: true })
}
