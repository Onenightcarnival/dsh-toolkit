/**
 * Antigravity client signature: the Cloud Code backend accepts content
 * requests only from the Antigravity CLI (`agy`) User-Agent family. The CLI
 * version is read once from the CLI auto-updater and falls back to a pinned
 * value; a configured `antigravity.userAgent` replaces the whole header.
 */
import type { FetchFn } from './common.js'
import { proxiedFetch } from '../http.js'

/** CLI version used until the auto-updater answers. */
export const ANTIGRAVITY_CLI_VERSION_FALLBACK = '1.5.3'
/** Changelist carried by the CLI signature; the backend accepts this value. */
export const ANTIGRAVITY_CLI_CHANGE_LIST = '962369648'
/** Plain-text endpoint announcing the current stable CLI version. */
export const ANTIGRAVITY_CLI_VERSION_URL = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app'
const VERSION_FETCH_TIMEOUT_MS = 5000
const SEMVER = /\d+\.\d+\.\d+/

let cliVersion = ANTIGRAVITY_CLI_VERSION_FALLBACK
let primed: Promise<string> | undefined

function osType(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'windows' : platform
}

function archName(arch: NodeJS.Architecture = process.arch): string {
  return arch === 'x64' ? 'amd64' : arch === 'ia32' ? '386' : arch
}

/** The CLI version currently in use. */
export function antigravityCliVersion(): string {
  return cliVersion
}

/** First semver in the auto-updater text, or null. */
export function parseAntigravityCliVersion(text: string): string | null {
  return SEMVER.exec(text)?.[0] ?? null
}

/** CLI signature User-Agent for content and metadata requests. */
export function buildAntigravityUserAgent(version = cliVersion, platform: NodeJS.Platform = process.platform, arch: NodeJS.Architecture = process.arch): string {
  return `antigravity/cli/${version} (aidev_client; os_type=${osType(platform)}; arch=${archName(arch)}; cl=${ANTIGRAVITY_CLI_CHANGE_LIST}; auth_method=consumer)`
}

/**
 * Read the stable CLI version once per process. A failed or malformed answer
 * keeps the current value; concurrent callers share one request.
 */
export function primeAntigravityCliVersion(fetchFn: FetchFn = proxiedFetch, url = ANTIGRAVITY_CLI_VERSION_URL): Promise<string> {
  primed ??= (async () => {
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS) })
      if (response.ok) {
        const version = parseAntigravityCliVersion((await response.text()).slice(0, 4096))
        if (version !== null) cliVersion = version
      } else {
        await response.body?.cancel()
      }
    } catch {
      // The pinned fallback stays in use.
    }
    return cliVersion
  })()
  return primed
}

/** Test seam: forget the primed version. */
export function resetAntigravityCliVersion(): void {
  cliVersion = ANTIGRAVITY_CLI_VERSION_FALLBACK
  primed = undefined
}
