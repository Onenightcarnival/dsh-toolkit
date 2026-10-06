/**
 * `@onenightcarnival/dsh-bridge-browser`: token-authenticated WebSocket bridge for
 * the browser extension plus the text-only `browser_*` tool set.
 *
 * The bridge mounts the `/ext/bridge` upgrade route on the host webserver,
 * outside the /api trust fence, with its own bearer-token authentication
 * (first frame `hello` within HELLO_TIMEOUT_MS). Extension calls, Session
 * streams and Host waterfalls use dsh 0.2.0's Typert Gateway and Connection
 * services. Tools dispatch `tool.call` frames to the connected extension,
 * which performs the action in the tab the user controls.
 *
 * Nothing is registered unless this plugin appears in the composition.
 *
 * @module @onenightcarnival/dsh-bridge-browser
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { BridgeServer } from './server.ts'
import { BrowserContextInjector } from './browser-context.ts'
import { registerBrowserTools } from './tools.ts'
import {
  BRIDGE_CONFIG_PATH,
  BRIDGE_PATH,
  DEFAULT_SNAPSHOT_MAX_CHARS,
  MIN_SNAPSHOT_MAX_CHARS,
} from './protocol.ts'
import { DEFAULT_DISCOVERY_PORT, startDiscoveryBeacon } from './discovery-beacon.ts'
import { withSessionDeferral } from './session-deferral.ts'
import { withSessionWorkspace } from './session-workspace.ts'
import type { SessionPurgeDeps } from './session-purge.ts'
import {
  DEFERRED_PURGE_FILE_NAME,
  DeferredPurgeStore,
  deleteSession,
  drainDeferredPurges,
  withDeferredPurgeFilter,
  type SessionDeleteOutcome,
} from './deferred-purge.ts'
import { resolveToken } from './token.ts'
import {
  createRemoteHostApi,
  type HostConnectionLike,
  type TypertGatewayLike,
} from './remote-host-api.ts'
import { isRecord, type BrowserHostApi } from './host-api.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'bridge-browser'

/** Services required by this plugin. */
export const inject = ['webServer', 'typertGateway', 'connection', 'tools', 'agents']

/** Default per-tool-call budget (ms). */
const DEFAULT_TOOL_TIMEOUT_MS = 90_000

/** Default cap on interactive inventory items per snapshot. */
const DEFAULT_MAX_INTERACTIVE_ITEMS = 400

/** Default directory backing the browser extension's session group. */
const DEFAULT_SESSION_WORKSPACE_PATH = dshHomePath('browser-sessions')

/** Durable session storage root written by the JSONL persistence plugin. */
const SESSIONS_ROOT = dshHomePath('sessions')

/** Default: sessions materialize only on the first message (open-and-close leaves no trace). */
const DEFAULT_DEFER_SESSION_CREATE = true

/** Plugin config: deployment-varying tunables only; the wire contract stays fixed. */
export interface Config {
  /** Fixed bearer token. When absent, a token is generated on first boot and persisted under the dsh home (0600). */
  token?: string
  /** Per-tool-call timeout in ms. Defaults to 90000. */
  toolTimeoutMs?: number
  /** Upper bound on one snapshot's rendered characters. Defaults to 200000; minimum 500. */
  snapshotMaxChars?: number
  /** Upper bound on interactive inventory items per snapshot. Defaults to 400. */
  maxInteractiveItems?: number
  /** Dedicated workspace path for extension-created sessions. Empty disables grouping. */
  sessionWorkspacePath?: string
  /** Defer real session creation until the first prompt. Defaults to true. */
  deferSessionCreate?: boolean
  /**
   * Discovery beacon port: loopback `/ext/bridge-config` for hosts on a random web port.
   * Defaults to 43189, falls back through the next three ports; 0 disables.
   */
  discoveryPort?: number
}

export const Config: z<Config> = z.object({
  token: z.string(),
  toolTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TOOL_TIMEOUT_MS),
  snapshotMaxChars: z.number().step(1).min(MIN_SNAPSHOT_MAX_CHARS).default(DEFAULT_SNAPSHOT_MAX_CHARS),
  maxInteractiveItems: z.number().step(1).min(1).default(DEFAULT_MAX_INTERACTIVE_ITEMS),
  sessionWorkspacePath: z.string().default(DEFAULT_SESSION_WORKSPACE_PATH),
  deferSessionCreate: z.boolean().default(DEFAULT_DEFER_SESSION_CREATE),
  discoveryPort: z.number().step(1).min(0).max(65535).default(DEFAULT_DISCOVERY_PORT),
})

/** The shape after schemastery applies its defaults to every field. */
type ResolvedConfig = Required<Omit<Config, 'token'>> & Pick<Config, 'token'>

/** Configured budgets must be positive integers. Exported for validation tests. */
export function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`bridge-browser: ${name} must be a positive integer`)
  }
}

