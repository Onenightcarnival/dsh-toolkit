/**
 * Discovery beacon: a loopback-only HTTP listener on a well-known port.
 *
 * Contract
 *   GET /ext/bridge-config → 200 `{"wsUrl": "<bridge URL of this dsh instance>"}`
 *   anything else          → 404
 *   bind address           → 127.0.0.1 only
 *
 * Port selection
 *   candidates = port … port + DISCOVERY_PORT_WINDOW - 1, minus `skipPorts`
 *   the first free candidate wins; each dsh instance on the machine takes the next one
 *   whole window taken → no beacon, one warning, nothing thrown
 *
 * Serves hosts that run `dsh web --port 0` (DeepSeek Harness Desktop): the
 * extension probes this fixed window instead of the host's random port.
 *
 * @module @onenightcarnival/dsh-bridge-browser/src/discovery-beacon
 */

import { createServer, type Server } from 'node:http'
import { BRIDGE_CONFIG_PATH } from './protocol.ts'

/** Default beacon port; first entry of the extension's probe window. */
export const DEFAULT_DISCOVERY_PORT = 43189

/** Window size: the configured port plus the next `DISCOVERY_PORT_WINDOW - 1` ports. */
export const DISCOVERY_PORT_WINDOW = 4

/** Running beacon handle. */
export interface DiscoveryBeacon {
  /** Port actually bound: the configured port or a fallback inside the window. */
  readonly port: number
  /** Stop listening; settles once the socket is closed. */
  close(): Promise<void>
}

/** Beacon start options. */
export interface DiscoveryBeaconOptions {
  /** First candidate port. */
  port: number
  /** Excluded candidates; normally the host webserver port, which serves the route itself. */
  skipPorts?: readonly number[]
  /** Bridge WebSocket URL, resolved per request. */
  resolveWsUrl: () => string
  /** Diagnostics sink. */
  log?: { info(message: string): void; warn(message: string): void }
}

/** Candidate ports for one configured base port, in probe order. */
export function discoveryPortWindow(base: number, window: number = DISCOVERY_PORT_WINDOW): number[] {
  const ports: number[] = []
  for (let offset = 0; offset < window; offset++) {
    const port = base + offset
    if (port > 65535) break
    ports.push(port)
  }
  return ports
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Start the beacon on the first free candidate port.
 * @returns the running beacon, or undefined when the whole window is taken (warned, never thrown).
 */
export async function startDiscoveryBeacon(options: DiscoveryBeaconOptions): Promise<DiscoveryBeacon | undefined> {
  const skip = new Set(options.skipPorts ?? [])
  const candidates = discoveryPortWindow(options.port).filter(port => !skip.has(port))
  for (const port of candidates) {
    const server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0]
      if (req.method !== 'GET' || path !== BRIDGE_CONFIG_PATH) {
        res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
        res.end('not found')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ wsUrl: options.resolveWsUrl() }))
    })
    // Short keep-alive so close() settles promptly on HMR/unload.
    server.keepAliveTimeout = 1_000
    try {
      await listen(server, port)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EADDRINUSE' || code === 'EACCES') continue
      throw error
    }
    options.log?.info(`browser bridge: discovery beacon listening on http://127.0.0.1:${port}${BRIDGE_CONFIG_PATH}`)
    return {
      port,
      close: () => new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      }),
    }
  }
  options.log?.warn(
    `browser bridge: discovery beacon disabled — ports ${candidates.join(', ')} are all in use; `
    + 'the extension can still connect through its manual bridge address setting',
  )
  return undefined
}
