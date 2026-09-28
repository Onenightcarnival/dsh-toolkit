// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { Row } from '../src/panel/events.ts'

vi.mock('../src/panel/api.ts', () => ({ connectPanel: () => ({}) }))

import { groupToolRows } from '../src/panel/App.tsx'

const row = (seq: number, kind: Row['kind'], status?: Row['status']): Row => ({ seq, kind, text: `${kind} ${seq}`, ...(status === undefined ? {} : { status }) })

describe('transcript tool groups', () => {
  it('folds consecutive tool rows into one group keyed by the first seq', () => {
    const items = groupToolRows([
      row(1, 'user'),
      row(2, 'tool', 'complete'),
      row(3, 'tool', 'complete'),
      row(4, 'assistant'),
      row(5, 'tool', 'running'),
    ])
    expect(items.map((item) => item.type)).toEqual(['row', 'tools', 'row', 'tools'])
    expect(items[1]).toEqual({ type: 'tools', key: 2, rows: [row(2, 'tool', 'complete'), row(3, 'tool', 'complete')] })
    expect(items[3]).toEqual({ type: 'tools', key: 5, rows: [row(5, 'tool', 'running')] })
  })

  it('keeps the group key stable while rows are appended', () => {
    const first = groupToolRows([row(1, 'user'), row(2, 'tool', 'running')])
    const later = groupToolRows([row(1, 'user'), row(2, 'tool', 'complete'), row(3, 'tool', 'running')])
    expect(first[1]).toMatchObject({ key: 2 })
    expect(later[1]).toMatchObject({ key: 2 })
  })
})
