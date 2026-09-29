/**
 * Session storage removal under the dsh home.
 *
 * Order: validate ID → acquire exclusive ownership → archive → remove data.
 * Scope: exact session directories two levels below the sessions root.
 * Invariants: running sessions rejected before disk access; lock inode retained.
 *
 * @module @onenightcarnival/dsh-bridge-browser/src/session-purge
 */

import { lstat, readdir, rm } from 'node:fs/promises'
import path from 'node:path'

/** Stable failure codes surfaced to the panel. Open set: callers must tolerate growth. */
export type SessionPurgeErrorCode = 'not-found' | 'running' | 'invalid-id' | 'internal'

/** Error thrown by {@link purgeSessionFiles}; the server turns it into a wire error. */
export class SessionPurgeError extends Error {
  constructor(
    readonly code: SessionPurgeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SessionPurgeError'
  }
}

/** Persisted session ids are `session-` plus one lowercase UUID. */
const SESSION_ID_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
/** Persistent inode for POSIX flock; retained throughout data removal. */
const SESSION_LOCK_FILENAME = 'session.lock'

/** Dependencies purging needs from the plugin. */
export interface SessionPurgeDeps {
  /** The dsh sessions root (`dshHomePath('sessions')`). */
  sessionsRoot: string
  /** Session ids currently running; purging any of these is refused. */
  runningSessionIds: ReadonlySet<string>
  /**
   * Exclusive runtime write handle and kernel lock, held through removal.
   * Exclusion includes idle Agents and other processes that own the log.
   */
  acquireOwnership(sessionId: string): Promise<{ close(): Promise<void> }>
  /** Archive while the durable session still exists and exclusive ownership is held. */
  archiveSession(sessionId: string): Promise<void>
}

/**
 * Validate one session id against the persisted shape. Rejects everything
 * that could escape the sessions root (separators, dot segments) before any
 * filesystem call sees it.
 * @param sessionId - untrusted id from the panel.
 * @returns the id when well-formed.
 * @throws SessionPurgeError with code `invalid-id` otherwise.
 */
export function assertPurgeableSessionId(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new SessionPurgeError('invalid-id', `session id "${sessionId}" does not match the persisted shape`)
  }
  return sessionId
}

/**
 * Permanently delete a session's data, keeping its directory and lock inode.
 * The runtime refuses ambiguous duplicate session identities across workspaces.
 * @param deps - root and running-set inputs.
 * @param sessionId - validated session id.
 * @returns nothing; throws {@link SessionPurgeError} on refusal or failure.
 */
export async function purgeSessionFiles(deps: SessionPurgeDeps, sessionId: string): Promise<void> {
  assertPurgeableSessionId(sessionId)
  if (deps.runningSessionIds.has(sessionId)) {
    throw new SessionPurgeError('running', 'refusing to purge a running session; cancel it first')
  }

  let workspaces: string[]
  try {
    workspaces = await readdir(deps.sessionsRoot, { withFileTypes: true })
      .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
  } catch (error: unknown) {
    throw new SessionPurgeError('internal', `could not read the sessions root "${deps.sessionsRoot}": ${String(error)}`)
  }

  const targets: string[] = []
  for (const workspace of workspaces) {
    // Validated IDs contain no separators or dot segments.
    const candidate = path.join(deps.sessionsRoot, workspace, sessionId)
    try {
      if (!(await lstat(candidate)).isDirectory()) continue
      const entries = await readdir(candidate)
      if (entries.some(entry => entry !== SESSION_LOCK_FILENAME)) targets.push(candidate)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new SessionPurgeError('internal', `could not inspect "${candidate}": ${String(error)}`, { cause: error })
      }
    }
  }

  if (targets.length === 0) {
    throw new SessionPurgeError('not-found', `no durable storage found for session "${sessionId}"`)
  }
  let ownership: { close(): Promise<void> }
  try {
    ownership = await deps.acquireOwnership(sessionId)
  } catch (error: unknown) {
    // Public error identity is shared across separately loaded runtime copies.
    if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
      throw new SessionPurgeError(
        'running',
        'session is still owned by a runtime; release the session or restart that runtime, then retry deletion',
      )
    }
    throw new SessionPurgeError('internal', `could not acquire exclusive session ownership: ${String(error)}`)
  }
  let failure: unknown
  let archived = false
  try {
    // Archive requires existing storage and precedes deletion.
    await deps.archiveSession(sessionId)
    archived = true
    for (const target of targets) {
      if (!(await lstat(target)).isDirectory()) throw new Error(`session directory changed: ${target}`)
      // Re-scan after write-open: opening an old log may materialize V3.
      for (const entry of await readdir(target)) {
        if (entry === SESSION_LOCK_FILENAME) continue
        await rm(path.join(target, entry), { recursive: true, force: true })
      }
    }
  } catch (error: unknown) {
    failure = new SessionPurgeError('internal', archived
      ? `session was archived, but durable cleanup failed: ${String(error)}`
      : `could not archive session; durable data was preserved: ${String(error)}`, { cause: error })
  } finally {
    try {
      await ownership.close()
    } catch (error: unknown) {
      failure = failure === undefined
        ? new SessionPurgeError('internal', `session was archived and cleared, but ownership release failed: ${String(error)}`, { cause: error })
        : new SessionPurgeError('internal', `${String(failure)}; ownership release also failed: ${String(error)}`, {
          cause: new AggregateError([failure, error], 'session purge and ownership release failed'),
        })
    }
  }
  if (failure !== undefined) throw failure
}
