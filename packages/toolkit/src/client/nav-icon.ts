/**
 * Settings nav icons of toolkit sections. The settings shell draws a gear for
 * section ids it does not know; this module marks each listed section's nav
 * button with `data-dsh-toolkit-nav="<key>"` and a style rule replaces the
 * gear with the section glyph.
 * - Matching: nav cell (`…_navCell`) whose label (`…_navLabel`) equals the
 *   section's current label, checked when a node is added directly under
 *   `<body>` (the settings dialog portal). Nav cells are keyed by section id,
 *   so a mark survives label changes while the dialog is open.
 * - Fallback: markup that does not match keeps the gear.
 */

/** A section glyph: the SVG markup used as a mask over the text color. */
export interface NavIcon {
  key: string
  label: () => string
  svg: string
}

/** Outline Medium artworks from @deepseek-ai/dsh-client-ui-primitives (MIT), 16×16, stroke 1.3. */
export const GLYPHS = {
  panelLeft: '<path d="M13.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z"/><path d="M5.5 1.5V14.5"/>',
  gauge: '<path d="M3.4041 13.096C2.49514 12.187 1.87614 11.0288 1.62537 9.76798C1.37459 8.50716 1.50331 7.20028 1.99525 6.01261C2.48719 4.82494 3.32025 3.80981 4.3891 3.09557C5.45795 2.38134 6.71458 2.00008 8.0001 2C9.28563 2.00008 10.5423 2.38134 11.6111 3.09557C12.68 3.80981 13.513 4.82494 14.005 6.01261C14.4969 7.20028 14.6256 8.50716 14.3748 9.76798C14.1241 11.0288 13.5051 12.187 12.5961 13.096"/><path d="M8 8.49994L11.6114 4.88855"/><path d="M8 9.75C8.69036 9.75 9.25 9.19036 9.25 8.5C9.25 7.80964 8.69036 7.25 8 7.25C7.30964 7.25 6.75 7.80964 6.75 8.5C6.75 9.19036 7.30964 9.75 8 9.75Z" fill="#000" stroke="none"/>',
  terminal: '<path d="M3 4L7 8L3 12"/><path d="M9 12H13"/>',
  lines: '<path d="M6 3.5h7.5M6 8h7.5M6 12.5h7.5" stroke-linecap="round"/><path d="M2.6 3.5h.01M2.6 8h.01M2.6 12.5h.01" stroke-linecap="round"/>',
} as const

const ATTRIBUTE = 'data-dsh-toolkit-nav'
const STYLE_ID = 'dsh-toolkit/nav-icon'

function maskUrl(paths: string): string {
  return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.3">${paths}</svg>`)
}

function css(icons: readonly NavIcon[]): string {
  const rules = icons.map(icon => {
    const url = maskUrl(icon.svg)
    return `button[${ATTRIBUTE}="${icon.key}"]::before { -webkit-mask-image: url("${url}"); mask-image: url("${url}"); }`
  })
  return `button[${ATTRIBUTE}] > svg[class*="_navIcon"] { display: none; }
button[${ATTRIBUTE}]::before { content: ""; flex: none; width: 16px; height: 16px; background-color: currentColor; -webkit-mask: center / 16px 16px no-repeat; mask: center / 16px 16px no-repeat; }
${rules.join('\n')}
`
}

/**
 * Keep the listed sections' nav buttons marked; returns a disposer.
 * @param icons - sections by current nav label.
 */
export function mountNavIcons(icons: readonly NavIcon[]): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-toolkit'
  style.dataset.pluginCss = STYLE_ID
  style.textContent = css(icons)
  document.head.appendChild(style)

  const mark = (root: ParentNode): void => {
    const cells = root.querySelectorAll<HTMLButtonElement>('button[class*="_navCell"]')
    if (cells.length === 0) return
    const keys = new Map(icons.map(icon => [icon.label(), icon.key]))
    for (const cell of cells) {
      const key = keys.get(cell.querySelector('[class*="_navLabel"]')?.textContent ?? '')
      if (key !== undefined) cell.setAttribute(ATTRIBUTE, key)
    }
  }
  mark(document.body)
  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) if (node instanceof Element) mark(node)
    }
  })
  observer.observe(document.body, { childList: true })

  return () => {
    observer.disconnect()
    style.remove()
    for (const cell of document.querySelectorAll(`[${ATTRIBUTE}]`)) cell.removeAttribute(ATTRIBUTE)
  }
}
