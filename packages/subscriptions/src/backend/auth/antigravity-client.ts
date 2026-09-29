import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET } from '@cortexkit/antigravity-auth-core'

export interface AntigravityOAuthConfig { clientId: string; clientSecret?: string }
const clientPath = (): string => dshHomePath('plugins', 'subscriptions', 'antigravity-oauth-client.json')
function pair(clientId: unknown, clientSecret: unknown): AntigravityOAuthConfig | undefined {
  if (typeof clientId !== 'string' || !clientId.trim()) {
    if (typeof clientSecret === 'string' && clientSecret.trim()) throw new Error('Antigravity OAuth clientSecret requires clientId')
    return undefined
  }
  return { clientId: clientId.trim(), ...(typeof clientSecret === 'string' && clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) }
}

export function resolveAntigravityOAuthConfig(config?: Partial<AntigravityOAuthConfig>): AntigravityOAuthConfig {
  const configured = pair(config?.clientId, config?.clientSecret)
  if (configured) return configured
  const environment = pair(process.env.ANTIGRAVITY_CLIENT_ID ?? process.env.NOAGY_CLIENT_ID, process.env.ANTIGRAVITY_CLIENT_SECRET ?? process.env.NOAGY_CLIENT_SECRET)
  if (environment) return environment
  try {
    const stored = JSON.parse(readFileSync(clientPath(), 'utf8')) as AntigravityOAuthConfig
    const result = pair(stored.clientId, stored.clientSecret)
    if (result) return result
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid local Antigravity OAuth client configuration') }
  return { clientId: ANTIGRAVITY_CLIENT_ID, clientSecret: ANTIGRAVITY_CLIENT_SECRET }
}

export async function preserveAntigravityClient(config: AntigravityOAuthConfig): Promise<void> {
  const path = clientPath()
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(config), { mode: 0o600 })
  await rename(temporary, path)
}
