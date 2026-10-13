/** Toolkit client dictionaries; both languages carry the same keys. */
export const zh = {
  title: '左侧边栏',
  'sidebar.title': '侧栏入口',
  'sidebar.hideAll': '全部关闭',
  'sidebar.showAll': '全部展示',
  'sidebar.empty': '没有侧栏入口。',
  'panel.rdb': '数据库',
  'panel.s3': 'S3',
  'panel.dsh-config-center-mcp': 'MCP',
  'panel.memory': '记忆',
  'panel.dsh-config-center-skills': '技能',
  'panel.subscriptions': 'AI 订阅',
  'error.load': '读取侧栏设置失败：{error}',
  'error.save': '保存侧栏设置失败：{error}',
}

export const en: Record<Key, string> = {
  title: 'Left sidebar',
  'sidebar.title': 'Sidebar entries',
  'sidebar.hideAll': 'Hide all',
  'sidebar.showAll': 'Show all',
  'sidebar.empty': 'No sidebar entries.',
  'panel.rdb': 'Database',
  'panel.s3': 'S3',
  'panel.dsh-config-center-mcp': 'MCP',
  'panel.memory': 'Memory',
  'panel.dsh-config-center-skills': 'Skills',
  'panel.subscriptions': 'AI subscriptions',
  'error.load': 'Failed to load sidebar settings: {error}',
  'error.save': 'Failed to save sidebar settings: {error}',
}

export type Key = keyof typeof zh
