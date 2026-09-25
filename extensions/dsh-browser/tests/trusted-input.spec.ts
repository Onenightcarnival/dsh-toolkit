// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseKeyCombo } from '../src/key-combo.ts'

type Sent = { method: string; params?: Record<string, unknown> }

const sent: Sent[] = []
let attachCalls = 0
const detachListeners: Array<(source: { tabId?: number }) => void> = []

beforeEach(() => {
  sent.length = 0
  attachCalls = 0
  vi.stubGlobal('chrome', {
    debugger: {
      attach: vi.fn(async () => { attachCalls += 1 }),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (_target: unknown, method: string, params?: Record<string, unknown>) => {
        sent.push({ method, ...(params === undefined ? {} : { params }) })
        if (method === 'Runtime.evaluate') {
          const expression = String(params?.expression)
          if (expression.includes('throw')) return { exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: nope' } } }
          if (expression === 'undefined') return { result: { type: 'undefined' } }
          return { result: { type: 'number', value: 42 } }
        }
        if (method === 'Page.captureScreenshot') return { data: 'AAAA' }
        return {}
      }),
      onDetach: { addListener: (fn: (source: { tabId?: number }) => void) => { detachListeners.push(fn) } },
    },
    permissions: { contains: vi.fn(async () => true) },
  })
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function load(): Promise<typeof import('../src/background/debugger-input.ts')> {
  return import('../src/background/debugger-input.ts')
}

describe('parseKeyCombo', () => {
  it('handles modifiers, aliases, the bare plus key, and modifier-only combos', () => {
    expect(parseKeyCombo('Ctrl+Shift+ArrowDown')).toEqual({ key: 'ArrowDown', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false })
    expect(parseKeyCombo('cmd+enter')).toMatchObject({ key: 'enter', metaKey: true })
    expect(parseKeyCombo('Option+a')).toMatchObject({ key: 'a', altKey: true })
    expect(parseKeyCombo('+')).toMatchObject({ key: '+' })
    expect(parseKeyCombo('Ctrl+Shift')).toMatchObject({ key: '', ctrlKey: true, shiftKey: true })
    expect(parseKeyCombo('Control')).toMatchObject({ key: 'Control', ctrlKey: true })
  })
})

describe('describeKey', () => {
  it('maps named keys to CDP descriptors and printable characters through their char code', async () => {
    const { describeKey } = await load()
    expect(describeKey('Enter')).toEqual({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' })
    expect(describeKey('Tab')).toEqual({ key: 'Tab', code: 'Tab', keyCode: 9 })
    expect(describeKey('a')).toEqual({ key: 'a', code: 'KeyA', keyCode: 65, text: 'a' })
    expect(describeKey('7')).toEqual({ key: '7', code: 'Digit7', keyCode: 55, text: '7' })
    expect(describeKey('/')).toMatchObject({ key: '/', code: '', text: '/' })
    expect(describeKey('Space')).toMatchObject({ code: 'Space', text: ' ' })
    expect(describeKey('Unknown')).toEqual({ key: 'Unknown', code: 'Unknown', keyCode: 0 })
  })
})

describe('debugger sessions', () => {
  it('attaches once per tab, shares concurrent attach attempts, and forgets on detach', async () => {
    const mod = await load()
    await Promise.all([mod.attachDebugger(7), mod.attachDebugger(7)])
    await mod.attachDebugger(7)
    expect(attachCalls).toBe(1)
    expect(mod.debuggerAttached(7)).toBe(true)
    detachListeners.at(-1)?.({ tabId: 7 })
    expect(mod.debuggerAttached(7)).toBe(false)
    await mod.attachDebugger(7)
    await mod.attachDebugger(8)
    await mod.detachAllDebuggers()
    expect(mod.debuggerAttached(7)).toBe(false)
    expect(mod.debuggerAttached(8)).toBe(false)
    expect(chrome.debugger.detach).toHaveBeenCalledTimes(2)
    await expect(mod.detachDebugger(99)).resolves.toBeUndefined()
  })

  it('dispatches mouse press/release pairs, drags with intermediate moves, and key chords', async () => {
    const mod = await load()
    await mod.debuggerClick(1, { x: 10, y: 20, clickCount: 2 })
    const clickTypes = sent.map((entry) => `${entry.params?.type}:${entry.params?.clickCount ?? ''}`)
    expect(clickTypes).toEqual(['mouseMoved:', 'mousePressed:1', 'mouseReleased:1', 'mousePressed:2', 'mouseReleased:2'])

    sent.length = 0
    await mod.debuggerDrag(1, { x: 0, y: 0 }, { x: 100, y: 50 })
    expect(sent[0]?.params?.type).toBe('mouseMoved')
    expect(sent[1]?.params?.type).toBe('mousePressed')
    expect(sent.at(-1)?.params).toMatchObject({ type: 'mouseReleased', x: 100, y: 50 })
    expect(sent.filter((entry) => entry.params?.type === 'mouseMoved' && entry.params.buttons === 1)).toHaveLength(10)

    sent.length = 0
    await mod.debuggerPress(1, { key: 'a', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false })
    expect(sent.map((entry) => entry.params?.type)).toEqual(['rawKeyDown', 'keyUp'])
    expect(sent[0]?.params).toMatchObject({ key: 'a', code: 'KeyA', modifiers: 2 })
    expect(sent[0]?.params?.text).toBeUndefined()

    sent.length = 0
    await mod.debuggerPress(1, { key: 'Enter', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false })
    expect(sent[0]?.params).toMatchObject({ type: 'keyDown', text: '\r', windowsVirtualKeyCode: 13 })
  })

  it('evaluates through Runtime.evaluate and reports exceptions', async () => {
    const mod = await load()
    expect(await mod.debuggerEvaluate(1, '6 * 7')).toEqual({ ok: true, value: 42 })
    expect(await mod.debuggerEvaluate(1, 'undefined')).toEqual({ ok: true, value: null })
    expect(await mod.debuggerEvaluate(1, 'throw new Error("nope")')).toEqual({ ok: false, error: 'Error: nope' })
    expect(await mod.debuggerScreenshot(1)).toBe('data:image/png;base64,AAAA')
  })
})
