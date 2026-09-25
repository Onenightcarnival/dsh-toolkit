/**
 * Text extraction primitives for the text-only page snapshot: visibility,
 * accessible names, interactive inventory, main-content heuristic, and
 * truncation helpers.
 *
 * The snapshot is the model's entire view of the page (no screenshots), so
 * every helper is written to produce dense, model-usable text under a hard
 * character budget.
 *
 * @module
 */

/** Every element type the model may be asked to operate on. */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="menuitem"]',
  'summary',
  '[contenteditable="true"]',
  '[contenteditable=""]',
].join(', ')

/** Default cap on one item's rendered name/state text. */
const MAX_ITEM_NAME_CHARS = 80

/**
 * Whether an element is visible to the user: not display/visibility/opacity
 * hidden and occupying layout space.
 * @param el - candidate element.
 * @returns true when the element renders.
 */
export function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

/**
 * Whether the element is inside the current viewport (used to order the
 * inventory: what the user sees comes first).
 * @param el - element.
 * @returns true when any part is within the viewport.
 */
export function isInViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  return rect.bottom >= 0 && rect.top <= window.innerHeight && rect.right >= 0 && rect.left <= window.innerWidth
}

/** Normalize whitespace and trim. */
function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Text of an element: innerText when available (browsers), textContent
 * otherwise (jsdom/edge cases).
 * @param el - element.
 * @returns the element's text.
 */
function elementText(el: Element): string {
  const own = el instanceof HTMLElement && typeof el.innerText === 'string' ? el.innerText : el.textContent ?? ''
  // innerText stops at shadow boundaries; append the text of open shadow
  // trees beneath this element so component-rendered prose is not lost.
  const shadowText: string[] = []
  for (const host of shadowHosts(el)) {
    const root = host.shadowRoot as ShadowRoot
    for (const child of root.children) shadowText.push(elementText(child))
  }
  if (el.shadowRoot !== null) {
    for (const child of el.shadowRoot.children) shadowText.push(elementText(child))
  }
  return shadowText.length === 0 ? own : `${own}\n${shadowText.join('\n')}`
}

/**
 * Truncate text at a character budget, marking the cut.
 * @param text - source text.
 * @param max - maximum characters.
 * @returns `{ text, truncated }` with `truncated` counting removed characters.
 */
export function truncate(text: string, max: number): { text: string; truncated: number } {
  if (text.length <= max) return { text, truncated: 0 }
  return { text: `${text.slice(0, max)}…`, truncated: text.length - max }
}

/**
 * The accessible name of an element, following the ARIA precedence chain
 * (aria-label → aria-labelledby → associated label → own text →
 * placeholder/alt).
 * @param el - element.
 * @returns a ≤80-char name, or the tag name as last resort.
 */
export function accessibleName(el: Element): string {
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel !== null && ariaLabel.trim() !== '') return truncate(clean(ariaLabel), MAX_ITEM_NAME_CHARS).text

  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy !== null) {
    const ref = document.getElementById(labelledBy.split(/\s+/)[0] ?? '')
    const refText = ref?.textContent
    if (refText !== undefined && refText.trim() !== '') return truncate(clean(refText), MAX_ITEM_NAME_CHARS).text
  }

  const labelable = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
  if (labelable) {
    if (el.id !== '') {
      const label = el.ownerDocument.querySelector<HTMLLabelElement>(`label[for="${cssEscape(el.id)}"]`)
      const labelText = label?.textContent
      if (labelText !== undefined && labelText.trim() !== '') return truncate(clean(labelText), MAX_ITEM_NAME_CHARS).text
    }
    const wrappingLabelText = el.closest('label')?.textContent
    if (wrappingLabelText !== undefined && wrappingLabelText.trim() !== '') {
      return truncate(clean(wrappingLabelText), MAX_ITEM_NAME_CHARS).text
    }
  }

  // A select's text content is its option list, which is data rather than a
  // name; fall through to its name/id like an input does.
  const ownText = el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? '' : el.textContent
  if (ownText !== undefined && ownText.trim() !== '') return truncate(clean(ownText), MAX_ITEM_NAME_CHARS).text

  if (el instanceof HTMLSelectElement) {
    const hint = el.getAttribute('name') ?? el.id
    return truncate(clean(hint !== null && hint !== '' ? hint : 'select'), MAX_ITEM_NAME_CHARS).text
  }

  if (el instanceof HTMLInputElement) {
    // Button-like inputs carry their label in `value`; other inputs never use
    // the current value as a name (it is data, not identity — and for
    // password/credit fields it would leak the secret into the snapshot).
    const buttonLike = el.type === 'submit' || el.type === 'button' || el.type === 'reset'
    if (buttonLike && el.value !== '') return truncate(clean(el.value), MAX_ITEM_NAME_CHARS).text
    if (el.placeholder !== '') return truncate(clean(el.placeholder), MAX_ITEM_NAME_CHARS).text
    if (el.alt !== '') return truncate(clean(el.alt), MAX_ITEM_NAME_CHARS).text
    return truncate(clean(el.type), MAX_ITEM_NAME_CHARS).text
  }

  return el.tagName.toLowerCase()
}

