// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `chrome.scripting.executeScript` is mocked to run the serialized function
 * inside this jsdom window, so the hooks are exercised end to end: install,
 * page calls, read-back, and policy changes.
 */
const executed: Array<{ tabId: number; name: string }> = []

beforeEach(() => {
  executed.length = 0
  vi.stubGlobal('chrome', {
    scripting: {
      executeScript: vi.fn(async (injection: { target: { tabId: number }; func: (...args: unknown[]) => unknown; args?: unknown[] }) => {
        executed.push({ tabId: injection.target.tabId, name: injection.func.name })
        return [{ result: injection.func(...(injection.args ?? [])) }]
      }),
    },
  })
  vi.resetModules()
})

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__dshPageHooks
  vi.unstubAllGlobals()
})

async function load(): Promise<typeof import('../src/background/page-hooks.ts')> {
  return import('../src/background/page-hooks.ts')
}

describe('page hooks', () => {
  it('installs once per document and re-installs for a new document', async () => {
    const mod = await load()
    await mod.ensurePageHooks(3, 'doc-a')
    await mod.ensurePageHooks(3, 'doc-a')
    expect(executed.filter((entry) => entry.name === 'installHooks')).toHaveLength(1)
    await mod.ensurePageHooks(3, 'doc-b')
    expect(executed.filter((entry) => entry.name === 'installHooks')).toHaveLength(2)
    mod.forgetPageHooks(3)
    await mod.ensurePageHooks(3, 'doc-b')
    expect(executed.filter((entry) => entry.name === 'installHooks')).toHaveLength(3)
  })

  it('answers dialogs per policy and records them for the model', async () => {
    const mod = await load()
    await mod.ensurePageHooks(1, 'doc')
    window.alert('hi')
    expect(window.confirm('sure?')).toBe(false)
    expect(window.prompt('name?', 'dflt')).toBeNull()

    expect(await mod.applyDialogPolicy(1, { action: 'accept', once: true })).toBe(true)
    expect(window.confirm('really?')).toBe(true)
    expect(window.confirm('again?')).toBe(false)

    await mod.applyDialogPolicy(1, { action: 'accept', text: 'Patricia', once: false })
    expect(window.prompt('name?')).toBe('Patricia')
    expect(window.prompt('name?')).toBe('Patricia')
    await mod.applyDialogPolicy(1, { action: 'accept', once: false })
    expect(window.prompt('name?', 'dflt')).toBe('dflt')

    const records = await mod.readDialogs(1, true)
    expect(records.map((record) => `${record.type}:${record.outcome}`)).toEqual([
      'alert:accepted', 'confirm:dismissed', 'prompt:dismissed', 'confirm:accepted', 'confirm:dismissed',
      'prompt:accepted', 'prompt:accepted', 'prompt:accepted',
    ])
    expect(await mod.readDialogs(1, true)).toEqual([])
    const text = mod.describeDialogs(records.slice(0, 4))
    expect(text).toBe('alert("hi") → closed\nconfirm("sure?") → dismissed (Cancel)\nprompt("name?") → dismissed (Cancel)\nconfirm("really?") → accepted (OK)')
    expect(mod.describeDialogs(records.slice(5, 6))).toBe('prompt("name?") → accepted with "Patricia"')
  })

  it('captures console output and uncaught errors, and clears on request', async () => {
    const mod = await load()
    expect(await mod.readConsole(2, false)).toBeNull()
    await mod.ensurePageHooks(2, 'doc')
    console.log('hello', { a: 1 })
    console.warn('careful')
    console.error(new Error('bad'))
    window.dispatchEvent(Object.assign(new Event('error'), { message: 'boom', filename: 'app.js', lineno: 3 }))
    const records = await mod.readConsole(2, true)
    expect(records?.map((record) => `${record.level}:${record.text}`)).toEqual([
      'log:hello {"a":1}',
      'warn:careful',
      'error:Error: bad',
      'error:Uncaught boom (app.js:3)',
    ])
    expect(await mod.readConsole(2, false)).toEqual([])
  })

  it('records XHR requests with status and timing', async () => {
    const mod = await load()
    await mod.ensurePageHooks(4, 'doc')
    const xhr = new XMLHttpRequest()
    xhr.open('GET', 'data:text/plain,ok')
    const done = new Promise<void>((resolve) => xhr.addEventListener('loadend', () => setTimeout(resolve, 0)))
    xhr.send()
    await done
    const records = await mod.readNetwork(4, true)
    expect(records).toHaveLength(1)
    expect(records?.[0]).toMatchObject({ kind: 'xhr', method: 'GET', url: 'data:text/plain,ok', status: 200, ok: true })
    expect(typeof records?.[0]?.ms).toBe('number')
  })

  it('evaluates expressions in the page and reports errors and promises', async () => {
    const mod = await load()
    await mod.ensurePageHooks(5, 'doc')
    document.title = 'Probe'
    expect(await mod.evaluateExpression(5, 'document.title + "!"')).toEqual({ ok: true, value: 'Probe!' })
    expect(await mod.evaluateExpression(5, '({ n: 1, list: [1, 2] })')).toEqual({ ok: true, value: { n: 1, list: [1, 2] } })
    expect(await mod.evaluateExpression(5, 'undefined')).toEqual({ ok: true, value: null })
    expect(await mod.evaluateExpression(5, 'Math.max')).toEqual({ ok: true, value: '[function max]' })
    const thrown = await mod.evaluateExpression(5, 'nope.x')
    expect(thrown.ok).toBe(false)
    expect((thrown as { error: string }).error).toMatch(/ReferenceError/)
    const promised = await mod.evaluateExpression(5, 'Promise.resolve(1)')
    expect(promised.ok).toBe(false)
    expect((promised as { error: string }).error).toContain('Promise')
  })
})
