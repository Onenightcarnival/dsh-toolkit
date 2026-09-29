import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Tool names owned by this plugin and their collision fallbacks. */
export const TOOL_ALIASES = {
  antigravity_web_search: 'dsh_subscriptions_antigravity_web_search',
  antigravity_image_generate: 'dsh_subscriptions_antigravity_image_generate',
  codex_web_search: 'dsh_subscriptions_codex_web_search',
  codex_image_generate: 'dsh_subscriptions_codex_image_generate',
} as const

export interface ToolRegistry {
  register(definition: ToolDefinition): () => void
}

/** Register a tool under its canonical name, then a plugin-scoped alias. */
export function registerWithAlias(
  registry: ToolRegistry,
  definition: ToolDefinition,
  warn: (message: string) => void = message => console.warn(message),
): { name: string; dispose: () => void } | undefined {
  try {
    return { name: definition.name, dispose: registry.register(definition) }
  } catch (error) {
    const alias = TOOL_ALIASES[definition.name as keyof typeof TOOL_ALIASES]
    if (alias === undefined) throw error
    try {
      return { name: alias, dispose: registry.register({ ...definition, name: alias }) }
    } catch (aliasError) {
      warn(`dsh-plugin-subscriptions: tool ${JSON.stringify(definition.name)} and alias ${JSON.stringify(alias)} are already registered; skipping (${aliasError instanceof Error ? aliasError.message : String(aliasError)})`)
      return undefined
    }
  }
}
