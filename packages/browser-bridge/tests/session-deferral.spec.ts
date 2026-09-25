import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { BrowserHostApi, HostRpcCall, HostRpcResult } from '../src/host-api.ts'
import { withSessionDeferral } from '../src/session-deferral.ts'

function apiHarness() {
  const sessionCreate = vi.fn(async (call: HostRpcCall): Promise<HostRpcResult> => ({
    ok: true,
    value: { sessionId: (call.payload as { sessionId: string }).sessionId },
  }))
  const sessionHistory = vi.fn(async (): Promise<HostRpcResult> => ({
    ok: true,
    value: { events: [{ event: { type: 'user/message' } }], hasMore: false },
  }))
  const sessionPrompt = vi.fn(async (): Promise<HostRpcResult> => ({
    ok: true,
    value: { accepted: true },
  }))
  const call = vi.fn(async (request: HostRpcCall): Promise<HostRpcResult> => {
    if (request.method === 'session.create') return sessionCreate(request)
    if (request.method === 'session.history') return sessionHistory(request)
    if (request.method === 'session.prompt') return sessionPrompt(request)
    return { ok: false, error: { code: 'not-found', message: request.method, details: {} } }
  })
  const api: BrowserHostApi = {
    call,
    async *events() {},
    respond: async () => ({ accepted: false }),
  }
  return { api, call, sessionCreate, sessionHistory, sessionPrompt }
}

function request(method: string, payload: unknown, rpcId = method): HostRpcCall {
  return { rpcId, method, payload, signal: new AbortController().signal }
}

async function provisionalId(api: BrowserHostApi, rpcId = 'create-rpc'): Promise<string> {
  const response = await api.call(request('session.create', {}, rpcId))
  if (!response.ok || typeof (response.value as { sessionId?: unknown }).sessionId !== 'string') {
    throw new Error('provisional create failed')
  }
  return (response.value as { sessionId: string }).sessionId
}

describe('withSessionDeferral', () => {
  afterEach(() => { vi.useRealTimers() })

  it('mints a provisional id without touching the Host', async () => {
    const { api, call } = apiHarness()
    const wrapped = withSessionDeferral(api, true)

    expect(await provisionalId(wrapped)).toMatch(/^session-/)
    expect(call).not.toHaveBeenCalled()
  })

  it('honors an explicit session id', async () => {
    const { api } = apiHarness()
    const wrapped = withSessionDeferral(api, true)

    await expect(wrapped.call(request('session.create', { sessionId: 'session-fixed' })))
      .resolves.toEqual({ ok: true, value: { sessionId: 'session-fixed' } })
  })

  it('serves provisional history locally and passes real history through', async () => {
    const { api, sessionHistory } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const id = await provisionalId(wrapped)

    await expect(wrapped.call(request('session.history', { sessionId: id })))
      .resolves.toEqual({ ok: true, value: { events: [], hasMore: false, projections: { asOfSeq: -1, values: { modelSelection: { lastUsed: null, next: null } } } } })
    expect(sessionHistory).not.toHaveBeenCalled()

    await wrapped.call(request('session.history', { sessionId: 'session-real' }))
    expect(sessionHistory).toHaveBeenCalledOnce()
  })

  it('projects image limits before materialization', async () => {
    const { api } = apiHarness()
    const limits: ImageAttachmentLimits = {
      maxImageBytes: 1024,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 4096,
      maxImagePixels: 1_000_000,
      maxImageDimension: 1200,
      mediaTypes: ['image/png', 'image/jpeg'],
    }
    const wrapped = withSessionDeferral(api, true, limits)
    const id = await provisionalId(wrapped)

    await expect(wrapped.call(request('session.history', { sessionId: id }))).resolves.toEqual({
      ok: true,
      value: {
        events: [],
        hasMore: false,
        projections: { asOfSeq: -1, values: { imageLimits: limits, modelSelection: { lastUsed: null, next: null } } },
      },
    })
  })

  it('materializes on first prompt and replays the create payload', async () => {
    const { api, sessionCreate, sessionPrompt, sessionHistory } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const created = await wrapped.call(request('session.create', { cwd: '/work' }))
    if (!created.ok) throw new Error('create failed')
    const id = (created.value as { sessionId: string }).sessionId
    const prompt = request('session.prompt', { sessionId: id, mode: 'queue', content: [] }, 'prompt')

    await wrapped.call(prompt)

    expect(sessionCreate).toHaveBeenCalledWith(expect.objectContaining({
      method: 'session.create', payload: { cwd: '/work', sessionId: id },
    }))
    expect(sessionPrompt).toHaveBeenCalledWith(prompt)
    await wrapped.call(request('session.history', { sessionId: id }))
    expect(sessionHistory).toHaveBeenCalledOnce()
  })

  it('deduplicates concurrent prompts into one materialization', async () => {
    const { api, sessionCreate, sessionPrompt } = apiHarness()
    let release: (() => void) | undefined
    sessionCreate.mockImplementationOnce(async (call: HostRpcCall) => {
      await new Promise<void>((resolve) => { release = resolve })
      return { ok: true, value: { sessionId: (call.payload as { sessionId: string }).sessionId } }
    })
    const wrapped = withSessionDeferral(api, true)
    const id = await provisionalId(wrapped)

    const first = wrapped.call(request('session.prompt', { sessionId: id }, 'p1'))
    const second = wrapped.call(request('session.prompt', { sessionId: id }, 'p2'))
    await vi.waitFor(() => { expect(release).toBeDefined() })
    release?.()
    await Promise.all([first, second])

    expect(sessionCreate).toHaveBeenCalledOnce()
    expect(sessionPrompt).toHaveBeenCalledTimes(2)
  })

  it('retains the provisional entry after a business failure and retries', async () => {
    const { api, sessionCreate, sessionPrompt } = apiHarness()
    sessionCreate.mockResolvedValueOnce({
      ok: false,
      error: { code: 'internal', message: 'boom', details: {} },
    })
    const wrapped = withSessionDeferral(api, true)
    const id = await provisionalId(wrapped)

    await expect(wrapped.call(request('session.prompt', { sessionId: id }, 'p1'))).resolves.toEqual({
      ok: false, error: { code: 'internal', message: 'boom', details: {} },
    })
    expect(sessionPrompt).not.toHaveBeenCalled()
    await wrapped.call(request('session.prompt', { sessionId: id }, 'p2'))
    expect(sessionCreate).toHaveBeenCalledTimes(2)
    expect(sessionPrompt).toHaveBeenCalledOnce()
  })

  it('prunes stale provisional entries and returns the original API when disabled', async () => {
    vi.useFakeTimers()
    const { api, sessionHistory } = apiHarness()
    const wrapped = withSessionDeferral(api, true)
    const first = await provisionalId(wrapped, 'c1')
    vi.advanceTimersByTime(31 * 60_000)
    const second = await provisionalId(wrapped, 'c2')

    await wrapped.call(request('session.history', { sessionId: first }))
    await wrapped.call(request('session.history', { sessionId: second }))
    expect(sessionHistory).toHaveBeenCalledOnce()
    expect(withSessionDeferral(api, false)).toBe(api)
  })
})

