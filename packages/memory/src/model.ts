/** Two-level career records; field order is also the extraction contract. */
export const FIELDS = {
  profile: ['name', 'position', 'specialties', 'abilities'],
  work: ['organization', 'period', 'jobTitle', 'highlights'],
  project: ['title', 'period', 'role', 'objective', 'contribution', 'outcome', 'workId'],
  episode: ['title', 'parentId', 'context', 'actions', 'result', 'evidence', 'lesson', 'limits'],
} as const
export type Kind = keyof typeof FIELDS
export interface Entry { id: string; kind: Kind; fields: Record<string, string>; protected: string[]; createdAt?: string }
export interface Snapshot { entries: Entry[] }
export interface Revision { revision: number; time: string; actor: 'human' | 'agent'; source: string; summary: string; snapshot: Snapshot }
export interface State extends Snapshot { schemaVersion: 3; revision: number; history: Revision[]; agentTools: boolean }
export interface Change { id: string; kind: Kind; fields?: Record<string, string>; remove?: boolean; unprotect?: string[] }
export interface Commit { baseRevision: number; summary: string; source?: string; changes?: Change[]; restore?: number; imported?: Snapshot & { schemaVersion?: number } }
export const API = '/api/dsh-memory'
export const emptySnapshot = (): Snapshot => ({ entries: [{ id: 'profile', kind: 'profile', fields: {}, protected: [] }] })

/** Unknown creation times follow dated entries; equal times retain insertion order. */
export function sortEntries(entries: Entry[], order: 'newest' | 'oldest' = 'newest'): Entry[] {
  return [...entries].sort((a, b) => {
    if (!a.createdAt) return b.createdAt ? 1 : 0
    if (!b.createdAt) return -1
    return (order === 'newest' ? -1 : 1) * a.createdAt.localeCompare(b.createdAt)
  })
}
