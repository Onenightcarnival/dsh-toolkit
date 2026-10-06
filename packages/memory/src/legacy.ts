import { readFileSync } from 'node:fs'
import type { Entry, Revision, Snapshot } from './model.ts'
import { fail, migrateSnapshot, plain, validateSnapshot } from './validate.ts'

/** Contents of a version 1–4 `career.json` file after conversion to the current field layout. */
export interface LegacyState { revision: number; agentTools: boolean; entries: Entry[]; history: (Revision & { snapshot: Snapshot })[] }

/** Read a legacy JSON store. Entries without a creation time take the time of the first revision containing them. */
export function readLegacyFile(path: string): LegacyState {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  if (!plain(raw) || ![1, 2, 3, 4].includes(raw.schemaVersion as number) || !Number.isSafeInteger(raw.revision) || !Array.isArray(raw.history)) fail('invalid')
  const agentTools = (raw.schemaVersion as number) >= 3 ? raw.agentTools : raw.agentUpdates
  if (typeof agentTools !== 'boolean') fail('invalid')
  const snapshot = (value: unknown): Snapshot => {
    if (raw.schemaVersion !== 4) return migrateSnapshot(value, raw.schemaVersion as number)
    validateSnapshot(value)
    return { entries: value.entries }
  }
  const history = raw.history.map(h => {
    if (!plain(h) || !Number.isSafeInteger(h.revision) || typeof h.time !== 'string' || !Number.isFinite(Date.parse(h.time))) fail('invalid')
    const text = (value: unknown) => typeof value === 'string' ? value : ''
    return { revision: h.revision as number, time: h.time as string, actor: h.actor === 'agent' ? 'agent' as const : 'human' as const, source: text(h.source), summary: text(h.summary), snapshot: snapshot(h.snapshot) }
  }).sort((a, b) => a.revision - b.revision)
  const current = snapshot(raw)
  const firstSeen = new Map<string, string>()
  for (const h of history) for (const entry of h.snapshot.entries) if (!firstSeen.has(entry.id)) firstSeen.set(entry.id, entry.createdAt ?? new Date(h.time).toISOString())
  for (const entry of [...current.entries, ...history.flatMap(h => h.snapshot.entries)]) entry.createdAt ??= firstSeen.get(entry.id)
  validateSnapshot(current)
  return { revision: raw.revision as number, agentTools, entries: current.entries, history }
}
