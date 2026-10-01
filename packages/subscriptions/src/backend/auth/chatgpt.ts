import { setTimeout as delay } from 'node:timers/promises'
import { withChatGptLock } from './chatgpt-lock.js'
import { createPublicKey, randomUUID, verify, type JsonWebKey } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { proxiedFetch } from '../http.js'
import { OAuthEndpointError, oauthEndpointError, type FetchFn } from '../providers/common.js'
import type { FlowSpec, OAuthAttempt } from './oauth-flow.js'
import type { ChatGptSession } from './store.js'

export const CHATGPT_RESOURCE = 'https://api.openai.com/v1'
export const CHATGPT_AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize'
export const CHATGPT_TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token'
export const CHATGPT_SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const ISSUER = 'https://auth.openai.com'
const DIRECT_SCOPE = 'chatgpt.tokens.use.direct'

/** Registration survives sign-out and terminal refresh failures. No bearer credentials. */
export interface ChatGptRegistration {
  clientId: string
  hostId: string
  subject?: string
  emailAddress?: string
  planEnabled?: boolean
}
interface Registrations { hostId: string; accounts: Record<string, ChatGptRegistration> }
const registryPath = () => dshHomePath('plugins', 'subscriptions', 'chatgpt-registrations.json')
let writes: Promise<unknown> = Promise.resolve()

export async function readChatGptRegistrations(path = registryPath()): Promise<Registrations> {
  try {
    const data = JSON.parse(await readFile(path, 'utf8')) as Registrations
    if (!/^urn:uuid:[0-9a-f-]{36}$/i.test(data.hostId) || !data.accounts || typeof data.accounts !== 'object' || Array.isArray(data.accounts)) throw new Error('Invalid ChatGPT registration store')
    for (const [key, entry] of Object.entries(data.accounts)) {
      if (!entry || key !== entry.clientId || !validClientId(key) || entry.hostId !== data.hostId) throw new Error('Invalid ChatGPT registration')
    }
    return data
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { hostId: `urn:uuid:${randomUUID()}`, accounts: {} }
  }
}

async function updateRegistry(update: (data: Registrations) => void, path = registryPath()): Promise<Registrations> {
  const run = writes.then(() => withChatGptLock('registrations', async () => {
    const data = await readChatGptRegistrations(path)
    update(data)
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 })
      await rename(temporary, path)
    } finally { await rm(temporary, { force: true }) }
    return data
  }))
  writes = run.catch(() => {})
  return run
}

export async function prepareChatGptRegistration(clientId?: string): Promise<ChatGptRegistration> {
  const data = await updateRegistry(() => {})
  if (clientId !== undefined) {
    if (!Object.hasOwn(data.accounts, clientId)) throw new Error('ChatGPT registration is unavailable')
    return data.accounts[clientId]
  }
  return { hostId: data.hostId, clientId: 'dynamic_agent_client' }
}

function validClientId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && /^[a-zA-Z0-9_.~-]+$/.test(value)
    && value !== 'dynamic_agent_client' && !Object.hasOwn(Object.prototype, value)
}

export function chatGptFlow(registration: ChatGptRegistration, idTokenHint?: string): FlowSpec {
  const initial = registration.clientId === 'dynamic_agent_client'
  return {
    callbackPath: '/auth/callback', listen: { host: '127.0.0.1', ports: [1455, 1457, 0] },
    manualRedirectUri: 'http://127.0.0.1:1455/auth/callback', requireCompleteCallback: true,
    buildAuthorizeUrl({ redirectUri, state, nonce, pkce }) {
      const params = new URLSearchParams({
        client_id: registration.clientId, ext_agent_host_id: registration.hostId,
        response_type: 'code', redirect_uri: redirectUri, state, nonce,
        scope: CHATGPT_SCOPE, resource: CHATGPT_RESOURCE,
        code_challenge: pkce.challenge, code_challenge_method: 'S256',
      })
      if (initial) params.set('agent_name_hint', 'DeepSeek Harness Toolkit')
      else {
        if (idTokenHint) params.set('id_token_hint', idTokenHint)
        if (registration.emailAddress) params.set('login_hint', registration.emailAddress)
        if (registration.planEnabled === false) params.set('prompt', 'consent')
      }
      return `${CHATGPT_AUTHORIZE_URL}?${params}`
    },
    validateCallback(params) {
      const returned = params.get('client_id')
      if (initial ? !validClientId(returned) : returned !== null && returned !== registration.clientId) {
        throw new Error('ChatGPT callback has a missing or mismatched client ID')
      }
    },
  }
}

/** Verify identity with OpenAI's signing keys; JWT payloads alone confer no identity. */
export async function validateChatGptIdentity(token: string, clientId: string, nonce: string | undefined, fetchFn: FetchFn = proxiedFetch): Promise<{ subject: string; emailAddress?: string }> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid ChatGPT ID token')
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString())
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Unsupported ChatGPT ID token signature')
  const response = await fetchFn(`${ISSUER}/.well-known/jwks.json`, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`ChatGPT signing keys unavailable (HTTP ${response.status})`)
  const jwks = await response.json() as { keys?: (JsonWebKey & { kid?: string; use?: string; alg?: string })[] }
  const key = jwks.keys?.find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'))
  if (!key || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new Error('Invalid ChatGPT ID token signature')
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  const now = Date.now() / 1000
  if (payload.iss !== ISSUER || !audiences.includes(clientId)
    || (audiences.length > 1 && payload.azp !== clientId) || (payload.azp !== undefined && payload.azp !== clientId)
    || typeof payload.exp !== 'number' || payload.exp <= now
    || (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf > now))
    || (nonce !== undefined && payload.nonce !== nonce)
    || typeof payload.sub !== 'string' || !payload.sub) throw new Error('ChatGPT ID token claims did not match this login')
  return { subject: payload.sub, ...(typeof payload.email === 'string' ? { emailAddress: payload.email } : {}) }
}

