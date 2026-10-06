import type { Context } from '@deepseek-ai/cordis'
import * as backend from './backend/index.js'

export const name = 'subscriptions'
export const inject = ['llm']

/** Backend transport registered without the backend's user-facing schema; `backend.apply` validates the normalized config. */
const transport = { name: 'subscriptions-transport', inject: backend.inject, apply: backend.apply }

export interface Config {
  enabled?: boolean
  codexClientVersion?: string
  streamIdleTimeoutMs?: number
  rateLimit?: backend.Config['rateLimit']
  models?: backend.ModelEntry[]
  chatgpt?: { models?: backend.ModelEntry[] }
  antigravity?: backend.Config['antigravity'] & { models?: backend.ModelEntry[] }
}

export function backendConfig(config: Config = {}): backend.Config {
  return {
    providers: ['codex', 'chatgpt', 'antigravity'],
    antigravity: config.antigravity,
    codexClientVersion: config.codexClientVersion,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    rateLimit: config.rateLimit,
    models: { chatgpt: config.chatgpt?.models, codex: config.models, antigravity: config.antigravity?.models },
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return
  ctx.plugin(transport, backendConfig(config))
}
