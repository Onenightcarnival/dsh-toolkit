/**
 * Keyboard chord parsing shared by the content script (synthetic events) and
 * the background (trusted input through the debugger).
 *
 * @module
 */

export interface KeyCombo {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

/**
 * Parse "Ctrl+Shift+ArrowDown" into the key and modifier flags.
 * A bare "+" is the plus key; modifier names are case-insensitive and accept
 * the usual aliases (Control, Cmd/Command/Win, Option).
 */
export function parseKeyCombo(combo: string): KeyCombo {
  const flags = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }
  if (combo.trim() === '+') return { key: '+', ...flags }
  const parts = combo.split('+').map((part) => part.trim()).filter((part) => part !== '')
  let key = ''
  for (const part of parts) {
    const lower = part.toLowerCase()
    if (lower === 'ctrl' || lower === 'control') flags.ctrlKey = true
    else if (lower === 'shift') flags.shiftKey = true
    else if (lower === 'alt' || lower === 'option') flags.altKey = true
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'win') flags.metaKey = true
    else key = part
  }
  if (key === '' && parts.length === 1) key = parts[0] as string
  return { key, ...flags }
}
