/** Toolkit client dictionaries: labels of module entries while their rows are unregistered; both languages carry the same keys. */
export const zh = {
  'panel.rdb': '数据库',
  'panel.s3': 'S3',
  'panel.dsh-config-center-mcp': 'MCP',
  'panel.memory': '记忆',
  'panel.dsh-config-center-skills': '技能',
  'panel.subscriptions': 'AI 订阅',
  'panel.gateway': 'API 网关',
}

export const en: Record<Key, string> = {
  'panel.rdb': 'Database',
  'panel.s3': 'S3',
  'panel.dsh-config-center-mcp': 'MCP',
  'panel.memory': 'Memory',
  'panel.dsh-config-center-skills': 'Skills',
  'panel.subscriptions': 'AI subscriptions',
  'panel.gateway': 'API gateway',
}

export type Key = keyof typeof zh
