import { useEffect, type ReactNode } from 'react'

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return '-'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++ }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`
}

export function formatTime(at: number): string {
  const date = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Status class for badges: 2xx ok, 3xx info, 4xx warn, 5xx error. */
export function statusKind(status: number | undefined): 'ok' | 'info' | 'warn' | 'error' {
  if (status === undefined) return 'error'
  if (status < 300) return 'ok'
  if (status < 400) return 'info'
  if (status < 500) return 'warn'
  return 'error'
}

export interface Banner { kind: 'ok' | 'error' | 'info'; text: string }

export function Modal(props: { title: string; wide?: boolean; onClose: () => void; children: ReactNode; footer?: ReactNode }): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') props.onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [props.onClose])
  return (
    <div className="dsh-http-backdrop" data-window-drag-exclude="" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose() }}>
      <div className="dsh-http-modal" role="dialog" aria-modal="true" aria-label={props.title} {...(props.wide ? { 'data-wide': '' } : {})}>
        <h3 className="dsh-http-modalTitle">{props.title}</h3>
        {props.children}
        {props.footer !== undefined && <div className="dsh-http-modalFooter">{props.footer}</div>}
      </div>
    </div>
  )
}

export function BannerView(props: { banner: Banner | undefined; onClose: () => void }): JSX.Element | null {
  if (props.banner === undefined) return null
  return (
    <div className="dsh-http-banner" data-kind={props.banner.kind} role="status">
      <span>{props.banner.text}</span>
      <button type="button" className="dsh-http-link" onClick={props.onClose} aria-label="close">×</button>
    </div>
  )
}

/** Pretty-print JSON when the text parses; otherwise return it unchanged. */
export function prettyJson(text: string): { text: string; json: boolean } {
  const trimmed = text.trim()
  if (trimmed === '' || !(trimmed.startsWith('{') || trimmed.startsWith('['))) return { text, json: false }
  try {
    return { text: JSON.stringify(JSON.parse(trimmed), null, 2), json: true }
  } catch {
    return { text, json: false }
  }
}

/** `HH:mm:ss` for today, `MM-DD HH:mm` for other days. */
export function shortTime(at: number): string {
  const date = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)
}

/** Label of the send shortcut on this platform. */
export function sendShortcut(): string {
  return isMac() ? '⌘ Enter' : 'Ctrl Enter'
}

/**
 * Copy text to the clipboard: the async clipboard API, then a selection-based
 * copy where that API is unavailable or refused.
 * @throws when both ways fail.
 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch { /* fall through */ }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0'
  document.body.appendChild(area)
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } finally {
    area.remove()
    active?.focus()
  }
  if (!ok) throw new Error('clipboard unavailable')
}
