// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

function chromeEvent<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>()
  return {
    addListener: vi.fn((listener: (...args: T) => void) => { listeners.add(listener) }),
    removeListener: vi.fn((listener: (...args: T) => void) => { listeners.delete(listener) }),
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

function tab(tabId: number, overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: tabId,
    index: 0,
    pinned: false,
    highlighted: true,
    active: true,
    incognito: false,
    selected: true,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    windowId: 1,
    title: `Tab ${tabId}`,
    url: `https://example.com/${tabId}`,
    ...overrides,
  }
}

const sender = { id: 'test-extension', tab: tab(1), frameId: 0 } as chrome.runtime.MessageSender

const capture = {
  text: 'dsh plugin: Chrome sidebar extension',
  truncated: false,
  title: 'Lum1104/dsh-browser',
  url: 'https://example.com/1',
}

function mockChrome(sharePageContent: 'auto' | 'off' = 'auto') {
  const onConnect = chromeEvent<[chrome.runtime.Port]>()
  const onMessage = chromeEvent<[unknown, chrome.runtime.MessageSender, (response: unknown) => void]>()
  const onUpdated = chromeEvent<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>()
  const onRemoved = chromeEvent<[number]>()
  const onReplaced = chromeEvent<[number, number]>()
  const onCommitted = chromeEvent<[{ tabId: number; frameId: number }]>()
  const sendMessage = vi.fn(async (
    _tabId: number,
    _message: unknown,
    _options?: chrome.tabs.MessageSendOptions,
  ) => {})
  const query = vi.fn(async () => [tab(1)])
  vi.stubGlobal('chrome', {
    alarms: { create: vi.fn(), clear: vi.fn(async () => true), onAlarm: chromeEvent<[chrome.alarms.Alarm]>() },
    notifications: {
      create: vi.fn(async () => ''),
      clear: vi.fn(async () => true),
      onClicked: chromeEvent<[string]>(),
    },
    action: { onClicked: chromeEvent<[chrome.tabs.Tab]>() },
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onConnect,
      onMessage,
    },
    sidePanel: { open: vi.fn(async () => {}), setPanelBehavior: vi.fn(async () => {}) },
    storage: {
      local: {
        get: vi.fn(async () => ({ dshSettings: { sharePageContent } })),
        set: vi.fn(async () => {}),
      },
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => tab(tabId)),
      query,
      sendMessage,
      onActivated: chromeEvent<[{ tabId: number; windowId: number }]>(),
      onUpdated,
      onReplaced,
      onRemoved,
    },
    webNavigation: { onCommitted },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: chromeEvent<[number]>(),
      onRemoved: chromeEvent<[number]>(),
    },
  } as unknown as typeof chrome)
  return { onCommitted, onConnect, onMessage, onRemoved, onReplaced, onUpdated, query, sendMessage }
}

async function connectPanelForTest(sharePageContent: 'auto' | 'off' = 'auto', windowId = 1) {
  const chromeMock = mockChrome(sharePageContent)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
  await import('../src/background/index.ts')
  await vi.waitFor(() => { expect(chromeMock.query).toHaveBeenCalled() })

  const panel = panelPort()
  chromeMock.onConnect.emit(panel.port)
  await vi.waitFor(() => {
    expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tab-affinity' }))
  })
  panel.onMessage.emit({ type: 'panel.window', windowId })
  await vi.waitFor(() => {
    expect(panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'selection' }))
  })
  panel.postMessage.mockClear()
  // Both the runtime (content scripts) and the port (panel) carry onMessage.
  return { ...chromeMock, ...panel, runtimeMessages: chromeMock.onMessage, panelMessages: panel.onMessage }
}

