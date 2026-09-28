// Boots the actual DSH web host in isolated homes; no real subscription is used.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const require = createRequire(join(root, 'package.json'))
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-subscriptions-host-'))
try {
  for (const mode of ['standalone', 'toolkit', 'disabled']) {
    const bundle = mode !== 'standalone'
    const patch = join(temporary, `${mode}.yml`)
    const name = pathToFileURL(join(root, `packages/${bundle ? 'toolkit' : 'subscriptions'}/lib/index.js`)).href
    const config = bundle
      ? { rdb: false, s3: false, otel: false, browser: false, subscriptions: mode === 'disabled' ? false : { codexClientVersion: '0.153.4' } }
      : { codexClientVersion: '0.153.4' }
    await writeFile(patch, `- insert:\n    - id: subscriptions-smoke\n      name: ${JSON.stringify(name)}\n      config: ${JSON.stringify(config)}\n`)
    const child = spawn(process.execPath, [cli, 'web', '--patch', patch, '--no-open', '--port', '0'], {
      cwd: root, env: { ...process.env, DSH_HOME: join(temporary, mode), DSH_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let log = ''
    child.stdout.on('data', data => { log += data })
    child.stderr.on('data', data => { log += data })
    try {
      let url
      for (let i = 0; i < 600; i++) {
        url = log.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)/)?.[1]
        if (url) break
        if (child.exitCode !== null) throw new Error(`Host exited ${child.exitCode}: ${log}`)
        await delay(100)
      }
      assert.ok(url, `Host startup timed out: ${log}`)
      const base = new URL(url).origin
      const bootstrap = await fetch(url, { redirect: 'manual' })
      assert.equal(bootstrap.status, 303)
      const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0]
      assert.ok(cookie)
      const endpoint = `${base}/api/subscriptions-auth.status`
      assert.equal((await fetch(endpoint, { method: 'POST' })).status, 401, 'RPC must require browser authentication')
      const rpc = async (method, payload = {}) => {
        const response = await fetch(`${base}/api/subscriptions-auth.${method}`, {
          method: 'POST', headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: `subscriptions-auth.${method}`, payload }),
        })
        if (mode === 'disabled') return response
        assert.equal(response.status, 200, `RPC ${method}: ${await response.clone().text()}`)
        const { result } = await response.json()
        assert.equal(result.ok, true, JSON.stringify(result))
        return result.value
      }
      if (bundle) {
        const map = await (await fetch(`${base}/api/dsh-toolkit/modules`, { headers: { cookie } })).json()
        assert.equal(map.subscriptions, mode !== 'disabled')
      }
      if (mode === 'disabled') assert.equal((await rpc('status')).status, 404)
      else {
        assert.deepEqual((await rpc('status')).providers.codex.accounts, [])
        await rpc('setProviderSettings', { provider: 'codex', settings: { tools: { web_search: false, image_generate: false } } })
        assert.deepEqual((await rpc('providerSettings', { provider: 'codex' })).settings.tools, { web_search: false, image_generate: false })
      }
      console.log(`${mode}: real web host, authentication, RPC and module switch passed`)
    } finally {
      if (child.exitCode === null) { child.kill(); await once(child, 'exit') }
    }
  }
} finally { await rm(temporary, { recursive: true, force: true }) }
