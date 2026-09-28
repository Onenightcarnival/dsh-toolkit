import type { Context } from '@deepseek-ai/cordis'
import * as backend from './backend/index.js'

export const name = 'subscriptions'
export const inject = ['llm']

// Pass the normalized internal config directly. The backend's user-facing schema
// defaults optional arrays to [], which would invalidate models without an
// explicit inputModalities field. Its apply function validates transport values.
const transport = { name: 'subscriptions-chatgpt-transport', inject: backend.inject, apply: backend.apply }

/** Only ChatGPT is exposed. The transport is maintained in src/backend. */
export interface Config {
  enabled?: boolean
  codexClientVersion?: string
  streamIdleTimeoutMs?: number
  rateLimit?: backend.Config['rateLimit']
  models?: backend.ModelEntry[]
}

export function backendConfig(config: Config = {}): backend.Config {
  return {
    providers: ['codex'],
    codexClientVersion: config.codexClientVersion,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    rateLimit: config.rateLimit,
    models: config.models ? { codex: config.models } : undefined,
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return
  ctx.plugin(transport, backendConfig(config))
}