function selectionMessages(postMessage: ReturnType<typeof vi.fn>): unknown[] {
  return postMessage.mock.calls
    .map(([message]) => message as { type?: string; selection?: unknown })
    .filter((message) => message.type === 'selection')
    .map((message) => message.selection)
}

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('page selection capture', () => {
  it('arms the content scripts once a panel is open', async () => {
    const { sendMessage } = await connectPanelForTest()

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
        type: 'DSH_SELECTION_WATCH',
        enabled: true,
      }))
    })
  })

  it('tells a freshly loaded document whether to watch selections', async () => {
    const { runtimeMessages } = await connectPanelForTest()
    const respond = vi.fn()

    runtimeMessages.emit({ type: 'DSH_CONTENT_READY' }, sender, respond)

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ selectionWatch: true }))
  })

  it('stamps arm commands so a stale delivery cannot undo a newer one', async () => {
    const { onDisconnect, onConnect, sendMessage } = await connectPanelForTest()
    await vi.waitFor(() => { expect(sendMessage).toHaveBeenCalled() })

    onDisconnect.emit()
    const reopened = panelPort()
    onConnect.emit(reopened.port)
    reopened.onMessage.emit({ type: 'panel.window', windowId: 1 })

    await vi.waitFor(() => {
      const commands = sendMessage.mock.calls
        .map(([, message]) => message as { type?: string; enabled?: boolean; revision?: number })
        .filter((message) => message.type === 'DSH_SELECTION_WATCH')
      expect(commands.length).toBeGreaterThanOrEqual(2)
      // Every command is ordered, so a late arrival is identifiable as stale.
      const revisions = commands.map((command) => command.revision)
      expect(revisions).toEqual([...revisions].sort((a, b) => (a ?? 0) - (b ?? 0)))
      expect(new Set(revisions).size).toBe(revisions.length)
    })
  })

  it('broadcasts a capture from the page the user is looking at', async () => {
    const { runtimeMessages, postMessage } = await connectPanelForTest()

    runtimeMessages.emit({ type: 'DSH_SELECTION', selection: capture }, sender, vi.fn())

    await vi.waitFor(() => { expect(selectionMessages(postMessage)).toHaveLength(1) })
    expect(selectionMessages(postMessage)[0]).toMatchObject({
      text: capture.text,
      title: capture.title,
      url: capture.url,
    })
  })

  it('ignores a capture from a tab the user is not looking at', async () => {
    const { runtimeMessages, postMessage } = await connectPanelForTest()

    runtimeMessages.emit(
      { type: 'DSH_SELECTION', selection: capture },
      { ...sender, tab: tab(7, { active: false }) } as chrome.runtime.MessageSender,
      vi.fn(),
    )
    // The visible tab's own selection proves the rejected one never landed.
    runtimeMessages.emit({ type: 'DSH_SELECTION', selection: { ...capture, text: 'visible tab' } }, sender, vi.fn())

    await vi.waitFor(() => { expect(selectionMessages(postMessage)).toHaveLength(1) })
    expect(selectionMessages(postMessage)[0]).toMatchObject({ text: 'visible tab' })
  })

  it('does not query Chrome for a capture it will not accept', async () => {
    const { runtimeMessages, query } = await connectPanelForTest()
    query.mockClear()

    for (let attempt = 0; attempt < 5; attempt += 1) {
      runtimeMessages.emit(
        { type: 'DSH_SELECTION', selection: { ...capture, text: `spam ${attempt}` } },
        { ...sender, tab: tab(7, { active: false }) } as chrome.runtime.MessageSender,
        vi.fn(),
      )
    }
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    // A background page must not be able to drive tabs.query by selecting.
    expect(query).not.toHaveBeenCalled()
  })

  it('keeps a selection inside the window that made it', async () => {
    const { runtimeMessages, postMessage, onConnect } = await connectPanelForTest()
    const otherWindow = panelPort()
    onConnect.emit(otherWindow.port)
    otherWindow.onMessage.emit({ type: 'panel.window', windowId: 2 })
    await vi.waitFor(() => { expect(otherWindow.postMessage).toHaveBeenCalled() })
    otherWindow.postMessage.mockClear()

    runtimeMessages.emit({ type: 'DSH_SELECTION', selection: capture }, sender, vi.fn())

    await vi.waitFor(() => { expect(selectionMessages(postMessage)).toHaveLength(1) })
    expect(selectionMessages(otherWindow.postMessage)).toHaveLength(0)
  })

  it('ignores captures from a window that has no open panel', async () => {
    const { runtimeMessages, postMessage } = await connectPanelForTest()

    runtimeMessages.emit(
      { type: 'DSH_SELECTION', selection: capture },
      { ...sender, tab: tab(7, { active: true, windowId: 2 }) } as chrome.runtime.MessageSender,
      vi.fn(),
    )
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    expect(selectionMessages(postMessage)).toHaveLength(0)
  })

  it('never captures while page sharing is off', async () => {
    const { runtimeMessages, postMessage, sendMessage } = await connectPanelForTest('off')
    const respond = vi.fn()

    runtimeMessages.emit({ type: 'DSH_CONTENT_READY' }, sender, respond)
    runtimeMessages.emit({ type: 'DSH_SELECTION', selection: capture }, sender, vi.fn())
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ selectionWatch: false }))
    expect(selectionMessages(postMessage)).toHaveLength(0)
    expect(sendMessage).not.toHaveBeenCalledWith(1, expect.objectContaining({
      type: 'DSH_SELECTION_WATCH',
      enabled: true,
    }))
  })

  it('drops the quote when its own frame commits a navigation', async () => {
    const { runtimeMessages, onCommitted, postMessage } = await connectPanelForTest()
    runtimeMessages.emit({ type: 'DSH_SELECTION', selection: capture }, sender, vi.fn())
    await vi.waitFor(() => { expect(selectionMessages(postMessage)).toHaveLength(1) })

    onCommitted.emit({ tabId: 1, frameId: 0 })

    expect(selectionMessages(postMessage).at(-1)).toBeNull()
  })

  it('keeps a top-level quote when a subframe navigates', async () => {
    const { runtimeMessages, onCommitted, postMessage } = await connectPanelForTest()
    runtimeMessages.emit({ type: 'DSH_SELECTION', selection: capture }, sender, vi.fn())
    await vi.waitFor(() => { expect(selectionMessages(postMessage)).toHaveLength(1) })

    onCommitted.emit({ tabId: 1, frameId: 9 })

    expect(selectionMessages(postMessage)).toHaveLength(1)
  })

  it('keeps a quote through a same-document history update', async () => {
    const { runtimeMessages, onUpdated, postMessage } = await connectPanelForTest()
    runtimeMessages.emit({ type: 'DSH_SELECTION', selection: capture }, sender, vi.fn())
    await vi.waitFor(() => { expect(selectionMessages(postMessage)).toHaveLength(1) })

    // An SPA pushState reports a new URL without replacing the document.
    onUpdated.emit(1, { url: 'https://example.com/1#section' }, tab(1))

    expect(selectionMessages(postMessage)).toHaveLength(1)
  })

  it('drops the quote when its tab closes', async () => {
    const { runtimeMessages, onRemoved, postMessage } = await connectPanelForTest()
    runtimeMessages.emit({ type: 'DSH_SELECTION', selection: capture }, sender, vi.fn())
    await vi.waitFor(() => { expect(selectionMessages(postMessage)).toHaveLength(1) })

    onRemoved.emit(1)

    expect(selectionMessages(postMessage).at(-1)).toBeNull()
  })

  it('drops the quote when Chrome replaces its tab document', async () => {
    const { runtimeMessages, onReplaced, postMessage } = await connectPanelForTest()
    runtimeMessages.emit({ type: 'DSH_SELECTION', selection: capture }, sender, vi.fn())
    await vi.waitFor(() => { expect(selectionMessages(postMessage)).toHaveLength(1) })

    onReplaced.emit(5, 1)

    expect(selectionMessages(postMessage).at(-1)).toBeNull()
  })

  it('lets the page report the same passage again after a dismissal', async () => {
    const { runtimeMessages, panelMessages, postMessage, sendMessage } = await connectPanelForTest()
    runtimeMessages.emit({ type: 'DSH_SELECTION', selection: capture }, sender, vi.fn())
    await vi.waitFor(() => { expect(selectionMessages(postMessage)).toHaveLength(1) })
    sendMessage.mockClear()

    panelMessages.emit({ type: 'selection.clear' })

    expect(selectionMessages(postMessage).at(-1)).toBeNull()
    // Without this the content script would deduplicate the same text away.
    expect(sendMessage).toHaveBeenCalledWith(
      1,
      { type: 'DSH_SELECTION_RESET' },
      { frameId: 0 },
    )
  })

  it('resets deduplication in the iframe that supplied the quote', async () => {
    const { runtimeMessages, panelMessages, postMessage, sendMessage } = await connectPanelForTest()
    runtimeMessages.emit(
      { type: 'DSH_SELECTION', selection: capture },
      { ...sender, frameId: 4 },
      vi.fn(),
    )
    await vi.waitFor(() => { expect(selectionMessages(postMessage)).toHaveLength(1) })
    const submitted = selectionMessages(postMessage)[0]
    sendMessage.mockClear()

    panelMessages.emit({ type: 'selection.clear', selection: submitted })

    expect(sendMessage).toHaveBeenCalledWith(
      1,
      { type: 'DSH_SELECTION_RESET' },
      { frameId: 4 },
    )
  })

  it('does not clear a newer capture when an older send finishes', async () => {
    const { runtimeMessages, panelMessages, postMessage } = await connectPanelForTest()
    runtimeMessages.emit({ type: 'DSH_SELECTION', selection: capture }, sender, vi.fn())
    await vi.waitFor(() => { expect(selectionMessages(postMessage)).toHaveLength(1) })
    const submitted = selectionMessages(postMessage)[0]
    runtimeMessages.emit(
      { type: 'DSH_SELECTION', selection: { ...capture, text: 'newer highlight' } },
      sender,
      vi.fn(),
    )
    await vi.waitFor(() => { expect(selectionMessages(postMessage)).toHaveLength(2) })

    panelMessages.emit({ type: 'selection.clear', selection: submitted })

    expect(selectionMessages(postMessage).at(-1)).toMatchObject({ text: 'newer highlight' })
  })

  it('clears the quote for every panel in the window that dismissed it', async () => {
    const { runtimeMessages, panelMessages, postMessage, onConnect } = await connectPanelForTest()
    const peer = panelPort()
    onConnect.emit(peer.port)
    peer.onMessage.emit({ type: 'panel.window', windowId: 1 })
    await vi.waitFor(() => {
      expect(peer.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'selection' }))
    })
    peer.postMessage.mockClear()
    runtimeMessages.emit({ type: 'DSH_SELECTION', selection: capture }, sender, vi.fn())
    await vi.waitFor(() => { expect(selectionMessages(postMessage)).toHaveLength(1) })
    await vi.waitFor(() => { expect(selectionMessages(peer.postMessage)).toHaveLength(1) })
    const submitted = selectionMessages(postMessage)[0]

    panelMessages.emit({ type: 'selection.clear', selection: submitted })

    expect(selectionMessages(postMessage).at(-1)).toBeNull()
    expect(selectionMessages(peer.postMessage).at(-1)).toBeNull()
  })

  it('disarms the content scripts when the last panel closes', async () => {
    const { onDisconnect, sendMessage } = await connectPanelForTest()
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
        type: 'DSH_SELECTION_WATCH',
        enabled: true,
      }))
    })

    onDisconnect.emit()

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({
        type: 'DSH_SELECTION_WATCH',
        enabled: false,
      }))
    })
  })
})
