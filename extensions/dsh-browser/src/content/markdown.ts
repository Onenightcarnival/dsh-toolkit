/**
 * DOM → Markdown for `browser_get_text`. Keeps the structure a model needs
 * to reason about a page — headings, lists, tables, links, code, images —
 * and drops chrome (scripts, styles, hidden nodes, nav/aside landmarks when
 * a main region exists). Open shadow roots are walked like light DOM.
 *
 * @module
 */

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'HEAD', 'META', 'LINK'])
const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'FIGURE', 'FIGCAPTION', 'BLOCKQUOTE', 'PRE', 'ADDRESS', 'DETAILS', 'SUMMARY', 'FORM', 'FIELDSET', 'DL', 'DT', 'DD', 'HR', 'TABLE', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BR', 'TR'])

function isHidden(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true
  const style = el.ownerDocument.defaultView?.getComputedStyle(el)
  if (style === undefined || style === null) return false
  return style.display === 'none' || style.visibility === 'hidden'
}

function inlineText(text: string): string {
  return text.replace(/\s+/g, ' ')
}

function absoluteUrl(href: string, base: string): string {
  try {
    return new URL(href, base).href
  } catch {
    return href
  }
}

function cellText(cell: Element, base: string): string {
  return renderChildren(cell, base, 0).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()
}

function renderTable(table: Element, base: string): string {
  const rows: string[][] = []
  for (const tr of table.querySelectorAll('tr')) {
    if (tr.closest('table') !== table) continue
    const cells = [...tr.children].filter((cell) => cell.tagName === 'TD' || cell.tagName === 'TH')
    if (cells.length > 0) rows.push(cells.map((cell) => cellText(cell, base)))
  }
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map((row) => row.length))
  const pad = (row: string[]): string[] => [...row, ...Array.from({ length: width - row.length }, () => '')]
  const header = pad(rows[0] as string[])
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`]
  for (const row of rows.slice(1)) lines.push(`| ${pad(row).join(' | ')} |`)
  const caption = table.querySelector('caption')?.textContent?.trim()
  return `${caption ? `**${inlineText(caption)}**\n\n` : ''}${lines.join('\n')}`
}

function renderList(list: Element, base: string, depth: number): string {
  const ordered = list.tagName === 'OL'
  const start = ordered ? Number((list as HTMLOListElement).start || 1) : 1
  const items: string[] = []
  let index = start
  for (const li of list.children) {
    if (li.tagName !== 'LI') continue
    const marker = ordered ? `${index}.` : '-'
    index += 1
    const body = renderChildren(li, base, depth + 1).trim()
    const [first = '', ...rest] = body.split('\n')
    const indent = '  '.repeat(depth + 1)
    items.push(`${'  '.repeat(depth)}${marker} ${first}${rest.length > 0 ? `\n${rest.map((line) => (line === '' ? '' : `${indent}${line}`)).join('\n')}` : ''}`)
  }
  return items.join('\n')
}

function renderChildren(parent: Node, base: string, depth: number): string {
  let out = ''
  const push = (fragment: string, block: boolean): void => {
    if (fragment === '') return
    if (block) {
      if (out !== '' && !out.endsWith('\n\n')) out = out.endsWith('\n') ? `${out}\n` : `${out}\n\n`
      out += fragment
      out += '\n\n'
    } else {
      out += fragment
    }
  }
  const nodes: Node[] = [...parent.childNodes]
  if (parent instanceof Element && parent.shadowRoot !== null) nodes.unshift(...parent.shadowRoot.childNodes)
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      push(inlineText(node.textContent ?? ''), false)
      continue
    }
    if (!(node instanceof Element)) continue
    if (SKIP_TAGS.has(node.tagName) || isHidden(node)) continue
    if (node.tagName === 'SLOT') {
      const assigned = (node as HTMLSlotElement).assignedNodes({ flatten: true })
      for (const slotted of assigned) {
        if (slotted.nodeType === Node.TEXT_NODE) push(inlineText(slotted.textContent ?? ''), false)
        else if (slotted instanceof Element) push(renderElement(slotted, base, depth), BLOCK_TAGS.has(slotted.tagName))
      }
      continue
    }
    push(renderElement(node, base, depth), BLOCK_TAGS.has(node.tagName))
  }
  return out
}

function renderElement(el: Element, base: string, depth: number): string {
  switch (el.tagName) {
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
      const level = Number(el.tagName[1])
      const text = renderChildren(el, base, depth).replace(/\s+/g, ' ').trim()
      return text === '' ? '' : `${'#'.repeat(level)} ${text}`
    }
    case 'BR': return '\n'
    case 'HR': return '---'
    case 'UL': case 'OL': return renderList(el, base, depth)
    case 'TABLE': return renderTable(el, base)
    case 'PRE': {
      const code = el.textContent ?? ''
      const lang = /language-([\w-]+)/.exec(el.querySelector('code')?.className ?? el.className)?.[1] ?? ''
      return `\`\`\`${lang}\n${code.replace(/\n$/, '')}\n\`\`\``
    }
    case 'CODE': return `\`${inlineText(el.textContent ?? '').trim()}\``
    case 'BLOCKQUOTE': return renderChildren(el, base, depth).trim().split('\n').map((line) => `> ${line}`).join('\n')
    case 'A': {
      const text = renderChildren(el, base, depth).replace(/\s+/g, ' ').trim()
      const href = el.getAttribute('href')
      if (href === null || href === '' || href.startsWith('javascript:')) return text
      const url = absoluteUrl(href, base)
      return text === '' ? `<${url}>` : `[${text}](${url})`
    }
    case 'IMG': {
      const alt = inlineText(el.getAttribute('alt') ?? '').trim()
      const src = el.getAttribute('src') ?? ''
      if (src === '' || src.startsWith('data:')) return alt === '' ? '' : `![${alt}]`
      return `![${alt}](${absoluteUrl(src, base)})`
    }
    case 'STRONG': case 'B': {
      const text = renderChildren(el, base, depth).trim()
      return text === '' ? '' : `**${text}**`
    }
    case 'EM': case 'I': {
      const text = renderChildren(el, base, depth).trim()
      return text === '' ? '' : `*${text}*`
    }
    case 'INPUT': {
      const input = el as HTMLInputElement
      if (input.type === 'checkbox' || input.type === 'radio') return input.checked ? '[x]' : '[ ]'
      if (input.type === 'hidden' || input.type === 'password') return ''
      return input.value !== '' ? `[${inlineText(input.value)}]` : input.placeholder !== '' ? `[${inlineText(input.placeholder)}]` : ''
    }
    case 'SELECT': {
      const select = el as HTMLSelectElement
      const chosen = [...select.selectedOptions].map((option) => inlineText(option.textContent ?? '').trim()).join(', ')
      return chosen === '' ? '' : `[${chosen}]`
    }
    case 'TEXTAREA': return (el as HTMLTextAreaElement).value.trim()
    case 'DT': return `**${renderChildren(el, base, depth).trim()}**`
    case 'DD': return `: ${renderChildren(el, base, depth).trim()}`
    default:
      return renderChildren(el, base, depth)
  }
}

/**
 * Convert an element (or the document's best content region) to Markdown.
 * @param root - element to render; the document body when omitted.
 * @param base - base URL for resolving links; defaults to the document URL.
 * @returns Markdown with collapsed blank lines.
 */
export function toMarkdown(root: Element | null | undefined, base: string = document.baseURI): string {
  const target = root ?? document.body
  if (target === null || target === undefined) return ''
  const body = renderElement(target, base, 0)
  return body
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
