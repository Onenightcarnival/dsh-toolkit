/**
 * Page actions: click/type/press/scroll/navigate/get_text/wait, executed in
 * the content script against the real page (preserving login state), each
 * returning a short text status. Navigations return a fresh full snapshot
 * because the document — and the id registry — reset.
 *
 * All browser action results use structured text, so a
 * status line tells the model what happened and what state remains.
 *
 * @module
 */

import { accessibleName, deepQuerySelector, deepQuerySelectorAll, pageText, truncate, viewportRect } from './extract.ts'
import type { ElementIds } from './ids.ts'
import type { SnapshotBudget } from './snapshot.ts'
import { buildSnapshot, renderSnapshot } from './snapshot.ts'
import { isSensitiveField } from './privacy.ts'
import { parseKeyCombo } from '../key-combo.ts'
import { toMarkdown } from './markdown.ts'

/** A settled action result. */
export interface ActionResult {
  text: string
  /** Page-authored snapshot delta; the background must wrap it as untrusted. */
  pageContent?: string
  /** A same-frame document navigation was scheduled after this response. */
  navigationPending?: boolean
}

/** How long an action should observe a ready document before returning. */
export interface PageSettlePolicy {
  /** Earliest return after the document becomes ready. */
  minimumMs: number
  /** Required DOM-quiet period before returning. */
  quietMs: number
  /** Hard cap after readiness; continuously animated pages cannot stall tools. */
  maxAfterReadyMs: number
  /** Hard cap while waiting for document readiness. */
  timeoutMs: number
}

const TYPE_SETTLE: PageSettlePolicy = { minimumMs: 32, quietMs: 32, maxAfterReadyMs: 100, timeoutMs: 5_000 }
const ACTION_SETTLE: PageSettlePolicy = { minimumMs: 100, quietMs: 50, maxAfterReadyMs: 250, timeoutMs: 5_000 }
const SCROLL_SETTLE: PageSettlePolicy = { minimumMs: 50, quietMs: 50, maxAfterReadyMs: 150, timeoutMs: 5_000 }
const EXPLICIT_WAIT_SETTLE: PageSettlePolicy = { minimumMs: 100, quietMs: 100, maxAfterReadyMs: 1_000, timeoutMs: 5_000 }
/** Keep automatic action context focused while preserving the negotiated full snapshot budget. */
const ACTION_DELTA_MAX_CHARS = 4_000

/**
 * Wait for document readiness and a mutation-free window. The old fixed delay
 * charged every action equally and still returned too early when a late DOM
 * update landed near its boundary. This observer returns early on already
 * stable pages, extends only for real mutations, and stays bounded on pages
 * with continuous animation.
 */
export function waitForPageSettled(policy: PageSettlePolicy = ACTION_SETTLE): Promise<boolean> {
  const startedAt = performance.now()
  let readyAt = document.readyState === 'complete' ? startedAt : undefined
  let lastMutationAt = startedAt
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished = false
  let observer: MutationObserver | undefined

  return new Promise((resolve) => {
    const finish = (settled: boolean): void => {
      if (finished) return
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      observer?.disconnect()
      document.removeEventListener('readystatechange', schedule)
      window.removeEventListener('load', schedule)
      resolve(settled)
    }
    const check = (): void => {
      timer = undefined
      const now = performance.now()
      if (readyAt === undefined && document.readyState === 'complete') {
        readyAt = now
        lastMutationAt = now
      }
      if (readyAt !== undefined) {
        const afterReady = now - readyAt
        const quietFor = now - lastMutationAt
        if ((afterReady >= policy.minimumMs && quietFor >= policy.quietMs)
          || afterReady >= policy.maxAfterReadyMs) {
          finish(true)
          return
        }
        const untilMinimum = Math.max(0, policy.minimumMs - afterReady)
        const untilQuiet = Math.max(0, policy.quietMs - quietFor)
        timer = setTimeout(check, Math.max(1, Math.min(policy.maxAfterReadyMs - afterReady, Math.max(untilMinimum, untilQuiet))))
        return
      }
      const elapsed = now - startedAt
      if (elapsed >= policy.timeoutMs) {
        finish(false)
        return
      }
      timer = setTimeout(check, Math.max(1, Math.min(100, policy.timeoutMs - elapsed)))
    }
    function schedule(): void {
      if (finished) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(check, 0)
    }

    if (document.documentElement !== null) {
      observer = new MutationObserver(() => {
        lastMutationAt = performance.now()
        schedule()
      })
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      })
    }
    document.addEventListener('readystatechange', schedule)
    window.addEventListener('load', schedule)
    schedule()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function elementOrThrow(ids: ElementIds, index: number): Element {
  const el = ids.elementByIndex(index)
  if (el === undefined) {
    throw new ActionError('action-failed', `Element [${index}] does not exist; the page may have changed. Call browser_snapshot again to get current indices.`)
  }
  return el
}

/** Error carrying a stable wire code. */
export class ActionError extends Error {
  constructor(
    readonly code: 'action-failed' | 'bad-args',
    message: string,
  ) {
    super(message)
    this.name = 'ActionError'
  }
}

/** React-compatible value write: native setter + input/change events. */
function setNativeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter === undefined) {
    input.value = value
  } else {
    setter.call(input, value)
  }
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

