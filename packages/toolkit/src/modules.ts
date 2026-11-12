/** Shared host and client mount order. */
export const MODULES = ['rdb', 's3', 'http', 'otel', 'browser', 'subscriptions', 'configCenter', 'memory', 'gateway'] as const
export type Module = typeof MODULES[number]

export const MODULES_API = '/api/dsh-toolkit/modules'
export const SIDEBAR_API = '/api/dsh-toolkit/sidebar'

/** Host module selection consumed by the client before panel mounting. */
export type ModuleMap = Record<Module, boolean>

/** Upper bounds of a stored unpinned set. */
export const MAX_HIDDEN = 200
export const MAX_PANEL_ID_LENGTH = 128

/** `GET` / `PUT` body of the sidebar endpoint: ids of the panels unpinned from the sidebar, any plugin. */
export interface SidebarPreferences {
  hidden: string[]
}

/** A storable panel id: non-empty, bounded, printable. */
export function isPanelId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PANEL_ID_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value)
}
