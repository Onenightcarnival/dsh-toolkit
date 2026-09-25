import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BridgeServer } from '../src/server.ts'
import { BROWSER_TOOL_NAMES, registerBrowserTools } from '../src/tools.ts'

describe('registerBrowserTools', () => {
  function makeHarness() {
    const registered: { name: string; definition: Record<string, unknown> }[] = []
    const ctx = {
      tools: {
        register: vi.fn((definition: { name: string }) => {
          registered.push({ name: definition.name, definition: definition as Record<string, unknown> })
          return () => {}
        }),
      },
    } as unknown as Context
    const requestTool = vi.fn(async (_name: string, _args: Record<string, unknown>, _signal: AbortSignal, _timeoutMs?: number): Promise<unknown> => {
      return { text: 'ok' }
    })
    const bridge = { requestTool } as unknown as BridgeServer
    return { ctx, bridge, requestTool, registered }
  }

  it('registers the full v1 tool set', () => {
    const { ctx, bridge, registered } = makeHarness()
    const disposers = registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    expect(registered.map((r) => r.name).sort()).toEqual([...BROWSER_TOOL_NAMES].sort())
    expect(disposers.size).toBe(BROWSER_TOOL_NAMES.length)
    for (const dispose of disposers.values()) dispose()
  })

  it('executes browser_click with mapped args', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'browser_click')!
    const exec = { signal: new AbortController().signal }
    const result = await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({ index: 3, frame: 7 }, exec)
    expect(requestTool).toHaveBeenCalledWith('browser_click', { index: 3, frame: 7 }, exec.signal, 1_000)
    expect(result).toEqual({ text: 'ok' })
  })

  it('associates browser calls with the owning Agent session', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'browser_click')!
    const exec = {
      signal: new AbortController().signal,
      agent: { id: 'session-browser' },
    }

    await (tool.definition.execute as (args: unknown, e: typeof exec) => Promise<unknown>)({ index: 3 }, exec)

    expect(requestTool).toHaveBeenCalledWith(
      'browser_click',
      { index: 3 },
      exec.signal,
      1_000,
      'session-browser',
    )
  })

  it('normalizes snapshot args (delta/region omitted when absent)', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'browser_snapshot')!
    const exec = { signal: new AbortController().signal }
    await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({ delta: true }, exec)
    expect(requestTool).toHaveBeenLastCalledWith('browser_snapshot', { delta: true }, exec.signal, 1_000)
    await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({}, exec)
    expect(requestTool).toHaveBeenLastCalledWith('browser_snapshot', {}, exec.signal, 1_000)
    await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({ delta: true, region: 'main' }, exec)
    expect(requestTool).toHaveBeenLastCalledWith('browser_snapshot', { delta: true, region: 'main' }, exec.signal, 1_000)
  })

  it('executes every remaining tool with mapped args', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const byName = new Map(registered.map((r) => [r.name, r.definition]))
    const exec = { signal: new AbortController().signal }
    const run = async (name: string, args: unknown): Promise<void> => {
      await (byName.get(name)!.execute as (a: unknown, e: { signal: AbortSignal }) => Promise<unknown>)(args, exec)
    }

    await run('browser_type', { index: 2, text: 'hello' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_type', { index: 2, text: 'hello' }, exec.signal, 1_000)
    await run('browser_type', { index: 2, text: 'hello', replace: true })
    expect(requestTool).toHaveBeenLastCalledWith('browser_type', { index: 2, text: 'hello', replace: true }, exec.signal, 1_000)
    await run('browser_type', { index: 2, frame: 4, text: 'inside frame' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_type', { index: 2, frame: 4, text: 'inside frame' }, exec.signal, 1_000)

    await run('browser_press', { key: 'Enter' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_press', { key: 'Enter' }, exec.signal, 1_000)

    await run('browser_scroll', { direction: 'down', amount: 200 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_scroll', { direction: 'down', amount: 200 }, exec.signal, 1_000)
    await run('browser_scroll', { direction: 'top' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_scroll', { direction: 'top' }, exec.signal, 1_000)
    await run('browser_scroll', { direction: 'down', frame: 4 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_scroll', { direction: 'down', frame: 4 }, exec.signal, 1_000)

    await run('browser_navigate', { url: 'https://example.com' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_navigate', { url: 'https://example.com' }, exec.signal, 1_000)
    await run('browser_open_tab', { url: 'https://example.com/new' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_open_tab', { url: 'https://example.com/new' }, exec.signal, 1_000)
    await run('browser_open_tab', { url: 'https://example.com/bg', active: false })
    expect(requestTool).toHaveBeenLastCalledWith(
      'browser_open_tab',
      { url: 'https://example.com/bg', active: false },
      exec.signal,
      1_000,
    )

    await run('browser_list_tabs', {})
    expect(requestTool).toHaveBeenLastCalledWith('browser_list_tabs', {}, exec.signal, 1_000)
    await run('browser_follow_tab', { tabId: 17 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_follow_tab', { tabId: 17 }, exec.signal, 1_000)
    await run('browser_close_tab', { tabId: 18 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_close_tab', { tabId: 18 }, exec.signal, 1_000)

    for (const name of ['browser_back', 'browser_forward', 'browser_reload'] as const) {
      await run(name, {})
      expect(requestTool).toHaveBeenLastCalledWith(name, {}, exec.signal, 1_000)
    }

    await run('browser_get_text', { selector: '#main' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_get_text', { selector: '#main' }, exec.signal, 1_000)
    await run('browser_get_text', {})
    expect(requestTool).toHaveBeenLastCalledWith('browser_get_text', {}, exec.signal, 1_000)
    await run('browser_get_text', { selector: 'main', frame: 4 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_get_text', { selector: 'main', frame: 4 }, exec.signal, 1_000)

    await run('browser_wait', { ms: 100 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_wait', { ms: 100 }, exec.signal, 1_000)
    await run('browser_wait', {})
    expect(requestTool).toHaveBeenLastCalledWith('browser_wait', {}, exec.signal, 1_000)
    await run('browser_wait', { frame: 4 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_wait', { frame: 4 }, exec.signal, 1_000)
  })

  it('normalizes every DSH parameter map to JSON Schema before registration', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    for (const { definition } of registered) {
      const params = definition.parameters as { type?: unknown; properties?: unknown }
      expect(params.type).toBe('object')
      expect(params.properties).toBeDefined()
    }
    const click = registered.find(({ name }) => name === 'browser_click')!.definition.parameters as {
      properties: Record<string, unknown>
      required?: string[]
    }
    // Click targets by inventory index or by viewport coordinates, so neither is required on its own.
    expect(click.properties.index).toBeDefined()
    expect(click.properties.x).toBeDefined()
    expect(click.properties.y).toBeDefined()
    expect(click.required ?? []).not.toContain('index')
    const type = registered.find(({ name }) => name === 'browser_type')!.definition.parameters as { required?: string[] }
    expect(type.required).toEqual(expect.arrayContaining(['index', 'text']))
    const formInput = registered.find(({ name }) => name === 'browser_form_input')!.definition.parameters as {
      properties: Record<string, { type?: string; items?: { properties?: Record<string, unknown> } }>
      required?: string[]
    }
    expect(formInput.properties.fields?.type).toBe('array')
    expect(formInput.properties.fields?.items?.properties?.index).toBeDefined()
    expect(formInput.required).toContain('fields')
  })

  it('registers the Claude-in-Chrome-shaped catalog', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const names = registered.map(({ name }) => name)
    for (const expected of [
      'browser_snapshot', 'browser_screenshot', 'browser_find', 'browser_form_input', 'browser_hover', 'browser_wait_for',
      'browser_batch', 'browser_drag', 'browser_upload', 'browser_handle_dialog', 'browser_console', 'browser_network', 'browser_evaluate',
    ]) {
      expect(names).toContain(expected)
    }
    const screenshot = registered.find(({ name }) => name === 'browser_screenshot')!.definition
    expect(typeof screenshot.finalizeContent).toBe('function')
  })

  it('declares cooperative timeoutMs on every tool (longer for batch and upload)', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const multipliers: Record<string, number> = { browser_batch: 3, browser_upload: 2 }
    for (const { name, definition } of registered) {
      expect(definition.timeoutMs, name).toBe(5_000 * (multipliers[name] ?? 1))
    }
  })

  it('keeps model-facing tool schemas in English', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const han = /\p{Script=Han}/u
    for (const { definition } of registered) {
      expect(String(definition.description)).not.toMatch(han)
      expect(JSON.stringify(definition.parameters)).not.toMatch(han)
    }
  })

  it('keeps model-facing tool descriptions bounded', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    // Descriptions carry usage guidance (when to prefer find over snapshot,
    // how coordinates relate to screenshots); the budget is per tool, not a
    // catalog-wide squeeze, since the target models have large contexts.
    for (const { name, definition } of registered) {
      expect(String(definition.description).length, name).toBeLessThan(600)
    }
  })

  it('exposes optional frame routing on frame-local tools only', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 5_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const byName = new Map(registered.map((entry) => [entry.name, entry.definition]))
    for (const name of ['browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_get_text', 'browser_wait']) {
      const params = byName.get(name)!.parameters as { properties: { frame?: { type?: unknown } } }
      expect(params.properties.frame?.type).toBe('number')
    }
    for (const name of ['browser_snapshot', 'browser_navigate', 'browser_open_tab', 'browser_list_tabs', 'browser_follow_tab', 'browser_close_tab', 'browser_back', 'browser_forward', 'browser_reload']) {
      const params = byName.get(name)!.parameters as { properties: { frame?: unknown } }
      expect(params.properties.frame).toBeUndefined()
    }
  })

  it('falls back to a no-text payload when the extension returns non-text', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    requestTool.mockResolvedValueOnce(null)
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'browser_wait')!
    const exec = { signal: new AbortController().signal }
    const result = await (tool.definition.execute as (args: unknown, e: { signal: AbortSignal }) => Promise<unknown>)({}, exec)
    expect(result).toEqual({ text: expect.stringContaining('no text') })
  })

  it('renders the canonical result as one text block', () => {
    const { ctx, bridge, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const tool = registered.find((r) => r.name === 'browser_click')!
    const output = tool.definition.output as { render: (args: unknown, value: unknown) => unknown }
    expect(output.render({}, { text: 'hello' })).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('forwards batch, drag, dialog, console, network, and evaluate args', async () => {
    const { ctx, bridge, requestTool, registered } = makeHarness()
    registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
    const byName = new Map(registered.map((r) => [r.name, r.definition]))
    const exec = { signal: new AbortController().signal, agent: { id: 'session-x' } }
    const run = async (name: string, args: unknown): Promise<unknown> =>
      (byName.get(name)!.execute as (a: unknown, e: typeof exec) => Promise<unknown>)(args, exec)

    const steps = [{ tool: 'browser_type', args: { index: 1, text: 'q' } }, { tool: 'browser_press', args: { key: 'Enter' } }]
    await run('browser_batch', { steps })
    expect(requestTool).toHaveBeenLastCalledWith('browser_batch', { steps }, exec.signal, 3_000, 'session-x')

    await run('browser_drag', { index: 2, toIndex: 5 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_drag', { index: 2, toIndex: 5 }, exec.signal, 1_000, 'session-x')
    await run('browser_drag', { x: 1, y: 2, toX: 30, toY: 40 })
    expect(requestTool).toHaveBeenLastCalledWith('browser_drag', { x: 1, y: 2, toX: 30, toY: 40 }, exec.signal, 1_000, 'session-x')

    await run('browser_handle_dialog', { action: 'accept', text: 'yes', once: false })
    expect(requestTool).toHaveBeenLastCalledWith('browser_handle_dialog', { action: 'accept', text: 'yes', once: false }, exec.signal, 1_000, 'session-x')
    await run('browser_console', { level: 'error', clear: true })
    expect(requestTool).toHaveBeenLastCalledWith('browser_console', { level: 'error', clear: true }, exec.signal, 1_000, 'session-x')
    await run('browser_network', { urlContains: '/api/' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_network', { urlContains: '/api/' }, exec.signal, 1_000, 'session-x')
    await run('browser_evaluate', { expression: 'document.title' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_evaluate', { expression: 'document.title' }, exec.signal, 1_000, 'session-x')
    await run('browser_get_text', { format: 'plain' })
    expect(requestTool).toHaveBeenLastCalledWith('browser_get_text', { format: 'plain' }, exec.signal, 1_000, 'session-x')
  })

  it('reads upload files only from inside the session working directory', async () => {
    const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'dsh-upload-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-outside-'))
    try {
      await mkdir(join(root, 'docs'))
      await writeFile(join(root, 'docs', 'note.txt'), 'hello')
      await writeFile(join(root, 'photo.png'), Buffer.from([0x89, 0x50]))
      await writeFile(join(outside, 'secret.txt'), 'nope')

      const { ctx, bridge, requestTool, registered } = makeHarness()
      registerBrowserTools(ctx, bridge, { toolTimeoutMs: 1_000, snapshotMaxChars: 12_000, maxInteractiveItems: 60 })
      const upload = registered.find((r) => r.name === 'browser_upload')!.definition
      const exec = { signal: new AbortController().signal, agent: { id: 's', session: { header: { cwd: root } } } }
      const run = (args: unknown): Promise<unknown> => (upload.execute as (a: unknown, e: typeof exec) => Promise<unknown>)(args, exec)

      await run({ index: 4, paths: ['docs/note.txt', join(root, 'photo.png')] })
      expect(requestTool).toHaveBeenLastCalledWith('browser_upload', {
        index: 4,
        files: [
          { name: 'note.txt', mediaType: 'text/plain', data: Buffer.from('hello').toString('base64') },
          { name: 'photo.png', mediaType: 'image/png', data: Buffer.from([0x89, 0x50]).toString('base64') },
        ],
      }, exec.signal, 2_000, 's')

      await expect(run({ index: 4, paths: ['../' + outside.split('/').pop() + '/secret.txt'] })).rejects.toThrow(/outside the session working directory/)
      await expect(run({ index: 4, paths: [join(outside, 'secret.txt')] })).rejects.toThrow(/outside the session working directory/)
      await expect(run({ index: 4, paths: ['docs'] })).rejects.toThrow(/not a regular file/)
      await expect(run({ index: 4, paths: [] })).rejects.toThrow(/at least one file/)
      const noCwd = { signal: exec.signal, agent: { id: 's' } }
      await expect((upload.execute as (a: unknown, e: typeof noCwd) => Promise<unknown>)({ index: 4, paths: ['docs/note.txt'] }, noCwd))
        .rejects.toThrow(/session working directory/)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
