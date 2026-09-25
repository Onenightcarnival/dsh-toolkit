// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { BridgeState } from '../src/background/bridge.ts'
import type { PanelApi } from '../src/panel/api.ts'
import type { ServerFrame } from '@onenightcarnival/dsh-bridge-browser/src/protocol.ts'

let panelApi: PanelApi
vi.mock('../src/panel/api.ts', async () => {
  const actual = await vi.importActual<typeof import('../src/panel/api.ts')>('../src/panel/api.ts')
  return { ...actual, connectPanel: () => panelApi }
})

import { App } from '../src/panel/App.tsx'

const catalog = {
  default: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  routableProviders: ['deepseek'],
  groups: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'deepseek-v4', name: 'DeepSeek V4', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
      ],
    },
    { id: 'relay', name: 'My relay', models: [{ id: 'gpt-x', name: 'GPT X' }] },
  ],
  failures: [],
}

describe('panel model picker', () => {
  let root: Root
  let onStatus: ((state: BridgeState, caps: null) => void) | undefined
  let onResumeHint: ((sessionId: string | null) => void) | undefined
  let onEvent: ((frame: ServerFrame) => void) | undefined
  let rpc: Mock<(method: string, payload?: unknown) => Promise<unknown>>

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    HTMLElement.prototype.scrollTo = vi.fn()
    vi.stubGlobal('chrome', {
      storage: { local: { get: vi.fn(async () => ({ dshSettings: { autoResumeSession: false } })) } },
      windows: { getCurrent: vi.fn(async () => ({ id: 1 })) },
    })
    rpc = vi.fn(async (method: string, payload?: unknown) => {
      if (method === 'session.create') return { sessionId: 'session-current' }
      if (method === 'session.history') return { events: [] }
      if (method === 'session.list') return { items: [] }
      if (method === 'session.modelCatalog') return catalog
      if (method === 'session.selectModel') {
        const { sessionId: _sessionId, ...selection } = payload as Record<string, unknown>
        return { selected: selection }
      }
      throw new Error(`unexpected RPC: ${method}`)
    })
    const unsubscribe = (): void => {}
    panelApi = {
      rpc: async <T = unknown>(method: string, payload?: unknown): Promise<T> => await rpc(method, payload) as T,
      respond: vi.fn(async () => undefined),
      onStatus: vi.fn((callback) => { onStatus = callback; return unsubscribe }),
      onEvent: vi.fn((callback) => { onEvent = callback; return unsubscribe }),
      onApprovalRequest: vi.fn(() => unsubscribe),
      onApprovalResolved: vi.fn(() => unsubscribe),
      onTabAffinity: vi.fn(() => unsubscribe),
      onSelection: vi.fn(() => unsubscribe),
      onSessionResumeHint: vi.fn((callback) => { onResumeHint = callback; return unsubscribe }),
      respondToApproval: vi.fn(async () => {}),
      resolveTabAffinity: vi.fn(async () => {}),
      rebindTabAffinity: vi.fn(async () => {}),
      clearSelection: vi.fn(async () => {}),
      registerWindow: vi.fn(async () => {}),
      setActiveSession: vi.fn(async () => {}),
      updateSettings: vi.fn(async () => {}),
      requestStatus: vi.fn(async () => {}),
    }
    root = createRoot(document.querySelector('#root')!)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function renderConnected(): Promise<void> {
    await act(async () => { root.render(createElement(App)) })
    await act(async () => {
      onStatus?.('connected', null)
      onResumeHint?.(null)
    })
  }

  const chip = (): HTMLButtonElement => document.querySelector('.model-chip') as HTMLButtonElement
  const click = async (element: Element | null): Promise<void> => {
    await act(async () => { (element as HTMLElement).click() })
  }

  it('shows the catalog default, lists providers and models, and switches through session.selectModel', async () => {
    await renderConnected()
    expect(rpc).toHaveBeenCalledWith('session.modelCatalog', {})
    expect(chip().textContent).toBe('DeepSeek V4 Flash')
    expect(document.querySelector('.model-menu')).toBeNull()

    await click(chip())
    const menu = document.querySelector('.model-menu')
    expect(menu).not.toBeNull()
    expect([...menu!.querySelectorAll('.model-group-name > span:first-child')].map((el) => el.textContent)).toEqual(['DeepSeek', 'My relay'])
    const options = [...menu!.querySelectorAll<HTMLButtonElement>('.model-option')]
    expect(options.map((option) => option.querySelector('.model-option-name')?.textContent)).toEqual(['DeepSeek V4 Flash', 'DeepSeek V4', 'GPT X'])
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')
    // The relay provider is configured but not routable: visible, disabled, flagged.
    expect(options[2]?.disabled).toBe(true)
    expect(menu!.querySelector('.model-group-flag')).not.toBeNull()
    expect(menu!.querySelector('.model-efforts')).toBeNull()

    await click(options[1]!)
    expect(rpc).toHaveBeenCalledWith('session.selectModel', {
      sessionId: 'session-current', provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high',
    })
    expect(chip().textContent).toBe('DeepSeek V4 · High')
    expect(document.querySelector('.model-menu')).toBeNull()

    await click(chip())
    const efforts = [...document.querySelectorAll<HTMLButtonElement>('.model-effort')]
    expect(efforts.map((effort) => effort.textContent)).toEqual(['Low', 'High'])
    expect(efforts[1]?.getAttribute('aria-checked')).toBe('true')
    await click(efforts[0]!)
    expect(rpc).toHaveBeenLastCalledWith('session.selectModel', {
      sessionId: 'session-current', provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'low',
    })
    expect(chip().textContent).toBe('DeepSeek V4 · Low')
  })

  it('follows the modelSelection projection from history and live frames', async () => {
    const original = rpc.getMockImplementation()!
    rpc.mockImplementation(async (method, payload) => method === 'session.history'
      ? { events: [], projections: { asOfSeq: 3, values: { modelSelection: { lastUsed: { provider: 'relay', model: 'gpt-x' }, next: null } } } }
      : original(method, payload))
    await renderConnected()
    expect(chip().textContent).toBe('GPT X')

    await act(async () => {
      onEvent?.({ t: 'event', frame: { rpcId: 'p-1', method: 'session/projection', payload: {
        sessionId: 'session-current', key: 'modelSelection', seq: 4,
        value: { lastUsed: { provider: 'relay', model: 'gpt-x' }, next: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' } },
      } } })
    })
    expect(chip().textContent).toBe('DeepSeek V4 · High')

    // Another session's projection must not touch the current chip.
    await act(async () => {
      onEvent?.({ t: 'event', frame: { rpcId: 'p-2', method: 'session/projection', payload: {
        sessionId: 'session-other', key: 'modelSelection', seq: 9,
        value: { lastUsed: null, next: { provider: 'relay', model: 'gpt-x' } },
      } } })
    })
    expect(chip().textContent).toBe('DeepSeek V4 · High')
  })

  it('surfaces a rejected switch as an error and keeps the previous selection', async () => {
    const original = rpc.getMockImplementation()!
    rpc.mockImplementation(async (method, payload) => method === 'session.selectModel'
      ? Promise.reject(new Error('session/model-unavailable: no such route'))
      : original(method, payload))
    await renderConnected()
    await click(chip())
    await click(document.querySelectorAll('.model-option')[1]!)
    expect(document.querySelector('.error')?.textContent).toContain('no such route')
    expect(chip().textContent).toBe('DeepSeek V4 Flash')
  })
})
