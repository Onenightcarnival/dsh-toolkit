import assert from 'node:assert/strict'
import { createServer, Server } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { build } from 'esbuild'

const compiled = await build({
  entryPoints: [new URL('../src/backend/auth/oauth-flow.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')],
  bundle: true, write: false, platform: 'node', format: 'esm',
})
const { OAuthFlowManager } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const spec = {
  listen: { host: '127.0.0.1', ports: [0] },
  callbackPath: '/auth/callback',
  manualRedirectUri: 'http://localhost:1455/auth/callback',
  buildAuthorizeUrl: ({ redirectUri, state, pkce }) => `https://auth.openai.com/oauth/authorize?${new URLSearchParams({ redirect_uri: redirectUri, state, code_challenge: pkce.challenge })}`,
}
const callback = (attempt, state = attempt.state) => `${attempt.redirectUri}?code=fixture-code&state=${state}`

for (const errorCode of ['EACCES', 'EPERM', 'EADDRINUSE']) {
  test(`${errorCode} on callback ports falls back to a state-validated manual login`, async t => {
    const ports = []
    t.mock.method(Server.prototype, 'listen', function (port) {
      ports.push(port)
      queueMicrotask(() => this.emit('error', Object.assign(new Error('blocked port'), { code: errorCode })))
      return this
    })
    const manager = new OAuthFlowManager()
    const attempt = await manager.start('codex', { ...spec, listen: { host: 'localhost', ports: [1455, 1457] } })
    const code = attempt.waitCode()
    try {
      assert.deepEqual(ports, [1455, 1457])
      assert.equal(attempt.manualOnly, true)
      assert.equal(manager.isBusy('codex'), true)
      assert.equal(new URL(attempt.authorizeUrl).searchParams.get('redirect_uri'), spec.manualRedirectUri)
      assert.ok(new URL(attempt.authorizeUrl).searchParams.get('code_challenge'))
      await assert.rejects(manager.start('codex', spec), /already in progress/)
      assert.throws(() => attempt.manual('fixture-code'), /complete callback URL/)
      assert.throws(() => attempt.manual(callback(attempt, 'wrong-state')), /state mismatch/)
      assert.throws(() => attempt.manual(callback(attempt).replace('localhost:1455', 'example.test')), /expected login callback/)
      assert.equal(manager.isBusy('codex'), true, 'bad pasted input must not end a valid attempt')
      attempt.manual(callback(attempt))
      assert.equal(await code, 'fixture-code')
      assert.equal(manager.isBusy('codex'), false)
    } finally { attempt.cancel(); await code.catch(() => {}) }
  })
}

test('a real occupied port permits manual authorization and cancellation', async () => {
  const blocker = createServer()
  blocker.listen(0, '127.0.0.1')
  await once(blocker, 'listening')
  const manager = new OAuthFlowManager()
  try {
    const attempt = await manager.start('codex', { ...spec, listen: { host: '127.0.0.1', ports: [blocker.address().port] } })
    assert.equal(attempt.manualOnly, true)
    const cancelled = assert.rejects(attempt.waitCode(), /login cancelled/)
    attempt.cancel()
    await cancelled
    assert.equal(manager.pending('codex'), undefined)
  } finally { await new Promise(resolve => blocker.close(resolve)) }
})

test('normal callback validates state, completes login and closes its listener', async () => {
  const manager = new OAuthFlowManager()
  const attempt = await manager.start('codex', spec)
  const code = attempt.waitCode()
  try {
    assert.equal(attempt.manualOnly, false)
    assert.equal((await fetch(callback(attempt, 'wrong-state'))).status, 400)
    assert.equal((await fetch(`${attempt.redirectUri}?error=access_denied&state=wrong-state`)).status, 400)
    assert.equal(manager.isBusy('codex'), true)
    assert.equal((await fetch(callback(attempt))).status, 200)
    assert.equal(await code, 'fixture-code')
    assert.equal(manager.isBusy('codex'), false)
    await assert.rejects(fetch(attempt.redirectUri))
  } finally { attempt.cancel(); await code.catch(() => {}) }
})

test('manual fallback still times out and releases the attempt', async t => {
  t.mock.method(Server.prototype, 'listen', function () {
    queueMicrotask(() => this.emit('error', Object.assign(new Error('blocked'), { code: 'EACCES' })))
    return this
  })
  const manager = new OAuthFlowManager()
  const attempt = await manager.start('codex', { ...spec, timeoutMs: 15 })
  await Promise.all([assert.rejects(attempt.waitCode(), /timed out/), delay(30)])
  assert.equal(manager.isBusy('codex'), false)
})

test('unexpected listener errors are not hidden by manual fallback', async t => {
  t.mock.method(Server.prototype, 'listen', function () {
    queueMicrotask(() => this.emit('error', Object.assign(new Error('resource limit'), { code: 'EMFILE' })))
    return this
  })
  await assert.rejects(new OAuthFlowManager().start('codex', spec), /resource limit/)
})

test('dynamic OAuth preserves registration fields and requires full state-bound manual callbacks', async () => {
  const manager = new OAuthFlowManager()
  const attempt = await manager.start('chatgpt', { ...spec, requireCompleteCallback: true,
    validateCallback(params) { if (params.get('client_id') !== 'oaiapp_fixture') throw new Error('missing client') },
  })
  const code = attempt.waitCode()
  try {
    assert.throws(() => attempt.manual('fixture-code'), /complete callback URL/)
    assert.throws(() => attempt.manual(callback(attempt)), /missing client/)
    assert.equal((await fetch(callback(attempt))).status, 400)
    assert.equal((await fetch(`${callback(attempt)}&client_id=oaiapp_fixture`)).status, 200)
    assert.equal(await code, 'fixture-code')
    assert.equal(attempt.callbackParams.get('client_id'), 'oaiapp_fixture')
    assert.ok(attempt.nonce.length >= 32)
    attempt.callbackParams.set('client_id', 'changed')
    assert.equal(attempt.callbackParams.get('client_id'), 'oaiapp_fixture')
  } finally { attempt.cancel(); await code.catch(() => {}) }
})

test('manual dynamic OAuth validates state before a declined consent can settle the flow', async () => {
  const manager = new OAuthFlowManager()
  const attempt = await manager.start('chatgpt', { ...spec, requireCompleteCallback: true })
  const code = attempt.waitCode()
  try {
    assert.throws(() => attempt.manual(`${attempt.redirectUri}?error=access_denied&state=wrong`), /state mismatch/)
    const rejected = assert.rejects(code, /access_denied/)
    attempt.manual(`${attempt.redirectUri}?error=access_denied&state=${attempt.state}`)
    await rejected
    assert.equal(manager.pending('chatgpt'), undefined)
  } finally { attempt.cancel(); await code.catch(() => {}) }
})
