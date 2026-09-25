/**
 * Trusted input through `chrome.debugger` (Chrome DevTools Protocol).
 *
 * Synthetic DOM events carry `isTrusted: false`: Tab does not move focus,
 * arrow keys do not walk menus, and canvas apps ignore them entirely. CDP's
 * `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` produce the same
 * events a real mouse and keyboard would. The cost is Chrome's "started
 * debugging this browser" bar while a tab is attached, so this path is opt-in
 * (the "trusted input" setting, which also requests the optional permission).
 *
 * The attachment is per tab and lazy; it is released when the setting is
 * turned off, when the tab closes, or when Chrome detaches it (DevTools
 * opened by the user, for example).
 *
 * @module
 */

const PROTOCOL_VERSION = '1.3'

const attached = new Set<number>()
const attaching = new Map<number, Promise<void>>()

if (typeof chrome !== 'undefined' && chrome.debugger?.onDetach !== undefined) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) attached.delete(source.tabId)
  })
}

/** Whether the optional debugger permission is currently granted. */
export async function debuggerPermitted(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ['debugger'] })
  } catch {
    return false
  }
}

/** Attach to a tab once; concurrent callers share the attempt. */
export async function attachDebugger(tabId: number): Promise<void> {
  if (attached.has(tabId)) return
  let pending = attaching.get(tabId)
  if (pending === undefined) {
    pending = chrome.debugger.attach({ tabId }, PROTOCOL_VERSION).then(() => { attached.add(tabId) }).finally(() => { attaching.delete(tabId) })
    attaching.set(tabId, pending)
  }
  await pending
}

/** Detach from one tab, ignoring a tab that was never attached. */
export async function detachDebugger(tabId: number): Promise<void> {
  if (!attached.has(tabId)) return
  attached.delete(tabId)
  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // Already gone.
  }
}

/** Detach from every tab (setting turned off, extension suspending). */
export async function detachAllDebuggers(): Promise<void> {
  await Promise.all([...attached].map((tabId) => detachDebugger(tabId)))
}

export function debuggerAttached(tabId: number): boolean {
  return attached.has(tabId)
}

async function send<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  return await chrome.debugger.sendCommand({ tabId }, method, params) as T
}

export interface MouseTarget {
  x: number
  y: number
  button?: 'left' | 'right'
  clickCount?: 1 | 2
}

/** Click at viewport coordinates with real mouse events. */
export async function debuggerClick(tabId: number, target: MouseTarget): Promise<void> {
  const button = target.button ?? 'left'
  const clickCount = target.clickCount ?? 1
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none' })
  for (let count = 1; count <= clickCount; count++) {
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button, clickCount: count })
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button, clickCount: count })
  }
}

/** Move the pointer to viewport coordinates (hover). */
export async function debuggerHover(tabId: number, x: number, y: number): Promise<void> {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
}

/** Press-drag-release from one point to another with intermediate moves. */
export async function debuggerDrag(tabId: number, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' })
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 })
  const steps = 10
  for (let step = 1; step <= steps; step++) {
    const x = from.x + ((to.x - from.x) * step) / steps
    const y = from.y + ((to.y - from.y) * step) / steps
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    await new Promise((resolve) => setTimeout(resolve, 16))
  }
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 })
}

/** Scroll with a wheel event at a point. */
export async function debuggerWheel(tabId: number, x: number, y: number, deltaY: number): Promise<void> {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
}

interface KeyDescriptor {
  key: string
  code: string
  keyCode: number
  text?: string
}

/** DOM key name → CDP key descriptor for the keys agents actually press. */
const SPECIAL_KEYS: Record<string, KeyDescriptor> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  F1: { key: 'F1', code: 'F1', keyCode: 112 }, F2: { key: 'F2', code: 'F2', keyCode: 113 }, F3: { key: 'F3', code: 'F3', keyCode: 114 },
  F4: { key: 'F4', code: 'F4', keyCode: 115 }, F5: { key: 'F5', code: 'F5', keyCode: 116 }, F6: { key: 'F6', code: 'F6', keyCode: 117 },
  F7: { key: 'F7', code: 'F7', keyCode: 118 }, F8: { key: 'F8', code: 'F8', keyCode: 119 }, F9: { key: 'F9', code: 'F9', keyCode: 120 },
  F10: { key: 'F10', code: 'F10', keyCode: 121 }, F11: { key: 'F11', code: 'F11', keyCode: 122 }, F12: { key: 'F12', code: 'F12', keyCode: 123 },
}

/** Describe a DOM key name for CDP; printable characters map through their char code. */
export function describeKey(key: string): KeyDescriptor {
  const special = SPECIAL_KEYS[key]
  if (special !== undefined) return special
  if (key.length === 1) {
    const upper = key.toUpperCase()
    const isLetter = /^[A-Z]$/.test(upper)
    const isDigit = /^[0-9]$/.test(key)
    return {
      key,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${key}` : '',
      keyCode: isLetter || isDigit ? upper.charCodeAt(0) : key.charCodeAt(0),
      text: key,
    }
  }
  return { key, code: key, keyCode: 0 }
}

export interface KeyChord {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

function modifierMask(chord: KeyChord): number {
  return (chord.altKey ? 1 : 0) | (chord.ctrlKey ? 2 : 0) | (chord.metaKey ? 4 : 0) | (chord.shiftKey ? 8 : 0)
}

/** Press and release one key (with modifiers) as trusted keyboard input. */
export async function debuggerPress(tabId: number, chord: KeyChord): Promise<void> {
  const descriptor = describeKey(chord.key)
  const modifiers = modifierMask(chord)
  const printable = descriptor.text !== undefined && !chord.ctrlKey && !chord.metaKey && !chord.altKey
  await send(tabId, 'Input.dispatchKeyEvent', {
    type: printable ? 'keyDown' : 'rawKeyDown',
    key: descriptor.key,
    code: descriptor.code,
    windowsVirtualKeyCode: descriptor.keyCode,
    nativeVirtualKeyCode: descriptor.keyCode,
    modifiers,
    ...(printable ? { text: descriptor.text, unmodifiedText: descriptor.text } : {}),
  })
  await send(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: descriptor.key,
    code: descriptor.code,
    windowsVirtualKeyCode: descriptor.keyCode,
    nativeVirtualKeyCode: descriptor.keyCode,
    modifiers,
  })
}

/** Insert text into the focused element as if typed (IME-style commit). */
export async function debuggerInsertText(tabId: number, text: string): Promise<void> {
  await send(tabId, 'Input.insertText', { text })
}

/** Evaluate an expression in the page; CDP is not subject to the page CSP. */
export async function debuggerEvaluate(tabId: number, expression: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const result = await send<{ result?: { value?: unknown; type?: string; description?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
    tabId,
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true, userGesture: true },
  )
  if (result.exceptionDetails !== undefined) {
    return { ok: false, error: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluation threw' }
  }
  const value = result.result?.value
  if (value === undefined) {
    return { ok: true, value: result.result?.type === 'undefined' ? null : result.result?.description ?? null }
  }
  return { ok: true, value }
}

/** Capture the tab through CDP; works for tabs that are not the window's active tab. */
export async function debuggerScreenshot(tabId: number): Promise<string> {
  const result = await send<{ data: string }>(tabId, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  return `data:image/png;base64,${result.data}`
}
