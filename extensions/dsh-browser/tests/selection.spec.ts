// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  MAX_SELECTION_CHARS,
  normalizeSelectionText,
  parsePageSelection,
  parseSelectionCapture,
} from '../src/selection.ts'

describe('selection normalization', () => {
  it('keeps line structure while collapsing horizontal whitespace', () => {
    const { text, truncated } = normalizeSelectionText('  first   line \n\t second\tline  ')
    expect(text).toBe('first line\nsecond line')
    expect(truncated).toBe(false)
  })

  it('keeps paragraph breaks but drops longer runs of blank lines', () => {
    expect(normalizeSelectionText('one\n\n\n\ntwo').text).toBe('one\n\ntwo')
  })

  it('truncates a highlight larger than the capture ceiling', () => {
    const { text, truncated } = normalizeSelectionText('x'.repeat(MAX_SELECTION_CHARS + 10))
    expect(text).toHaveLength(MAX_SELECTION_CHARS)
    expect(truncated).toBe(true)
  })

  it('reports whitespace-only highlights as empty', () => {
    expect(normalizeSelectionText(' \n \t ').text).toBe('')
  })
})

describe('capture validation', () => {
  it('normalizes and keeps a well-formed capture', () => {
    expect(parseSelectionCapture({
      text: '  quoted   text ',
      truncated: false,
      title: ' Example  Page ',
      url: 'https://example.com/a',
    })).toEqual({
      text: 'quoted text',
      truncated: false,
      title: 'Example Page',
      url: 'https://example.com/a',
    })
  })

  it('re-applies the ceiling a page may have ignored', () => {
    const capture = parseSelectionCapture({ text: 'y'.repeat(MAX_SELECTION_CHARS * 2), truncated: false })
    expect(capture?.text).toHaveLength(MAX_SELECTION_CHARS)
    expect(capture?.truncated).toBe(true)
  })

  it('drops a source URL that is not a page the extension runs in', () => {
    expect(parseSelectionCapture({ text: 'quoted', url: 'javascript:alert(1)' })?.url).toBe('')
    expect(parseSelectionCapture({ text: 'quoted', url: 'file:///etc/passwd' })?.url).toBe('')
  })

  it('rejects payloads without usable text', () => {
    expect(parseSelectionCapture(null)).toBeNull()
    expect(parseSelectionCapture({ text: 42 })).toBeNull()
    expect(parseSelectionCapture({ text: '   ' })).toBeNull()
  })
})

describe('stamped selection validation', () => {
  it('requires a capture timestamp', () => {
    expect(parsePageSelection({ text: 'quoted', capturedAt: 5 })?.capturedAt).toBe(5)
    expect(parsePageSelection({ text: 'quoted' })).toBeNull()
    expect(parsePageSelection({ text: 'quoted', capturedAt: 'now' })).toBeNull()
  })
})
