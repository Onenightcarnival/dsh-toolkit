// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { MAX_BATCH_STEPS, runBatch } from '../src/background/batch.ts'
import type { ToolAnswer, ToolCall } from '../src/background/tools.ts'

const batch = (steps: unknown): ToolCall => ({ id: 'b1', name: 'browser_batch', args: { steps }, sessionId: 's1' })

describe('runBatch', () => {
  it('runs steps in order with derived ids and merges their text', async () => {
    const seen: ToolCall[] = []
    const runOne = vi.fn(async (one: ToolCall): Promise<ToolAnswer> => {
      seen.push(one)
      return { ok: true, result: { text: `${one.name} done` } }
    })
    const answer = await runBatch(batch([
      { tool: 'browser_click', args: { index: 3 } },
      { tool: 'browser_type', args: { index: 4, text: 'hi' } },
      { tool: 'browser_wait' },
    ]), runOne, new AbortController().signal)
    expect(answer.ok).toBe(true)
    expect(seen.map((one) => one.id)).toEqual(['b1:1', 'b1:2', 'b1:3'])
    expect(seen.map((one) => one.sessionId)).toEqual(['s1', 's1', 's1'])
    expect(seen[2]?.args).toEqual({})
    const text = (answer.result as { text: string }).text
    expect(text).toContain('Batch of 3 step(s) completed.')
    expect(text).toContain('Step 1 (browser_click): ok\nbrowser_click done')
    expect(text).toContain('Step 3 (browser_wait): ok')
  })

  it('stops at the first failure and reports the steps that did not run', async () => {
    const runOne = vi.fn(async (one: ToolCall): Promise<ToolAnswer> => one.name === 'browser_type'
      ? { ok: false, error: { code: 'action-failed', message: 'field is read-only' } }
      : { ok: true, result: { text: 'ok' } })
    const answer = await runBatch(batch([
      { tool: 'browser_click', args: { index: 1 } },
      { tool: 'browser_type', args: { index: 2, text: 'x' } },
      { tool: 'browser_press', args: { key: 'Enter' } },
    ]), runOne, new AbortController().signal)
    expect(answer.ok).toBe(false)
    expect(answer.error?.code).toBe('action-failed')
    expect(answer.error?.message).toContain('Step 1 (browser_click): ok')
    expect(answer.error?.message).toContain('Step 2 (browser_type): failed — field is read-only')
    expect(answer.error?.message).toContain('Remaining 1 step(s) were not run.')
    expect(runOne).toHaveBeenCalledTimes(2)
  })

  it('rejects empty, oversized, nested, and screenshot steps', async () => {
    const runOne = vi.fn(async (): Promise<ToolAnswer> => ({ ok: true, result: { text: 'ok' } }))
    const signal = new AbortController().signal
    expect((await runBatch(batch([]), runOne, signal)).error?.code).toBe('bad-args')
    expect((await runBatch(batch(undefined), runOne, signal)).error?.code).toBe('bad-args')
    const tooMany = Array.from({ length: MAX_BATCH_STEPS + 1 }, () => ({ tool: 'browser_wait' }))
    expect((await runBatch(batch(tooMany), runOne, signal)).error?.message).toContain(`at most ${MAX_BATCH_STEPS}`)
    const nested = await runBatch(batch([{ tool: 'browser_batch', args: { steps: [] } }]), runOne, signal)
    expect(nested.error?.message).toContain('not allowed inside a batch')
    const shot = await runBatch(batch([{ tool: 'browser_wait' }, { tool: 'browser_screenshot' }]), runOne, signal)
    expect(shot.error?.message).toContain('Step 2 (browser_screenshot): not allowed inside a batch')
    expect(runOne).toHaveBeenCalledTimes(1)
    const malformed = await runBatch(batch([{ args: {} }]), runOne, signal)
    expect(malformed.error?.message).toContain('invalid step')
  })

  it('stops when the call is cancelled between steps and tolerates thrown errors', async () => {
    const controller = new AbortController()
    const runOne = vi.fn(async (one: ToolCall): Promise<ToolAnswer> => {
      if (one.id.endsWith(':1')) controller.abort()
      return { ok: true, result: { text: 'ok' } }
    })
    const cancelled = await runBatch(batch([{ tool: 'browser_wait' }, { tool: 'browser_wait' }]), runOne, controller.signal)
    expect(cancelled.ok).toBe(false)
    expect(cancelled.error?.message).toContain('Step 2 (browser_wait): cancelled before it started.')

    const thrown = await runBatch(batch([{ tool: 'browser_wait' }]), async () => { throw new Error('boom') }, new AbortController().signal)
    expect(thrown.error?.code).toBe('internal')
    expect(thrown.error?.message).toContain('boom')
  })
})