/**
 * Apply defaults and direct-call validation at the plugin boundary.
 * @param config - Loader-resolved or directly supplied plugin configuration.
 * @returns a complete configuration ready for runtime use.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    ...(config.token === undefined ? {} : { token: config.token }),
    toolTimeoutMs: config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    snapshotMaxChars: config.snapshotMaxChars ?? DEFAULT_SNAPSHOT_MAX_CHARS,
    maxInteractiveItems: config.maxInteractiveItems ?? DEFAULT_MAX_INTERACTIVE_ITEMS,
    sessionWorkspacePath: config.sessionWorkspacePath ?? DEFAULT_SESSION_WORKSPACE_PATH,
    deferSessionCreate: config.deferSessionCreate ?? DEFAULT_DEFER_SESSION_CREATE,
    discoveryPort: config.discoveryPort ?? DEFAULT_DISCOVERY_PORT,
  }
  if (!Number.isInteger(resolved.discoveryPort) || resolved.discoveryPort < 0 || resolved.discoveryPort > 65535) {
    throw new Error('bridge-browser: discoveryPort must be an integer between 0 and 65535')
  }
  assertPositiveInteger('toolTimeoutMs', resolved.toolTimeoutMs)
  assertPositiveInteger('snapshotMaxChars', resolved.snapshotMaxChars)
  if (resolved.snapshotMaxChars < MIN_SNAPSHOT_MAX_CHARS) {
    throw new Error(`bridge-browser: snapshotMaxChars must be at least ${MIN_SNAPSHOT_MAX_CHARS}`)
  }
  assertPositiveInteger('maxInteractiveItems', resolved.maxInteractiveItems)
  return resolved
}

/**
 * Mount the bridge: resolve the token, register the upgrade route, the tool
 * set, and an optional system-prompt section, all effect-scoped for HMR.
 *
 * @param ctx - Cordis context.
 * @param config - plugin config (schema defaults applied).
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)

  const gateway = ctx.get('typertGateway') as unknown as GatewayCandidate | undefined
  const connection = ctx.get('connection') as unknown as HostConnectionLike | undefined
  if (gateway === undefined || !hasRemoteWireStream(gateway)) {
    throw new Error('bridge-browser: dsh 0.2.0-rc.2 or a compatible newer runtime is required (Gateway wireStream unavailable)')
  }
  if (connection === undefined) throw new Error('bridge-browser: dsh connection service is required')
  const tokenRes = await resolveToken(resolved.token)
  mountBridge(ctx, resolved, tokenRes, createRemoteHostApi(gateway, connection))
}

function mountBridge(
  ctx: Context,
  resolved: ResolvedConfig,
  tokenRes: Awaited<ReturnType<typeof resolveToken>>,
  hostApi: BrowserHostApi,
): void {
  // Layers, innermost first: workspace grouping, session deferral, deferred-purge
  // filter. Materialization at first prompt flows through grouping; sessions
  // awaiting purge are hidden from every listing.
  const pendingPurges = new DeferredPurgeStore(dshHomePath(DEFERRED_PURGE_FILE_NAME))
  const api = withDeferredPurgeFilter(withSessionDeferral(
    withSessionWorkspace(
      hostApi,
      resolved.sessionWorkspacePath,
      message => { ctx.logger.warn(message) },
    ),
    resolved.deferSessionCreate,
    ctx.get('attachments')?.imageLimits,
  ), pendingPurges)
  const browserContext = new BrowserContextInjector(ctx.agents)
  ctx.on('agent/created', ({ agent }) => {
    browserContext.activate(agent)
    return undefined
  })

  const purgeDeps = async (): Promise<SessionPurgeDeps> => {
    const runningSessionIds = new Set<string>()
    try {
      const listed = await api.call({
        rpcId: randomUUID(),
        method: 'session.list',
        payload: {},
        signal: new AbortController().signal,
      })
      if (listed.ok && isRecord(listed.value) && Array.isArray(listed.value.items)) {
        for (const entry of listed.value.items) {
          if (isRecord(entry) && entry.running === true && typeof entry.sessionId === 'string') {
            runningSessionIds.add(entry.sessionId)
          }
        }
      }
    } catch {
      // Listing is advisory; exclusive ownership below guards active, idle and
      // foreign-process sessions.
    }
    const deps: SessionPurgeDeps = {
      sessionsRoot: SESSIONS_ROOT,
      runningSessionIds,
      acquireOwnership: async (id) => {
        const persistence = ctx.get('sessionPersistence')
        if (persistence === undefined) {
          throw new Error('browser bridge: session persistence is required to safely purge a session')
        }
        return persistence.open(id as Parameters<typeof persistence.open>[0], 'write')
      },
      archiveSession: async (id) => {
        const archived = await api.call({
          rpcId: randomUUID(),
          method: 'workspace.archiveSession',
          payload: { sessionId: id },
          signal: new AbortController().signal,
        })
        if (!archived.ok) throw new Error(archived.error.message)
      },
    }
    return deps
  }
  const purgeSession = async (sessionId: string): Promise<SessionDeleteOutcome> => deleteSession({
    purge: await purgeDeps(),
    store: pendingPurges,
    isLive: (id) => ctx.agents.get(id as Parameters<typeof ctx.agents.get>[0]) !== undefined,
  }, sessionId)
  // Queued ids are purged at start; a failure defers the purge to the next start.
  void pendingPurges.load()
    .then(async () => {
      if (pendingPurges.list().length === 0) return
      // Session storage is touched only after the whole Loader tree is ready.
      await (ctx.get('loader') as { await?: () => Promise<unknown> } | undefined)?.await?.()
      await drainDeferredPurges({ purge: await purgeDeps(), store: pendingPurges }, {
        info: (m) => { ctx.logger.info(m) },
        warn: (m) => { ctx.logger.warn(m) },
      })
    })
    .catch((error: unknown) => { ctx.logger.warn(`browser bridge: deferred purge queue unavailable: ${String(error)}`) })

  const server = new BridgeServer({
    token: tokenRes.token,
    api,
    toolTimeoutMs: resolved.toolTimeoutMs,
    caps: {
      textOnly: true,
      snapshotMaxChars: resolved.snapshotMaxChars,
      maxInteractiveItems: resolved.maxInteractiveItems,
    },
    injectBrowserSnapshot: (sessionId, snapshot) => { browserContext.inject(sessionId, snapshot) },
    purgeSession,
  })

  const route: WebUpgradeRoute = {
    path: BRIDGE_PATH,
    handler: (req, socket, head) => { server.handleUpgrade(req, socket, head) },
  }
  ctx.effect(() => ctx.webServer.registerUpgrade(route), 'bridge-browser: /ext/bridge upgrade route')
  // Async disposer: unload waits for the bridge to close fully (sockets, pumps, acceptor).
  ctx.effect(() => () => server.close(), 'bridge-browser: bridge server')

  // /ext/bridge-config on the host port: the extension's zero-config discovery route.
  // The URL carries no secret; remote clients still present the token on the WS itself.
  const configRoute: WebRoute = {
    kind: 'exact',
    path: BRIDGE_CONFIG_PATH,
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${ctx.webServer.port}${BRIDGE_PATH}` }))
    },
  }
  ctx.effect(() => ctx.webServer.register(configRoute), 'bridge-browser: /ext/bridge-config route')

  // Same payload on the fixed-port beacon, for hosts whose web port is random
  // (`dsh web --port 0`). The host port is skipped: the route above serves it.
  if (resolved.discoveryPort > 0) {
    ctx.effect(() => {
      const beacon = startDiscoveryBeacon({
        port: resolved.discoveryPort,
        skipPorts: [ctx.webServer.port],
        resolveWsUrl: () => `ws://127.0.0.1:${ctx.webServer.port}${BRIDGE_PATH}`,
        log: { info: (m) => { ctx.logger.info(m) }, warn: (m) => { ctx.logger.warn(m) } },
      }).catch((error: unknown) => {
        ctx.logger.warn(`browser bridge: discovery beacon failed to start: ${String(error)}`)
        return undefined
      })
      return async () => { await (await beacon)?.close() }
    }, 'bridge-browser: discovery beacon')
  }

  ctx.effect(() => {
    const disposers = registerBrowserTools(ctx, server, {
      toolTimeoutMs: resolved.toolTimeoutMs,
      snapshotMaxChars: resolved.snapshotMaxChars,
      maxInteractiveItems: resolved.maxInteractiveItems,
    })
    return () => { for (const dispose of disposers.values()) dispose() }
  }, 'bridge-browser: browser tools')

  // Optional system-prompt section describing snapshot and tool usage.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'tool:bridge-browser',
      order: 107,
      text: 'A browser bridge may be connected to the user\'s own Chrome. To read or operate the page, start with browser_snapshot '
        + '(numbered items are the targets for click/type/form_input) unless the current turn already includes a plugin-provided '
        + 'followed-page browser_snapshot; reuse that snapshot and its indices directly. Use browser_find to locate specific elements on '
        + 'large pages, browser_screenshot when layout, images, charts, or canvases matter (labels on the image are snapshot indices), '
        + 'browser_form_input to fill several fields at once, and browser_wait_for after actions that load content asynchronously. '
        + 'Never assume page content you have not read.',
    }), 'bridge-browser: system prompt section')
  }

  ctx.logger.info(
    tokenRes.generated
      ? `browser bridge: new token generated and persisted at ${tokenRes.file} (chmod 0600); connect the extension and paste it in its settings`
      : `browser bridge: using token from ${tokenRes.file}`,
  )
  ctx.logger.info(`browser bridge: listening on ${BRIDGE_PATH}`)
}

type GatewayCandidate = Pick<TypertGatewayLike, 'invoke'> & {
  readonly wireStream?: TypertGatewayLike['wireStream']
}

/** Check the minimum supported Gateway contract before mounting the bridge. */
function hasRemoteWireStream(gateway: GatewayCandidate): gateway is TypertGatewayLike {
  return gateway.wireStream !== undefined
    && typeof gateway.wireStream.open === 'function'
    && typeof gateway.wireStream.failure === 'function'
}