/** Action implementations; each returns a text result. */
export interface ActionContext {
  ids: ElementIds
  budget: SnapshotBudget
  /** Enabled only when the background may share page content without another approval. */
  includePageDelta?: boolean
}

/** Run one named action with its args. */
export async function runAction(action: string, args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  switch (action) {
    case 'browser_snapshot':
      return snapshotAction(args, ctx)
    case 'browser_click':
      return clickAction(args, ctx)
    case 'browser_type':
      return typeAction(args, ctx)
    case 'browser_press':
      return pressAction(args, ctx)
    case 'browser_scroll':
      return scrollAction(args, ctx)
    case 'browser_navigate':
      return navigateAction(args)
    case 'browser_back':
      return historyAction(-1)
    case 'browser_forward':
      return historyAction(1)
    case 'browser_reload':
      return reloadAction()
    case 'browser_get_text':
      return getTextAction(args, ctx)
    case 'browser_wait':
      return waitAction(args, ctx)
    case 'browser_find':
      return findAction(args, ctx)
    case 'browser_hover':
      return hoverAction(args, ctx)
    case 'browser_form_input':
      return formInputAction(args, ctx)
    case 'browser_wait_for':
      return waitForAction(args, ctx)
    case 'browser_element_rects':
      return elementRectsAction(ctx)
    case 'browser_element_rect': {
      const { el, label } = targetElement(args, ctx)
      el.scrollIntoView({ block: 'center', behavior: 'instant' })
      const rect = viewportRect(el)
      if (rect === null) throw new ActionError('action-failed', `${label} has no layout box.`)
      return { text: JSON.stringify({ ...rect, x: rect.x + Math.floor(rect.width / 2), y: rect.y + Math.floor(rect.height / 2), label }) }
    }
    case 'browser_drag':
      return dragAction(args, ctx)
    case 'browser_upload':
      return uploadAction(args, ctx)
    default:
      throw new ActionError('bad-args', `Unknown action: ${action}`)
  }
}

function snapshotAction(args: Record<string, unknown>, ctx: ActionContext): ActionResult {
  const delta = args.delta === true
  const region = typeof args.region === 'string' && args.region !== '' ? args.region : undefined
  // 基线在每次快照后都更新：delta 调用才能相对上一次（无论是否 delta）比较。
  const view = buildSnapshot(ctx.ids, { delta, region, budget: ctx.budget }, lastSnapshot)
  lastSnapshot = view
  return { text: renderSnapshot(view, delta) }
}

/** Module-level last snapshot state for delta mode (content-script lifetime). */
let lastSnapshot: ReturnType<typeof buildSnapshot> | null = null

/** Invalidate delta state after navigation (new document). */
function resetDeltaState(): void {
  lastSnapshot = null
}

/** Attach the settled page change while retaining the full view as the next delta baseline. */
function withPageDelta(text: string, ctx: ActionContext): ActionResult {
  if (ctx.includePageDelta !== true || lastSnapshot === null) return { text }
  const view = buildSnapshot(ctx.ids, { delta: true, budget: ctx.budget }, lastSnapshot)
  lastSnapshot = view
  return {
    text,
    pageContent: renderSnapshot(view, true, Math.min(ctx.budget.maxChars, ACTION_DELTA_MAX_CHARS)),
  }
}

/**
 * The deepest element at viewport coordinates, descending into open shadow
 * roots so a click lands on the component's real control, not its host.
 */
function elementAtPoint(x: number, y: number): Element | null {
  if (typeof document.elementFromPoint !== 'function') return null
  let el = document.elementFromPoint(x, y)
  while (el?.shadowRoot !== null && el?.shadowRoot !== undefined) {
    const inner = el.shadowRoot.elementFromPoint(x, y)
    if (inner === null || inner === el) break
    el = inner
  }
  return el
}

/** Resolve an action target from `index`, or from `x`/`y` viewport coordinates. */
function targetElement(args: Record<string, unknown>, ctx: ActionContext): { el: Element; label: string; index: number } {
  if (typeof args.x === 'number' && typeof args.y === 'number') {
    const x = Math.round(args.x)
    const y = Math.round(args.y)
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      throw new ActionError('bad-args', `(${x}, ${y}) is outside the viewport (${window.innerWidth}×${window.innerHeight}).`)
    }
    const el = elementAtPoint(x, y)
    if (el === null) throw new ActionError('action-failed', `No element at (${x}, ${y}).`)
    const index = typeof ctx.ids.indexOf === 'function' ? ctx.ids.indexOf(el) : undefined
    return { el, label: index === undefined ? `element at (${x}, ${y})` : `[${index}] at (${x}, ${y})`, index: index ?? -1 }
  }
  const index = numberArg(args, 'index')
  return { el: elementOrThrow(ctx.ids, index), label: `[${index}]`, index }
}

