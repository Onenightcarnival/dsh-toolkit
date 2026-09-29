/**
 * Registry of built-in plugin settings. Each option maps one form field onto
 * the profile patch row of a composition entry: a `config` key, or the row's
 * `disabled` field (`kind: 'enable'`, value true = entry enabled). The routes,
 * validation and patch edits read this registry; labels live in the client
 * dictionaries under `setting.<key>` and `group.<entryId>`.
 */

import type { SettingType, SettingValue } from './protocol.ts'

export interface SettingOption {
  key: string
  entryId: string
  /** `config` key on the entry; absent for `kind: 'enable'`. */
  configKey?: string
  kind?: 'enable'
  type: SettingType
  /** Upstream default of the web profile. */
  def: SettingValue
}

/** Display order of groups; options keep registry order inside a group. */
export const SETTING_GROUPS = ['goal', 'compaction-basic'] as const

export const SETTINGS: readonly SettingOption[] = [
  { key: 'goalMaxRounds', entryId: 'goal', configKey: 'defaultMaxGoalRounds', type: 'posInt', def: 256 },
  { key: 'compactionEnabled', entryId: 'compaction-basic', kind: 'enable', type: 'bool', def: false },
  { key: 'compactionThreshold', entryId: 'compaction-basic', configKey: 'thresholdRatio', type: 'ratio', def: 0.8 },
]

export type SettingValues = Record<string, SettingValue | null>

/** Whether `value` satisfies the option's type. */
export function settingValueValid(option: SettingOption, value: unknown): value is SettingValue {
  switch (option.type) {
    case 'posInt': return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    case 'ratio': return typeof value === 'number' && value > 0 && value < 1
    case 'bool': return typeof value === 'boolean'
  }
}

/**
 * Validate a submitted value map against the registry.
 * @returns the offending option key with a reason, or undefined when valid.
 */
export function invalidSetting(values: unknown): { key: string; reason: 'unknown' | 'type' } | undefined {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) return { key: '', reason: 'type' }
  const known = new Map(SETTINGS.map(option => [option.key, option]))
  for (const [key, value] of Object.entries(values)) {
    const option = known.get(key)
    if (option === undefined) return { key, reason: 'unknown' }
    if (value === null) continue
    if (!settingValueValid(option, value)) return { key, reason: 'type' }
  }
  return undefined
}
