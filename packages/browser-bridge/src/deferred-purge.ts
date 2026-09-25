/**
 * Deletion of sessions whose durable log is still held open by this runtime.
 *
 * The Web gateway resumes a session into a live Agent on first use and never
 * disposes it, so every session the panel has chatted in stays "owned by a
 * runtime" for the rest of the process. `purgeSessionFiles` then fails with
 * `running` even though nothing is executing. There is no gateway method to
 * release an Agent, so deletion of such a session is split in two: it is
 * archived now (it leaves every session list immediately and runs no further
 * model steps) and its id is queued in a small JSON file under the dsh home;
 * the next bridge start, when no Agent holds the log, purges the files.
 *
 * @module @onenightcarnival/dsh-bridge-browser/src/deferred-purge
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BrowserHostApi, HostRpcCall, HostRpcResult } from './host-api.ts'
import { isRecord } from './host-api.ts'
import { assertPurgeableSessionId, purgeSessionFiles, SessionPurgeError, type SessionPurgeDeps } from './session-purge.ts'

/** File name under the dsh home holding the ids awaiting purge. */
export const DEFERRED_PURGE_FILE_NAME = 'ext-bridge-pending-purge.json'

/** Outcome of one panel-initiated deletion. */
export type SessionDeleteOutcome = 'purged' | 'deferred'

/** Diagnostics sink. */
export interface DeferredPurgeLog {
  info(message: string): void
  warn(message: string): void
}

/** Durable set of session ids whose file purge is pending. */
export class DeferredPurgeStore {
  private readonly ids = new Set<string>()

  /** @param file - JSON file holding `{ "sessionIds": [...] }`. */
  constructor(private readonly file: string) {}

  /** Read the file; a missing or malformed file yields an empty set. */
  async load(): Promise<void> {
    this.ids.clear()
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.sessionIds)) return
    for (const id of parsed.sessionIds) {
      if (typeof id !== 'string') continue
      try {
        this.ids.add(assertPurgeableSessionId(id))
      } catch {
        // Ignore ids that could never name a durable session.
      }
    }
  }

  has(sessionId: string): boolean {
    return this.ids.has(sessionId)
  }

  list(): string[] {
    return [...this.ids]
  }

  async add(sessionId: string): Promise<void> {
    if (this.ids.has(sessionId)) return
    this.ids.add(sessionId)
    await this.persist()
  }

  async remove(sessionId: string): Promise<void> {
    if (!this.ids.delete(sessionId)) return
    await this.persist()
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify({ sessionIds: [...this.ids] }, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, this.file)
  }
}

/** What deletion needs beyond the file purge itself. */
export interface SessionDeleteDeps {
  purge: SessionPurgeDeps
  store: DeferredPurgeStore
  /** Whether this runtime holds a live Agent (idle or not) for the id. */
  isLive(sessionId: string): boolean
}

/**
 * Delete one session now, or archive it and defer the file purge when this
 * runtime's own idle Agent still owns the log.
 * @param deps - purge inputs, the pending store and the live-Agent probe.
 * @param sessionId - untrusted id from the panel; validated by the purge.
 * @returns `purged` when the files are gone, `deferred` when only archived.
 * @throws SessionPurgeError for every refusal the caller cannot resolve.
 */
export async function deleteSession(deps: SessionDeleteDeps, sessionId: string): Promise<SessionDeleteOutcome> {
  try {
    await purgeSessionFiles(deps.purge, sessionId)
    await deps.store.remove(sessionId)
    return 'purged'
  } catch (error: unknown) {
    const ownedByIdleAgent = error instanceof SessionPurgeError
      && error.code === 'running'
      && !deps.purge.runningSessionIds.has(sessionId)
      && deps.isLive(sessionId)
    if (!ownedByIdleAgent) throw error
  }
  // Archive first: the session must vanish from lists even if persisting the
  // queue fails, and archiving an already archived id is a no-op upstream.
  try {
    await deps.purge.archiveSession(sessionId)
  } catch (error: unknown) {
    throw new SessionPurgeError('internal', `could not archive session "${sessionId}": ${String(error)}`, { cause: error })
  }
  try {
    await deps.store.add(sessionId)
  } catch (error: unknown) {
    throw new SessionPurgeError('internal',
      `session "${sessionId}" was archived, but the deferred purge could not be recorded: ${String(error)}`, { cause: error })
  }
  return 'deferred'
}

/**
 * Purge every queued session whose log is no longer held. Runs at bridge
 * start, before any panel can resume one of them. Ids that no longer have
 * durable storage are dropped; ids still owned stay queued for next time.
 * @param deps - purge inputs and the pending store.
 * @param log - diagnostics sink.
 */
export async function drainDeferredPurges(deps: Pick<SessionDeleteDeps, 'purge' | 'store'>, log: DeferredPurgeLog): Promise<void> {
  for (const sessionId of deps.store.list()) {
    try {
      await purgeSessionFiles(deps.purge, sessionId)
      await deps.store.remove(sessionId)
      log.info(`browser bridge: purged deferred session ${sessionId}`)
    } catch (error: unknown) {
      if (error instanceof SessionPurgeError && (error.code === 'not-found' || error.code === 'invalid-id')) {
        await deps.store.remove(sessionId)
        continue
      }
      log.warn(`browser bridge: deferred purge of ${sessionId} still pending: ${String(error)}`)
    }
  }
}

/**
 * Hide queued sessions from `session.list` so a deferred deletion looks
 * complete to the panel. Every other method passes through untouched.
 * @param api - gateway API to wrap.
 * @param store - pending purge set.
 * @returns the wrapped API.
 */
export function withDeferredPurgeFilter(api: BrowserHostApi, store: DeferredPurgeStore): BrowserHostApi {
  return {
    async call(call: HostRpcCall): Promise<HostRpcResult> {
      const result = await api.call(call)
      if (call.method !== 'session.list' || !result.ok || !isRecord(result.value) || !Array.isArray(result.value.items)) {
        return result
      }
      const items = result.value.items.filter((item) => !(isRecord(item) && typeof item.sessionId === 'string' && store.has(item.sessionId)))
      return items.length === result.value.items.length ? result : { ...result, value: { ...result.value, items } }
    },
    events: signal => api.events(signal),
    respond: (rpcId, result, signal) => api.respond(rpcId, result, signal),
  }
}
