/**
 * Model selection for the side panel: the shapes dsh's `session.modelCatalog`,
 * `session.selectModel` and the `modelSelection` projection use, plus the pure
 * helpers the picker renders from. Wire access stays in App.tsx.
 */

/** Provider route, model id and optional adapter-owned reasoning effort. */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** One selectable reasoning effort of a model. */
export interface ModelReasoningEffort {
  id: string
  name: string
  description?: string
}

/** One model inside its provider group. */
export interface ModelCatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: {
    efforts: ModelReasoningEffort[]
    defaultEffort?: string
  }
}

/** One provider and its loaded models. */
export interface ModelProviderGroup {
  id: string
  name: string
  models: ModelCatalogModel[]
}

/** Host-generation catalog as `session.modelCatalog` returns it. */
export interface ModelCatalog {
  default: ModelSelection
  /** Providers currently able to serve a request. */
  routableProviders: string[]
  groups: ModelProviderGroup[]
  failures: Array<{ id: string; name: string; message: string }>
}

/** Public `modelSelection` projection: last consumed selection and the pending next one. */
export interface ModelSelectionProjection {
  lastUsed: ModelSelection | null
  next: ModelSelection | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate one wire selection; anything malformed is treated as absent. */
export function parseModelSelection(value: unknown): ModelSelection | null {
  if (!isRecord(value) || typeof value.provider !== 'string' || typeof value.model !== 'string') return null
  if (value.provider === '' || value.model === '') return null
  return {
    provider: value.provider,
    model: value.model,
    ...(typeof value.reasoningEffort === 'string' && value.reasoningEffort !== ''
      ? { reasoningEffort: value.reasoningEffort }
      : {}),
  }
}

/** Validate the projection value carried by history and `session/projection` frames. */
export function parseModelSelectionProjection(value: unknown): ModelSelectionProjection | null {
  if (!isRecord(value)) return null
  if (!('lastUsed' in value) && !('next' in value)) return null
  return { lastUsed: parseModelSelection(value.lastUsed), next: parseModelSelection(value.next) }
}

/** Validate a `session.modelCatalog` response; a malformed one yields null so the picker stays closed. */
export function parseModelCatalog(value: unknown): ModelCatalog | null {
  if (!isRecord(value) || !Array.isArray(value.groups)) return null
  const fallback = parseModelSelection(value.default)
  if (fallback === null) return null
  const groups: ModelProviderGroup[] = []
  for (const group of value.groups) {
    if (!isRecord(group) || typeof group.id !== 'string' || !Array.isArray(group.models)) continue
    const models: ModelCatalogModel[] = []
    for (const model of group.models) {
      if (!isRecord(model) || typeof model.id !== 'string') continue
      const reasoning = isRecord(model.reasoning) && Array.isArray(model.reasoning.efforts)
        ? {
          efforts: model.reasoning.efforts.flatMap((effort) => isRecord(effort) && typeof effort.id === 'string'
            ? [{
              id: effort.id,
              name: typeof effort.name === 'string' && effort.name !== '' ? effort.name : effort.id,
              ...(typeof effort.description === 'string' ? { description: effort.description } : {}),
            }]
            : []),
          ...(typeof model.reasoning.defaultEffort === 'string' ? { defaultEffort: model.reasoning.defaultEffort } : {}),
        }
        : undefined
      models.push({
        id: model.id,
        name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
        ...(typeof model.description === 'string' ? { description: model.description } : {}),
        ...(reasoning === undefined || reasoning.efforts.length === 0 ? {} : { reasoning }),
      })
    }
    groups.push({ id: group.id, name: typeof group.name === 'string' && group.name !== '' ? group.name : group.id, models })
  }
  return {
    default: fallback,
    routableProviders: Array.isArray(value.routableProviders)
      ? value.routableProviders.filter((id): id is string => typeof id === 'string')
      : groups.map((group) => group.id),
    groups,
    failures: Array.isArray(value.failures)
      ? value.failures.flatMap((failure) => isRecord(failure) && typeof failure.id === 'string'
        ? [{
          id: failure.id,
          name: typeof failure.name === 'string' ? failure.name : failure.id,
          message: typeof failure.message === 'string' ? failure.message : '',
        }]
        : [])
      : [],
  }
}

/** Whether two selections name the same route and effort. */
export function sameSelection(left: ModelSelection | null, right: ModelSelection | null): boolean {
  if (left === null || right === null) return left === right
  return left.provider === right.provider && left.model === right.model
    && (left.reasoningEffort ?? undefined) === (right.reasoningEffort ?? undefined)
}

/**
 * The selection the session's next request will use: the pending choice,
 * else the last consumed one, else the catalog default.
 */
export function effectiveSelection(
  projection: ModelSelectionProjection | null,
  fallback: ModelSelection | null,
): ModelSelection | null {
  return projection?.next ?? projection?.lastUsed ?? fallback
}

/** Find the catalog entry for a selection, when the catalog lists it. */
export function findCatalogModel(
  catalog: ModelCatalog | null,
  selection: ModelSelection | null,
): { group: ModelProviderGroup; model: ModelCatalogModel } | null {
  if (catalog === null || selection === null) return null
  const group = catalog.groups.find((candidate) => candidate.id === selection.provider)
  const model = group?.models.find((candidate) => candidate.id === selection.model)
  return group === undefined || model === undefined ? null : { group, model }
}

/** Short label for the composer chip: model display name plus effort name when set. */
export function selectionLabel(catalog: ModelCatalog | null, selection: ModelSelection | null): string {
  if (selection === null) return ''
  const found = findCatalogModel(catalog, selection)
  const name = found?.model.name ?? selection.model
  if (selection.reasoningEffort === undefined) return name
  const effort = found?.model.reasoning?.efforts.find((candidate) => candidate.id === selection.reasoningEffort)
  return `${name} · ${effort?.name ?? selection.reasoningEffort}`
}

/** Whether a provider can currently serve requests. */
export function providerRoutable(catalog: ModelCatalog, providerId: string): boolean {
  return catalog.routableProviders.includes(providerId)
}

/**
 * Selection produced by picking one catalog model: keeps the current effort
 * when the same model is re-picked, otherwise the model's default effort.
 */
export function selectionForModel(
  group: ModelProviderGroup,
  model: ModelCatalogModel,
  current: ModelSelection | null,
): ModelSelection {
  const efforts = model.reasoning?.efforts ?? []
  let reasoningEffort: string | undefined
  if (efforts.length > 0) {
    const keep = current !== null && current.provider === group.id && current.model === model.id
      && efforts.some((effort) => effort.id === current.reasoningEffort)
    reasoningEffort = keep ? current.reasoningEffort : model.reasoning?.defaultEffort ?? efforts[0]?.id
  }
  return { provider: group.id, model: model.id, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}
