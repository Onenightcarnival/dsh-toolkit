// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { safeTextPrefix } from '../src/text.ts'
import { truncate } from '../src/content/extract.ts'
import { renderSnapshot, type SnapshotView } from '../src/content/snapshot.ts'
import { wrapUntrustedContent } from '../src/security/untrusted.ts'
import { MAX_SELECTION_CHARS, normalizeSelectionText, parseSelectionCapture } from '../src/selection.ts'

describe('Unicode in model-facing browser text', () => {
  it('keeps whole code points at every UTF-16 budget boundary', () => {
    const text = '中文 👍 🎉 ❤️ 🚀 𠮷 end'
    for (let limit = 0; limit <= text.length; limit++) {
      const prefix = safeTextPrefix(text, limit)
      expect(prefix.length).toBeLessThanOrEqual(limit)
      expect(text.startsWith(prefix)).toBe(true)
      expect(prefix).not.toMatch(/\p{Surrogate}/u)
    }
    expect(safeTextPrefix(text, text.length)).toBe(text)
  })

  it('repairs existing lone surrogates without changing valid emoji', () => {
    expect(safeTextPrefix('a\uD83Db\uDE80🚀', 100)).toBe('a�b�🚀')
    expect(truncate('a\uD83Db', 100)).toEqual({ text: 'a�b', truncated: 0 })
  })

  it('counts both removed halves when extraction would split an emoji', () => {
    expect(truncate('a🚀b', 2)).toEqual({ text: 'a…', truncated: 3 })
    expect(truncate('a🚀b', 3)).toEqual({ text: 'a🚀…', truncated: 1 })
  })

  it.each([false, true])('keeps snapshot code points intact (delta=%s)', (delta) => {
    const view: SnapshotView = {
      version: 3, url: 'https://example.com/releases', title: 'Releases', ready: 'complete',
      main: 'Assets 3 👍 13 🎉 1 ❤️ 3 🚀 4', items: [], forms: [], changed: [-1],
      removed: [], reindexed: false, truncated: { mainChars: 0, itemsDropped: 0, formsDropped: 0 }, budgetChars: 4000,
    }
    const full = renderSnapshot(view, delta)
    const cut = full.indexOf('🚀') + 1
    expect(cut).toBeGreaterThan(0)
    const rendered = renderSnapshot(view, delta, cut)
    expect(rendered).toBe(`${full.slice(0, cut - 1)}…(truncated to the snapshot character budget)`)
    const wrapped = wrapUntrustedContent(rendered, 5000, 'regression')
    expect(wrapped).not.toMatch(/\p{Surrogate}/u)
    expect(JSON.stringify(wrapped)).not.toContain('\\ud83d')
  })

  it('preserves security boundaries and valid Unicode at every wrapper budget', () => {
    const nonce = 'unicode-test'
    const minimum = wrapUntrustedContent('', 5000, nonce).length + 80
    for (let maxChars = minimum; maxChars < minimum + 40; maxChars++) {
      const wrapped = wrapUntrustedContent('🚀'.repeat(1000), maxChars, nonce)
      expect(wrapped.length).toBeLessThanOrEqual(maxChars)
      expect(wrapped).not.toMatch(/\p{Surrogate}/u)
      expect(wrapped).toContain(`</UNTRUSTED_PAGE_CONTENT nonce="${nonce}">`)
    }
    expect(wrapUntrustedContent('bad\uD83D', 5000, nonce)).toContain('bad�')
  })

  it('keeps selected text and page titles well formed before attaching them', () => {
    const text = `${'a'.repeat(MAX_SELECTION_CHARS - 1)}🚀tail`
    expect(normalizeSelectionText(text)).toEqual({ text: 'a'.repeat(MAX_SELECTION_CHARS - 1), truncated: true })
    const capture = parseSelectionCapture({ text: 'bad\uDE80', title: `${'a'.repeat(199)}🚀tail`, url: 'https://example.com' })
    expect(capture?.text).toBe('bad�')
    expect(capture?.title).toBe('a'.repeat(199))
  })
})
