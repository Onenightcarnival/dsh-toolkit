/** Cloud Code Assist thinking budgets, matched to the runtime model family. */
import { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'

const configurableImageThinking = (model: string): boolean => /^gemini-3\.1-flash(?:-lite)?-image(?:-|$)/.test(model)

/** Major version of a Gemini model id (`gemini-4-…` → 4); 0 for any other model. */
export function geminiMajor(model: string): number {
  const major = /^gemini-(\d+)/i.exec(model)?.[1]
  return major === undefined ? 0 : Number(major)
}

/** Efforts supported by the known Antigravity runtime families. Unknown models keep upstream defaults. */
export function antigravityReasoning(model: string): LlmResolvedModelInfo['reasoning'] {
  if (/-image(?:-|$)/.test(model) && !configurableImageThinking(model)) return undefined
  const ids = configurableImageThinking(model) ? ['minimal', 'high']
    : model.startsWith('claude-') ? ['high']
      : model.startsWith('gpt-oss-') ? ['medium']
        : model.startsWith('gemini-3.1-pro') || model === 'gemini-pro-agent' ? ['low', 'high']
          : model.startsWith('gemini-2.5') || geminiMajor(model) >= 3 ? ['low', 'medium', 'high'] : []
  const fixedEffort = /^gemini-.*-(low|medium|high)$/.exec(model)?.[1]
  const efforts = fixedEffort !== undefined && ids.includes(fixedEffort) ? [fixedEffort] : ids
  return efforts.length === 0 ? undefined : {
    efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: id.charAt(0).toUpperCase() + id.slice(1) })),
  }
}

/** Build the v1internal thinking config; do not forward arbitrary DSH effort strings. */
export function antigravityThinking(model: string, effort: string | undefined, maxTokens?: number): Record<string, unknown> | undefined {
  if (effort === undefined) return undefined
  const supported = antigravityReasoning(model)
  if (supported === undefined || (effort !== 'off' || configurableImageThinking(model)) && !supported.efforts.some(entry => entry.id === effort)) {
    throw new LlmError(`Antigravity model ${model} does not support reasoning effort ${effort}`, 'UNSUPPORTED_REASONING_EFFORT')
  }
  if (configurableImageThinking(model)) return { thinkingLevel: effort.toUpperCase(), includeThoughts: true }
  if (effort === 'off') return { includeThoughts: false, thinkingBudget: 0 }
  if (model === 'gemini-3.7-flash-tiered') return { thinkingLevel: effort.toUpperCase() }
  let budget: number
  if (model.startsWith('claude-')) budget = 1024
  else if (model.startsWith('gpt-oss-')) budget = 8192
  else if (model.startsWith('gemini-3.1-pro') || model === 'gemini-pro-agent') {
    budget = effort === 'high' ? 10001 : 1001
  } else if (model.startsWith('gemini-3.5-flash') || model === 'gemini-3-flash-agent') {
    budget = effort === 'high' ? 10000 : effort === 'medium' ? 4000 : 1000
  } else {
    budget = effort === 'high' ? -1 : effort === 'medium' ? 4000 : 1000
  }
  if (maxTokens !== undefined && budget > 0 && maxTokens <= budget) {
    throw new LlmError(`Antigravity maxTokens must exceed the thinking budget (${budget}) for ${model}/${effort}`, 'INVALID_REQUEST')
  }
  return { includeThoughts: true, thinkingBudget: budget }
}