describe('model selection on provisional sessions', () => {
  function modelHarness(selectOk = true) {
    const h = apiHarness()
    const selectModel = vi.fn(async (call: HostRpcCall): Promise<HostRpcResult> => selectOk
      ? { ok: true, value: { selected: { ...(call.payload as object) } } }
      : { ok: false, error: { code: 'session/model-unavailable', message: 'no such route', details: {} } })
    h.call.mockImplementation(async (request: HostRpcCall): Promise<HostRpcResult> => {
      if (request.method === 'session.create') return h.sessionCreate(request)
      if (request.method === 'session.history') return h.sessionHistory(request)
      if (request.method === 'session.prompt') return h.sessionPrompt(request)
      if (request.method === 'session.selectModel') return selectModel(request)
      return { ok: false, error: { code: 'not-found', message: request.method, details: {} } }
    })
    return { ...h, selectModel }
  }

  it('records a pre-prompt choice, echoes it through projections, and installs it after materialization', async () => {
    const h = modelHarness()
    const api = withSessionDeferral(h.api, true)
    const sessionId = await provisionalId(api)

    const chosen = await api.call(request('session.selectModel', { sessionId, provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'high' }))
    expect(chosen).toEqual({ ok: true, value: { selected: { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'high' } } })
    expect(h.selectModel).not.toHaveBeenCalled()

    const history = await api.call(request('session.history', { sessionId }))
    expect(history).toEqual({
      ok: true,
      value: {
        events: [],
        hasMore: false,
        projections: { asOfSeq: -1, values: { modelSelection: { lastUsed: null, next: { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'high' } } } },
      },
    })
    expect(h.sessionHistory).not.toHaveBeenCalled()

    const prompted = await api.call(request('session.prompt', { sessionId, content: [] }))
    expect(prompted).toEqual({ ok: true, value: { accepted: true } })
    expect(h.sessionCreate).toHaveBeenCalledTimes(1)
    expect(h.selectModel).toHaveBeenCalledTimes(1)
    expect(h.selectModel.mock.calls[0]?.[0].payload).toEqual({ sessionId, provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'high' })
    // Call order: create → selectModel → prompt.
    const order = h.call.mock.calls.map(([call]) => call.method)
    expect(order.slice(-3)).toEqual(['session.create', 'session.selectModel', 'session.prompt'])

    // Once real, both methods go straight to the gateway.
    await api.call(request('session.history', { sessionId }))
    expect(h.sessionHistory).toHaveBeenCalledTimes(1)
    await api.call(request('session.selectModel', { sessionId, provider: 'deepseek', model: 'deepseek-v4' }))
    expect(h.selectModel).toHaveBeenCalledTimes(2)
  })

  it('fails the first prompt when the stored route is rejected, keeping the session provisional-free', async () => {
    const h = modelHarness(false)
    const api = withSessionDeferral(h.api, true)
    const sessionId = await provisionalId(api)
    await api.call(request('session.selectModel', { sessionId, provider: 'nope', model: 'missing' }))
    const prompted = await api.call(request('session.prompt', { sessionId, content: [] }))
    expect(prompted).toMatchObject({ ok: false, error: { code: 'session/model-unavailable' } })
    expect(h.sessionPrompt).not.toHaveBeenCalled()
  })

  it('rejects a malformed provisional selection and passes real-session calls through untouched', async () => {
    const h = modelHarness()
    const api = withSessionDeferral(h.api, true)
    const sessionId = await provisionalId(api)
    expect(await api.call(request('session.selectModel', { sessionId, provider: '', model: 'x' })))
      .toMatchObject({ ok: false, error: { code: 'bad-request' } })
    await api.call(request('session.selectModel', { sessionId: 'session-other', provider: 'a', model: 'b' }))
    expect(h.selectModel).toHaveBeenCalledTimes(1)
    const history = await api.call(request('session.history', { sessionId }))
    expect(history).toMatchObject({ ok: true, value: { projections: { asOfSeq: -1, values: { modelSelection: { lastUsed: null, next: null } } } } })
  })
})
