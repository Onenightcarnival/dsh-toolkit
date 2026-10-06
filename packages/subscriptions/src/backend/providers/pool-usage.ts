/**
 * Quota tracking for pool members using normalized ProviderUsage snapshots.
 * The quota_aware strategy ranks members by remaining quota / timeUntilReset.
 */

import { isMissingOrInvalidCredential, OAuthEndpointError } from './common.js'
import type { ProviderUsage, UsageWindow } from './common.js'
import type { ProviderId } from '../auth/store.js'
import type { ConcretePoolMember } from './pool-family.js'

/** A member is taken out of rotation once any window crosses this fill level. */
export const QUOTA_FULL_PERCENT = 95
/** How long a usage snapshot is trusted before a background refresh. */
export const USAGE_TTL_MS = 5 * 60_000

/** Assumed window length when the provider discloses no `resetsAt`. */
const FALLBACK_HORIZON_MS: Record<UsageWindow['kind'], number> = {
  session: 5 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
  other: 30 * 24 * 60 * 60_000,
}

/** The scheduling view of one member's quota. */
export interface MemberQuota {
  /** False when a window is effectively full or the login is gone. */
  available: boolean
  /** Required burn rate (fraction of window per ms); 0 when unknown. */
  urgency: number
  /** Epoch ms of the snapshot this was computed from; 0 when none. */
  fetchedAt: number
}

/** A successful snapshot, cached until `ttlMs` (or the entry's own `cooldownMs`) elapses. */
interface SnapshotEntry {
  snapshot: ProviderUsage
  error?: undefined
  at: number
  cooldownMs?: undefined
}

/**
 * Cached fetch failure with a retry cooldown.
 * lastSnapshot retains the latest successful fetch for display; routing uses
 * the failure state until the cooldown expires and a new fetch succeeds.
 */
interface FailureEntry {
  snapshot?: undefined
  error: unknown
  at: number
  /** Overrides `ttlMs` — the endpoint's own `retry-after` when it sent one. */
  cooldownMs: number
  /** The last successful snapshot before this failure, when one exists. */
  lastSnapshot?: ProviderUsage
}

type CacheEntry = SnapshotEntry | FailureEntry

/**
 * Per-ACCOUNT usage snapshots with in-flight dedupe and
 * stale-while-revalidate refresh. Unavailable usage scores zero urgency, behind measured members. Fetchers are resolved
 * lazily per (provider, account) so accounts added after startup join
 * tracking on their first score.
 */
export class PoolUsageTracker {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<ProviderUsage>>()

  constructor(
    private readonly fetcherFor: (provider: ProviderId, account: string) => (() => Promise<ProviderUsage>) | undefined,
    private readonly ttlMs = USAGE_TTL_MS,
  ) {}

  /**
   * Quota availability and urgency for one account. Cold caches await a fetch;
   * stale successful entries return immediately and refresh in the background.
   * Failures within their cooldown return degraded quota without a network call.
   * Routing does not use lastSnapshot.
   */
  async quotaFor(member: ConcretePoolMember): Promise<MemberQuota> {
    const key = `${member.provider}/${member.account}`
    const fetcher = this.fetcherFor(member.provider, member.account)
    if (fetcher === undefined) return { available: true, urgency: 0, fetchedAt: 0 }
    const entry = this.entries.get(key)
    if (entry !== undefined) {
      const fresh = Date.now() - entry.at < (entry.cooldownMs ?? this.ttlMs)
      if (entry.snapshot !== undefined) {
        if (!fresh) void this.refresh(key, fetcher).catch(() => undefined)
        return this.score(member, entry)
      }
      if (fresh) return degradedQuota(entry.error)
      // The cooldown expired: fall through to a fresh, blocking attempt.
    }
    try {
      const snapshot = await this.refresh(key, fetcher)
      return this.score(member, { snapshot, at: Date.now() })
    } catch (error: unknown) {
      return degradedQuota(error)
    }
  }