async function clickAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const { el, label, index } = targetElement(args, ctx)
  const count = args.count === 2 ? 2 : 1
  if (count === 2) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
    const init = { bubbles: true, cancelable: true, composed: true, detail: 2 }
    el.dispatchEvent(new MouseEvent('mousedown', init))
    el.dispatchEvent(new MouseEvent('mouseup', init))
    el.dispatchEvent(new MouseEvent('click', init))
    el.dispatchEvent(new MouseEvent('dblclick', init))
    await waitForPageSettled(ACTION_SETTLE)
    return withPageDelta(`Double-clicked ${label}.`, ctx)
  }
  if (args.button === 'right') {
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
    const init = { bubbles: true, cancelable: true, composed: true, button: 2 }
    el.dispatchEvent(new MouseEvent('mousedown', init))
    el.dispatchEvent(new MouseEvent('mouseup', init))
    el.dispatchEvent(new MouseEvent('contextmenu', init))
    await waitForPageSettled(ACTION_SETTLE)
    return withPageDelta(`Right-clicked ${label}.`, ctx)
  }
  el.scrollIntoView({ block: 'center', behavior: 'instant' })
  if (el instanceof HTMLAnchorElement) {
    const target = el.target.trim().toLowerCase()
    const sameFrameTarget = target === '' || target === '_self'
    let href: URL | undefined
    try { href = new URL(el.href) } catch { /* let the native click handle unusual links */ }
    const controlledNavigation = sameFrameTarget
      && !el.hasAttribute('download')
      && (href?.protocol === 'http:' || href?.protocol === 'https:')
    if (controlledNavigation && href !== undefined) {
      // Manual location assignment cannot preserve browser-managed link
      // semantics such as referrer suppression, hyperlink auditing, or
      // attribution registration. Keep native activation for those links,
      // but do not claim a replacement document is guaranteed: an SPA may
      // still cancel the click and remain in this document.
      const hasReferrerPolicy = typeof el.referrerPolicy === 'string' && el.referrerPolicy !== ''
      const requiresNativeActivation = el.relList.contains('noreferrer')
        || hasReferrerPolicy
        || el.hasAttribute('ping')
        || el.hasAttribute('attributionsrc')
      if (requiresNativeActivation) {
        setTimeout(() => { el.click() }, 0)
        return {
          text: `Clicked link [${index}] using native browser activation. Call browser_snapshot to read the resulting state.`,
        }
      }
      // Dispatch the click handlers without its default navigation so a
      // client-side router can cancel synchronously and keep this document.
      const shouldNavigate = el.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
      }))
      if (!shouldNavigate) {
        await waitForPageSettled(ACTION_SETTLE)
        return withPageDelta(`Clicked link [${index}].`, ctx)
      }
      const sameDocument = href.origin === location.origin
        && href.pathname === location.pathname
        && href.search === location.search
      if (sameDocument) {
        if (href.hash !== location.hash) location.hash = href.hash
        await waitForPageSettled(ACTION_SETTLE)
        return withPageDelta(`Clicked link [${index}].`, ctx)
      }
      // A cross-document navigation can unload this content script before an
      // awaited response. Answer first and navigate in the next task.
      setTimeout(() => { location.href = href.href }, 0)
      return {
        text: `Clicked link [${index}]. Call browser_snapshot again after navigation settles.`,
        navigationPending: true,
      }
    }
    setTimeout(() => { el.click() }, 0)
    return { text: `Clicked link [${index}]. The link may open outside the controlled frame.` }
  }
  if (el instanceof HTMLButtonElement && el.disabled) {
    throw new ActionError('action-failed', `Button ${label} is disabled.`)
  }
  ;(el as HTMLElement).click()
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Clicked ${label}.`, ctx)
}

/**
 * The nearest editable host, or null when a `contenteditable="false"` island
 * blocks editing.
 *
 * The walk must stop at the nearest `[contenteditable]` boundary instead of
 * skipping disabled ones: an element inside a non-editable island nested in an
 * editable composer belongs to the island, and resolving past it would type
 * into the surrounding composer rather than refusing the target.
 *
 * @param el - element addressed by the action.
 * @returns the owning editable host, or null when editing is blocked.
 */
function editingHost(el: HTMLElement): HTMLElement | null {
  const boundary = el.closest('[contenteditable]')
  if (!(boundary instanceof HTMLElement)) return null
  return boundary.getAttribute('contenteditable') === 'false' ? null : boundary
}

/**
 * Whether the element can receive rich-text input.
 *
 * `isContentEditable` is the browser's own answer; the boundary walk covers the
 * attribute case, which is unimplemented in jsdom, where these tests run.
 *
 * @param el - element addressed by the action.
 * @returns true when the element can receive rich-text input.
 */
function isEditable(el: Element): el is HTMLElement {
  return el instanceof HTMLElement && (el.isContentEditable || editingHost(el) !== null)
}

/**
 * Insert text into a rich-text host through the browser's editing pipeline.
 *
 * Editors such as Lexical, Draft.js and ProseMirror keep their own document
 * model and reconcile away foreign DOM writes, so assigning `textContent`
 * silently reverts and the caller's success report becomes a lie.
 * `execCommand('insertText')` is deprecated but remains the only path that
 * produces the `beforeinput`/`input` sequence those editors listen for. Hosts
 * without it keep the direct-write fallback.
 *
 * @param el - element addressed by the action.
 * @param text - text to insert.
 * @param replace - whether to replace the host's current contents.
 */
function typeIntoContentEditable(el: HTMLElement, text: string, replace: boolean): void {
  // `isEditable` already refused a disabled island, so a null host here means
  // the element is editable without the attribute; address it directly.
  const host = editingHost(el) ?? el
  host.focus()
  const selection = host.ownerDocument.getSelection()
  if (selection !== null) {
    const range = host.ownerDocument.createRange()
    range.selectNodeContents(host)
    // A caret collapsed to the end appends; a full selection is replaced by insertText.
    if (!replace) range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  const doc = host.ownerDocument
  if (typeof doc.execCommand === 'function') {
    try {
      if (doc.execCommand('insertText', false, text)) return
    } catch {
      // Fall through to the direct-write path below.
    }
  }
  if (replace) host.textContent = ''
  host.textContent = `${host.textContent ?? ''}${text}`
  host.dispatchEvent(new Event('input', { bubbles: true }))
}

async function typeAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const index = numberArg(args, 'index')
  const text = typeof args.text === 'string' ? args.text : ''
  if (text === '') throw new ActionError('bad-args', 'text must not be empty.')
  const replace = args.replace === true
  const el = elementOrThrow(ctx.ids, index)
  if (isEditable(el)) {
    typeIntoContentEditable(el, text, replace)
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (replace) setNativeValue(el, '')
    setNativeValue(el, `${el.value}${text}`)
  } else {
    throw new ActionError('action-failed', `Element [${index}] is not editable (${el.tagName.toLowerCase()}).`)
  }
  await waitForPageSettled(TYPE_SETTLE)
  return withPageDelta(`Entered ${text.length} characters into [${index}].`, ctx)
}

export { parseKeyCombo } from '../key-combo.ts'

async function pressAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const combo = typeof args.key === 'string' && args.key !== '' ? args.key : ''
  if (combo === '') throw new ActionError('bad-args', 'key must not be empty.')
  const { key, ...modifiers } = parseKeyCombo(combo)
  if (key === '') throw new ActionError('bad-args', `"${combo}" names modifiers only; add the key to press.`)
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body
  const init = { key, bubbles: true, cancelable: true, composed: true, ...modifiers }
  const proceed = target.dispatchEvent(new KeyboardEvent('keydown', init))
  target.dispatchEvent(new KeyboardEvent('keyup', init))
  if (proceed && key === 'Enter' && target instanceof HTMLInputElement && target.form !== null) {
    target.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }
  if (proceed && key === 'Tab' && !modifiers.ctrlKey && !modifiers.altKey && !modifiers.metaKey) {
    // Synthetic Tab never moves focus; emulate the browser's next-field walk
    // over the visible interactive inventory in DOM order.
    const focusables = deepQuerySelectorAll(document, 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]')
      .filter((el) => el instanceof HTMLElement && !(el as HTMLButtonElement).disabled && el.getBoundingClientRect().width > 0)
    const at = focusables.indexOf(target)
    const next = focusables[(at + (modifiers.shiftKey ? -1 : 1) + focusables.length) % Math.max(1, focusables.length)]
    if (next instanceof HTMLElement) next.focus()
  }
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Sent key "${combo}".`, ctx)
}

