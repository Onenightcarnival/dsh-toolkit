/**
 * MAIN-world page hooks: dialog interception, console capture, and network
 * capture. The content script lives in an isolated world and cannot see
 * `window.alert` or `console.log` as the page calls them, so these hooks are
 * installed with `chrome.scripting.executeScript({ world: 'MAIN' })` and read
 * back the same way. Everything the hooks record is page-authored data.
 *
 * Install is idempotent per document and happens lazily on the first tool
 * dispatched to a tab, so pages the agent never touches are never modified.
 *
 * @module
 */

export interface DialogRecord {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
  /** What the hook answered on the page's behalf. */
  outcome: 'accepted' | 'dismissed'
  text?: string
  at: number
}

export interface ConsoleRecord {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  text: string
  at: number
}

export interface NetworkRecord {
  kind: 'fetch' | 'xhr'
  method: string
  url: string
  status: number
  ok: boolean
  ms: number
  at: number
}

export interface DialogPolicy {
  /** Answer for the next confirm()/prompt(); alert() is always accepted. */
  action: 'accept' | 'dismiss'
  /** Text returned by prompt() when accepted. */
  text?: string
  /** Apply to the next dialog only, then revert to dismissing. */
  once: boolean
}

/**
 * Self-contained installer; serialized by executeScript, so it must not
 * reference anything from this module's scope.
 */
function installHooks(): boolean {
  const w = window as unknown as Record<string, unknown>
  if (typeof w.__dshPageHooks === 'object' && w.__dshPageHooks !== null) return false
  const state = {
    dialogs: [] as Array<{ type: string; message: string; outcome: string; text?: string; at: number }>,
    console: [] as Array<{ level: string; text: string; at: number }>,
    network: [] as Array<{ kind: string; method: string; url: string; status: number; ok: boolean; ms: number; at: number }>,
    policy: { action: 'dismiss', text: '', once: false } as { action: 'accept' | 'dismiss'; text?: string; once: boolean },
  }
  const cap = <T,>(list: T[], max: number): void => { if (list.length > max) list.splice(0, list.length - max) }
  const stringify = (value: unknown): string => {
    try {
      if (typeof value === 'string') return value
      if (value instanceof Error) return `${value.name}: ${value.message}`
      return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? String(v) : v)) ?? String(value)
    } catch {
      return String(value)
    }
  }
  const usePolicy = (): { action: 'accept' | 'dismiss'; text?: string } => {
    const current = { action: state.policy.action, text: state.policy.text }
    if (state.policy.once) state.policy = { action: 'dismiss', text: '', once: false }
    return current
  }
  const original = { alert: window.alert, confirm: window.confirm, prompt: window.prompt }
  window.alert = (message?: unknown): void => {
    state.dialogs.push({ type: 'alert', message: stringify(message ?? ''), outcome: 'accepted', at: Date.now() })
    cap(state.dialogs, 50)
  }
  window.confirm = (message?: unknown): boolean => {
    const policy = usePolicy()
    state.dialogs.push({ type: 'confirm', message: stringify(message ?? ''), outcome: policy.action === 'accept' ? 'accepted' : 'dismissed', at: Date.now() })
    cap(state.dialogs, 50)
    return policy.action === 'accept'
  }
  window.prompt = (message?: unknown, defaultValue?: unknown): string | null => {
    const policy = usePolicy()
    const text = policy.action === 'accept' ? (policy.text ?? (typeof defaultValue === 'string' ? defaultValue : '')) : undefined
    state.dialogs.push({ type: 'prompt', message: stringify(message ?? ''), outcome: policy.action === 'accept' ? 'accepted' : 'dismissed', ...(text === undefined ? {} : { text }), at: Date.now() })
    cap(state.dialogs, 50)
    return text ?? null
  }
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const fn = console[level]
    console[level] = (...args: unknown[]): void => {
      state.console.push({ level, text: args.map(stringify).join(' ').slice(0, 1_000), at: Date.now() })
      cap(state.console, 300)
      try { fn.apply(console, args) } catch { /* original console missing */ }
    }
  }
  window.addEventListener('error', (event) => {
    state.console.push({ level: 'error', text: `Uncaught ${stringify(event.error ?? event.message)} (${event.filename}:${event.lineno})`.slice(0, 1_000), at: Date.now() })
    cap(state.console, 300)
  })
  window.addEventListener('unhandledrejection', (event) => {
    state.console.push({ level: 'error', text: `Unhandled rejection: ${stringify(event.reason)}`.slice(0, 1_000), at: Date.now() })
    cap(state.console, 300)
  })
  const nativeFetch = window.fetch
  if (typeof nativeFetch === 'function') {
    window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const started = Date.now()
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
      try {
        const response = await nativeFetch.call(window, input, init)
        state.network.push({ kind: 'fetch', method, url: String(url).slice(0, 500), status: response.status, ok: response.ok, ms: Date.now() - started, at: started })
        cap(state.network, 300)
        return response
      } catch (error) {
        state.network.push({ kind: 'fetch', method, url: String(url).slice(0, 500), status: 0, ok: false, ms: Date.now() - started, at: started })
        cap(state.network, 300)
        throw error
      }
    }
  }
  const xhrOpen = XMLHttpRequest.prototype.open
  const xhrSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest & { __dsh?: { method: string; url: string } }, method: string, url: string | URL, ...rest: unknown[]): void {
    this.__dsh = { method: String(method).toUpperCase(), url: String(url).slice(0, 500) }
    return (xhrOpen as (...args: unknown[]) => void).apply(this, [method, url, ...rest])
  }
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest & { __dsh?: { method: string; url: string } }, body?: Document | XMLHttpRequestBodyInit | null): void {
    const started = Date.now()
    const meta = this.__dsh
    this.addEventListener('loadend', () => {
      state.network.push({ kind: 'xhr', method: meta?.method ?? 'GET', url: meta?.url ?? '', status: this.status, ok: this.status >= 200 && this.status < 400, ms: Date.now() - started, at: started })
      cap(state.network, 300)
    })
    return xhrSend.call(this, body)
  }
  void original
  Object.defineProperty(w, '__dshPageHooks', { value: state, configurable: true, enumerable: false, writable: false })
  return true
}

