/** Toolkit client dictionaries; both languages carry the same keys. */
export const zh = {
  title: 'Toolkit',
  'sidebar.title': '侧栏入口',
  'sidebar.intro': '关闭的入口不在左侧边栏显示；对应功能与数据保持不变。',
  'sidebar.empty': '已启用的模块没有侧栏入口。',
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
  title: 'Toolkit',
  'sidebar.title': 'Sidebar entries',
  'sidebar.intro': 'Entries turned off are hidden from the left sidebar; their features and data stay unchanged.',
  'sidebar.empty': 'Enabled modules have no sidebar entries.',
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