async function scrollAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  if (typeof args.index === 'number') {
    const el = elementOrThrow(ctx.ids, numberArg(args, 'index'))
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
    await waitForPageSettled(SCROLL_SETTLE)
    return withPageDelta(`Scrolled [${String(args.index)}] into view.`, ctx)
  }
  const direction = typeof args.direction === 'string' ? args.direction : ''
  const amount = typeof args.amount === 'number' ? args.amount : Math.floor(window.innerHeight * 0.8)
  switch (direction) {
    case 'top':
      window.scrollTo({ top: 0, behavior: 'instant' })
      break
    case 'bottom':
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })
      break
    case 'up':
      window.scrollBy({ top: -amount, behavior: 'instant' })
      break
    case 'down':
      window.scrollBy({ top: amount, behavior: 'instant' })
      break
    default:
      throw new ActionError('bad-args', `direction must be up, down, top, or bottom; received "${direction}".`)
  }
  await waitForPageSettled(SCROLL_SETTLE)
  return withPageDelta(`Scrolled ${direction}.`, ctx)
}

async function navigateAction(args: Record<string, unknown>): Promise<ActionResult> {
  const url = typeof args.url === 'string' && args.url !== '' ? args.url : ''
  if (url === '') throw new ActionError('bad-args', 'url must not be empty.')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ActionError('bad-args', `url is not valid: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ActionError('bad-args', `Only http and https URLs are supported; received ${parsed.protocol}.`)
  }
  resetDeltaState()
  // Cross-document navigation unloads this content script and destroys the
  // tabs.sendMessage response port before any await settles — so answer
  // FIRST, then navigate in a fresh task. The model re-snapshots after load.
  setTimeout(() => { location.href = parsed.href }, 0)
  return {
    text: `Navigating to ${parsed.href}. Call browser_snapshot again after the page loads.`,
    navigationPending: true,
  }
}

async function historyAction(delta: 1 | -1): Promise<ActionResult> {
  resetDeltaState()
  // 同 navigate：先响应再导航（文档卸载会销毁响应端口）。
  setTimeout(() => { if (delta === -1) history.back(); else history.forward() }, 0)
  return {
    text: 'Navigating through browser history. Call browser_snapshot again after the page loads.',
    navigationPending: true,
  }
}

function reloadAction(): ActionResult {
  resetDeltaState()
  setTimeout(() => { location.reload() }, 0)
  return {
    text: 'The page is reloading. Call browser_snapshot again after it loads.',
    navigationPending: true,
  }
}

async function getTextAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : undefined
  const format = args.format === 'plain' ? 'plain' : 'markdown'
  let source: Element | null = null
  if (selector !== undefined) {
    source = deepQuerySelector(document, selector)
    if (source === null) return { text: `No element matched selector: ${selector}` }
  } else if (format === 'markdown') {
    // Prefer the content region so navigation chrome does not dominate.
    source = deepQuerySelector(document, 'main, [role="main"], article') ?? document.body
  }
  const text = format === 'plain'
    ? (source !== null ? pageText(source) : pageText())
    : toMarkdown(source)
  const limit = Math.max(8_000, ctx.budget.maxChars)
  const truncated = truncate(text, limit)
  return { text: truncated.text + (truncated.truncated > 0 ? `\n(Truncated ${truncated.truncated} characters; use selector to read a narrower region.)` : '') }
}

async function waitAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const ms = typeof args.ms === 'number' && args.ms > 0 ? args.ms : 0
  await waitForPageSettled(EXPLICIT_WAIT_SETTLE)
  if (ms > 0) await sleep(ms)
  return withPageDelta(`The page is stable${ms > 0 ? ` after an additional ${ms}ms wait` : ''}.`, ctx)
}

const MAX_FIND_RESULTS = 50

/**
 * Locate elements by visible text, accessible name, role, or CSS selector.
 * Results are inventory-numbered so click/type/form_input can use them
 * directly; elements not yet in the inventory (non-interactive text hits) are
 * assigned ids on the spot.
 */
function findAction(args: Record<string, unknown>, ctx: ActionContext): ActionResult {
  const text = typeof args.text === 'string' ? args.text.trim().toLowerCase() : ''
  const role = typeof args.role === 'string' ? args.role.trim().toLowerCase() : ''
  const selector = typeof args.selector === 'string' ? args.selector.trim() : ''
  if (text === '' && role === '' && selector === '') {
    throw new ActionError('bad-args', 'Provide at least one of text, role, or selector.')
  }
  let candidates: Element[]
  try {
    candidates = selector !== '' ? deepQuerySelectorAll(document, selector) : deepQuerySelectorAll(document, '*')
  } catch {
    throw new ActionError('bad-args', `"${selector}" is not a valid CSS selector.`)
  }
  const matches: Element[] = []
  for (const el of candidates) {
    if (matches.length >= MAX_FIND_RESULTS * 4) break
    if (!(el instanceof HTMLElement) || el.getBoundingClientRect().width === 0) continue
    if (role !== '' && roleLabel(el) !== role) continue
    if (text !== '') {
      const own = ownText(el).toLowerCase()
      const name = accessibleName(el).toLowerCase()
      const value = el instanceof HTMLInputElement && !isSensitiveField(el) ? el.value.toLowerCase() : ''
      const placeholder = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.placeholder.toLowerCase() : ''
      if (!own.includes(text) && !name.includes(text) && !value.includes(text) && !placeholder.includes(text)) continue
    }
    matches.push(el)
  }
  // Prefer the innermost match: a text hit on a wrapper is also a hit on every
  // ancestor, and the model wants the control, not the page body.
  const leafMatches = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)))
  const listed = leafMatches.slice(0, MAX_FIND_RESULTS)
  ctx.ids.ensure(listed)
  if (listed.length === 0) return { text: 'No elements matched.' }
  const lines = listed.map((el) => {
    const index = ctx.ids.indexOf(el)
    const rect = viewportRect(el)
    const where = rect === null ? '' : ` at (${rect.x + Math.floor(rect.width / 2)}, ${rect.y + Math.floor(rect.height / 2)})`
    return `  [${String(index)}] ${roleLabel(el)} "${accessibleName(el)}"${where}`
  })
  const more = leafMatches.length > listed.length ? `\n  … ${leafMatches.length - listed.length} more matches omitted` : ''
  return { text: `${listed.length} match${listed.length === 1 ? '' : 'es'}:\n${lines.join('\n')}${more}` }
}

/** Text directly inside an element (not its descendants' block text). */
function ownText(el: Element): string {
  let text = ''
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? ''
  }
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return trimmed !== '' ? trimmed : renderedText(el).replace(/\s+/g, ' ').trim().slice(0, 200)
}

/** innerText where the engine provides it (browsers), textContent otherwise (jsdom). */
function renderedText(el: Element | null): string {
  if (el === null) return ''
  if (el instanceof HTMLElement && typeof el.innerText === 'string') return el.innerText
  return el.textContent ?? ''
}

function roleLabel(el: Element): string {
  const role = el.getAttribute('role')
  if (role !== null && role !== '') return role.toLowerCase()
  if (el instanceof HTMLAnchorElement) return 'link'
  if (el instanceof HTMLButtonElement) return 'button'
  if (el instanceof HTMLInputElement) return el.type === 'checkbox' || el.type === 'radio' ? el.type : 'input'
  if (el instanceof HTMLSelectElement) return 'select'
  if (el instanceof HTMLTextAreaElement) return 'textarea'
  if (/^h[1-6]$/i.test(el.tagName)) return 'heading'
  return el.tagName.toLowerCase()
}

async function hoverAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const { el, label } = targetElement(args, ctx)
  el.scrollIntoView({ block: 'center', behavior: 'instant' })
  const rect = el.getBoundingClientRect()
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  }
  const pointer = (type: string, options: MouseEventInit): Event =>
    typeof PointerEvent === 'function' ? new PointerEvent(type, options) : new MouseEvent(type, options)
  el.dispatchEvent(pointer('pointerover', init))
  el.dispatchEvent(pointer('pointerenter', { ...init, bubbles: false }))
  el.dispatchEvent(new MouseEvent('mouseover', init))
  el.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }))
  el.dispatchEvent(pointer('pointermove', init))
  el.dispatchEvent(new MouseEvent('mousemove', init))
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Hovered ${label}.`, ctx)
}

