import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { discoveryPortWindow, startDiscoveryBeacon } from '../src/discovery-beacon.ts'

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => { probe.listen(0, '127.0.0.1', resolve) })
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((resolve) => { probe.close(() => resolve()) })
  return port
}

describe('discovery beacon', () => {
  it('computes a contiguous port window clipped at 65535', () => {
    expect(discoveryPortWindow(43189)).toEqual([43189, 43190, 43191, 43192])
    expect(discoveryPortWindow(65534)).toEqual([65534, 65535])
    expect(discoveryPortWindow(100, 1)).toEqual([100])
  })

  it('answers /ext/bridge-config only, on 127.0.0.1, with the resolved ws URL', async () => {
    const port = await freePort()
    const beacon = await startDiscoveryBeacon({ port, resolveWsUrl: () => 'ws://127.0.0.1:5555/ext/bridge' })
    expect(beacon?.port).toBe(port)
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/ext/bridge-config?x=1`)
      expect(ok.status).toBe(200)
      expect(ok.headers.get('cache-control')).toBe('no-store')
      expect(await ok.json()).toEqual({ wsUrl: 'ws://127.0.0.1:5555/ext/bridge' })
      expect((await fetch(`http://127.0.0.1:${port}/ext/bridge`)).status).toBe(404)
      expect((await fetch(`http://127.0.0.1:${port}/ext/bridge-config`, { method: 'POST' })).status).toBe(404)
    } finally {
      await beacon?.close()
    }
    await expect(fetch(`http://127.0.0.1:${port}/ext/bridge-config`)).rejects.toThrow()
  })

  it('falls back to the next port in the window when the first is taken, and skips excluded ports', async () => {
    const base = await freePort()
    const blocker = createServer()
    await new Promise<void>((resolve) => { blocker.listen(base, '127.0.0.1', resolve) })
    const warnings: string[] = []
    try {
      const beacon = await startDiscoveryBeacon({
        port: base,
        skipPorts: [base + 1],
        resolveWsUrl: () => 'ws://127.0.0.1:1/ext/bridge',
        log: { info: () => {}, warn: (m) => { warnings.push(m) } },
      })
      expect(beacon).toBeDefined()
      expect(beacon?.port).toBeGreaterThanOrEqual(base + 2)
      expect(beacon?.port).toBeLessThanOrEqual(base + 3)
      await beacon?.close()
      expect(warnings).toEqual([])
    } finally {
      await new Promise<void>((resolve) => { blocker.close(() => resolve()) })
    }
  })

  it('reports (not throws) when the whole window is unavailable', async () => {
    const base = await freePort()
    const warnings: string[] = []
    const beacon = await startDiscoveryBeacon({
      port: base,
      skipPorts: [base, base + 1, base + 2, base + 3],
      resolveWsUrl: () => 'ws://127.0.0.1:1/ext/bridge',
      log: { info: () => {}, warn: (m) => { warnings.push(m) } },
    })
    expect(beacon).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/discovery beacon disabled/)
  })
})
