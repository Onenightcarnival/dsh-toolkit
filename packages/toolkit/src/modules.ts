/** Shared host and client mount order. */
export const MODULES = ['rdb', 's3', 'otel', 'browser', 'subscriptions', 'configCenter', 'memory'] as const
export type Module = typeof MODULES[number]

export const MODULES_API = '/api/dsh-toolkit/modules'
export const SIDEBAR_API = '/api/dsh-toolkit/sidebar'

/** Host module selection consumed by the client before panel mounting. */
export type ModuleMap = Record<Module, boolean>

/** Sidebar rows in sidebar order: row id and owning module. */
export const SIDEBAR_PANELS = [
  { id: 'rdb', module: 'rdb' },
  { id: 's3', module: 's3' },
  { id: 'dsh-config-center-mcp', module: 'configCenter' },
  { id: 'memory', module: 'memory' },
  { id: 'dsh-config-center-skills', module: 'configCenter' },
  { id: 'subscriptions', module: 'subscriptions' },
] as const satisfies ReadonlyArray<{ id: string; module: Module }>
export type SidebarPanel = typeof SIDEBAR_PANELS[number]['id']

/** `GET` / `PUT` body of the sidebar endpoint: row ids hidden from the sidebar. */
export interface SidebarPreferences {
  hidden: SidebarPanel[]
}

export function isSidebarPanel(value: unknown): value is SidebarPanel {
  return SIDEBAR_PANELS.some(panel => panel.id === value)
}
