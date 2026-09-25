/** The plugins the toolkit carries, in mount order. */
export const MODULES = ['rdb', 's3', 'otel', 'browser'] as const
export type Module = typeof MODULES[number]

export const MODULES_API = '/api/dsh-toolkit/modules'

/** Which modules a host mounted; the client reads it before mounting the matching panels. */
export type ModuleMap = Record<Module, boolean>
