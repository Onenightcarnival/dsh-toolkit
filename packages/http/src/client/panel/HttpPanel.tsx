/**
 * Three-pane HTTP client. Sidebar: scope selector (no target, or one of the
 * targets), then the scope's saved requests and its exchange history on two
 * tabs. Request pane: the form of the selected saved request, edited in place
 * and saved automatically. Response pane: the latest response of that request,
 * or a picked exchange. The panes sit side by side with a draggable divider
 * and stack when narrow.
 *
 * "New" creates a blank request in the current scope. A request without a
 * target carries a full URL; a target adds a base URL, host-kept credentials
 * and agent access, and can be created from such a request.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { HttpApi } from '../api.ts'
import { DEFAULT_TIMEOUT_MS, DIRECT_TARGET_ID, joinUrl, type HttpExchange, type HttpSavedRequest, type HttpSavedRequestPayload, type HttpTargetPayload, type HttpTargetSummary } from '../../protocol.ts'
import { tt } from '../locales.ts'
import { BannerView, Modal, copyText, errorMessage, sendShortcut, type Banner } from './common.tsx'
import { HistorySidebar } from './HistorySidebar.tsx'
import { RequestList, requestTitle } from './RequestList.tsx'
import { RequestPane, builderFromExchange, builderFromSaved, curlOf, pathBelow, savedFromBuilder, toRequestInput, type BuilderState, type RequestTab } from './RequestPane.tsx'
import { ResponsePane, type LiveStream, type ResponseTab } from './ResponsePane.tsx'
import type { SseRow } from '../sse.ts'
import { TargetForm } from './TargetForm.tsx'

export interface HttpPanelProps {
  api: HttpApi
  /** Return the center column to the Conversation. */
  close: () => void
}

type SideTab = 'requests' | 'history'

type FormState =
  /** `fromRequest`: the new target takes this request's origin as base URL and the request moves to it. */
  | { mode: 'create'; fromRequest?: HttpSavedRequest }
  | { mode: 'edit'; target: HttpTargetSummary }

const SPLIT_KEY = 'dsh-http:split'
const SCOPE_KEY = 'dsh-http:scope'
const SPLIT_MIN = 20
const SPLIT_MAX = 80
/** Select value of the "new target" entry. */
const NEW_TARGET = '__new__'
/** Interval of the newest-entry check that picks up requests sent by the agent. */
const HISTORY_POLL_MS = 4000
/** Quiet time after the last edit before a request form is saved. */
const AUTOSAVE_MS = 500

function readSplit(): number {
  try {
    const value = Number(localStorage.getItem(SPLIT_KEY))
    return value >= SPLIT_MIN && value <= SPLIT_MAX ? value : 50
  } catch {
    return 50
  }
}

