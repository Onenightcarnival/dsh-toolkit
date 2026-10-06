/**
 * The page selection each browser window's side panels may attach to a prompt.
 *
 * Selections are scoped per window; each window keeps only its newest
 * highlight. The tracker is pure: replace, dismiss, navigation and tab close
 * are handled without a browser runtime.
 *
 * @module
 */

import type { PageSelection, SelectionCapture } from '../selection.ts'

/** The frame a capture came from; iframes report their own document. */
export interface SelectionSource {
  windowId: number
  tabId: number
  frameId: number
}

/** Holds the latest selection for each window that has one. */
export class SelectionTracker {
  private entries = new Map<number, { source: SelectionSource; selection: PageSelection }>()
  /** Makes each stamped value unique even when two captures share a clock tick. */
  private lastCapturedAt = Number.NEGATIVE_INFINITY

  /**
   * Record a capture as its window's current selection.
   * @returns true when that window's panels must be told.
   */
  capture(source: SelectionSource, capture: SelectionCapture, now: number = Date.now()): boolean {
    const current = this.entries.get(source.windowId)
    if (current !== undefined
      && current.source.tabId === source.tabId
      && current.source.frameId === source.frameId
      && current.selection.text === capture.text
      && current.selection.truncated === capture.truncated
      && current.selection.title === capture.title
      && current.selection.url === capture.url) return false
    const capturedAt = Math.max(now, this.lastCapturedAt + 1)
    this.lastCapturedAt = capturedAt
    this.entries.set(source.windowId, { source: { ...source }, selection: { ...capture, capturedAt } })
    return true
  }

  current(windowId: number): PageSelection | null {
    const entry = this.entries.get(windowId)
    return entry === undefined ? null : { ...entry.selection }
  }

  /** The frame that owns a window's current selection, when it has one. */
  source(windowId: number): SelectionSource | null {
    const source = this.entries.get(windowId)?.source
    return source === undefined ? null : { ...source }
  }

  /** @returns true when that window's selection was dropped. */
  clear(windowId: number): boolean {
    return this.entries.delete(windowId)
  }

  /**
   * Drop a selection only if it is still the one a panel acted on. The
   * complete stamped value must match; a newer highlight is left in place.
   */
  clearIfCurrent(windowId: number, expected: PageSelection): boolean {
    const current = this.entries.get(windowId)?.selection
    if (current === undefined
      || current.capturedAt !== expected.capturedAt
      || current.text !== expected.text
      || current.truncated !== expected.truncated
      || current.title !== expected.title
      || current.url !== expected.url) return false
    this.entries.delete(windowId)
    return true
  }

  /**
   * Drop selections whose page went away.
   * @param frameId - when given, drop only a capture from that exact frame.
   * @returns the windows whose panels must be told.
   */
  clearTab(tabId: number, frameId?: number): number[] {
    const affected: number[] = []
    for (const [windowId, entry] of this.entries) {
      if (entry.source.tabId !== tabId) continue
      if (frameId !== undefined && entry.source.frameId !== frameId) continue
      affected.push(windowId)
    }
    for (const windowId of affected) this.entries.delete(windowId)
    return affected
  }

  /** @returns the windows whose panels must be told. */
  clearAll(): number[] {
    const affected = [...this.entries.keys()]
    this.entries.clear()
    return affected
  }

  /** The frames still holding a selection, for targeted content-script resets. */
  sourcesWithSelection(): SelectionSource[] {
    const sources = new Map<string, SelectionSource>()
    for (const { source } of this.entries.values()) {
      sources.set(`${source.tabId}:${source.frameId}`, { ...source })
    }
    return [...sources.values()]
  }
}