/**
 * Set several fields in one call. Text fields get their value replaced,
 * selects pick by option label or value, checkboxes/radios take booleans,
 * contenteditable hosts are replaced through the editing pipeline.
 */
async function formInputAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const fields = Array.isArray(args.fields) ? args.fields : undefined
  if (fields === undefined || fields.length === 0) throw new ActionError('bad-args', 'fields must be a non-empty array of { index, value }.')
  const report: string[] = []
  for (const field of fields) {
    if (typeof field !== 'object' || field === null) throw new ActionError('bad-args', 'Each field must be an object with index and value.')
    const { index, value } = field as { index?: unknown; value?: unknown }
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      throw new ActionError('bad-args', `field index must be a non-negative integer; received ${String(index)}.`)
    }
    const el = elementOrThrow(ctx.ids, index)
    report.push(setFieldValue(el, index, value))
  }
  await waitForPageSettled(TYPE_SETTLE)
  return withPageDelta(report.join('\n'), ctx)
}

function setFieldValue(el: Element, index: number, value: unknown): string {
  if (el instanceof HTMLSelectElement) {
    const wanted = (Array.isArray(value) ? value : [value]).map((entry) => String(entry).trim().toLowerCase())
    let hit = 0
    for (const option of el.options) {
      const label = (option.label || option.textContent || '').trim().toLowerCase()
      const matched = wanted.includes(label) || wanted.includes(option.value.trim().toLowerCase())
      if (el.multiple) option.selected = matched
      else if (matched && hit === 0) el.selectedIndex = option.index
      if (matched) hit += 1
    }
    if (hit === 0) throw new ActionError('action-failed', `[${index}] has no option matching ${JSON.stringify(value)}. Options: ${[...el.options].map((option) => option.label || option.textContent).join(', ')}`)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return `[${index}] selected ${JSON.stringify(Array.isArray(value) ? value : String(value))}.`
  }
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    const checked = value === true || value === 'true' || value === 'on' || value === 1
    if (el.checked !== checked) el.click()
    if (el.checked !== checked) {
      el.checked = checked
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    return `[${index}] ${checked ? 'checked' : 'unchecked'}.`
  }
  if (el instanceof HTMLInputElement && el.type === 'file') {
    throw new ActionError('action-failed', `[${index}] is a file input; file upload is not supported by this tool.`)
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.disabled || el.readOnly) throw new ActionError('action-failed', `[${index}] is ${el.disabled ? 'disabled' : 'read-only'}.`)
    const text = value === null || value === undefined ? '' : String(value)
    el.focus()
    setNativeValue(el, text)
    return `[${index}] set (${text.length} characters).`
  }
  if (isEditable(el)) {
    typeIntoContentEditable(el, value === null || value === undefined ? '' : String(value), true)
    return `[${index}] replaced editable content.`
  }
  throw new ActionError('action-failed', `[${index}] is not a form field (${el.tagName.toLowerCase()}).`)
}

