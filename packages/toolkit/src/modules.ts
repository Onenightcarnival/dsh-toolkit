/** Shared host and client mount order. */
export const MODULES = ['rdb', 's3', 'otel', 'browser', 'subscriptions'] as const
export type Module = typeof MODULES[number]

export const MODULES_API = '/api/dsh-toolkit/modules'

/** Host module selection consumed by the client before panel mounting. */
export type ModuleMap = Record<Module, boolean>
