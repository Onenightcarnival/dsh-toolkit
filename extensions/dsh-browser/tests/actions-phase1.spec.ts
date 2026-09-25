// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseKeyCombo, runAction } from '../src/content/actions.ts'
import { collectInteractive, deepQuerySelectorAll } from '../src/content/extract.ts'
import { ElementIds } from '../src/content/ids.ts'
import { buildSnapshot, renderSnapshot } from '../src/content/snapshot.ts'
import { parseAnnotationPayload, splitDataUrl } from '../src/background/screenshot.ts'

const budget = { maxItems: 50, maxForms: 25, maxChars: 20_000 }

function mount(html: string): void {
  document.body.innerHTML = html
  for (const el of document.body.querySelectorAll<HTMLElement>('*')) el.scrollIntoView = vi.fn()
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('shadow DOM piercing', () => {
  it('inventories controls inside open shadow roots and reads their text', () => {
    mount('<div id="host"></div><button id="light">Light</button>')
    const host = document.getElementById('host') as HTMLElement
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<button id="deep">Deep button</button><div id="nested"></div>'
    const nested = root.getElementById('nested') as HTMLElement
    nested.attachShadow({ mode: 'open' }).innerHTML = '<a href="/inner">Inner link</a>'
    for (const el of [...root.querySelectorAll<HTMLElement>('*'), ...(nested.shadowRoot as ShadowRoot).querySelectorAll<HTMLElement>('*')]) {
      el.scrollIntoView = vi.fn()
    }

    const names = collectInteractive(document).map((el) => el.textContent)
    expect(names).toEqual(['Light', 'Deep button', 'Inner link'])
    expect(deepQuerySelectorAll(document, 'a[href]').map((el) => el.textContent)).toEqual(['Inner link'])

    const ids = new ElementIds()
    const view = buildSnapshot(ids, { budget }, null)
    expect(view.items.map((item) => item.name)).toEqual(['Light', 'Deep button', 'Inner link'])
  })
})

describe('snapshot enrichment', () => {
  it('lists select options, marks expanded state, and reports rects', () => {
    mount(`
      <select id="s"><option value="a">Alpha</option><option value="b" selected>Beta</option></select>
      <button aria-expanded="false">Menu</button>
    `)
    const ids = new ElementIds()
    const view = buildSnapshot(ids, { budget }, null)
    const select = view.items.find((item) => item.role === 'select')!
    expect(select.options).toEqual(['Alpha', 'Beta ✓'])
    expect(select.rect).toEqual({ x: 0, y: 0, width: 200, height: 40 })
    const menu = view.items.find((item) => item.name === 'Menu')!
    expect(menu.expanded).toBe(false)
    const text = renderSnapshot(view, false)
    expect(text).toContain('options: "Alpha", "Beta ✓"')
    expect(text).toContain('[collapsed]')
  })
})

describe('browser_find', () => {
  it('matches by text, role, and selector inside shadow roots and returns addressable indices', async () => {
    mount('<h1>Orders</h1><button>Export CSV</button><input placeholder="Search orders"><div id="host"></div>')
    const host = document.getElementById('host') as HTMLElement
    host.attachShadow({ mode: 'open' }).innerHTML = '<button>Export PDF</button>'
    ;(host.shadowRoot!.firstElementChild as HTMLElement).scrollIntoView = vi.fn()
    const ids = new ElementIds()
    buildSnapshot(ids, { budget }, null)

    const byText = await runAction('browser_find', { text: 'export' }, { ids, budget })
    expect(byText.text).toMatch(/^2 matches:/)
    expect(byText.text).toContain('button "Export CSV"')
    expect(byText.text).toContain('button "Export PDF"')
    expect(byText.text).toContain('at (100, 20)')

    const byRole = await runAction('browser_find', { role: 'heading' }, { ids, budget })
    expect(byRole.text).toContain('heading "Orders"')
    const headingIndex = Number(/\[(\d+)\] heading/.exec(byRole.text)?.[1])
    expect(ids.elementByIndex(headingIndex)?.textContent).toBe('Orders')

    const byPlaceholder = await runAction('browser_find', { text: 'search orders', role: 'input' }, { ids, budget })
    expect(byPlaceholder.text).toContain('input "Search orders"')

    const none = await runAction('browser_find', { selector: 'table' }, { ids, budget })
    expect(none.text).toBe('No elements matched.')
    await expect(runAction('browser_find', {}, { ids, budget })).rejects.toMatchObject({ code: 'bad-args' })
  })

  it('keeps find-assigned indices valid across later snapshots while the element stays attached', async () => {
    mount('<p id="para">Total due: 42</p><button>Pay</button>')
    const ids = new ElementIds()
    buildSnapshot(ids, { budget }, null)
    const found = await runAction('browser_find', { text: 'total due' }, { ids, budget })
    const index = Number(/\[(\d+)\]/.exec(found.text)?.[1])
    buildSnapshot(ids, { budget }, null)
    expect(ids.elementByIndex(index)?.id).toBe('para')
    document.getElementById('para')?.remove()
    buildSnapshot(ids, { budget }, null)
    expect(ids.elementByIndex(index)).toBeUndefined()
  })
})

describe('browser_form_input', () => {
  it('sets text, selects by label or value, toggles checkboxes, and reports each field', async () => {
    mount(`
      <input id="name" value="old">
      <select id="country"><option value="cn">China</option><option value="sg">Singapore</option></select>
      <select id="tags" multiple><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>
      <input id="agree" type="checkbox">
      <textarea id="notes"></textarea>
    `)
    const ids = new ElementIds()
    buildSnapshot(ids, { budget }, null)
    const indexOf = (id: string): number => ids.indexOf(document.getElementById(id)!)!
    const changes: string[] = []
    for (const id of ['name', 'country', 'tags', 'agree', 'notes']) {
      document.getElementById(id)!.addEventListener('change', () => changes.push(id))
    }

    const result = await runAction('browser_form_input', { fields: [
      { index: indexOf('name'), value: 'Patricia' },
      { index: indexOf('country'), value: 'singapore' },
      { index: indexOf('tags'), value: ['A', 'c'] },
      { index: indexOf('agree'), value: true },
      { index: indexOf('notes'), value: 'multi\nline' },
    ] }, { ids, budget })

    expect((document.getElementById('name') as HTMLInputElement).value).toBe('Patricia')
    expect((document.getElementById('country') as HTMLSelectElement).value).toBe('sg')
    expect([...(document.getElementById('tags') as HTMLSelectElement).selectedOptions].map((o) => o.value)).toEqual(['a', 'c'])
    expect((document.getElementById('agree') as HTMLInputElement).checked).toBe(true)
    expect((document.getElementById('notes') as HTMLTextAreaElement).value).toBe('multi\nline')
    expect(changes).toEqual(['name', 'country', 'tags', 'agree', 'notes'])
    expect(result.text).not.toContain('Patricia')
    expect(result.text).toContain('selected')

    await expect(runAction('browser_form_input', { fields: [{ index: indexOf('country'), value: 'Mars' }] }, { ids, budget }))
      .rejects.toMatchObject({ code: 'action-failed', message: expect.stringContaining('no option matching') })
    await expect(runAction('browser_form_input', { fields: [] }, { ids, budget })).rejects.toMatchObject({ code: 'bad-args' })
  })
})

describe('browser_press combos and browser_hover', () => {
  it('parses modifier combinations', () => {
    expect(parseKeyCombo('Ctrl+Shift+ArrowDown')).toEqual({ key: 'ArrowDown', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false })
    expect(parseKeyCombo('Meta+Enter')).toMatchObject({ key: 'Enter', metaKey: true })
    expect(parseKeyCombo('+')).toEqual({ key: '+', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false })
    expect(parseKeyCombo('a')).toMatchObject({ key: 'a' })
  })

  it('dispatches keydown with modifiers and hover pointer events', async () => {
    mount('<input id="field"><button id="target">Hover me</button>')
    const field = document.getElementById('field') as HTMLInputElement
    field.focus()
    const seen: KeyboardEvent[] = []
    field.addEventListener('keydown', (event) => seen.push(event))
    const ids = new ElementIds()
    buildSnapshot(ids, { budget }, null)
    await runAction('browser_press', { key: 'Ctrl+a' }, { ids, budget })
    expect(seen[0]?.key).toBe('a')
    expect(seen[0]?.ctrlKey).toBe(true)

    const target = document.getElementById('target') as HTMLButtonElement
    const hovered: string[] = []
    for (const type of ['mouseover', 'mouseenter', 'pointerover']) target.addEventListener(type, () => hovered.push(type))
    const result = await runAction('browser_hover', { index: ids.indexOf(target) }, { ids, budget })
    expect(hovered).toEqual(expect.arrayContaining(['mouseover', 'mouseenter']))
    expect(result.text).toContain('Hovered')
  })
})

describe('browser_wait_for', () => {
  it('resolves when text appears and fails on timeout', async () => {
    mount('<div id="status">loading</div>')
    const ids = new ElementIds()
    const pending = runAction('browser_wait_for', { text: 'ready', timeoutMs: 2_000 }, { ids, budget })
    setTimeout(() => { document.getElementById('status')!.textContent = 'Ready!' }, 30)
    const result = await pending
    expect(result.text).toMatch(/text "ready" appeared after \d+ms/)

    await expect(runAction('browser_wait_for', { selector: '#missing', timeoutMs: 100 }, { ids, budget }))
      .rejects.toMatchObject({ code: 'action-failed', message: expect.stringContaining('Timed out') })
    const gone = await runAction('browser_wait_for', { selector: '#missing', gone: true, timeoutMs: 100 }, { ids, budget })
    expect(gone.text).toContain('disappeared')
    await expect(runAction('browser_wait_for', {}, { ids, budget })).rejects.toMatchObject({ code: 'bad-args' })
  })
})

describe('screenshot helpers', () => {
  it('reports the inventory rects for annotation', async () => {
    mount('<button>One</button><a href="/two">Two</a>')
    const ids = new ElementIds()
    const result = await runAction('browser_element_rects', {}, { ids, budget })
    const payload = parseAnnotationPayload(result.text)
    expect(payload?.rects).toHaveLength(2)
    expect(payload?.rects[0]).toMatchObject({ x: 0, y: 0, width: 200, height: 40 })
    expect(payload?.viewport.width).toBeGreaterThan(0)
  })

  it('splits data URLs and rejects malformed payloads', () => {
    expect(splitDataUrl('data:image/png;base64,AAAA')).toEqual({ mediaType: 'image/png', base64: 'AAAA' })
    expect(() => splitDataUrl('nope')).toThrow()
    expect(parseAnnotationPayload('{')).toBeNull()
    expect(parseAnnotationPayload(JSON.stringify({ rects: [{ index: 1 }], viewport: { width: 10, height: 10 } }))?.rects).toEqual([])
  })
})
