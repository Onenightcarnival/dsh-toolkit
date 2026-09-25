// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAction } from '../src/content/actions.ts'
import { ElementIds } from '../src/content/ids.ts'
import { buildSnapshot } from '../src/content/snapshot.ts'

const budget = { maxItems: 50, maxForms: 25, maxChars: 20_000 }

function mount(html: string): ElementIds {
  document.body.innerHTML = html
  for (const el of document.body.querySelectorAll<HTMLElement>('*')) el.scrollIntoView = vi.fn()
  const ids = new ElementIds()
  buildSnapshot(ids, { budget }, null)
  return ids
}

const indexOf = (ids: ElementIds, id: string): number => ids.indexOf(document.getElementById(id)!)!

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('browser_get_text', () => {
  it('returns markdown of the main region by default and plain text on request', async () => {
    const ids = mount('<nav><a href="/x">Nav link</a></nav><main><h1>Title</h1><p>Body <strong>bold</strong></p></main>')
    const markdown = await runAction('browser_get_text', {}, { ids, budget })
    expect(markdown.text).toContain('# Title')
    expect(markdown.text).toContain('Body **bold**')
    expect(markdown.text).not.toContain('Nav link')

    const plain = await runAction('browser_get_text', { format: 'plain' }, { ids, budget })
    expect(plain.text).toContain('Nav link')
    expect(plain.text).not.toContain('# Title')

    const scoped = await runAction('browser_get_text', { selector: 'nav' }, { ids, budget })
    expect(scoped.text).toBe('[Nav link](http://localhost:3000/x)')
    const missing = await runAction('browser_get_text', { selector: '#nope' }, { ids, budget })
    expect(missing.text).toContain('No element matched selector')
  })

  it('truncates long markdown and says how to narrow the read', async () => {
    const ids = mount(`<main>${'<p>paragraph text</p>'.repeat(2_000)}</main>`)
    const result = await runAction('browser_get_text', {}, { ids, budget: { ...budget, maxChars: 8_000 } })
    expect(result.text.length).toBeLessThan(9_000)
    expect(result.text).toMatch(/Truncated \d+ characters; use selector/)
  })
})

describe('browser_element_rect', () => {
  it('scrolls the element into view and reports its viewport center', async () => {
    const ids = mount('<button id="b">Go</button>')
    const button = document.getElementById('b') as HTMLButtonElement
    button.getBoundingClientRect = () => ({ x: 10, y: 20, width: 100, height: 30, top: 20, left: 10, right: 110, bottom: 50, toJSON: () => ({}) })
    const index = indexOf(ids, 'b')
    const result = await runAction('browser_element_rect', { index }, { ids, budget })
    expect(button.scrollIntoView).toHaveBeenCalled()
    expect(JSON.parse(result.text)).toEqual({ x: 60, y: 35, width: 100, height: 30, label: `[${index}]` })
  })

  it('rejects an unknown index', async () => {
    const ids = mount('<button id="b">Go</button>')
    await expect(runAction('browser_element_rect', { index: 999 }, { ids, budget })).rejects.toMatchObject({ code: 'action-failed' })
    await expect(runAction('browser_element_rect', {}, { ids, budget })).rejects.toMatchObject({ code: 'bad-args' })
  })
})

describe('browser_drag', () => {
  it('emits pointer and drag events from the source to the target element', async () => {
    const ids = mount('<div id="src" draggable="true">Card</div><div id="dst">Drop zone</div><button id="b">x</button>')
    const src = document.getElementById('src') as HTMLElement
    const dst = document.getElementById('dst') as HTMLElement
    src.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 40, top: 0, left: 0, right: 100, bottom: 40, toJSON: () => ({}) })
    dst.getBoundingClientRect = () => ({ x: 300, y: 0, width: 100, height: 40, top: 0, left: 300, right: 400, bottom: 40, toJSON: () => ({}) })
    await runAction('browser_find', { selector: '#src, #dst' }, { ids, budget })
    const srcIndex = ids.indexOf(src)!
    const dstIndex = ids.indexOf(dst)!
    const srcEvents: string[] = []
    const dstEvents: Array<[string, number]> = []
    for (const type of ['pointerdown', 'mousedown', 'dragstart', 'dragend']) src.addEventListener(type, () => srcEvents.push(type))
    for (const type of ['mouseup', 'pointerup', 'drop', 'dragover']) dst.addEventListener(type, (event) => dstEvents.push([type, (event as MouseEvent).clientX]))

    const result = await runAction('browser_drag', { index: srcIndex, toIndex: dstIndex }, { ids, budget })
    expect(srcEvents).toEqual(expect.arrayContaining(['pointerdown', 'mousedown', 'dragstart', 'dragend']))
    expect(dstEvents).toEqual(expect.arrayContaining([['drop', 350], ['mouseup', 350], ['pointerup', 350]]))
    expect(result.text).toContain(`Dragged [${srcIndex}] to [${dstIndex}]`)
  })

  it('accepts coordinate drop targets and rejects a missing target', async () => {
    const ids = mount('<div id="src" draggable="true">Card</div>')
    const src = document.getElementById('src') as HTMLElement
    await runAction('browser_find', { selector: '#src' }, { ids, budget })
    document.elementFromPoint = () => src
    const result = await runAction('browser_drag', { index: ids.indexOf(src), toX: 200, toY: 50 }, { ids, budget })
    expect(result.text).toContain('(200, 50)')
    await expect(runAction('browser_drag', { index: ids.indexOf(src) }, { ids, budget })).rejects.toMatchObject({ code: 'bad-args' })
  })
})