function readHooks(kind: 'dialogs' | 'console' | 'network', clear: boolean): unknown {
  const state = (window as unknown as Record<string, { dialogs: unknown[]; console: unknown[]; network: unknown[] } | undefined>).__dshPageHooks
  if (state === undefined) return null
  const list = state[kind]
  const copy = [...list]
  if (clear) list.length = 0
  return copy
}

function setDialogPolicy(action: 'accept' | 'dismiss', text: string | undefined, once: boolean): boolean {
  const state = (window as unknown as Record<string, { policy: unknown } | undefined>).__dshPageHooks
  if (state === undefined) return false
  state.policy = { action, ...(text === undefined ? {} : { text }), once }
  return true
}

function evaluateInPage(code: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    // A page CSP without 'unsafe-eval' makes this throw; the caller reports it.
    const fn = new Function(`return (${code}\n)`) as () => unknown
    let value = fn()
    if (value !== null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function') {
      return { ok: false, error: 'the expression returned a Promise; await it inside the expression (e.g. (async () => { ... })() is not supported synchronously)' }
    }
    if (typeof value === 'function') value = `[function ${(value as { name?: string }).name ?? ''}]`
    if (value === undefined) value = null
    return { ok: true, value: JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? String(v) : v)) ?? 'null') }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
  }
}

const installedDocuments = new Map<number, string>()

/** Forget a tab's install record (tab closed or navigated). */
export function forgetPageHooks(tabId: number): void {
  installedDocuments.delete(tabId)
}

/**
 * Install the hooks in a tab's main frame once per document.
 * @param tabId - target tab.
 * @param documentId - main-frame document identity; a new document re-installs.
 */
export async function ensurePageHooks(tabId: number, documentId: string | undefined): Promise<void> {
  const key = documentId ?? 'unknown'
  if (installedDocuments.get(tabId) === key) return
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: installHooks })
  installedDocuments.set(tabId, key)
}

async function runInPage<T>(tabId: number, func: (...args: never[]) => T, args: unknown[]): Promise<T | undefined> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: func as (...args: unknown[]) => T,
    args,
  })
  return result?.result as T | undefined
}

/** Read and optionally clear recorded dialogs. */
export async function readDialogs(tabId: number, clear: boolean): Promise<DialogRecord[]> {
  const records = await runInPage(tabId, readHooks, ['dialogs', clear])
  return Array.isArray(records) ? records as DialogRecord[] : []
}

/** Read and optionally clear captured console entries. */
export async function readConsole(tabId: number, clear: boolean): Promise<ConsoleRecord[] | null> {
  const records = await runInPage(tabId, readHooks, ['console', clear])
  return records === null || records === undefined ? null : Array.isArray(records) ? records as ConsoleRecord[] : []
}

/** Read and optionally clear captured network entries. */
export async function readNetwork(tabId: number, clear: boolean): Promise<NetworkRecord[] | null> {
  const records = await runInPage(tabId, readHooks, ['network', clear])
  return records === null || records === undefined ? null : Array.isArray(records) ? records as NetworkRecord[] : []
}

/** Set how the next confirm()/prompt() is answered. */
export async function applyDialogPolicy(tabId: number, policy: DialogPolicy): Promise<boolean> {
  return (await runInPage(tabId, setDialogPolicy, [policy.action, policy.text, policy.once])) === true
}

/** Evaluate a JavaScript expression in the page's main world. */
export async function evaluateExpression(tabId: number, code: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const result = await runInPage(tabId, evaluateInPage, [code])
  return result ?? { ok: false, error: 'the page returned no result' }
}

/** Render dialog records for a tool result. */
export function describeDialogs(records: readonly DialogRecord[]): string {
  return records.map((record) => {
    const answer = record.type === 'alert'
      ? 'closed'
      : record.outcome === 'accepted'
        ? (record.type === 'prompt' ? `accepted with "${record.text ?? ''}"` : 'accepted (OK)')
        : 'dismissed (Cancel)'
    return `${record.type}("${record.message.slice(0, 300)}") → ${answer}`
  }).join('\n')
}