function readScope(): string | undefined {
  try {
    return localStorage.getItem(SCOPE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

/** Stand-in summary of the scope without a target. */
function directScope(): HttpTargetSummary {
  return { id: DIRECT_TARGET_ID, name: tt('targets.direct'), baseUrl: '', auth: { type: 'none' }, headers: {}, variables: {}, allowedHosts: [], allowMutations: true, allowPrivate: true, timeoutMs: DEFAULT_TIMEOUT_MS, createdAt: 0, updatedAt: 0 }
}

function authLabel(target: HttpTargetSummary): string {
  switch (target.auth.type) {
    case 'none': return tt('form.auth.none')
    case 'bearer': return `Bearer ${target.auth.hint}`
    case 'basic': return `Basic ${target.auth.username}`
    case 'header': return `${target.auth.name}: ${target.auth.hint}`
    case 'query': return `?${target.auth.name}=${target.auth.hint}`
  }
}

/** Origin of a full request URL; empty when it does not parse. */
function originOf(path: string): string {
  try {
    return joinUrl('', path, {}).origin
  } catch {
    return ''
  }
}

export function HttpPanel(props: HttpPanelProps): JSX.Element {
  const { api, close } = props
  const [targets, setTargets] = useState<HttpTargetSummary[]>([])
  /** Scope on display: DIRECT_TARGET_ID or a target id. */
  const [scopeId, setScopeId] = useState<string>(DIRECT_TARGET_ID)
  const [agentTools, setAgentTools] = useState(false)
  const [banner, setBanner] = useState<Banner | undefined>()
  const [form, setForm] = useState<FormState | undefined>()
  const [confirmDelete, setConfirmDelete] = useState<HttpTargetSummary | undefined>()
  const [confirmClear, setConfirmClear] = useState<HttpTargetSummary | undefined>()
  const [confirmDeleteRequest, setConfirmDeleteRequest] = useState<HttpSavedRequest | undefined>()
  const [testing, setTesting] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [requests, setRequests] = useState<HttpSavedRequest[]>([])
  /** Selected saved request per scope. */
  const [selected, setSelected] = useState<Record<string, string>>({})
  /** Exchange picked for display per scope; absent shows the selected request's latest one. */
  const [shown, setShown] = useState<Record<string, HttpExchange | undefined>>({})
  const [history, setHistory] = useState<HttpExchange[]>([])
  const [sideTab, setSideTab] = useState<SideTab>('requests')
  const [requestFilter, setRequestFilter] = useState('')
  const [historyFilter, setHistoryFilter] = useState('')
  const [requestTab, setRequestTab] = useState<RequestTab>('params')
  const [responseTab, setResponseTab] = useState<ResponseTab>('preview')
  const [sending, setSending] = useState<{ since: number; controller: AbortController } | undefined>()
  /** The event stream being read, from its response head on. */
  const [live, setLive] = useState<LiveStream | undefined>()
  const [split, setSplit] = useState(readSplit)
  const panelRef = useRef<HTMLElement>(null)
  const panesRef = useRef<HTMLDivElement>(null)
  const newestRef = useRef<string | undefined>(undefined)
  const loadedRef = useRef(false)
  /** Put the caret in the URL bar once the requests of the scope being entered are on screen. */
  const focusAfterLoad = useRef(false)
  const requestsRef = useRef<HttpSavedRequest[]>([])
  requestsRef.current = requests
  /** Pending autosave timers by request id. */
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [list, settings] = await Promise.all([api.targets(), api.settings()])
      setTargets(list)
      setAgentTools(settings.agentTools)
      // First load: the scope used last, else the first target, else no target.
      const first = !loadedRef.current
      loadedRef.current = true
      setScopeId((prev) => {
        if (!first) return prev === DIRECT_TARGET_ID || list.some(t => t.id === prev) ? prev : DIRECT_TARGET_ID
        const stored = readScope()
        if (stored === DIRECT_TARGET_ID || (stored !== undefined && list.some(t => t.id === stored))) return stored
        return list[0]?.id ?? DIRECT_TARGET_ID
      })
      setLoaded(true)
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) })
    }
  }, [api])

  useEffect(() => { void refresh() }, [refresh])

  /** Write a request form with a pending edit to the host now. */
  const flushSave = useCallback((id: string, keepalive = false): void => {
    const timer = saveTimers.current.get(id)
    if (timer === undefined) return
    clearTimeout(timer)
    saveTimers.current.delete(id)
    const request = requestsRef.current.find(r => r.id === id)
    if (request === undefined) return
    api.updateRequest(id, { name: request.name, ...savedFromBuilder(builderFromSaved(request)) }, keepalive).catch((error: unknown) => {
      setBanner({ kind: 'error', text: tt('requests.saveFailed', { error: errorMessage(error) }) })
    })
  }, [api])

  const flushAll = useCallback((keepalive = false): void => {
    for (const id of [...saveTimers.current.keys()]) flushSave(id, keepalive)
  }, [flushSave])

  const dropSave = (id: string): void => {
    const pending = saveTimers.current.get(id)
    if (pending !== undefined) clearTimeout(pending)
    saveTimers.current.delete(id)
  }

  const loadHistory = useCallback(async (scope: string): Promise<void> => {
    try {
      const entries = await api.history(scope)
      newestRef.current = entries[0]?.id
      setHistory(entries)
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) })
    }
  }, [api])

  useEffect(() => {
    if (!loaded) return
    try { localStorage.setItem(SCOPE_KEY, scopeId) } catch { /* optional */ }
    setRequestFilter('')
    setHistoryFilter('')
    setRequests([])
    let stale = false
    api.requests(scopeId).then((list) => {
      if (stale) return
      setRequests(list)
      if (focusAfterLoad.current) {
        focusAfterLoad.current = false
        setTimeout(() => { panelRef.current?.querySelector<HTMLInputElement>('[data-http-url]')?.focus() }, 0)
      }
    }, (error: unknown) => {
      if (!stale) setBanner({ kind: 'error', text: errorMessage(error) })
    })
    void loadHistory(scopeId)
    // Requests sent by the agent reach the list through a one-entry check.
    const timer = setInterval(() => {
      if (document.hidden) return
      api.history(scopeId, 1).then((entries) => {
        if (entries[0]?.id !== newestRef.current) void loadHistory(scopeId)
      }, () => undefined)
    }, HISTORY_POLL_MS)
    return () => {
      stale = true
      clearInterval(timer)
      // Edits of the scope being left are saved before its forms leave the state.
      flushAll()
    }
  }, [loaded, scopeId, api, loadHistory, flushAll])

  useEffect(() => {
    const onHide = (): void => { flushAll(true) }
    window.addEventListener('pagehide', onHide)
    return () => { window.removeEventListener('pagehide', onHide) }
  }, [flushAll])

  useEffect(() => { try { localStorage.setItem(SPLIT_KEY, String(split)) } catch { /* optional */ } }, [split])

  const scope: HttpTargetSummary = targets.find(t => t.id === scopeId) ?? directScope()
  const direct = scope.id === DIRECT_TARGET_ID
  const current = requests.find(r => r.id === selected[scope.id]) ?? requests[0]
  const versions = current === undefined ? [] : history.filter(e => e.requestId === current.id)
  const displayed = shown[scope.id] ?? versions[0]

  const focusUrl = (): void => {
    setTimeout(() => { panelRef.current?.querySelector<HTMLInputElement>('[data-http-url]')?.focus() }, 0)
  }

  const selectRequest = (id: string): void => {
    setSelected(prev => ({ ...prev, [scope.id]: id }))
    setShown(prev => ({ ...prev, [scope.id]: undefined }))
    setResponseTab('preview')
  }

  /** Apply a field change to a saved request and schedule its save. */
  const editRequest = (id: string, patch: Partial<HttpSavedRequest>): void => {
    setRequests(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)))
    dropSave(id)
    saveTimers.current.set(id, setTimeout(() => { flushSave(id) }, AUTOSAVE_MS))
  }

  /** Add a request to the current scope, select it and put the caret in its URL bar. */
  const createRequest = async (fields: HttpSavedRequestPayload = {}): Promise<void> => {
    const targetId = scope.id
    try {
      const created = await api.createRequest({ ...fields, targetId })
      setRequests(prev => [...prev, created])
      setSelected(prev => ({ ...prev, [targetId]: created.id }))
      setShown(prev => ({ ...prev, [targetId]: undefined }))
      setRequestFilter('')
      setSideTab('requests')
      setRequestTab('params')
      focusUrl()
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) })
    }
  }

  const duplicateRequest = (id: string): void => {
    const source = requests.find(r => r.id === id)
    if (source === undefined) return
    void createRequest({ ...savedFromBuilder(builderFromSaved(source)), name: source.name === '' ? '' : `${source.name} ${tt('requests.copySuffix')}` })
  }

  const copyCurl = async (id: string): Promise<void> => {
    const request = requests.find(r => r.id === id)
    const command = request === undefined ? undefined : curlOf(scope, builderFromSaved(request))
    if (command === undefined) {
      setBanner({ kind: 'error', text: tt('requests.curlUnavailable') })
      return
    }
    try {
      await copyText(command)
      setBanner({ kind: 'ok', text: tt('requests.curlCopied') })
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) })
    }
  }

  const runDeleteRequest = async (request: HttpSavedRequest): Promise<void> => {
    setConfirmDeleteRequest(undefined)
    dropSave(request.id)
    try {
      await api.deleteRequest(request.id)
      setRequests(prev => prev.filter(r => r.id !== request.id))
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) })
    }
  }

  const toggleAgentTools = async (next: boolean): Promise<void> => {
    setAgentTools(next)
    try {
      const settings = await api.saveSettings({ agentTools: next })
      setAgentTools(settings.agentTools)
      setBanner({ kind: 'ok', text: settings.agentTools ? tt('panel.toolsOn') : tt('panel.toolsOff') })
    } catch (error) {
      setAgentTools(!next)
      setBanner({ kind: 'error', text: errorMessage(error) })
    }
  }

  const saveTarget = async (payload: HttpTargetPayload): Promise<void> => {
    if (form === undefined) return
    if (form.mode === 'edit') {
      const saved = await api.updateTarget(form.target.id, payload)
      setForm(undefined)
      await refresh()
      setScopeId(saved.id)
      return
    }
    const saved = await api.createTarget(payload)
    const moving = form.fromRequest === undefined ? undefined : requestsRef.current.find(r => r.id === form.fromRequest?.id)
    let firstId: string | undefined
    if (moving !== undefined) {
      // The request the target was created from moves below it, with its URL made relative.
      dropSave(moving.id)
      // Authentication taken over by the target leaves the request.
      const auth = saved.auth.type === 'none' ? moving.auth : { type: 'none' as const }
      const moved = await api.updateRequest(moving.id, { name: moving.name, ...savedFromBuilder(builderFromSaved(moving)), auth, targetId: saved.id, path: pathBelow(saved.baseUrl, moving.path) }).catch(() => undefined)
      firstId = moved?.id
    } else {
      // A new target starts with one request form ready to edit.
      firstId = (await api.createRequest({ targetId: saved.id }).catch(() => undefined))?.id
    }
    setForm(undefined)
    focusAfterLoad.current = true
    await refresh()
    setScopeId(saved.id)
    if (firstId !== undefined) {
      const id = firstId
      setSelected(prev => ({ ...prev, [saved.id]: id }))
    }
    setSideTab('requests')
  }

  const runTest = async (target: HttpTargetSummary): Promise<void> => {
    setTesting(true)
    setBanner({ kind: 'info', text: tt('targets.testing') })
    try {
      const result = await api.test(target.id)
      setBanner(result.ok
        ? { kind: 'ok', text: tt('targets.testOk', { status: result.status ?? 0, latency: result.latencyMs }) }
        : { kind: 'error', text: tt('targets.testFail', { error: result.error ?? '?' }) })
    } catch (error) {
      setBanner({ kind: 'error', text: tt('targets.testFail', { error: errorMessage(error) }) })
    } finally {
      setTesting(false)
    }
  }

  const runDeleteTarget = async (target: HttpTargetSummary): Promise<void> => {
    setConfirmDelete(undefined)
    // The host deletes the target's requests with it; their pending saves are dropped.
    if (target.id === scope.id) {
      for (const timer of saveTimers.current.values()) clearTimeout(timer)
      saveTimers.current.clear()
    }
    try {
      await api.deleteTarget(target.id)
      await refresh()
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) })
    }
  }

  const send = async (): Promise<void> => {
    if (current === undefined || sending !== undefined) return
    const controller = new AbortController()
    const targetId = scope.id
    flushSave(current.id)
    setSending({ since: Date.now(), controller })
    setBanner(undefined)
    // Stream events reach the state once per frame.
    const pending: SseRow[] = []
    let frame = 0
    const flush = (): void => {
      frame = 0
      const batch = pending.splice(0)
      setLive(prev => (prev === undefined ? prev : { ...prev, rows: prev.rows.concat(batch) }))
    }
    try {
      const exchange = await api.send(targetId, { ...toRequestInput(builderFromSaved(current)), requestId: current.id }, controller.signal, {
        onHead: (head) => { setLive({ head, rows: [] }); setResponseTab('preview') },
        onEvent: (event, at) => {
          pending.push({ ...event, at })
          if (frame === 0) frame = requestAnimationFrame(flush)
        },
      })
      setShown(prev => ({ ...prev, [targetId]: exchange }))
      setResponseTab('preview')
    } catch (error) {
      if (!controller.signal.aborted) setBanner({ kind: 'error', text: errorMessage(error) })
      // A stopped request shows what the host recorded for it: the latest exchange of this request.
      else setShown(prev => ({ ...prev, [targetId]: undefined }))
    } finally {
      if (frame !== 0) cancelAnimationFrame(frame)
      setLive(undefined)
      setSending(undefined)
      // A cancelled request is recorded by the host once its connection closes.
      if (controller.signal.aborted) setTimeout(() => { void loadHistory(targetId) }, 400)
      else void loadHistory(targetId)
    }
  }

  /** Show a recorded exchange; its saved request, when it still exists, becomes the selected one. */
  const pickExchange = (entry: HttpExchange): void => {
    if (entry.requestId !== undefined && requests.some(r => r.id === entry.requestId)) setSelected(prev => ({ ...prev, [scope.id]: entry.requestId as string }))
    setShown(prev => ({ ...prev, [scope.id]: entry }))
    setResponseTab('preview')
  }

  const deleteEntry = async (entry: HttpExchange): Promise<void> => {
    try {
      await api.clearHistory({ id: entry.id })
      setHistory((prev) => {
        const next = prev.filter(e => e.id !== entry.id)
        newestRef.current = next[0]?.id
        return next
      })
      if (shown[scope.id]?.id === entry.id) setShown(prev => ({ ...prev, [scope.id]: undefined }))
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) })
    }
  }

  const clearHistory = async (target: HttpTargetSummary): Promise<void> => {
    setConfirmClear(undefined)
    try {
      await api.clearHistory({ targetId: target.id })
      newestRef.current = undefined
      setHistory([])
      setShown(prev => ({ ...prev, [target.id]: undefined }))
    } catch (error) {
      setBanner({ kind: 'error', text: errorMessage(error) })
    }
  }

  const dialogOpen = form !== undefined || confirmDelete !== undefined || confirmClear !== undefined || confirmDeleteRequest !== undefined
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (dialogOpen) return
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      void send()
    }
  }

  /** Drag the divider: the request pane takes the pointer's share of the panes box, along its main axis. */
  const onDividerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const panes = panesRef.current
    if (panes === null) return
    event.preventDefault()
    const divider = event.currentTarget
    divider.setPointerCapture(event.pointerId)
    const move = (e: PointerEvent): void => {
      const rect = panes.getBoundingClientRect()
      const column = getComputedStyle(panes).flexDirection === 'column'
      const ratio = column ? (e.clientY - rect.top) / rect.height : (e.clientX - rect.left) / rect.width
      setSplit(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Math.round(ratio * 1000) / 10)))
    }
    const up = (): void => {
      divider.removeEventListener('pointermove', move)
      divider.removeEventListener('pointerup', up)
      divider.removeEventListener('pointercancel', up)
    }
    divider.addEventListener('pointermove', move)
    divider.addEventListener('pointerup', up)
    divider.addEventListener('pointercancel', up)
  }

  return (
    <section className="dsh-http-panel" data-dsh-plugin="http" data-dsh-part="panel" onKeyDown={onKeyDown} ref={panelRef}>
      <header className="dsh-http-header">
        <h2 className="dsh-http-title">{tt('panel.title')}</h2>
        <label className="dsh-http-toggle" {...(agentTools ? { 'data-on': '' } : {})}>
          <input type="checkbox" checked={agentTools} disabled={!loaded} onChange={(e) => { void toggleAgentTools(e.target.checked) }} />
          <span className="dsh-http-switch" aria-hidden="true" />
          <span>{tt('panel.agentTools')}</span>
        </label>
        <button type="button" className="dsh-http-ghost" onClick={close}>{tt('panel.back')}</button>
      </header>

      <BannerView banner={banner} onClose={() => { setBanner(undefined) }} />

      <div className="dsh-http-body">
        <aside className="dsh-http-side">
          <div className="dsh-http-sideTop">
            <div className="dsh-http-targetRow">
              <select
                className="dsh-http-select dsh-http-targetSelect"
                value={scope.id}
                disabled={sending !== undefined}
                aria-label={tt('targets.select')}
                onChange={(e) => {
                  if (e.target.value === NEW_TARGET) setForm({ mode: 'create' })
                  else setScopeId(e.target.value)
                }}
              >
                <option value={DIRECT_TARGET_ID}>{tt('targets.direct')}</option>
                {targets.map(target => <option key={target.id} value={target.id}>{target.name}</option>)}
                <option value={NEW_TARGET}>{tt('targets.addOption')}</option>
              </select>
              <button type="button" className="dsh-http-iconButton" data-boxed aria-label={tt('targets.edit')} title={tt('targets.edit')} disabled={direct} onClick={() => { if (!direct) setForm({ mode: 'edit', target: scope }) }}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11.5 2.5 13.5 4.5 5.5 12.5 2.5 13.5 3.5 10.5z" /></svg>
              </button>
            </div>
            {direct ? (
              <div className="dsh-http-targetInfo">
                <span className="dsh-http-targetMeta" data-wrap>{tt('targets.directHint')}</span>
              </div>
            ) : (
              <div className="dsh-http-targetInfo">
                <span className="dsh-http-targetUrl" title={scope.baseUrl}>{scope.baseUrl}</span>
                <span className="dsh-http-targetMeta">{authLabel(scope)} · {scope.allowMutations ? tt('targets.mutations') : tt('targets.readOnly')}</span>
                <button type="button" className="dsh-http-link" disabled={testing} onClick={() => { void runTest(scope) }}>{tt('targets.test')}</button>
              </div>
            )}
          </div>
          <div className="dsh-http-sideTabs" role="tablist">
            <button type="button" role="tab" aria-selected={sideTab === 'requests'} className="dsh-http-tab" {...(sideTab === 'requests' ? { 'data-active': '' } : {})} onClick={() => { setSideTab('requests') }}>{tt('side.requests')}{requests.length > 0 && <span className="dsh-http-count">{requests.length}</span>}</button>
            <button type="button" role="tab" aria-selected={sideTab === 'history'} className="dsh-http-tab" {...(sideTab === 'history' ? { 'data-active': '' } : {})} onClick={() => { setSideTab('history') }}>{tt('side.history')}{history.length > 0 && <span className="dsh-http-count">{history.length}</span>}</button>
            <span className="dsh-http-spacer" />
            <button type="button" className="dsh-http-iconButton" data-accent aria-label={tt('requests.new')} title={tt('requests.new')} disabled={!loaded} onClick={() => { void createRequest() }}>+</button>
          </div>
          {sideTab === 'requests' ? (
            <RequestList
              requests={requests}
              selectedId={current?.id}
              filter={requestFilter}
              onFilter={setRequestFilter}
              onSelect={selectRequest}
              onRename={(id, name) => { editRequest(id, { name }) }}
              onDuplicate={duplicateRequest}
              onCopyCurl={(id) => { void copyCurl(id) }}
              onDelete={(id) => { setConfirmDeleteRequest(requests.find(r => r.id === id)) }}
            />
          ) : (
            <HistorySidebar
              entries={history}
              filter={historyFilter}
              onFilter={setHistoryFilter}
              activeId={displayed?.id}
              onPick={pickExchange}
              onSave={(entry) => { void createRequest(savedFromBuilder(builderFromExchange(entry))) }}
              onDelete={(entry) => { void deleteEntry(entry) }}
              onClear={() => { setConfirmClear(scope) }}
            />
          )}
        </aside>

        <div className="dsh-http-panesWrap">
          <div className="dsh-http-panes" ref={panesRef} style={{ ['--dsh-http-split' as string]: `${split}%` }} key={scope.id}>
            {current !== undefined ? (
              <RequestPane
                key={current.id}
                target={scope}
                state={builderFromSaved(current)}
                onChange={(builder: BuilderState) => { editRequest(current.id, savedFromBuilder(builder)) }}
                onSend={() => { void send() }}
                sending={sending !== undefined}
                tab={requestTab}
                onTab={setRequestTab}
                onEditTarget={() => { if (!direct) setForm({ mode: 'edit', target: scope }) }}
                onCreateTarget={() => { setForm({ mode: 'create', fromRequest: current }) }}
                onNotice={(text) => { setBanner({ kind: 'info', text }) }}
              />
            ) : (
              <div className="dsh-http-pane" data-pane="request">
                <div className="dsh-http-paneBody" data-center>
                  {loaded && (
                    <div className="dsh-http-hints">
                      <span>{tt('requests.none')}</span>
                      <button type="button" className="dsh-http-send" onClick={() => { void createRequest() }}>{tt('requests.new')}</button>
                      <span className="dsh-http-hintRow"><span>{tt('request.send')}</span><kbd className="dsh-http-kbd">{sendShortcut()}</kbd></span>
                    </div>
                  )}
                </div>
              </div>
            )}
            <div className="dsh-http-divider" role="separator" aria-label={tt('panel.resize')} onPointerDown={onDividerDown} onDoubleClick={() => { setSplit(50) }} />
            <ResponsePane
              exchange={displayed}
              versions={versions}
              onVersion={(exchange) => { setShown(prev => ({ ...prev, [scope.id]: exchange })) }}
              sendingSince={sending?.since}
              live={live}
              onCancel={() => { sending?.controller.abort() }}
              tab={responseTab}
              onTab={setResponseTab}
            />
          </div>
        </div>
      </div>

      {form !== undefined && (
        <TargetForm
          mode={form.mode}
          target={form.mode === 'edit' ? form.target : undefined}
          initialBaseUrl={form.mode === 'create' && form.fromRequest !== undefined ? originOf(form.fromRequest.path) : undefined}
          initialAuth={form.mode === 'create' ? requests.find(r => r.id === form.fromRequest?.id)?.auth : undefined}
          onCancel={() => { setForm(undefined) }}
          onSave={saveTarget}
          onDelete={form.mode === 'edit' ? () => { setConfirmDelete(form.target); setForm(undefined) } : undefined}
        />
      )}
      {confirmDelete !== undefined && (
        <Modal title={tt('targets.delete')} onClose={() => { setConfirmDelete(undefined) }} footer={<>
          <button type="button" className="dsh-http-ghost" onClick={() => { setConfirmDelete(undefined) }}>{tt('form.cancel')}</button>
          <button type="button" className="dsh-http-primary" data-danger onClick={() => { void runDeleteTarget(confirmDelete) }}>{tt('targets.delete')}</button>
        </>}>
          <p style={{ margin: 0 }}>{tt('targets.deleteConfirm', { name: confirmDelete.name })}</p>
        </Modal>
      )}
      {confirmDeleteRequest !== undefined && (
        <Modal title={tt('requests.delete')} onClose={() => { setConfirmDeleteRequest(undefined) }} footer={<>
          <button type="button" className="dsh-http-ghost" onClick={() => { setConfirmDeleteRequest(undefined) }}>{tt('form.cancel')}</button>
          <button type="button" className="dsh-http-primary" data-danger onClick={() => { void runDeleteRequest(confirmDeleteRequest) }}>{tt('requests.delete')}</button>
        </>}>
          <p style={{ margin: 0 }}>{tt('requests.deleteConfirm', { name: requestTitle(confirmDeleteRequest) })}</p>
        </Modal>
      )}
      {confirmClear !== undefined && (
        <Modal title={tt('history.clear')} onClose={() => { setConfirmClear(undefined) }} footer={<>
          <button type="button" className="dsh-http-ghost" onClick={() => { setConfirmClear(undefined) }}>{tt('form.cancel')}</button>
          <button type="button" className="dsh-http-primary" data-danger onClick={() => { void clearHistory(confirmClear) }}>{tt('history.clear')}</button>
        </>}>
          <p style={{ margin: 0 }}>{tt('history.clearConfirm', { name: confirmClear.name })}</p>
        </Modal>
      )}
    </section>
  )
}