describe('browser_upload', () => {
  class FakeDataTransfer {
    readonly items = { add: (file: File): void => { this.list.push(file) } }
    private readonly list: File[] = []
    get files(): FileList {
      const list = this.list
      return Object.assign([...list], { item: (i: number) => list[i] ?? null }) as unknown as FileList
    }
  }

  beforeEach(() => {
    vi.stubGlobal('DataTransfer', FakeDataTransfer)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function writableFiles(input: HTMLInputElement): void {
    Object.defineProperty(input, 'files', { writable: true, value: null })
  }

  it('sets files on a file input and dispatches input/change', async () => {
    const ids = mount('<input id="f" type="file" multiple>')
    const input = document.getElementById('f') as HTMLInputElement
    writableFiles(input)
    const events: string[] = []
    input.addEventListener('input', () => events.push('input'))
    input.addEventListener('change', () => events.push('change'))
    const result = await runAction('browser_upload', {
      index: indexOf(ids, 'f'),
      files: [{ name: 'a.txt', mediaType: 'text/plain', data: btoa('hello') }, { name: 'b.bin', data: btoa('xyz') }],
    }, { ids, budget })
    expect(input.files?.length).toBe(2)
    expect(input.files?.[0]?.name).toBe('a.txt')
    expect(input.files?.[0]?.type).toBe('text/plain')
    expect(input.files?.[1]?.type).toBe('application/octet-stream')
    expect(events).toEqual(['input', 'change'])
    expect(result.text).toContain('a.txt (5 bytes)')
    expect(result.text).toContain('b.bin (3 bytes)')
  })

  it('finds the hidden file input behind a styled upload button', async () => {
    const ids = mount('<div class="upload-area"><button id="btn">Choose file</button><input id="f" type="file" style="display:none"></div>')
    const input = document.getElementById('f') as HTMLInputElement
    writableFiles(input)
    const result = await runAction('browser_upload', { index: indexOf(ids, 'btn'), files: [{ name: 'c.txt', data: btoa('c') }] }, { ids, budget })
    expect(input.files?.length).toBe(1)
    expect(result.text).toContain('c.txt')
  })

  it('validates the file list and single-file inputs', async () => {
    const ids = mount('<input id="f" type="file"><div><button id="b">Plain</button></div>')
    writableFiles(document.getElementById('f') as HTMLInputElement)
    await expect(runAction('browser_upload', { index: indexOf(ids, 'f'), files: [] }, { ids, budget })).rejects.toMatchObject({ code: 'bad-args' })
    await expect(runAction('browser_upload', { index: indexOf(ids, 'f'), files: [{ name: 'x' }] }, { ids, budget })).rejects.toMatchObject({ code: 'bad-args' })
    await expect(runAction('browser_upload', { index: indexOf(ids, 'f'), files: [{ name: 'x', data: btoa('1') }, { name: 'y', data: btoa('2') }] }, { ids, budget }))
      .rejects.toMatchObject({ code: 'action-failed', message: expect.stringContaining('accepts a single file') })
    await expect(runAction('browser_upload', { index: indexOf(ids, 'b'), files: [{ name: 'x', data: btoa('1') }] }, { ids, budget }))
      .rejects.toMatchObject({ code: 'action-failed', message: expect.stringContaining('not a file input') })
  })
})
