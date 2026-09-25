// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  effectiveSelection,
  findCatalogModel,
  parseModelCatalog,
  parseModelSelection,
  parseModelSelectionProjection,
  providerRoutable,
  sameSelection,
  selectionForModel,
  selectionLabel,
  type ModelCatalog,
} from '../src/panel/models.ts'

const wireCatalog = {
  default: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  routableProviders: ['deepseek'],
  groups: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        {
          id: 'deepseek-v4',
          name: 'DeepSeek V4',
          description: 'Flagship',
          reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
        },
      ],
    },
    { id: 'relay', name: 'My relay', models: [{ id: 'gpt-x' }] },
    { id: 'broken', models: 'not-a-list' },
  ],
  failures: [{ id: 'anthropic', name: 'Anthropic', message: 'no key' }, { bogus: true }],
}

describe('parseModelCatalog', () => {
  it('normalizes names, efforts and failures, and drops malformed groups', () => {
    const catalog = parseModelCatalog(wireCatalog)
    expect(catalog).not.toBeNull()
    expect(catalog?.groups.map((group) => group.id)).toEqual(['deepseek', 'relay'])
    expect(catalog?.groups[1]?.models[0]).toEqual({ id: 'gpt-x', name: 'gpt-x' })
    expect(catalog?.groups[0]?.models[1]?.reasoning).toEqual({
      efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
      defaultEffort: 'high',
    })
    expect(catalog?.failures).toEqual([{ id: 'anthropic', name: 'Anthropic', message: 'no key' }])
    expect(providerRoutable(catalog as ModelCatalog, 'deepseek')).toBe(true)
    expect(providerRoutable(catalog as ModelCatalog, 'relay')).toBe(false)
  })

  it('rejects a catalog without a usable default', () => {
    expect(parseModelCatalog({ groups: [] })).toBeNull()
    expect(parseModelCatalog({ default: { provider: '', model: 'x' }, groups: [] })).toBeNull()
    expect(parseModelCatalog('nope')).toBeNull()
  })

  it('treats every group as routable when the host omits routableProviders', () => {
    const catalog = parseModelCatalog({ default: wireCatalog.default, groups: wireCatalog.groups })
    expect(catalog?.routableProviders).toEqual(['deepseek', 'relay'])
  })
})

describe('selection helpers', () => {
  const catalog = parseModelCatalog(wireCatalog) as ModelCatalog

  it('parses selections and projections defensively', () => {
    expect(parseModelSelection({ provider: 'a', model: 'b', reasoningEffort: '' })).toEqual({ provider: 'a', model: 'b' })
    expect(parseModelSelection({ provider: 'a' })).toBeNull()
    expect(parseModelSelectionProjection({ lastUsed: { provider: 'a', model: 'b' }, next: null }))
      .toEqual({ lastUsed: { provider: 'a', model: 'b' }, next: null })
    expect(parseModelSelectionProjection({})).toBeNull()
    expect(parseModelSelectionProjection(undefined)).toBeNull()
  })

  it('prefers the pending selection, then the last used one, then the default', () => {
    const fallback = catalog.default
    expect(effectiveSelection(null, fallback)).toEqual(fallback)
    expect(effectiveSelection({ lastUsed: { provider: 'deepseek', model: 'deepseek-v4' }, next: null }, fallback))
      .toEqual({ provider: 'deepseek', model: 'deepseek-v4' })
    expect(effectiveSelection({
      lastUsed: { provider: 'deepseek', model: 'deepseek-v4' },
      next: { provider: 'relay', model: 'gpt-x' },
    }, fallback)).toEqual({ provider: 'relay', model: 'gpt-x' })
  })

  it('labels selections with catalog names and effort names, falling back to raw ids', () => {
    expect(selectionLabel(catalog, { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' })).toBe('DeepSeek V4 · High')
    expect(selectionLabel(catalog, { provider: 'deepseek', model: 'deepseek-v4-flash' })).toBe('DeepSeek V4 Flash')
    expect(selectionLabel(catalog, { provider: 'other', model: 'mystery', reasoningEffort: 'max' })).toBe('mystery · max')
    expect(selectionLabel(null, { provider: 'other', model: 'mystery' })).toBe('mystery')
    expect(selectionLabel(catalog, null)).toBe('')
  })

  it('picks the default effort for a new model and keeps the effort when re-picking the same one', () => {
    const group = catalog.groups[0]!
    const v4 = group.models[1]!
    const flash = group.models[0]!
    expect(selectionForModel(group, v4, null)).toEqual({ provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' })
    expect(selectionForModel(group, v4, { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'low' }))
      .toEqual({ provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'low' })
    expect(selectionForModel(group, flash, { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'low' }))
      .toEqual({ provider: 'deepseek', model: 'deepseek-v4-flash' })
    expect(findCatalogModel(catalog, { provider: 'relay', model: 'gpt-x' })?.group.name).toBe('My relay')
    expect(sameSelection({ provider: 'a', model: 'b' }, { provider: 'a', model: 'b', reasoningEffort: 'x' })).toBe(false)
    expect(sameSelection(null, null)).toBe(true)
  })
})
