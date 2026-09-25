// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import {
  PageSessionContextTracker,
  pageUrlKey,
} from '../src/background/session-continuity.ts'

function webTab(id: number, url: string, windowId = 1) {
  return { id, windowId, url }
}

describe('pageUrlKey', () => {
  it('uses normalized origin and pathname while ignoring query and hash', () => {
    expect(pageUrlKey('HTTPS://Example.COM:443/orders/7?sort=desc#receipt'))
      .toBe('https://example.com/orders/7')
    expect(pageUrlKey('https://example.com/orders/7?sort=asc'))
      .toBe('https://example.com/orders/7')
  })

  it('preserves pathname distinctions and rejects non-http pages', () => {
    expect(pageUrlKey('https://example.com/orders')).not.toBe(pageUrlKey('https://example.com/orders/'))
    expect(pageUrlKey('chrome://extensions')).toBeUndefined()
    expect(pageUrlKey('file:///tmp/report.html')).toBeUndefined()
    expect(pageUrlKey('not a url')).toBeUndefined()
  })
})

describe('PageSessionContextTracker', () => {
  it('restores only the same tab, window, origin, and pathname', async () => {
    const tracker = new PageSessionContextTracker({
      read: async () => ({
        version: 1,
        tabs: {
          7: { sessionId: 'session-7', windowId: 2, urlKey: 'https://example.com/orders', updatedAt: 10 },
        },
      }),
      write: async () => {},
    })
    await tracker.ready

    expect(tracker.candidate(webTab(7, 'https://example.com/orders?q=one#two', 2))).toBe('session-7')
    expect(tracker.candidate(webTab(7, 'https://example.com/account', 2))).toBeNull()
    expect(tracker.candidate(webTab(8, 'https://example.com/orders', 2))).toBeNull()
    expect(tracker.candidate(webTab(7, 'https://example.com/orders', 3))).toBeNull()
  })

  it('rebinds a session to one current tab and overwrites a tab restore target', async () => {
    const write = vi.fn(async () => {})
    const tracker = new PageSessionContextTracker({ read: async () => undefined, write }, () => 42)
    await tracker.ready

    tracker.bind('session-old', webTab(1, 'https://example.com/old'))
    tracker.bind('session-new', webTab(1, 'https://example.com/new'))
    tracker.bind('session-new', webTab(2, 'https://example.com/new'))

    expect(tracker.candidate(webTab(1, 'https://example.com/new'))).toBeNull()
    expect(tracker.candidate(webTab(2, 'https://example.com/new'))).toBe('session-new')
    await vi.waitFor(() => {
      expect(write).toHaveBeenLastCalledWith({
        version: 1,
        tabs: {
          2: { sessionId: 'session-new', windowId: 1, urlKey: 'https://example.com/new', updatedAt: 42 },
        },
      })
    })
  })

  it('keeps only the newest restored tab when storage contains a duplicate session', async () => {
    const tracker = new PageSessionContextTracker({
      read: async () => ({
        version: 1,
        tabs: {
          1: { sessionId: 'session', windowId: 1, urlKey: 'https://example.com/old', updatedAt: 1 },
          2: { sessionId: 'session', windowId: 1, urlKey: 'https://example.com/new', updatedAt: 2 },
        },
      }),
      write: async () => {},
    })
    await tracker.ready

    expect(tracker.candidate(webTab(1, 'https://example.com/old'))).toBeNull()
    expect(tracker.candidate(webTab(2, 'https://example.com/new'))).toBe('session')
  })

  it('removes unsupported-page bindings instead of leaving a stale checkpoint', async () => {
    const tracker = new PageSessionContextTracker({ read: async () => undefined, write: async () => {} })
    await tracker.ready
    tracker.bind('session', webTab(1, 'https://example.com/page'))
    tracker.bind('session', webTab(1, 'chrome://extensions'))
    expect(tracker.candidate(webTab(1, 'https://example.com/page'))).toBeNull()
  })

  it('cleans removed tabs and migrates replacement tab identities', async () => {
    const tracker = new PageSessionContextTracker({ read: async () => undefined, write: async () => {} })
    await tracker.ready
    tracker.bind('session', webTab(1, 'https://example.com/page'))
    expect(tracker.replaceTab(1, 9)).toBe(true)
    expect(tracker.candidate(webTab(1, 'https://example.com/page'))).toBeNull()
    expect(tracker.candidate(webTab(9, 'https://example.com/page'))).toBe('session')
    expect(tracker.removeTab(9)).toBe(true)
    expect(tracker.candidate(webTab(9, 'https://example.com/page'))).toBeNull()
  })

  it('does not let a late storage read overwrite newer memory state', async () => {
    let finishRead!: (value: unknown) => void
    const tracker = new PageSessionContextTracker({
      read: async () => await new Promise((resolve) => { finishRead = resolve }),
      write: async () => {},
    })
    tracker.bind('session-live', webTab(1, 'https://live.example/path'))
    finishRead({
      version: 1,
      tabs: {
        1: { sessionId: 'session-stale', windowId: 1, urlKey: 'https://stale.example/path', updatedAt: 1 },
      },
    })
    await tracker.ready
    expect(tracker.candidate(webTab(1, 'https://live.example/path'))).toBe('session-live')
  })
})
