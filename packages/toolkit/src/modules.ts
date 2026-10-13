/** Shared host and client mount order. */
export const MODULES = ['rdb', 's3', 'otel', 'browser', 'subscriptions', 'configCenter', 'memory'] as const
export type Module = typeof MODULES[number]

export const MODULES_API = '/api/dsh-toolkit/modules'
export const SIDEBAR_API = '/api/dsh-toolkit/sidebar'

/** Host module selection consumed by the client before panel mounting. */
export type ModuleMap = Record<Module, boolean>

/** Sidebar rows of toolkit modules: row id, owning module and row order. */
export const SIDEBAR_PANELS = [
  { id: 'rdb', module: 'rdb', order: 40 },
  { id: 's3', module: 's3', order: 50 },
  { id: 'dsh-config-center-mcp', module: 'configCenter', order: 55 },
  { id: 'memory', module: 'memory', order: 55 },
  { id: 'dsh-config-center-skills', module: 'configCenter', order: 56 },
  { id: 'subscriptions', module: 'subscriptions', order: 60 },
] as const satisfies ReadonlyArray<{ id: string; module: Module; order: number }>
export type SidebarPanel = typeof SIDEBAR_PANELS[number]['id']

/** Upper bounds of a stored hidden set. */
export const MAX_HIDDEN = 200
export const MAX_PANEL_ID_LENGTH = 128

/** `GET` / `PUT` body of the sidebar endpoint: row ids hidden from the sidebar, any plugin. */
export interface SidebarPreferences {
  hidden: string[]
}

/** A storable row id: non-empty, bounded, printable. */
export function isPanelId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PANEL_ID_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value)
}
