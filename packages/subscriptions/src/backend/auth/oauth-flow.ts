/**
 * Generic OAuth authorization-code flow engine: one temporary loopback HTTP
 * server per login attempt receives the provider's redirect, validates
 * `state`, and yields the authorization `code`. A pasted callback URL or bare
 * code can substitute for the browser redirect (`manual`), and the user can
 * abort (`cancel`). At most one attempt per provider runs at a time.
 */

import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createPkce, randomHex, randomToken, type PkcePair } from './pkce.js'

/** Default attempt lifetime: three minutes for the user to complete login. */
export const DEFAULT_FLOW_TIMEOUT_MS = 180_000

/** Where the temporary callback server listens; port 0 asks the OS for an ephemeral port. */
export interface ListenSpec {
  host: string
  /** Tried in order; the first free port wins. */
  ports: readonly number[]
}

/** Inputs an authorize-URL builder may need for one attempt. */
export interface AuthorizeInput {
  /** Loopback redirect URI pointing at the temporary server. */
  redirectUri: string
  state: string
  pkce: PkcePair
  /** Random hex nonce; only providers that require one use it. */
  nonce: string
}

/** Static per-provider flow facts. */
export interface FlowSpec {
  /** Path the provider redirects to on the loopback server. */
  callbackPath: string
  listen: ListenSpec
  /** Registered redirect URI to use with pasted callbacks if loopback ports are blocked. */
  manualRedirectUri?: string
  timeoutMs?: number
  /** Require the full state-validated callback, including registration fields. */
  requireCompleteCallback?: boolean
  validateCallback?(params: URLSearchParams): void
  /**
   * Build the provider authorize URL for one attempt.
   * @param input - redirect URI, state, PKCE pair, and nonce minted for this attempt.
   * @returns the URL the user's browser should open.
   */
  buildAuthorizeUrl(input: AuthorizeInput): string
}

/** One in-flight login attempt. */
export interface OAuthAttempt {
  /** URL to open in the user's browser. */
  readonly authorizeUrl: string
  /** Redirect URI registered for this attempt (echoed at the token exchange). */
  readonly redirectUri: string
  readonly manualOnly: boolean
  /** PKCE pair minted for this attempt. */
  readonly pkce: PkcePair
  /** State parameter minted for this attempt (some providers echo it at exchange). */
  readonly state: string
  readonly nonce: string
  readonly callbackParams: URLSearchParams
  /**
   * Wait for the authorization code from the browser callback or `manual`.
   * @returns the authorization code; rejects on timeout, provider error, or cancel.
   */
  waitCode(): Promise<string>
  /**
   * Feed a pasted full callback URL (code + state extracted and validated) or
   * a bare authorization code (state cannot be checked) into this attempt.
   * @param input - the pasted text.
   * @throws when the input carries no code or a mismatched state.
   */
  manual(input: string): void
  /** Abort the attempt and close its callback server. */
  cancel(): void
}

const SUCCESS_PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>Login successful</title></head>'
  + '<body style="font-family:sans-serif"><h1>Login successful</h1>'
  + '<p>You can close this tab and return to DeepSeek Harness.</p></body></html>'

function failurePage(detail: string): string {
  return '<!doctype html><html><head><meta charset="utf-8"><title>Login failed</title></head>'
    + `<body style="font-family:sans-serif"><h1>Login failed</h1><p>${detail.replace(/[<>&]/g, '')}</p></body></html>`
}

/** Loopback addresses one listen host covers: `localhost` serves both 127.0.0.1 and ::1. */
function listenHosts(host: string): readonly string[] {
  return host === 'localhost' ? ['127.0.0.1', '::1'] : [host]
}

/** One bound callback port: every server answers the same handler on the same port. */
interface BoundServers {
  servers: Server[]
  port: number
}

/** True when the address family does not exist on this machine (safe to skip), unlike a taken port. */
function familyUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EADDRNOTAVAIL' || code === 'EPROTONOSUPPORT'
}

/**
 * Listen on the first port of the spec free on every loopback family;
 * rejects when every port fails. Ephemeral ports (0) are retried so each
 * family can be re-bound onto the first family's assigned port.
 */
async function listen(handler: RequestListener, spec: ListenSpec): Promise<BoundServers> {
  const hosts = listenHosts(spec.host)
  const candidates = spec.ports.flatMap(port => (port === 0 ? [0, 0, 0] : [port]))
  let lastError: unknown
  for (const candidate of candidates) {
    const servers: Server[] = []
    let port = candidate
    let unusable = false
    for (const host of hosts) {
      const server = createServer(handler)
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => reject(error)
          server.once('error', onError)
          server.listen(port, host, () => {
            server.removeListener('error', onError)
            resolve()
          })
        })
        const address = server.address() as AddressInfo | null
        if (address === null) throw new Error(`callback server on ${host}:${port} has no address`)
        if (port === 0) port = address.port
        servers.push(server)
      } catch (error) {
        server.close()
        if (familyUnavailable(error)) continue
        lastError = error
        unusable = true
        break
      }
    }
    if (unusable || servers.length === 0) {
      for (const server of servers) server.close()
      continue
    }
    return { servers, port }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`callback server could not listen on ${spec.host} (ports ${spec.ports.join(', ')})`)
}

/**
 * Own the set of in-flight login attempts, keyed by provider. One attempt per
 * provider at a time; an attempt removes itself when it settles.
 */
export class OAuthFlowManager {
  private attempts = new Map<string, OAuthAttempt>()

