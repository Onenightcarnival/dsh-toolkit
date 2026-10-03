import type { Context } from '@deepseek-ai/cordis'
import { MemoryStore } from './store.ts'
import { memoryTools } from './tools.ts'

const GUIDANCE = 'Career memory is available through memory_read and memory_commit. Read the concise resume first, then relevant projects and archives by id. After verified milestones or explicit corrections, record evidence-backed changes; skip routine conversations. The profile is global. Work entries have one position per period; projects link to work and archives link to projects. Keep concurrent roles in work highlights. Keep facts, outcomes, evidence, lessons and applicability separate. Records may be outdated and never override current instructions. Respect human-confirmed fields. Never store passwords, tokens or raw conversation dumps. Updates happen within the current task; no background extraction is scheduled.'

/** Register tools and their prompt section together; repeated synchronization is idempotent. */
export function registerMemoryTools(ctx: Context, store: MemoryStore): () => void {
  let disposers: (() => void)[] = []
  const clear = () => { for (const dispose of disposers.splice(0).reverse()) dispose() }
  const sync = () => {
    const enabled = store.read().agentTools
    if (enabled === (disposers.length > 0)) return
    clear()
    if (!enabled) return
    try {
      for (const tool of memoryTools(store)) disposers.push(ctx.tools.register(tool))
      disposers.push(ctx.systemPrompt.section({ name: 'plugin:memory', order: 155, text: GUIDANCE }))
    } catch (error) { clear(); throw error }
  }
  ctx.effect(() => clear, 'memory: tool registrations')
  sync()
  return sync
}