/** CSS.escape with a fallback for environments that lack it (jsdom). */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`)
}

/**
 * Collect the page's interactive elements in document order, deduplicated and
 * visibility-filtered.
 * @param root - document or element to scan.
 * @returns the interactive inventory.
 */
export function collectInteractive(root: Document | Element): Element[] {
  const seen = new Set<Element>()
  const result: Element[] = []
  for (const el of deepQuerySelectorAll(root, INTERACTIVE_SELECTOR)) {
    if (seen.has(el)) continue
    seen.add(el)
    if (isVisible(el)) result.push(el)
  }
  return result
}

/**
 * `querySelectorAll` that also descends into open shadow roots, in composed
 * document order. Web-component sites (YouTube, Lit/Stencil apps, many admin
 * consoles) keep their buttons and fields inside shadow trees, which the plain
 * query never sees. Closed shadow roots stay opaque.
 * @param root - document, element, or shadow root to scan.
 * @param selector - CSS selector applied within each tree.
 * @returns matches from the light tree and every open shadow tree beneath it.
 */
export function deepQuerySelectorAll(root: Document | Element | ShadowRoot, selector: string): Element[] {
  const result: Element[] = []
  const visit = (scope: Document | Element | ShadowRoot): void => {
    for (const el of scope.querySelectorAll(selector)) result.push(el)
    for (const host of shadowHosts(scope)) visit(host.shadowRoot as ShadowRoot)
  }
  visit(root)
  if (root instanceof Element && root.matches(selector)) result.unshift(root)
  return result
}

/** Elements in a tree that own an open shadow root, in document order. */
function shadowHosts(scope: Document | Element | ShadowRoot): Element[] {
  const hosts: Element[] = []
  const walker = (scope.ownerDocument ?? (scope as Document)).createTreeWalker(scope, NodeFilter.SHOW_ELEMENT)
  let node = walker.nextNode()
  while (node !== null) {
    if ((node as Element).shadowRoot !== null) hosts.push(node as Element)
    node = walker.nextNode()
  }
  return hosts
}

/**
 * First match of `selector` including open shadow trees, for region and
 * selector arguments the model supplies.
 * @param root - scope to search.
 * @param selector - CSS selector.
 * @returns the first composed-order match, or null.
 */
export function deepQuerySelector(root: Document | Element | ShadowRoot, selector: string): Element | null {
  return deepQuerySelectorAll(root, selector)[0] ?? null
}

/**
 * Bounding box of an element in CSS pixels of the viewport, or null when it
 * has no layout. Used for screenshot annotation and coordinate fallbacks.
 * @param el - element.
 * @returns integer-rounded viewport rectangle.
 */
export function viewportRect(el: Element): { x: number; y: number; width: number; height: number } | null {
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

/**
 * Best-effort main-content extraction (readability-lite): prefer a main
 * landmark, then a single standalone article, else the largest block
 * containing at least two paragraphs. Multiple articles commonly represent
 * cards or feed entries, so selecting only the first would hide page content.
 * @param doc - the document.
 * @returns the cleaned main text (unbounded; callers apply budgets).
 */
export function mainText(doc: Document): string {
  const main = deepQuerySelector(doc, 'main, [role="main"]')
  if (main !== null) return clean(elementText(main))
  const articles = doc.querySelectorAll('article')
  if (articles.length === 1) return clean(elementText(articles[0]!))

  let best: Element | null = null
  let bestScore = 0
  for (const candidate of doc.querySelectorAll('section, div, [role="main"]')) {
    const paragraphs = candidate.querySelectorAll('p').length
    if (paragraphs < 2) continue
    const text = elementText(candidate)
    const score = text.length * Math.min(paragraphs, 5)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  if (best !== null) return clean(elementText(best))
  return clean(elementText(doc.body))
}

/**
 * The full text of an element (or the whole document).
 * @param root - element to read; defaults to the document body.
 * @returns normalized text.
 */
export function pageText(root?: Element | null): string {
  const source = root ?? document.body
  if (source === null || source === undefined) return ''
  return clean(elementText(source))
}
