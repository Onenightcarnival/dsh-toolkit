import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { apply, assertPositiveInteger, Config, resolveConfig } from '../src/index.ts'

/** Minimal context stub: apply only needs the services at registration time. */
function stubContext(): Context {
  const gateway = {
    wireStream: {
      open: async (): Promise<AsyncIterable<unknown>> => ({
        async *[Symbol.asyncIterator]() { yield { type: 'ready', clientId: 'test', host: { home: '/tmp' } } },
      }),
      failure: (error: unknown) => ({ code: 'internal', message: String(error), details: {} }),
    },
    invoke: async () => undefined,
  }
  const connection = {
    createSharedFetchHandler: () => ({ fetch: async () => new Response('not found', { status: 404 }) }),
  }
  return {
    webServer: { port: 0, registerUpgrade: () => () => {}, register: () => () => {} },
    tools: { register: () => () => {} },
    agents: { get: () => undefined },
    get: (key: string) => key === 'typertGateway' ? gateway : key === 'connection' ? connection : undefined,
    on: () => () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn: () => unknown, label?: string) => {
      void label
      return fn() as () => void
    },
  } as unknown as Context
}

const dirs: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('assertPositiveInteger', () => {
  it('accepts positive integers and rejects everything else', () => {
    expect(() => assertPositiveInteger('x', 1)).not.toThrow()
    expect(() => assertPositiveInteger('x', 0)).toThrow(/must be a positive integer/)
    expect(() => assertPositiveInteger('x', -1)).toThrow(/must be a positive integer/)
    expect(() => assertPositiveInteger('x', 1.5)).toThrow(/must be a positive integer/)
  })
})

/** Valid budgets (the Loader applies schema defaults; hand-built tests pass them explicitly). */
const VALID = { toolTimeoutMs: 90_000, snapshotMaxChars: 200_000, maxInteractiveItems: 400, discoveryPort: 0 }

describe('config', () => {
  it('resolves defaults, including an enabled workspace under the dsh home', () => {
    expect(resolveConfig({})).toEqual({
      ...VALID,
      discoveryPort: 43189,
      sessionWorkspacePath: dshHomePath('browser-sessions'),
      deferSessionCreate: true,
    })
    expect(new Config().sessionWorkspacePath).toBe(dshHomePath('browser-sessions'))
    expect(new Config().discoveryPort).toBe(43189)
  })

  it('preserves explicit values and the empty-string workspace opt-out', () => {
    expect(resolveConfig({
      token: 'fixed',
      toolTimeoutMs: 1,
      snapshotMaxChars: 500,
      maxInteractiveItems: 3,
      sessionWorkspacePath: '',
      deferSessionCreate: false,
      discoveryPort: 0,
    })).toEqual({
      token: 'fixed',
      toolTimeoutMs: 1,
      snapshotMaxChars: 500,
      maxInteractiveItems: 3,
      sessionWorkspacePath: '',
      deferSessionCreate: false,
      discoveryPort: 0,
    })
    expect(new Config({ sessionWorkspacePath: '' }).sessionWorkspacePath).toBe('')
  })
})

describe('apply', () => {
  it('registers the bridge with a fixed token (no generation)', async () => {
    await apply(stubContext(), { token: 'fixed-token', ...VALID, sessionWorkspacePath: '' })
  })

  it.each([undefined, {}, { wireStream: {} }])('rejects unsupported Gateway capabilities: %j', async (gateway) => {
    const ctx = stubContext()
    const get = ctx.get.bind(ctx)
    vi.spyOn(ctx, 'get').mockImplementation((key) => key === 'typertGateway' ? gateway : get(key))
    const register = vi.spyOn(ctx.webServer, 'registerUpgrade')
    await expect(apply(ctx, { token: 'fixed-token', ...VALID })).rejects.toThrow(/dsh 0\.1\.7-rc\.2.*wireStream unavailable/)
    expect(register).not.toHaveBeenCalled()
  })

  it('leaves Remote event source ownership to the host composition', async () => {
    const ctx = stubContext()
    const gateway = ctx.get('typertGateway')
    const open = vi.spyOn(gateway.wireStream, 'open')

    await apply(ctx, { token: 'fixed-token', ...VALID, sessionWorkspacePath: '' })

    expect(open).not.toHaveBeenCalled()
  })

  it('generates and persists a token when none is configured', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-bridge-home-'))
    dirs.push(home)
    vi.stubEnv('DSH_HOME', home)
    await apply(stubContext(), VALID)
  })

  it('rejects invalid budgets loudly', async () => {
    await expect(apply(stubContext(), { ...VALID, toolTimeoutMs: 0 })).rejects.toThrow(/toolTimeoutMs/)
    await expect(apply(stubContext(), { ...VALID, snapshotMaxChars: -1 })).rejects.toThrow(/snapshotMaxChars/)
    await expect(apply(stubContext(), { ...VALID, snapshotMaxChars: 499 })).rejects.toThrow(/at least 500/)
    await expect(apply(stubContext(), { ...VALID, discoveryPort: 70000 })).rejects.toThrow(/discoveryPort/)
    await expect(apply(stubContext(), { ...VALID, discoveryPort: 1.5 })).rejects.toThrow(/discoveryPort/)
  })

  it('starts the discovery beacon on the configured port and closes it on dispose', async () => {
    const ctx = stubContext()
    const disposers: Array<() => unknown> = []
    ;(ctx as unknown as { effect: unknown }).effect = (fn: () => unknown) => {
      const dispose = fn() as () => unknown
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    }
    const probe = createServer()
    await new Promise<void>((resolve) => { probe.listen(0, '127.0.0.1', resolve) })
    const free = (probe.address() as { port: number }).port
    await new Promise<void>((resolve) => { probe.close(() => resolve()) })
    ;(ctx.webServer as { port: number }).port = 4321

    await apply(ctx, { token: 'fixed-token', ...VALID, sessionWorkspacePath: '', discoveryPort: free })
    // The beacon starts asynchronously inside its effect; poll until it answers.
    let body: { wsUrl?: string } | undefined
    for (let attempt = 0; attempt < 50 && body === undefined; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${free}/ext/bridge-config`)
        if (response.ok) body = await response.json() as { wsUrl?: string }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    expect(body?.wsUrl).toBe('ws://127.0.0.1:4321/ext/bridge')
    const missing = await fetch(`http://127.0.0.1:${free}/anything-else`)
    expect(missing.status).toBe(404)

    for (const dispose of disposers.reverse()) await dispose()
    await expect(fetch(`http://127.0.0.1:${free}/ext/bridge-config`)).rejects.toThrow()
  })
})