const MAX_WAIT_FOR_MS = 60_000

/**
 * Wait until a condition holds: text present/absent, a selector present/absent,
 * or the URL matching a substring/regex. Polls on DOM mutations and a timer.
 */
async function waitForAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const text = typeof args.text === 'string' && args.text.trim() !== '' ? args.text.trim() : undefined
  const selector = typeof args.selector === 'string' && args.selector.trim() !== '' ? args.selector.trim() : undefined
  const url = typeof args.url === 'string' && args.url.trim() !== '' ? args.url.trim() : undefined
  const gone = args.gone === true
  if (text === undefined && selector === undefined && url === undefined) {
    throw new ActionError('bad-args', 'Provide at least one of text, selector, or url.')
  }
  const requested = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 10_000
  const timeoutMs = Math.min(requested, MAX_WAIT_FOR_MS)
  const check = (): boolean => {
    const results: boolean[] = []
    if (text !== undefined) {
      const body = renderedText(document.body).toLowerCase()
      results.push(body.includes(text.toLowerCase()))
    }
    if (selector !== undefined) {
      try {
        const el = deepQuerySelector(document, selector)
        results.push(el !== null && el.getBoundingClientRect().width > 0)
      } catch {
        throw new ActionError('bad-args', `"${selector}" is not a valid CSS selector.`)
      }
    }
    if (url !== undefined) {
      let ok = location.href.includes(url)
      if (!ok && url.length > 2 && url.startsWith('/') && url.lastIndexOf('/') > 0) {
        try { ok = new RegExp(url.slice(1, url.lastIndexOf('/')), url.slice(url.lastIndexOf('/') + 1)).test(location.href) } catch { ok = false }
      }
      results.push(ok)
    }
    const present = results.every((result) => result)
    return gone ? results.every((result) => !result) : present
  }
  const started = Date.now()
  if (!check()) {
    await new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        observer.disconnect()
        clearInterval(timer)
        clearTimeout(deadline)
        resolve()
      }
      const observer = new MutationObserver(() => { if (check()) finish() })
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true })
      const timer = setInterval(() => { if (check()) finish() }, 250)
      const deadline = setTimeout(finish, timeoutMs)
    })
  }
  const elapsed = Date.now() - started
  const what = [text !== undefined ? `text "${text}"` : '', selector !== undefined ? `selector "${selector}"` : '', url !== undefined ? `url "${url}"` : '']
    .filter((part) => part !== '').join(', ')
  if (!check()) {
    throw new ActionError('action-failed', `Timed out after ${timeoutMs}ms waiting for ${what} to ${gone ? 'disappear' : 'appear'}.`)
  }
  await waitForPageSettled(TYPE_SETTLE)
  return withPageDelta(`${what} ${gone ? 'disappeared' : 'appeared'} after ${elapsed}ms.`, ctx)
}

