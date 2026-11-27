/**
 * OAuth session store: ~/.dsh/plugins/subscriptions/auth.json.
 * Format: provider id → accounts map and default account key.
 * Writes use an atomic temporary-file rename with mode 0600.
 * This module defines the durable session types.
 *
 * Sections outside {@link PROVIDER_IDS} that hold credentials are discarded on
 * read and absent from the next write; other unowned sections are preserved.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Provider routes this plugin can serve. */
export type ProviderId = 'chatgpt'

/** Every provider route, in display order. */
export const PROVIDER_IDS: readonly ProviderId[] = ['chatgpt']

/** Sign in with ChatGPT credentials bound to one issued OAuth client. */
export interface ChatGptSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
  clientId: string
  subject: string
  hostId: string
  idToken: string
  emailAddress?: string
  scopes: string[]
}

/** One provider's accounts: account key → session, plus the default account. */
export interface ProviderAccounts<S> {
  /** Key of the account direct (non-pool) routes serve; the first login wins. */
  default?: string
  accounts: Record<string, S>
}

/** The durable store shape: per provider, its accounts. */
export interface SessionMap {
  /** Preserve unowned sections of an existing shared file without exposing them. */
  [section: string]: unknown
  chatgpt?: ProviderAccounts<ChatGptSession>
}

/** Any stored session, for provider-agnostic plumbing. */
export type StoredSession = ChatGptSession

/** The session type one provider stores. */
export type SessionOf<K extends ProviderId> = K extends 'chatgpt' ? ChatGptSession : never

/** One account entry as returned by {@link listAccounts} (default first). */
export interface AccountEntry<S> {
  key: string
  session: S
}

/**
 * The stable identity of one session's account: the OAuth client issued to
 * its registration. Logging the same account in again updates its entry.
 * @param provider - the provider route.
 * @param session - the session to key.
 * @returns the account map key.
 */
export function accountKeyOf(provider: ProviderId, session: StoredSession): string {
  switch (provider) {
    case 'chatgpt': return session.clientId
  }
}

/**
 * Absolute path of the auth store file.
 * @returns `dshHomePath('plugins', 'subscriptions', 'auth.json')`.
 */
export function authFilePath(): string {
  return dshHomePath('plugins', 'subscriptions', 'auth.json')
}

/** Check that one durable session carries the fields every session needs. */
function assertSessionShape(provider: ProviderId, account: string, value: unknown): asserts value is StoredSession {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`subscriptions auth store: entry "${provider}/${account}" is not an object; fix or delete the store file`)
  }
  const entry = value as Record<string, unknown>
  if (typeof entry.accessToken !== 'string' || entry.accessToken.length === 0
    || typeof entry.refreshToken !== 'string' || entry.refreshToken.length === 0
    || typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt)) {
    throw new Error(
      `subscriptions auth store: entry "${provider}/${account}" is missing accessToken/refreshToken/expiresAt; fix or delete the store file`,
    )
  }

}

/**
 * Read the credential store. Missing files return an empty map; invalid JSON
 * or top-level structure throws. Invalid account entries are skipped.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @returns the parsed session map.
 */
export async function loadStore(path = authFilePath()): Promise<SessionMap> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return {}
  }
  return parseStore(text, path)
}

/** Whether a section has the shape of stored credentials: a bare session or an accounts map. */
function holdsCredentials(section: unknown): boolean {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return false
  const record = section as Record<string, unknown>
  return typeof record.accessToken === 'string' || (typeof record.accounts === 'object' && record.accounts !== null)
}

/**
 * Parse credential JSON. Invalid account entries and credential sections
 * outside {@link PROVIDER_IDS} are skipped; the next write omits them.
 * Invalid JSON and non-object roots throw.
 */
function parseStore(text: string, path: string): SessionMap {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`subscriptions auth store at ${path} is not valid JSON; fix or delete the file`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`subscriptions auth store at ${path} must be a JSON object keyed by provider; fix or delete the file`)
  }
  const raw = parsed as Record<string, unknown>
  const store: SessionMap = Object.fromEntries(Object.entries(raw).filter(([section, value]) =>
    !(PROVIDER_IDS as readonly string[]).includes(section) && !holdsCredentials(value)))
  for (const provider of PROVIDER_IDS) {
    const entry = raw[provider]
    if (entry === undefined) continue
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      console.warn(`subscriptions auth store: entry "${provider}" is not an object; skipped`)
      continue
    }
    const record = entry as Record<string, unknown>
    const accounts = record.accounts
    if (typeof accounts !== 'object' || accounts === null || Array.isArray(accounts)) {
      console.warn(`subscriptions auth store: entry "${provider}" has no accounts map; skipped`)
      continue
    }
    if (record.default !== undefined && typeof record.default !== 'string') {
      console.warn(`subscriptions auth store: entry "${provider}" default is not a string; skipped`)
      continue
    }
    const kept: Record<string, StoredSession> = {}
    for (const [account, session] of Object.entries(accounts)) {
      if (isValidSessionShape(session)) {
        kept[account] = session as StoredSession
      } else {
        console.warn(
          `subscriptions auth store: entry "${provider}/${account}" has no usable accessToken/refreshToken/expiresAt; skipped`,
        )
      }
    }
    if (Object.keys(kept).length === 0) continue
    const validDefault = record.default === undefined || record.default in kept
      ? record.default
      : Object.keys(kept)[0]
    ;(store as Record<string, unknown>)[provider] = { ...record, default: validDefault, accounts: kept }
  }
  return store
}