interface TokenResponse { access_token?: string; refresh_token?: string; id_token?: string; token_type?: string; expires_in?: number; scope?: string }
async function tokenRequest(params: Record<string, string>, fetchFn: FetchFn): Promise<TokenResponse> {
  const response = await fetchFn(CHATGPT_TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, resource: CHATGPT_RESOURCE }), signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw await oauthEndpointError(response, 'ChatGPT')
  const body = await response.json() as TokenResponse
  if (!body.access_token || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.token_type?.toLowerCase() !== 'bearer') throw new Error('Invalid ChatGPT token response')
  return body
}

export class ChatGptPlanNotEnabledError extends Error {
  constructor(readonly clientId: string) { super('ChatGPT plan usage was not enabled. Continue with ChatGPT to grant access.') }
}

export const chatGptPlanEnabled = (session: Pick<ChatGptSession, 'scopes'>): boolean => session.scopes.includes(DIRECT_SCOPE)

export async function exchangeChatGptCode(code: string, attempt: OAuthAttempt, registration: ChatGptRegistration, fetchFn: FetchFn = proxiedFetch): Promise<ChatGptSession> {
  const clientId = attempt.callbackParams.get('client_id') ?? registration.clientId
  if (!validClientId(clientId) || (registration.clientId !== 'dynamic_agent_client' && registration.clientId !== clientId)) throw new Error('Invalid ChatGPT registration callback')
  const issued = { ...registration, clientId }
  await updateRegistry(data => { data.accounts[clientId] = issued })
  const body = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.pkce.verifier, redirect_uri: attempt.redirectUri }, fetchFn)
  if (!body.id_token) throw new Error('ChatGPT did not return an ID token')
  const identity = await validateChatGptIdentity(body.id_token, clientId, attempt.nonce, fetchFn)
  if (registration.subject && registration.subject !== identity.subject) throw new Error('ChatGPT identity changed during reauthorization')
  const scopes = typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : []
  await updateRegistry(data => { data.accounts[clientId] = { ...issued, ...identity, planEnabled: scopes.includes(DIRECT_SCOPE) } })
  // Identity-only grants retain their verified registration for explicit reauthorization.
  if (!scopes.includes(DIRECT_SCOPE)) throw new ChatGptPlanNotEnabledError(clientId)
  if (!body.refresh_token) throw new Error('ChatGPT did not grant offline access. Sign in again.')
  return { ...issued, ...identity, scopes, accessToken: body.access_token!, refreshToken: body.refresh_token,
    idToken: body.id_token, expiresAt: Date.now() + body.expires_in! * 1000 }
}

export async function refreshChatGpt(session: ChatGptSession, fetchFn: FetchFn = proxiedFetch): Promise<ChatGptSession> {
  const body = await tokenRequest({ grant_type: 'refresh_token', client_id: session.clientId, refresh_token: session.refreshToken }, fetchFn)
  if (!body.refresh_token) throw new Error('ChatGPT refresh returned no replacement refresh token')
  if (body.id_token) {
    const identity = await validateChatGptIdentity(body.id_token, session.clientId, undefined, fetchFn)
    if (identity.subject !== session.subject) throw new Error('ChatGPT identity changed during refresh')
  }
  return { ...session, accessToken: body.access_token!, refreshToken: body.refresh_token,
    idToken: body.id_token ?? session.idToken, expiresAt: Date.now() + body.expires_in! * 1000,
    scopes: body.scope === undefined ? session.scopes : body.scope.split(/\s+/).filter(Boolean) }
}

export function isChatGptPermanentRefreshError(error: unknown): boolean {
  return error instanceof OAuthEndpointError && ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(error.oauthCode ?? '')
}

/** Revoke the renewable session at the issuer's discovered endpoint. */
export async function revokeChatGpt(session: ChatGptSession, fetchFn: FetchFn = proxiedFetch): Promise<void> {
  const discovery = await fetchFn(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) })
  if (!discovery.ok) throw new Error('ChatGPT revocation discovery failed')
  const config = await discovery.json() as { issuer?: string; revocation_endpoint?: string }
  const url = new URL(config.revocation_endpoint ?? '')
  if (config.issuer !== ISSUER || url.origin !== ISSUER || url.username || url.password) throw new Error('Invalid ChatGPT revocation endpoint')
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetchFn(url.href, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: session.refreshToken, token_type_hint: 'refresh_token', client_id: session.clientId }), signal: AbortSignal.timeout(5_000) })
      if (response.ok) return
      if (response.status < 500 || attempt >= 2) throw new OAuthEndpointError('ChatGPT revocation was not confirmed', response.status)
    } catch (error) { if (error instanceof OAuthEndpointError || attempt >= 2) throw error }
    await delay(250 * 2 ** attempt)
  }
}
