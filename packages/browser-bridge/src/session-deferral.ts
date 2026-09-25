/**
 * Defer real session creation until the first prompt.
 *
 * The panel calls `session.create` as soon as it connects, but a session that
 * is opened and never used should leave zero trace in the store/GUI. This
 * wrapper answers `session.create` with a provisional id (minted locally,
 * nothing persisted), serves `session.history` for provisional ids as empty,
 * and materializes the real session — same id, original create payload — on
 * the first `session.prompt` for that id. Abandoned provisional ids are
 * pruned after {@link PROVISIONAL_TTL_MS}.
 *
 * @module @onenightcarnival/dsh-bridge-browser/src/session-deferral
 */

import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { BrowserHostApi, HostRpcCall, HostRpcResult } from './host-api.ts'
import { isRecord } from './host-api.ts'

/** Provisional entries older than this are dropped on the next create. */
const PROVISIONAL_TTL_MS = 30 * 60_000

interface ProvisionalEntry {
  /** The original create payload, replayed at materialization (keeps cwd/workspaceId). */
  payload: Record<string, unknown>
  createdAt: number
  /** Model chosen in the panel before the first prompt; installed right after materialization. */
  model?: { provider: string; model: string; reasoningEffort?: string }
}

function modelSelectionOf(payload: unknown): ProvisionalEntry['model'] | undefined {
  if (!isRecord(payload) || typeof payload.provider !== 'string' || typeof payload.model !== 'string') return undefined
  if (payload.provider === '' || payload.model === '') return undefined
  return {
    provider: payload.provider,
    model: payload.model,
    ...(typeof payload.reasoningEffort === 'string' && payload.reasoningEffort !== ''
      ? { reasoningEffort: payload.reasoningEffort }
      : {}),
  }
}

/**
 * Wrap the gateway sessions API so `session.create` returns a provisional id
 * without creating anything; the real session materializes on the first
 * `session.prompt` for that id.
 *
 * @param api - Gateway API implementation.
 * @param enabled - Whether deferral is active; false returns the API untouched.
 * @param imageLimits - actual host image capability, used for the synthetic
 * empty history before the deferred Session exists.
 * @returns the original API when disabled, otherwise the wrapped API.
 */
export function withSessionDeferral(
  api: BrowserHostApi,
  enabled: boolean,
  imageLimits?: ImageAttachmentLimits,
): BrowserHostApi {
  if (!enabled) return api

  const provisional = new Map<string, ProvisionalEntry>()
  const materializing = new Map<string, Promise<HostRpcResult>>()

  const prune = (): void => {
    const cutoff = Date.now() - PROVISIONAL_TTL_MS
    for (const [id, entry] of provisional) {
      if (entry.createdAt < cutoff) provisional.delete(id)
    }
  }

  const mintedId = (payload: Record<string, unknown>): string =>
    typeof payload.sessionId === 'string' ? payload.sessionId : `session-${crypto.randomUUID()}`

  return {
    async call(call: HostRpcCall): Promise<HostRpcResult> {
      if (call.method === 'session.create') {
        if (!isRecord(call.payload)) {
          return { ok: false, error: { code: 'bad-request', message: 'session.create payload must be an object', details: {} } }
        }
        prune()
        const sessionId = mintedId(call.payload)
        provisional.set(sessionId, { payload: { ...call.payload }, createdAt: Date.now() })
        return { ok: true, value: { sessionId } }
      }
      if (call.method === 'session.history') {
        const sessionId = sessionIdOf(call.payload)
        if (sessionId === undefined || !provisional.has(sessionId)) return api.call(call)
        const entry = provisional.get(sessionId)
        return {
          ok: true,
          value: {
            events: [],
            hasMore: false,
            projections: {
              asOfSeq: -1,
              values: {
                ...(imageLimits === undefined ? {} : { imageLimits }),
                // Mirrors the Host's modelSelection projection so the panel
                // shows a pre-prompt choice the way it shows a real one.
                modelSelection: { lastUsed: null, next: entry?.model === undefined ? null : { ...entry.model } },
              },
            },
          },
        }
      }
      if (call.method === 'session.selectModel') {
        // The gateway cannot validate a route without a live session; keep
        // the choice and install it the moment the session materializes.
        const sessionId = sessionIdOf(call.payload)
        const entry = sessionId === undefined ? undefined : provisional.get(sessionId)
        if (entry === undefined) return api.call(call)
        const model = modelSelectionOf(call.payload)
        if (model === undefined) {
          return { ok: false, error: { code: 'bad-request', message: 'provider and model must be non-empty strings', details: {} } }
        }
        entry.model = model
        return { ok: true, value: { selected: { ...model } } }
      }
      if (call.method !== 'session.prompt') return api.call(call)
      const sessionId = sessionIdOf(call.payload)
      if (sessionId === undefined) return api.call(call)
      const entry = provisional.get(sessionId)
      if (entry === undefined) return api.call(call)
      const existing = materializing.get(sessionId)
      const pending = existing ?? (async (): Promise<HostRpcResult> => {
        const created = await api.call({
          rpcId: crypto.randomUUID(),
          method: 'session.create',
          payload: { ...entry.payload, sessionId },
          signal: call.signal,
        })
        if (!created.ok || entry.model === undefined) return created
        // A pre-prompt model choice is part of creating this session: the
        // first request must already use it, so a rejected route fails the
        // prompt instead of silently running on the default model.
        const selected = await api.call({
          rpcId: crypto.randomUUID(),
          method: 'session.selectModel',
          payload: { sessionId, ...entry.model },
          signal: call.signal,
        })
        return selected.ok ? created : selected
      })()
      if (existing === undefined) {
        materializing.set(sessionId, pending)
        void pending.then(
          () => { materializing.delete(sessionId) },
          () => { materializing.delete(sessionId) },
        )
      }
      const created = await pending
      if (!created.ok) return created
      provisional.delete(sessionId)
      return api.call(call)
    },
    events: signal => api.events(signal),
    respond: (rpcId, result, signal) => api.respond(rpcId, result, signal),
  }
}

function sessionIdOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined
  return typeof payload.sessionId === 'string' ? payload.sessionId : undefined
}