/** Whether a value carries the fields every stored session needs (non-empty tokens). */
function isValidSessionShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.accessToken === 'string' && entry.accessToken.length > 0
    && typeof entry.refreshToken === 'string' && entry.refreshToken.length > 0
    && typeof entry.expiresAt === 'number' && Number.isFinite(entry.expiresAt)
}

/** Persist the whole store atomically with owner-only permissions. */
async function writeStore(store: SessionMap, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    await writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 })
    // The renamed file carries the temporary file's mode.
    await chmod(tmp, 0o600)
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/**
 * One write chain per store path serializes read-modify-write mutations.
 * A chain is dropped once nothing is queued behind it.
 */
const writeChains = new Map<string, Promise<unknown>>()

/**
 * Run one read-modify-write of a store path after every write already queued
 * for it. Callers join the chain synchronously, so call order is write order.
 * @param path - the store file being mutated.
 * @param action - the read-modify-write to run.
 * @returns whatever `action` returns.
 */
async function serialize<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(path) ?? Promise.resolve()
  // A failed write does not block the writes queued behind it.
  const next = previous.then(action, action)
  const tail = next.then(() => undefined, () => undefined)
  writeChains.set(path, tail)
  try {
    return await next
  } finally {
    if (writeChains.get(path) === tail) writeChains.delete(path)
  }
}

/**
 * List one provider's accounts, default first.
 * @param provider - the provider route.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @returns the account entries in stable order (empty when logged out).
 */
export async function listAccounts<K extends ProviderId>(
  provider: K,
  path = authFilePath(),
): Promise<AccountEntry<SessionOf<K>>[]> {
  const entry = (await loadStore(path))[provider]
  if (entry === undefined) return []
  const accounts = Object.entries(entry.accounts).map(([key, session]) => ({ key, session: session as SessionOf<K> }))
  accounts.sort((a, b) => Number(b.key === entry.default) - Number(a.key === entry.default))
  return accounts
}

/**
 * Read one account's session.
 * @param provider - the provider route.
 * @param account - the account key; defaults to the provider's default account.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @returns the stored session, or `undefined` when absent.
 */
export async function getAccountSession<K extends ProviderId>(
  provider: K,
  account?: string,
  path = authFilePath(),
): Promise<SessionOf<K> | undefined> {
  const entry = (await loadStore(path))[provider]
  if (entry === undefined) return undefined
  const key = account ?? entry.default
  if (key === undefined) return undefined
  return entry.accounts[key] as SessionOf<K> | undefined
}

/**
 * Validate and store one account session while preserving other accounts.
 * The first account for a provider becomes its default.
 * @param provider - the provider route.
 * @param account - the account key (see {@link accountKeyOf}).
 * @param session - the fresh session from a login or refresh.
 * @param path - store file path; defaults to {@link authFilePath}.
 * @throws when the session is missing accessToken/refreshToken/expiresAt.
 */
export async function saveAccountSession<K extends ProviderId>(
  provider: K,
  account: string,
  session: SessionOf<K>,
  path = authFilePath(),
): Promise<void> {
  assertSessionShape(provider, account, session)
  return serialize(path, async () => {
    const store = await loadStore(path)
    const entry = store[provider] as ProviderAccounts<SessionOf<K>> | undefined
    ;(store as Record<string, unknown>)[provider] = {
      ...entry,
      default: entry?.default ?? account,
      accounts: { ...entry?.accounts, [account]: session },
    } satisfies ProviderAccounts<SessionOf<K>>
    await writeStore(store, path)
  })
}

/**
 * Delete one account's session (logout). Deleting the default moves the badge
 * to the next remaining account.
 * @param provider - the provider route.
 * @param account - the account key.
 * @param path - store file path; defaults to {@link authFilePath}.
 */
export async function deleteAccountSession(
  provider: ProviderId,
  account: string,
  path = authFilePath(),
): Promise<void> {
  return serialize(path, async () => {
    const store = await loadStore(path)
    const entry = store[provider]
    if (entry === undefined) return
    if (!Object.hasOwn(entry.accounts, account)) return
    const accounts = { ...entry.accounts }
    delete accounts[account]
    if (Object.keys(accounts).length === 0) {
      delete store[provider]
    } else {
      ;(store as Record<string, unknown>)[provider] = {
        ...entry,
        ...entry.default === account ? { default: Object.keys(accounts)[0] } : { default: entry.default },
        accounts,
      }
    }
    await writeStore(store, path)
  })
}

/**
 * Pin the account direct (non-pool) routes serve.
 * @param provider - the provider route.
 * @param account - the account key; must exist.
 * @param path - store file path; defaults to {@link authFilePath}.
 */
export async function setDefaultAccount(
  provider: ProviderId,
  account: string,
  path = authFilePath(),
): Promise<void> {
  return serialize(path, async () => {
    const store = await loadStore(path)
    const entry = store[provider]
    if (entry === undefined || !Object.hasOwn(entry.accounts, account)) {
      throw new Error(`no ${provider} account "${account}" is logged in`)
    }
    ;(store as Record<string, unknown>)[provider] = { ...entry, default: account }
    await writeStore(store, path)
  })
}