  /**
   * Whether a login attempt is running for one provider.
   * @param provider - the provider route.
   * @returns true while an attempt is waiting for its code.
   */
  isBusy(provider: string): boolean {
    return this.attempts.has(provider)
  }

  /**
   * The pending attempt for one provider, when any.
   * @param provider - the provider route.
   * @returns the in-flight attempt, or `undefined`.
   */
  pending(provider: string): OAuthAttempt | undefined {
    return this.attempts.get(provider)
  }

  /**
   * Start a login attempt: mint PKCE/state, open the loopback callback
   * server, and build the authorize URL.
   * @param provider - the provider route (one attempt at a time).
   * @param spec - static flow facts for this provider.
   * @returns the live attempt; its `waitCode()` settles the login.
   * @throws when an attempt is already running or no callback port is free.
   */
  async start(provider: string, spec: FlowSpec): Promise<OAuthAttempt> {
    if (this.attempts.has(provider)) {
      throw new Error(`a ${provider} login attempt is already in progress`)
    }
    const input: AuthorizeInput = {
      redirectUri: '',
      state: randomToken(32),
      pkce: createPkce(),
      nonce: randomHex(32),
    }
    const timeoutMs = spec.timeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS

    let resolveCode!: (code: string) => void
    let rejectCode!: (error: Error) => void
    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve
      rejectCode = reject
    })

    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let servers: Server[] = []
    let callbackParams = new URLSearchParams()
    const handler: RequestListener = (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname !== spec.callbackPath) {
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end('not found')
        return
      }
      if (url.searchParams.get('state') !== input.state) {
        response.writeHead(400, { 'content-type': 'text/plain' })
        response.end('state mismatch')
        return
      }
      const errorDescription = url.searchParams.get('error_description') ?? url.searchParams.get('error')
      if (errorDescription !== null) {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end(failurePage(errorDescription))
        settle(new Error(`authorization failed: ${errorDescription}`))
        return
      }
      const code = url.searchParams.get('code')
      if (code === null || code.length === 0) {
        response.writeHead(400, { 'content-type': 'text/plain' })
        response.end('missing authorization code')
        return
      }
      try { spec.validateCallback?.(url.searchParams) } catch (error) {
        response.writeHead(400, { 'content-type': 'text/plain' })
        response.end(error instanceof Error ? error.message : 'invalid callback')
        return
      }
      callbackParams = new URLSearchParams(url.searchParams)
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(SUCCESS_PAGE)
      settle(undefined, code)
    }

    const settle = (error?: Error, code?: string): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      for (const server of servers) {
        server.close()
        server.closeAllConnections()
      }
      this.attempts.delete(provider)
      if (error !== undefined) rejectCode(error)
      else if (code !== undefined) resolveCode(code)
    }

    let manualOnly = false
    try {
      const bound = await listen(handler, spec.listen)
      servers = bound.servers
      input.redirectUri = `http://${spec.listen.host}:${bound.port}${spec.callbackPath}`
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!spec.manualRedirectUri || !['EACCES', 'EPERM', 'EADDRINUSE'].includes(code ?? '')) throw error
      // Manual mode uses the registered redirect URI; the browser URL is pasted after login.
      input.redirectUri = spec.manualRedirectUri
      manualOnly = true
    }

    timer = setTimeout(() => {
      settle(new Error(`login timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    timer.unref()

    const attempt: OAuthAttempt = {
      authorizeUrl: spec.buildAuthorizeUrl(input),
      redirectUri: input.redirectUri,
      manualOnly,
      pkce: input.pkce,
      state: input.state,
      nonce: input.nonce,
      get callbackParams() { return new URLSearchParams(callbackParams) },
      waitCode: () => codePromise,
      manual(rawInput: string) {
        if (settled) throw new Error(`the ${provider} login attempt already finished`)
        const trimmed = rawInput.trim()
        let code: string | undefined
        let pastedState: string | undefined
        let params = new URLSearchParams()
        if (spec.requireCompleteCallback && !/^https?:\/\//i.test(trimmed)) {
          throw new Error('paste the complete callback URL including its state parameter')
        }
        if (/^https?:\/\//i.test(trimmed)) {
          const url = new URL(trimmed)
          const expected = new URL(input.redirectUri)
          if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
            throw new Error('the pasted URL is not the expected login callback')
          }
          code = url.searchParams.get('code') ?? undefined
          pastedState = url.searchParams.get('state') ?? undefined
          if (pastedState !== input.state) throw new Error('state mismatch: paste the complete callback URL from this login attempt')
          params = url.searchParams
          if (params.has('error')) {
            settle(new Error(`authorization failed: ${params.get('error_description') ?? params.get('error')}`))
            return
          }
        } else if (trimmed.includes('code=')) {
          params = new URLSearchParams(trimmed)
          code = params.get('code') ?? undefined
          pastedState = params.get('state') ?? undefined
        } else if (trimmed.length > 0 && !/\s/.test(trimmed)) {
          code = trimmed
        }
        if (manualOnly && pastedState !== input.state) {
          throw new Error('paste the complete callback URL including its state parameter')
        }
        if (code === undefined || code.length === 0) {
          throw new Error('no authorization code found in the pasted input')
        }
        if (pastedState !== undefined && pastedState !== input.state) {
          throw new Error('state mismatch: the pasted URL belongs to a different login attempt')
        }
        spec.validateCallback?.(params)
        callbackParams = new URLSearchParams(params)
        settle(undefined, code)
      },
      cancel() {
        settle(new Error('login cancelled'))
      },
    }
    this.attempts.set(provider, attempt)
    return attempt
  }
}
