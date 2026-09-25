// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { PAGE_SESSION_CONTEXT_STORAGE_KEY } from '../src/background/session-continuity.ts'

function chromeEvent<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>()
  return {
    addListener: vi.fn((listener: (...args: T) => void) => { listeners.add(listener) }),
    emit: (...args: T) => { for (const listener of listeners) listener(...args) },
  }
}

function panelPort() {
  const onMessage = chromeEvent<[unknown]>()
  const onDisconnect = chromeEvent<[]>()
  const postMessage = vi.fn()
  const port = { name: 'dsh-panel', postMessage, onMessage, onDisconnect } as unknown as chrome.runtime.Port
  return { onDisconnect, onMessage, port, postMessage }
}

function tab(id: number, url: string, windowId = 1): chrome.tabs.Tab {
  return {
    id,
    index: 0,
    pinned: false,
    highlighted: true,
    active: true,
    incognito: false,
    selected: true,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    windowId,
    title: `Tab ${id}`,
    url,
  }
}

function mockChrome(initialTabs: chrome.tabs.Tab[], storedContext?: unknown) {
  const tabs = new Map(initialTabs.map((entry) => [entry.id!, entry]))
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const onRemoved = chromeEvent<[number]>()
  const onReplaced = chromeEvent<[number, number]>()
  const sessionData: Record<string, unknown> = storedContext === undefined
    ? {}
    : { [PAGE_SESSION_CONTEXT_STORAGE_KEY]: storedContext }
  const sessionSet = vi.fn(async (items: Record<string, unknown>) => { Object.assign(sessionData, items) })
  const query = vi.fn(async (queryInfo: chrome.tabs.QueryInfo) => {
    const candidates = [...tabs.values()].filter((entry) => queryInfo.windowId === undefined || entry.windowId === queryInfo.windowId)
    return candidates.filter((entry) => queryInfo.active !== true || entry.active)
  })
  vi.stubGlobal('chrome', {
    alarms: { create: vi.fn(), clear: vi.fn(async () => true), onAlarm: chromeEvent<[chrome.alarms.Alarm]>() },
    notifications: {
      create: vi.fn(async () => ''),
      clear: vi.fn(async () => true),
      onClicked: chromeEvent<[string]>(),
    },
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onConnect,
      onMessage: chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>(),
    },
    sidePanel: { open: vi.fn(async () => {}), setPanelBehavior: vi.fn(async () => {}) },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      session: {
        get: vi.fn(async (key: string) => ({ [key]: sessionData[key] })),
        set: sessionSet,
        remove: vi.fn(async (key: string) => { delete sessionData[key] }),
      },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        const entry = tabs.get(tabId)
        if (entry === undefined) throw new Error('No tab')
        return entry
      }),
      query,
      sendMessage: vi.fn(async () => {}),
      onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
      onUpdated: chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>(),
      onReplaced,
      onRemoved,
    },
    webNavigation: { onCommitted: chromeEvent<[{ tabId: number; frameId: number }]>() },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: chromeEvent<[number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
  } as unknown as typeof chrome)
  return { onConnect, onRemoved, onReplaced, query, sessionData, sessionSet, tabs }
}

function resumeHints(postMessage: ReturnType<typeof vi.fn>): Array<string | null> {
  return postMessage.mock.calls
    .map(([message]) => message as { type?: string; sessionId?: string | null })
    .filter((message) => message.type === 'session.resume-hint')
    .map((message) => message.sessionId ?? null)
}