  /**
   * Usage snapshot for display, sharing the quotaFor cache.
   * A failed fetch returns the last successful snapshot when available, otherwise
   * throws the stored error. force bypasses a successful snapshot TTL; active
   * failure cooldowns still apply.
   */
  async snapshotFor(provider: ProviderId, account: string, force = false): Promise<ProviderUsage> {
    const fetcher = this.fetcherFor(provider, account)
    if (fetcher === undefined) return { supported: false }
    const key = `${provider}/${account}`
    const entry = this.entries.get(key)
    if (entry !== undefined && Date.now() - entry.at < (entry.cooldownMs ?? this.ttlMs)) {
      if (entry.snapshot !== undefined) {
        if (!force) return entry.snapshot
      } else if (entry.lastSnapshot !== undefined) {
        // Display retains the last successful snapshot during the cooldown.
        return entry.lastSnapshot
      } else {
        throw entry.error
      }
    }
    try {
      return await this.refresh(key, fetcher)
    } catch (error: unknown) {
      // A failed refresh preserves the last successful display snapshot.
      const failed = this.entries.get(key)
      if (failed?.snapshot === undefined && failed?.lastSnapshot !== undefined) return failed.lastSnapshot
      throw error
    }
  }

  /** Drop cached snapshots: one account, or a whole provider when `account` is omitted. */
  invalidate(provider: ProviderId, account?: string): void {
    if (account !== undefined) {
      this.entries.delete(`${provider}/${account}`)
      return
    }
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${provider}/`)) this.entries.delete(key)
    }
  }

  /**
   * Run or join the in-flight usage fetch for an account and cache its outcome.
   * Missing or invalid credentials bypass the failure cache and are checked on
   * the next call.
   */
  private refresh(key: string, fetcher: () => Promise<ProviderUsage>): Promise<ProviderUsage> {
    let pending = this.inflight.get(key)
    if (pending === undefined) {
      // The last successful snapshot, including one carried by a previous
      // failure entry, survives a failed refresh.
      const prior = this.entries.get(key)
      const lastSnapshot = prior?.snapshot ?? prior?.lastSnapshot
      pending = fetcher().then(
        (snapshot) => {
          this.entries.set(key, { snapshot, at: Date.now() })
          return snapshot
        },
        (error: unknown) => {
          if (!isMissingOrInvalidCredential(error)) {
            this.entries.set(key, {
              error,
              at: Date.now(),
              cooldownMs: cooldownFor(error, this.ttlMs),
              ...lastSnapshot === undefined ? {} : { lastSnapshot },
            })
          }
          throw error
        },
      ).finally(() => {
        this.inflight.delete(key)
      })
      this.inflight.set(key, pending)
    }
    return pending
  }

  /** Score one member against a snapshot's windows. */
  private score(member: ConcretePoolMember, entry: SnapshotEntry): MemberQuota {
    const windows = (entry.snapshot.windows ?? []).filter(window => windowApplies(window, member.model))
    let available = true
    let urgency = 0
    for (const window of windows) {
      if (window.usedPercent >= QUOTA_FULL_PERCENT) available = false
      urgency = Math.max(urgency, windowUrgency(window))
    }
    return { available, urgency, fetchedAt: entry.at }
  }
}

/** The routing view of a fetch failure. Logged out: unavailable. Any other failure: available with zero urgency. */
function degradedQuota(error: unknown): MemberQuota {
  return isMissingOrInvalidCredential(error)
    ? { available: false, urgency: 0, fetchedAt: 0 }
    : { available: true, urgency: 0, fetchedAt: 0 }
}

/** How long to hold a failure in the negative cache: the endpoint's own `retry-after`, or the default TTL. */
function cooldownFor(error: unknown, defaultTtlMs: number): number {
  return error instanceof OAuthEndpointError && error.retryAfterMs !== undefined ? error.retryAfterMs : defaultTtlMs
}

/**
 * Whether a window constrains this model: unscoped windows always do; a
 * model-scoped window applies when its scope
 * names the model family.
 */
function windowApplies(window: UsageWindow, model: string): boolean {
  if (window.scope === undefined) return true
  return model.toLowerCase().includes(window.scope.toLowerCase())
}

/** The required burn rate of one window (fraction per ms). */
function windowUrgency(window: UsageWindow, now = Date.now()): number {
  const remaining = Math.max(0, 1 - window.usedPercent / 100)
  const horizon = window.resetsAt !== undefined
    ? Math.max(window.resetsAt - now, 1)
    : FALLBACK_HORIZON_MS[window.kind]
  return remaining / horizon
}