/**
 * Drag one element onto another (or to viewport coordinates) with both the
 * HTML5 drag-and-drop event sequence (dragstart → dragenter/dragover → drop →
 * dragend, sharing one DataTransfer) and a pointer/mouse sequence for
 * libraries that implement dragging from mouse events instead.
 */
async function dragAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const source = targetElement(args, ctx)
  const to = typeof args.toIndex === 'number'
    ? targetElement({ index: args.toIndex }, ctx)
    : typeof args.toX === 'number' && typeof args.toY === 'number'
      ? targetElement({ x: args.toX, y: args.toY }, ctx)
      : undefined
  if (to === undefined) throw new ActionError('bad-args', 'Provide toIndex, or toX and toY, for the drop target.')
  source.el.scrollIntoView({ block: 'center', behavior: 'instant' })
  const from = source.el.getBoundingClientRect()
  const dest = to.el.getBoundingClientRect()
  const start = { x: from.left + from.width / 2, y: from.top + from.height / 2 }
  const end = typeof args.toX === 'number' && typeof args.toY === 'number'
    ? { x: Math.round(args.toX), y: Math.round(args.toY) }
    : { x: dest.left + dest.width / 2, y: dest.top + dest.height / 2 }
  const pointer = (type: string, target: Element, x: number, y: number, extra: Record<string, unknown> = {}): boolean => {
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1, ...extra }
    const event = typeof PointerEvent === 'function' && type.startsWith('pointer') ? new PointerEvent(type, init) : new MouseEvent(type, init)
    return target.dispatchEvent(event)
  }
  const transfer = typeof DataTransfer === 'function' ? new DataTransfer() : undefined
  const drag = (type: string, target: Element, x: number, y: number): boolean => {
    const init: DragEventInit = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, ...(transfer === undefined ? {} : { dataTransfer: transfer }) }
    const event = typeof DragEvent === 'function' ? new DragEvent(type, init) : new MouseEvent(type, init)
    return target.dispatchEvent(event)
  }
  pointer('pointerdown', source.el, start.x, start.y)
  pointer('mousedown', source.el, start.x, start.y)
  const nativeDrag = drag('dragstart', source.el, start.x, start.y)
  const steps = 8
  for (let step = 1; step <= steps; step++) {
    const x = start.x + ((end.x - start.x) * step) / steps
    const y = start.y + ((end.y - start.y) * step) / steps
    const over = elementAtPoint(x, y) ?? to.el
    pointer('pointermove', over, x, y)
    pointer('mousemove', over, x, y)
    if (nativeDrag) drag('dragover', over, x, y)
    await sleep(16)
  }
  if (nativeDrag) {
    drag('dragenter', to.el, end.x, end.y)
    drag('dragover', to.el, end.x, end.y)
    drag('drop', to.el, end.x, end.y)
    drag('dragend', source.el, end.x, end.y)
  }
  pointer('pointerup', to.el, end.x, end.y, { buttons: 0 })
  pointer('mouseup', to.el, end.x, end.y, { buttons: 0 })
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Dragged ${source.label} to ${to.label}.`, ctx)
}

/** Files arrive base64-encoded from the bridge (read on the dsh host); set them on a file input. */
async function uploadAction(args: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
  const index = numberArg(args, 'index')
  const el = elementOrThrow(ctx.ids, index)
  const files = Array.isArray(args.files) ? args.files : []
  if (files.length === 0) throw new ActionError('bad-args', 'files must be a non-empty array.')
  let input: HTMLInputElement | null = null
  if (el instanceof HTMLInputElement && el.type === 'file') input = el
  else {
    // A styled upload button usually wraps or labels a hidden file input.
    const scope = el.closest('label, form, [class*="upload" i], [class*="dropzone" i]') ?? el.parentElement
    if (scope !== null && scope !== document.body) input = deepQuerySelectorAll(scope, 'input[type="file"]')[0] as HTMLInputElement | undefined ?? null
    if (input === null && el instanceof HTMLLabelElement && el.control instanceof HTMLInputElement) input = el.control
  }
  if (input === null) throw new ActionError('action-failed', `[${index}] is not a file input and no file input was found near it.`)
  if (typeof DataTransfer !== 'function') throw new ActionError('action-failed', 'This page does not support programmatic file selection.')
  const transfer = new DataTransfer()
  const names: string[] = []
  for (const entry of files) {
    const file = entry as { name?: unknown; mediaType?: unknown; data?: unknown }
    if (typeof file.name !== 'string' || typeof file.data !== 'string') throw new ActionError('bad-args', 'Each file needs name and base64 data.')
    const bytes = Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0))
    transfer.items.add(new File([bytes], file.name, { type: typeof file.mediaType === 'string' ? file.mediaType : 'application/octet-stream' }))
    names.push(`${file.name} (${bytes.byteLength} bytes)`)
  }
  if (!input.multiple && files.length > 1) throw new ActionError('action-failed', `[${index}] accepts a single file; ${files.length} were given.`)
  input.files = transfer.files
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await waitForPageSettled(ACTION_SETTLE)
  return withPageDelta(`Selected ${names.join(', ')} for the file input.`, ctx)
}

/** Viewport rectangles of the current inventory, for screenshot annotation. */
function elementRectsAction(ctx: ActionContext): ActionResult {
  const view = lastSnapshot ?? buildSnapshot(ctx.ids, { budget: ctx.budget }, null)
  if (lastSnapshot === null) lastSnapshot = view
  const rects = view.items
    .filter((item) => item.rect !== undefined && item.inViewport)
    .map((item) => ({ index: item.index, ...item.rect as { x: number; y: number; width: number; height: number } }))
  return {
    text: JSON.stringify({
      rects,
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
      url: location.href,
      title: document.title,
    }),
  }
}

function numberArg(args: Record<string, unknown>, name: string): number {
  const value = args[name]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ActionError('bad-args', `${name} must be a non-negative integer; received ${String(value)}.`)
  }
  return value
}
