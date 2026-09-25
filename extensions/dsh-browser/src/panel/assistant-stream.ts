/** dsh 0.1.5 transient Assistant presentation, kept separate from durable seqs. */

import { imageRefsFromBlocks } from './attachments.ts'
import { textFromBlocks, type Row, type SessionEventView } from './events.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

interface PartialBlock {
  type: string
  text: string
  closed?: Record<string, unknown>
}

interface Attempt {
  id: string
  turn: number
  step: number
  startedAfterSeq: number
  nextIndex: number
  blocks: Map<number, PartialBlock>
  settlement?: { seq: number; type: string }
}

export type StreamUpdate = 'changed' | 'ignored' | 'rebaseline'

/** One Session's live attempt. Dense frame indices detect missing chunks. */
export class AssistantStreamView {
  private revision = 0
  private active: Attempt | undefined

  /** Accept an authoritative follow opening before its live suffix is delivered. */
  replace(value: unknown): StreamUpdate {
    this.active = undefined
    if (!isRecord(value) || !isIndex(value.revision)) return 'rebaseline'
    this.revision = value.revision
    const opening = value.activeAttempt
    if (opening === undefined) return 'changed'
    if (!isRecord(opening) || !validStart(opening) || !isIndex(opening.nextIndex)
      || !Array.isArray(opening.stream)) return 'rebaseline'
    const attempt = newAttempt(opening)
    for (const record of opening.stream) {
      if (!isRecord(record)) return 'rebaseline'
      if (record.type === 'chunk') {
        if (!isRecord(record.chunk)) return 'rebaseline'
        pushChunk(attempt, record.chunk)
        attempt.nextIndex += 1
      } else if (record.type === 'text-chunks' || record.type === 'reasoning-chunks' || record.type === 'tool-call-chunks') {
        const members = record.type === 'tool-call-chunks' ? record.args : record.texts
        if (!isIndex(record.index) || !Array.isArray(members) || members.length === 0
          || members.some(member => typeof member !== 'string') || !Array.isArray(record.dt)
          || record.dt.length !== members.length - 1) return 'rebaseline'
        // Rendering needs one joined delta; the dense index still counts every
        // original member, including reasoning and tool arguments we don't show.
        if (record.type !== 'tool-call-chunks') {
          pushChunk(attempt, {
            type: record.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta',
            index: record.index,
            text: members.join(''),
          })
        }
        attempt.nextIndex += members.length
      } else return 'rebaseline'
    }
    if (attempt.nextIndex !== opening.nextIndex) return 'rebaseline'
    this.active = attempt
    return 'changed'
  }

  accept(value: unknown): StreamUpdate {
    if (!isRecord(value) || !isIndex(value.revision) || typeof value.attemptId !== 'string') return 'rebaseline'
    // A reactivated Agent starts a fresh process-local revision sequence.
    if (value.type === 'start' && value.revision === 1 && this.active === undefined) this.revision = 0
    if (value.revision <= this.revision) return 'ignored'
    if (value.revision !== this.revision + 1) return this.rebaseline()
    this.revision = value.revision
    if (value.type === 'start') {
      if (this.active !== undefined || !validStart(value)) return this.rebaseline()
      this.active = newAttempt(value)
      return 'changed'
    }
    const attempt = this.active
    // A Host controller mounted in the middle of an attempt has no reconstructible
    // prefix. Its eventual durable message is still rendered normally.
    if (attempt === undefined || value.attemptId !== attempt.id) return 'ignored'
    if (!isIndex(value.index) || value.index !== attempt.nextIndex) return this.rebaseline()
    if (value.type === 'chunk') {
      if (!isRecord(value.chunk)) return this.rebaseline()
      pushChunk(attempt, value.chunk)
      attempt.nextIndex += 1
      return 'changed'
    }
    if (value.type !== 'end' || !isRecord(value.outcome)) return this.rebaseline()
    this.active = undefined
    if (value.outcome.kind === 'abandoned') return attempt.settlement === undefined ? 'changed' : 'rebaseline'
    return value.outcome.kind === 'committed'
      && attempt.settlement?.seq === value.outcome.seq
      && attempt.settlement?.type === value.outcome.eventType
      ? 'changed' : 'rebaseline'
  }

  /** Replace the transient row as soon as its authoritative durable event arrives. */
  settle(event: SessionEventView): boolean {
    const attempt = this.active
    if (attempt === undefined || (event.type !== 'assistant/message' && event.type !== 'assistant/attempt')
      || event.data?.turn !== attempt.turn || event.data.step !== attempt.step
      || !isIndex(event.seq) || event.seq <= attempt.startedAfterSeq
      || (event.type === 'assistant/message' && event.surfaceOp !== undefined && event.surfaceOp !== 'append')) return false
    attempt.settlement = { seq: event.seq, type: event.type }
    return true
  }

  row(): Row | null {
    const attempt = this.active
    if (attempt === undefined || attempt.settlement !== undefined) return null
    const blocks = [...attempt.blocks.values()].map(block => block.closed ?? { type: block.type, text: block.text })
    const text = textFromBlocks(blocks)
    const images = imageRefsFromBlocks(blocks)
    return text.trim() === '' && images.length === 0 ? null : {
      seq: -1,
      kind: 'assistant',
      text,
      ...(images.length === 0 ? {} : { images }),
    }
  }

  private rebaseline(): StreamUpdate {
    this.active = undefined
    return 'rebaseline'
  }
}

function validStart(value: Record<string, unknown>): value is Record<string, unknown> & {
  attemptId: string; turn: number; step: number; startedAfterSeq: number
} {
  return typeof value.attemptId === 'string' && value.attemptId !== ''
    && isIndex(value.turn) && isIndex(value.step)
    && typeof value.startedAfterSeq === 'number' && Number.isSafeInteger(value.startedAfterSeq) && value.startedAfterSeq >= -1
}

function newAttempt(value: { attemptId: string; turn: number; step: number; startedAfterSeq: number }): Attempt {
  return { id: value.attemptId, turn: value.turn, step: value.step, startedAfterSeq: value.startedAfterSeq, nextIndex: 0, blocks: new Map() }
}

function pushChunk(attempt: Attempt, chunk: Record<string, unknown>): void {
  if (!isIndex(chunk.index)) return
  let block = attempt.blocks.get(chunk.index)
  if (block?.closed !== undefined) return
  if (chunk.type === 'block-start' && typeof chunk.blockType === 'string') {
    if (block === undefined) attempt.blocks.set(chunk.index, { type: chunk.blockType, text: '' })
  } else if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && typeof chunk.text === 'string') {
    if (block === undefined) {
      block = { type: chunk.type === 'text-delta' ? 'text' : 'reasoning', text: '' }
      attempt.blocks.set(chunk.index, block)
    }
    block.text += chunk.text
  } else if (chunk.type === 'block-end' && isRecord(chunk.block) && typeof chunk.block.type === 'string') {
    attempt.blocks.set(chunk.index, { type: chunk.block.type, text: '', closed: chunk.block })
  }
}