async function loadBackground(chromeMock: ReturnType<typeof mockChrome>) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
  await import('../src/background/index.ts')
  await vi.waitFor(() => { expect(chromeMock.query).toHaveBeenCalled() })
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('background contextual session continuity', () => {
  it('returns a hint only for the active tab with the same origin and pathname', async () => {
    const stored = {
      version: 1,
      tabs: {
        1: { sessionId: 'session-page', windowId: 1, urlKey: 'https://example.com/orders', updatedAt: 1 },
      },
    }
    const chromeMock = mockChrome([tab(1, 'https://example.com/orders?q=new#receipt')], stored)
    await loadBackground(chromeMock)

    const matching = panelPort()
    chromeMock.onConnect.emit(matching.port)
    matching.onMessage.emit({ type: 'panel.window', windowId: 1 })
    await vi.waitFor(() => { expect(resumeHints(matching.postMessage)).toContain('session-page') })

    chromeMock.tabs.set(1, tab(1, 'https://example.com/account'))
    const differentPath = panelPort()
    chromeMock.onConnect.emit(differentPath.port)
    differentPath.onMessage.emit({ type: 'panel.window', windowId: 1 })
    await vi.waitFor(() => { expect(resumeHints(differentPath.postMessage)).toContain(null) })

    chromeMock.tabs.delete(1)
    chromeMock.tabs.set(2, tab(2, 'https://example.com/orders'))
    const differentTab = panelPort()
    chromeMock.onConnect.emit(differentTab.port)
    differentTab.onMessage.emit({ type: 'panel.window', windowId: 1 })
    await vi.waitFor(() => { expect(resumeHints(differentTab.postMessage)).toContain(null) })
  })

  it('checkpoints panel-open navigation on close but ignores later user navigation', async () => {
    const chromeMock = mockChrome([tab(1, 'https://example.com/start')])
    await loadBackground(chromeMock)
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    panel.onMessage.emit({ type: 'panel.window', windowId: 1 })
    panel.onMessage.emit({ type: 'session.active', sessionId: 'session-live', isNew: true })
    await vi.waitFor(() => {
      expect(chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({
        tabs: { 1: { sessionId: 'session-live', urlKey: 'https://example.com/start' } },
      })
    })

    chromeMock.tabs.set(1, tab(1, 'https://example.com/during-panel?step=2'))
    panel.onDisconnect.emit()
    await vi.waitFor(() => {
      expect(chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({
        tabs: { 1: { sessionId: 'session-live', urlKey: 'https://example.com/during-panel' } },
      })
    })

    chromeMock.tabs.set(1, tab(1, 'https://example.com/after-close'))
    const reopened = panelPort()
    chromeMock.onConnect.emit(reopened.port)
    reopened.onMessage.emit({ type: 'panel.window', windowId: 1 })
    await vi.waitFor(() => { expect(resumeHints(reopened.postMessage)).toContain(null) })
    expect(chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({
      tabs: { 1: { urlKey: 'https://example.com/during-panel' } },
    })
  })

  it('moves the recovery binding when the user explicitly rebinds the session', async () => {
    const first = tab(1, 'https://example.com/first')
    const chromeMock = mockChrome([first])
    await loadBackground(chromeMock)
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    panel.onMessage.emit({ type: 'session.active', sessionId: 'session-live', isNew: true })
    await vi.waitFor(() => {
      expect(chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({ tabs: { 1: {} } })
    })

    chromeMock.tabs.set(1, { ...first, active: false })
    chromeMock.tabs.set(2, tab(2, 'https://example.com/second'))
    panel.onMessage.emit({ type: 'tab-affinity.rebind', id: 'rebind' })

    await vi.waitFor(() => {
      expect(panel.postMessage).toHaveBeenCalledWith({ type: 'tab-affinity.rebind.result', id: 'rebind', ok: true })
      expect(chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({
        tabs: { 2: { sessionId: 'session-live', urlKey: 'https://example.com/second' } },
      })
    })
    expect((chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY] as { tabs: Record<string, unknown> }).tabs)
      .not.toHaveProperty('1')
  })

  it('migrates replacement tabs and removes closed-tab recovery contexts', async () => {
    const chromeMock = mockChrome([tab(1, 'https://example.com/page')])
    await loadBackground(chromeMock)
    const panel = panelPort()
    chromeMock.onConnect.emit(panel.port)
    panel.onMessage.emit({ type: 'session.active', sessionId: 'session-live', isNew: true })
    await vi.waitFor(() => {
      expect(chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({ tabs: { 1: {} } })
    })

    chromeMock.tabs.delete(1)
    chromeMock.tabs.set(9, tab(9, 'https://example.com/page'))
    chromeMock.onReplaced.emit(9, 1)
    await vi.waitFor(() => {
      expect(chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({ tabs: { 9: {} } })
    })

    chromeMock.tabs.delete(9)
    chromeMock.onRemoved.emit(9)
    await vi.waitFor(() => {
      expect(chromeMock.sessionData[PAGE_SESSION_CONTEXT_STORAGE_KEY]).toMatchObject({ tabs: {} })
    })
  })
})
