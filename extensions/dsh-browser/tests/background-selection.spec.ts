// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { SelectionTracker } from '../src/background/selection.ts'

const capture = {
  text: 'quoted text',
  truncated: false,
  title: 'Example page',
  url: 'https://example.com/a',
}

const source = { windowId: 1, tabId: 1, frameId: 0 }

describe('selection tracker', () => {
  it('stamps the newest capture and reports it once', () => {
    const tracker = new SelectionTracker()

    expect(tracker.capture(source, capture, 1_000)).toBe(true)
    expect(tracker.current(1)).toEqual({ ...capture, capturedAt: 1_000 })
    expect(tracker.capture(source, capture, 2_000)).toBe(false)
    expect(tracker.current(1)?.capturedAt).toBe(1_000)
  })

  it('replaces an older selection instead of collecting it', () => {
    const tracker = new SelectionTracker()
    tracker.capture(source, capture, 1_000)

    expect(tracker.capture(source, { ...capture, text: 'newer' }, 2_000)).toBe(true)
    expect(tracker.current(1)).toEqual({ ...capture, text: 'newer', capturedAt: 2_000 })
  })

  it('treats the same text in another frame as a new selection', () => {
    const tracker = new SelectionTracker()
    tracker.capture(source, capture, 1_000)

    expect(tracker.capture({ ...source, frameId: 3 }, capture, 2_000)).toBe(true)
  })

  it('updates metadata even when normalized text is unchanged', () => {
    const tracker = new SelectionTracker()
    tracker.capture(source, capture, 1_000)

    expect(tracker.capture(source, { ...capture, truncated: true }, 2_000)).toBe(true)
    expect(tracker.current(1)?.truncated).toBe(true)
  })

  it('keeps each window on its own selection', () => {
    const tracker = new SelectionTracker()
    tracker.capture(source, capture, 1_000)
    tracker.capture({ windowId: 2, tabId: 9, frameId: 0 }, { ...capture, text: 'other window' }, 1_000)

    expect(tracker.current(1)?.text).toBe('quoted text')
    expect(tracker.current(2)?.text).toBe('other window')
    expect(tracker.current(3)).toBeNull()
  })

  it('clears one window without disturbing another', () => {
    const tracker = new SelectionTracker()
    tracker.capture(source, capture, 1_000)
    tracker.capture({ windowId: 2, tabId: 9, frameId: 0 }, capture, 1_000)

    expect(tracker.clear(1)).toBe(true)
    expect(tracker.current(1)).toBeNull()
    expect(tracker.current(2)).not.toBeNull()
    expect(tracker.clear(1)).toBe(false)
  })

  it('does not clear a newer selection when a stale send completes', () => {
    const tracker = new SelectionTracker()
    tracker.capture(source, capture, 1_000)
    const submitted = tracker.current(1)!
    tracker.capture(source, { ...capture, text: 'newer quote' }, 2_000)

    expect(tracker.clearIfCurrent(1, submitted)).toBe(false)
    expect(tracker.current(1)?.text).toBe('newer quote')
    expect(tracker.source(1)).toEqual(source)
  })

  it('conditionally clears the selection a panel actually used', () => {
    const tracker = new SelectionTracker()
    tracker.capture(source, capture, 1_000)

    expect(tracker.clearIfCurrent(1, tracker.current(1)!)).toBe(true)
    expect(tracker.current(1)).toBeNull()
    expect(tracker.source(1)).toBeNull()
  })

  it('gives a re-capture a new identity within the same clock tick', () => {
    const tracker = new SelectionTracker()
    tracker.capture(source, capture, 1_000)
    const first = tracker.current(1)!
    tracker.clear(1)
    tracker.capture(source, capture, 1_000)

    expect(tracker.current(1)?.capturedAt).toBe(1_001)
    expect(tracker.clearIfCurrent(1, first)).toBe(false)
  })

  it('drops the selection when its own page goes away', () => {
    const tracker = new SelectionTracker()
    tracker.capture(source, capture, 1_000)

    expect(tracker.clearTab(2)).toEqual([])
    expect(tracker.current(1)).not.toBeNull()
    expect(tracker.clearTab(1)).toEqual([1])
    expect(tracker.current(1)).toBeNull()
  })

  it('reports every window that lost a selection with one tab', () => {
    const tracker = new SelectionTracker()
    tracker.capture(source, capture, 1_000)
    tracker.capture({ windowId: 2, tabId: 1, frameId: 0 }, capture, 1_000)

    expect(tracker.clearTab(1).sort()).toEqual([1, 2])
  })

  it('invalidates only the frame that navigated', () => {
    const tracker = new SelectionTracker()
    tracker.capture({ ...source, frameId: 4 }, capture, 1_000)

    // A sibling or parent frame navigating leaves this quote alone.
    expect(tracker.clearTab(1, 0)).toEqual([])
    expect(tracker.current(1)).not.toBeNull()
    expect(tracker.clearTab(1, 4)).toEqual([1])
    expect(tracker.current(1)).toBeNull()
  })

  it('clears every window at once when watching stops', () => {
    const tracker = new SelectionTracker()
    tracker.capture(source, capture, 1_000)
    tracker.capture({ windowId: 2, tabId: 9, frameId: 0 }, capture, 1_000)

    expect(tracker.clearAll().sort()).toEqual([1, 2])
    expect(tracker.current(1)).toBeNull()
    expect(tracker.clearAll()).toEqual([])
  })

  it('lists the frames holding a selection for content-script resets', () => {
    const tracker = new SelectionTracker()
    tracker.capture(source, capture, 1_000)
    tracker.capture({ windowId: 2, tabId: 1, frameId: 0 }, capture, 1_000)
    tracker.capture({ windowId: 3, tabId: 9, frameId: 0 }, capture, 1_000)

    expect(tracker.sourcesWithSelection()).toEqual([
      { windowId: 2, tabId: 1, frameId: 0 },
      { windowId: 3, tabId: 9, frameId: 0 },
    ])
  })

  it('hands out copies so a panel broadcast cannot mutate the state', () => {
    const tracker = new SelectionTracker()
    tracker.capture(source, capture, 1_000)

    const first = tracker.current(1)!
    first.text = 'tampered'

    expect(tracker.current(1)?.text).toBe('quoted text')
  })
})
