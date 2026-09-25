import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DeferredPurgeStore,
  deleteSession,
  drainDeferredPurges,
  withDeferredPurgeFilter,
} from '../src/deferred-purge.ts'
import type { BrowserHostApi } from '../src/host-api.ts'
import type { SessionPurgeDeps } from '../src/session-purge.ts'

const SESSION_A = 'session-82222a77-aab5-4c0b-b33e-6376973ec93d'
const SESSION_B = 'session-92bad0de-136e-4d1f-a308-d1f5388d608f'

const tempRoots: string[] = []
afterEach(async () => {
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-deferred-purge-'))
  tempRoots.push(root)
  return root
}

async function makeSession(root: string, sessionId: string): Promise<string> {
  const dir = path.join(root, 'sessions', 'ws', sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'session.jsonl.zstd'), 'x')
  return dir
}

/** A persistence stand-in: `owned` ids throw the runtime-ownership error on write-open. */
function purgeDeps(root: string, owned: Set<string>, archived: string[], running = new Set<string>()): SessionPurgeDeps {
  return {
    sessionsRoot: path.join(root, 'sessions'),
    runningSessionIds: running,
    acquireOwnership: async (id) => {
      if (owned.has(id)) {
        const error = new Error(`session "${id}" is already owned`)
        error.name = 'SessionAlreadyOwnedError'
        throw error
      }
      return { close: async () => {} }
    },
    archiveSession: async (id) => { archived.push(id) },
  }
}

describe('DeferredPurgeStore', () => {
  it('round-trips ids through the JSON file and tolerates a missing or corrupt file', async () => {
    const root = await makeRoot()
    const file = path.join(root, 'nested', 'pending.json')
    const store = new DeferredPurgeStore(file)
    await store.load()
    expect(store.list()).toEqual([])
    await store.add(SESSION_A)
    await store.add(SESSION_A)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ sessionIds: [SESSION_A] })
    const reloaded = new DeferredPurgeStore(file)
    await reloaded.load()
    expect(reloaded.has(SESSION_A)).toBe(true)
    await reloaded.remove(SESSION_A)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ sessionIds: [] })

    await writeFile(file, '{not json')
    const corrupt = new DeferredPurgeStore(file)
    await corrupt.load()
    expect(corrupt.list()).toEqual([])
    await writeFile(file, JSON.stringify({ sessionIds: ['../escape', 42, SESSION_B] }))
    await corrupt.load()
    expect(corrupt.list()).toEqual([SESSION_B])
  })
})

describe('deleteSession', () => {
  it('purges immediately when nothing owns the log', async () => {
    const root = await makeRoot()
    const dir = await makeSession(root, SESSION_A)
    const archived: string[] = []
    const store = new DeferredPurgeStore(path.join(root, 'pending.json'))
    const outcome = await deleteSession({ purge: purgeDeps(root, new Set(), archived), store, isLive: () => true }, SESSION_A)
    expect(outcome).toBe('purged')
    expect(archived).toEqual([SESSION_A])
    expect(await readdir(dir)).toEqual([])
    expect(store.has(SESSION_A)).toBe(false)
  })

  it("archives and queues a session held by this runtime's idle Agent", async () => {
    const root = await makeRoot()
    const dir = await makeSession(root, SESSION_A)
    const archived: string[] = []
    const store = new DeferredPurgeStore(path.join(root, 'pending.json'))
    const outcome = await deleteSession({
      purge: purgeDeps(root, new Set([SESSION_A]), archived),
      store,
      isLive: (id) => id === SESSION_A,
    }, SESSION_A)
    expect(outcome).toBe('deferred')
    expect(archived).toEqual([SESSION_A])
    expect(await readdir(dir)).toEqual(['session.jsonl.zstd'])
    expect(store.list()).toEqual([SESSION_A])
  })

  it('still refuses a session that is running or owned by another process', async () => {
    const root = await makeRoot()
    await makeSession(root, SESSION_A)
    const store = new DeferredPurgeStore(path.join(root, 'pending.json'))
    await expect(deleteSession({
      purge: purgeDeps(root, new Set([SESSION_A]), [], new Set([SESSION_A])),
      store,
      isLive: () => true,
    }, SESSION_A)).rejects.toMatchObject({ code: 'running' })
    await expect(deleteSession({
      purge: purgeDeps(root, new Set([SESSION_A]), []),
      store,
      isLive: () => false,
    }, SESSION_A)).rejects.toMatchObject({ code: 'running' })
    expect(store.list()).toEqual([])
  })

  it('reports an archive failure without queueing', async () => {
    const root = await makeRoot()
    await makeSession(root, SESSION_A)
    const store = new DeferredPurgeStore(path.join(root, 'pending.json'))
    const deps = purgeDeps(root, new Set([SESSION_A]), [])
    deps.archiveSession = async () => { throw new Error('workspace/session-active') }
    await expect(deleteSession({ purge: deps, store, isLive: () => true }, SESSION_A))
      .rejects.toMatchObject({ code: 'internal', message: expect.stringContaining('could not archive') })
    expect(store.list()).toEqual([])
  })
})

describe('drainDeferredPurges', () => {
  it('purges released sessions, drops vanished ones, and keeps still-owned ones', async () => {
    const root = await makeRoot()
    const dirA = await makeSession(root, SESSION_A)
    const dirB = await makeSession(root, SESSION_B)
    const gone = 'session-00000000-0000-4000-8000-000000000000'
    const store = new DeferredPurgeStore(path.join(root, 'pending.json'))
    for (const id of [SESSION_A, SESSION_B, gone]) await store.add(id)
    const warnings: string[] = []
    await drainDeferredPurges(
      { purge: purgeDeps(root, new Set([SESSION_B]), []), store },
      { info: () => {}, warn: (m) => { warnings.push(m) } },
    )
    expect(await readdir(dirA)).toEqual([])
    expect(await readdir(dirB)).toEqual(['session.jsonl.zstd'])
    expect(store.list()).toEqual([SESSION_B])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(SESSION_B)
  })
})

describe('withDeferredPurgeFilter', () => {
  it('drops queued ids from session.list and leaves everything else alone', async () => {
    const root = await makeRoot()
    const store = new DeferredPurgeStore(path.join(root, 'pending.json'))
    await store.add(SESSION_A)
    const calls: string[] = []
    const inner: BrowserHostApi = {
      call: async (call) => {
        calls.push(call.method)
        if (call.method === 'session.list') {
          return { ok: true, value: { items: [{ sessionId: SESSION_A }, { sessionId: SESSION_B }], next: 'cursor' } }
        }
        return { ok: true, value: { echo: call.method } }
      },
      events: () => ({ async *[Symbol.asyncIterator]() {} }),
      respond: async () => undefined,
    }
    const api = withDeferredPurgeFilter(inner, store)
    const signal = new AbortController().signal
    const listed = await api.call({ rpcId: '1', method: 'session.list', payload: {}, signal })
    expect(listed).toEqual({ ok: true, value: { items: [{ sessionId: SESSION_B }], next: 'cursor' } })
    const other = await api.call({ rpcId: '2', method: 'session.history', payload: {}, signal })
    expect(other).toEqual({ ok: true, value: { echo: 'session.history' } })
    expect(calls).toEqual(['session.list', 'session.history'])
  })
})
