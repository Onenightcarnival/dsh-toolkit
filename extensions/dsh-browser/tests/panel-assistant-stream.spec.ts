// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { AssistantStreamView } from '../src/panel/assistant-stream.ts'

const start = { type: 'start', attemptId: 'a', revision: 1, turn: 0, step: 0, startedAfterSeq: 4 }
const delta = (revision: number, index: number, text: string) => ({
  type: 'chunk', attemptId: 'a', revision, index, time: 10,
  chunk: { type: 'text-delta', index: 0, text },
})

describe('dsh 0.1.5 Assistant stream presentation', () => {
  it('renders deltas immediately, replaces them with the durable message, and does not duplicate settlement', () => {
    const view = new AssistantStreamView()
    expect(view.replace({ revision: 0 })).toBe('changed')
    expect(view.accept(start)).toBe('changed')
    expect(view.accept(delta(2, 0, 'Hel'))).toBe('changed')
    expect(view.row()?.text).toBe('Hel')
    view.accept(delta(3, 1, 'lo'))
    expect(view.row()?.text).toBe('Hello')
    expect(view.settle({ type: 'assistant/message', seq: 5, surfaceOp: 'append', data: { turn: 0, step: 0 } })).toBe(true)
    expect(view.row()).toBeNull()
    expect(view.accept({
      type: 'end', attemptId: 'a', revision: 4, index: 2,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 5 },
    })).toBe('changed')
    expect(view.row()).toBeNull()
  })

  it('restores packed reconnect text and counts every reasoning/tool/raw chunk before the next live index', () => {
    const view = new AssistantStreamView()
    expect(view.replace({
      revision: 7,
      activeAttempt: { ...start, nextIndex: 6, stream: [
        { type: 'reasoning-chunks', index: 0, time0: 1, dt: [1], texts: ['private', ' reasoning'] },
        { type: 'text-chunks', index: 1, time0: 3, dt: [1], texts: ['Hello', ' '] },
        { type: 'tool-call-chunks', index: 2, id: 'tool', time0: 5, dt: [], args: ['{}'] },
        { type: 'chunk', time: 6, chunk: { type: 'usage', usage: {} } },
      ] },
    })).toBe('changed')
    expect(view.row()?.text).toBe('Hello ')
    expect(view.accept({ ...delta(8, 6, 'world'), chunk: { type: 'text-delta', index: 1, text: 'world' } })).toBe('changed')
    expect(view.row()?.text).toBe('Hello world')
  })

  it('uses authoritative block-end text and ignores duplicate delta delivery', () => {
    const view = new AssistantStreamView()
    view.accept(start)
    view.accept(delta(2, 0, 'draft'))
    expect(view.accept(delta(2, 0, 'draft'))).toBe('ignored')
    view.accept({ type: 'chunk', attemptId: 'a', revision: 3, index: 1,
      chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'final' } } })
    view.accept(delta(4, 2, 'straggler'))
    expect(view.row()?.text).toBe('final')
  })

  it('requests a new baseline on a missing chunk, malformed prefix, or missing durable settlement', () => {
    const view = new AssistantStreamView()
    view.accept(start)
    expect(view.accept(delta(2, 1, 'lost prefix'))).toBe('rebaseline')
    expect(view.row()).toBeNull()
    expect(view.replace({ revision: 4, activeAttempt: { ...start, nextIndex: 5, stream: [] } })).toBe('rebaseline')
    view.replace({ revision: 0 })
    view.accept(start)
    expect(view.accept({ type: 'end', attemptId: 'a', revision: 2, index: 0,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 5 } })).toBe('rebaseline')
  })

  it('drops abandoned or failed-attempt output and accepts a reactivated Agent revision reset', () => {
    const view = new AssistantStreamView()
    view.accept(start)
    view.accept(delta(2, 0, 'retry text'))
    expect(view.settle({ type: 'assistant/attempt', seq: 6, data: { turn: 0, step: 0 } })).toBe(true)
    expect(view.row()).toBeNull()
    expect(view.accept({ type: 'end', attemptId: 'a', revision: 3, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 6 } })).toBe('changed')
    expect(view.accept(start)).toBe('changed')
    view.accept(delta(2, 0, 'abandoned text'))
    expect(view.accept({ type: 'end', attemptId: 'a', revision: 3, index: 1,
      outcome: { kind: 'abandoned' } })).toBe('changed')
    expect(view.row()).toBeNull()
  })

  it('does not settle another step or a historical surface replacement', () => {
    const view = new AssistantStreamView()
    view.accept(start)
    view.accept(delta(2, 0, 'current'))
    expect(view.settle({ type: 'assistant/message', seq: 6, data: { turn: 0, step: 1 } })).toBe(false)
    expect(view.settle({ type: 'assistant/message', seq: 6,
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, data: { turn: 0, step: 0 } })).toBe(false)
    expect(view.row()?.text).toBe('current')
  })
})
