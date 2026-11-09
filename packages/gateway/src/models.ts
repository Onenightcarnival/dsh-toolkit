/**
 * Model catalog of the gateway: every host provider route as `provider:model`
 * and alias resolution. A request must name a model; nothing is assumed.
 */
import type { GatewayModel, GatewaySettings } from './protocol.ts'

/** The host services the catalog reads; structural so tests can stub them. */
export interface CatalogHost {
  listProviders(): ReadonlyArray<{ id: string; name: string }>
  listModels(provider: string): Promise<ReadonlyArray<{ id: string; name: string }>>
}

export interface ModelSelection {
  provider: string
  model: string
}

export interface ResolvedModel extends ModelSelection {
  /** `provider:model`. */
  id: string
  /** The name the request carried, when any. */
  requested: string | undefined
}

export class ModelResolutionError extends Error {
  constructor(message: string) { super(message); this.name = 'ModelResolutionError' }
}

export const SEPARATOR = ':'

export function gatewayId(provider: string, model: string): string {
  return `${provider}${SEPARATOR}${model}`
}

/** Split `provider:model` at the first separator; undefined when the shape does not fit. */
export function splitGatewayId(id: string): ModelSelection | undefined {
  const index = id.indexOf(SEPARATOR)
  if (index <= 0 || index === id.length - 1) return undefined
  return { provider: id.slice(0, index), model: id.slice(index + 1) }
}

export class ModelCatalog {
  constructor(
    private readonly host: CatalogHost,
    private readonly settings: () => GatewaySettings,
  ) {}

  /** Every model of every registered provider; a provider whose listing fails contributes nothing. */
  async list(): Promise<GatewayModel[]> {
    const models: GatewayModel[] = []
    for (const provider of this.host.listProviders()) {
      let entries: ReadonlyArray<{ id: string; name: string }>
      try {
        entries = await this.host.listModels(provider.id)
      } catch {
        continue
      }
      for (const entry of entries) {
        models.push({ id: gatewayId(provider.id, entry.id), provider: provider.id, providerName: provider.name, model: entry.id, name: entry.name })
      }
    }
    return models
  }

  /**
   * Resolve a request's model name: an alias first, then a `provider:model`
   * id of a registered provider.
   * @throws {ModelResolutionError} when the request names no model or one of an unregistered provider.
   */
  resolve(requested: unknown): ResolvedModel {
    const name = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : undefined
    if (name === undefined) throw new ModelResolutionError('the request names no model; use a provider:model id from GET /v1/models')
    const providers = new Set(this.host.listProviders().map(provider => provider.id))
    const target = this.settings().aliases[name] ?? name
    const split = splitGatewayId(target)
    if (split === undefined || !providers.has(split.provider)) {
      throw new ModelResolutionError(`unknown model "${name}"; use a provider:model id from GET /v1/models`)
    }
    return { ...split, id: target, requested: name }
  }
}
