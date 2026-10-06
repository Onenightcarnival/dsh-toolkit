/** Two-level career records; field order is also the extraction contract. */
export const FIELDS = {
  profile: ['name', 'position', 'specialties', 'abilities'],
  work: ['organization', 'startDate', 'endDate', 'jobTitle', 'highlights'],
  project: ['title', 'startDate', 'endDate', 'role', 'highlights', 'workId'],
  episode: ['title', 'date', 'parentId', 'context', 'actions', 'result', 'evidence', 'lesson', 'limits'],
} as const
export type Kind = keyof typeof FIELDS
/** What each record kind stands for in an agent's career; shared by tool schemas and prompt guidance. */
export const KIND_GUIDE: Record<Kind, string> = {
  profile: 'The single global profile: who this agent is and what it can do.',
  work: 'One position: one role under one job description for one organization or principal over a continuous period. A new role or a new principal is a new work entry.',
  project: 'One deliverable or body of work carried out within a position. An independent project has no work.',
  episode: 'One concrete experience within a project: what happened, what was observed and what it teaches, backed by evidence.',
}
/** protected is retained only for legacy storage compatibility and grants no field-level restriction. */
export interface Entry { id: string; kind: Kind; fields: Record<string, string>; protected: string[]; createdAt?: string; legacyPeriod?: string }
export interface Snapshot { entries: Entry[] }
/** Revision metadata; the entries of a revision are read separately. */
export interface Revision { revision: number; time: string; actor: 'human' | 'agent'; source: string; summary: string }
export interface State extends Snapshot { schemaVersion: 4; revision: number; history: Revision[]; agentTools: boolean }
/** Entries of one revision and of the revision before it; the first revision compares against the empty resume. */
export interface Diff { revision: number; before: Snapshot; after: Snapshot }
export interface Change { id: string; kind: Kind; fields?: Record<string, string>; remove?: boolean }
export interface Commit { baseRevision: number; summary: string; source?: string; changes?: Change[]; restore?: number; imported?: Snapshot & { schemaVersion?: number } }
export const API = '/api/dsh-memory'
export const emptySnapshot = (): Snapshot => ({ entries: [{ id: 'profile', kind: 'profile', fields: {}, protected: [] }] })

export const DATE_FIELDS = ['startDate', 'endDate', 'date'] as const
export const validDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '0001-01-01' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
export const experienceDate = (entry: Entry): string => entry.kind === 'episode' ? entry.fields.date || '' : entry.fields.startDate || (entry.fields.endDate === 'present' ? '' : entry.fields.endDate) || ''

/** Experience dates determine order; undated entries follow dated entries and ties retain insertion order. */
export function sortEntries(entries: Entry[], order: 'newest' | 'oldest' = 'newest'): Entry[] {
  return [...entries].sort((a, b) => {
    const av = experienceDate(a), bv = experienceDate(b)
    if (!av) return bv ? 1 : 0
    if (!bv) return -1
    return (order === 'newest' ? -1 : 1) * av.localeCompare(bv)
  })
}
