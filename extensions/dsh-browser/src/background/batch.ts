/**
 * `browser_batch`: several tool steps in one round trip.
 *
 * @module
 */

import type { ToolAnswer, ToolCall } from './tools.ts'

export const MAX_BATCH_STEPS = 25
const BATCH_TOOLS_DISALLOWED = new Set(['browser_batch', 'browser_screenshot'])

/**
 * Run several tool steps in one round trip. Each step goes through exactly
 * the dispatch (and approval) path it would take on its own; the batch stops
 * at the first failure and reports every step's outcome so the model knows
 * how far it got. Screenshots are excluded (their image result cannot be
 * merged into text); take one after the batch instead.
 */
export async function runBatch(
  call: ToolCall,
  runOne: (one: ToolCall) => Promise<ToolAnswer>,
  signal: AbortSignal,
): Promise<ToolAnswer> {
  const steps = Array.isArray(call.args.steps) ? call.args.steps : undefined
  if (steps === undefined || steps.length === 0) {
    return { ok: false, error: { code: 'bad-args', message: 'steps must be a non-empty array of { tool, args }.' } }
  }
  if (steps.length > MAX_BATCH_STEPS) {
    return { ok: false, error: { code: 'bad-args', message: `A batch may contain at most ${MAX_BATCH_STEPS} steps.` } }
  }
  const lines: string[] = []
  for (const [position, step] of steps.entries()) {
    const label = `Step ${position + 1}`
    if (typeof step !== 'object' || step === null || typeof (step as { tool?: unknown }).tool !== 'string') {
      lines.push(`${label}: invalid step; each step needs a tool name.`)
      return { ok: false, error: { code: 'bad-args', message: lines.join('\n') } }
    }
    const { tool, args } = step as { tool: string; args?: unknown }
    if (BATCH_TOOLS_DISALLOWED.has(tool)) {
      lines.push(`${label} (${tool}): not allowed inside a batch.`)
      return { ok: false, error: { code: 'bad-args', message: lines.join('\n') } }
    }
    if (signal.aborted) {
      lines.push(`${label} (${tool}): cancelled before it started.`)
      return { ok: false, error: { code: 'action-failed', message: lines.join('\n') } }
    }
    const sub: ToolCall = {
      ...call,
      id: `${call.id}:${position + 1}`,
      name: tool,
      args: typeof args === 'object' && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : {},
    }
    let answer: ToolAnswer
    try {
      answer = await runOne(sub)
    } catch (error: unknown) {
      answer = { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } }
    }
    if (answer.ok) {
      const text = typeof answer.result === 'object' && answer.result !== null && typeof (answer.result as { text?: unknown }).text === 'string'
        ? (answer.result as { text: string }).text
        : JSON.stringify(answer.result)
      lines.push(`${label} (${tool}): ok\n${text}`)
      continue
    }
    lines.push(`${label} (${tool}): failed — ${answer.error?.message ?? 'unknown error'}`)
    if (position + 1 < steps.length) lines.push(`Remaining ${steps.length - position - 1} step(s) were not run.`)
    return { ok: false, error: { code: answer.error?.code ?? 'action-failed', message: lines.join('\n\n') } }
  }
  return { ok: true, result: { text: `Batch of ${steps.length} step(s) completed.\n\n${lines.join('\n\n')}` } }
}
