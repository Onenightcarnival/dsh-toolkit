export const zh = {
  connectChatGpt: '使用 ChatGPT 继续', emptyChatGpt: '连接 ChatGPT 账号',
  introChatGpt: '授权本应用使用 ChatGPT 套餐，支持对话与本地工具调用。',
  chatGptConsentHint: '登录后需授权使用套餐额度。凭据保存在本机；本应用不会获得你的 ChatGPT 对话或记忆。',
  chatGptUsageHint: '与 Codex / ChatGPT Work 共享套餐额度，应用上限在 ChatGPT 中管理。',
  chatGptUsageUnavailable: '应用剩余额度请在 ChatGPT 中查看。', manageUsage: '管理用量',
  reconnect: '重新登录', planDisabled: '未授权使用套餐', subscriptionType: '订阅类型',
  title: 'AI 订阅', back: '返回对话', accounts: '订阅账号', add: '添加账号',
  connected: '已连接', disconnected: '未连接', waiting: '等待授权', default: '默认账号', setDefault: '设为默认',
  disconnect: '断开连接', cancel: '取消', confirm: '确认断开', disconnectHint: '断开 {account} 并移除本地登录凭证？',
  authHint: '请在浏览器中完成账号授权。若新窗口未打开，点击下方链接继续。', openAuth: '打开授权页面',
  manualOnlyHint: '本机回调端口不可用，已切换为手动登录。请打开授权页面并完成登录；跳转到本机回调地址后，即使浏览器显示无法访问，也请复制地址栏中的完整 URL，粘贴到下方并提交。',
  manual: '手动提交回调地址', manualHint: '无法自动回到应用时，将浏览器地址栏中的完整回调 URL 粘贴到这里。', submit: '提交',
  models: '模型', usage: '用量', refresh: '刷新', loading: '加载中…', retry: '重试',
  modelHint: '勾选的模型显示在对话中；同类账号共用设置。',
  contextHint: '支持整数、256K、1M（十进制）。Enter 保存，留空恢复默认。',
  save: '保存', saveContext: '保存上下文', resetContext: '恢复默认',
  contextDefault: '默认 {value}', contextMax: '上限 {value}', contextEffective: '实际生效 {value}',
  contextInvalid: '请输入正整数，或使用 256K、1M 等写法。', contextTooLarge: '不能超过目录提供的上限 {max}。',
  search: '搜索模型名称或 ID', autoModels: '自动显示所有模型', modelName: '模型', context: '上下文', reasoning: '默认推理强度',
  providerDefault: '跟随提供方', noModels: '暂无可用模型，请连接账号或刷新模型目录。', noMatches: '没有匹配的模型。',
  unavailable: '暂时无法读取该账号的模型目录，请稍后刷新。', saved: '设置已保存',
  enabled: '已启用', disabled: '已关闭', close: '关闭', pending: '处理中…',
}
export type Key = keyof typeof zh
export const en: Record<Key, string> = {
  connectChatGpt: 'Continue with ChatGPT', emptyChatGpt: 'Connect your ChatGPT account',
  introChatGpt: 'Authorize this app to use your ChatGPT plan for conversations and local tools.',
  chatGptConsentHint: 'Allow plan usage when signing in. Credentials stay on this host; this app receives no access to your ChatGPT conversations or memories.',
  chatGptUsageHint: 'Shares plan usage with Codex / ChatGPT Work. Manage app limits in ChatGPT.',
  chatGptUsageUnavailable: 'View remaining app usage in ChatGPT.', manageUsage: 'Manage usage',
  reconnect: 'Sign in again', planDisabled: 'Plan usage disabled', subscriptionType: 'Subscription type',
  title: 'AI subscriptions', back: 'Back to chat', accounts: 'Subscription accounts', add: 'Add account',
  connected: 'Connected', disconnected: 'Not connected', waiting: 'Waiting for authorization', default: 'Default account', setDefault: 'Set as default',
  disconnect: 'Disconnect', cancel: 'Cancel', confirm: 'Disconnect account', disconnectHint: 'Disconnect {account} and remove its local credentials?',
  authHint: 'Complete account authorization in your browser. If no window opened, use the link below.', openAuth: 'Open authorization page',
  manualOnlyHint: 'The local callback ports are unavailable. Open the authorization page and sign in. After redirecting to the local callback, copy the full address-bar URL below and submit it, even if the browser says the page cannot be reached.',
  manual: 'Submit callback URL manually', manualHint: 'If the automatic callback fails, paste the full callback URL from your browser address bar.', submit: 'Submit',
  models: 'Models', usage: 'Usage', refresh: 'Refresh', loading: 'Loading…', retry: 'Retry',
  modelHint: 'Selected models appear in conversations; shared across accounts of this provider.',
  contextHint: 'Use integers, 256K or 1M (decimal). Enter saves; blank restores the default.',
  save: 'Save', saveContext: 'Save context', resetContext: 'Reset to default',
  contextDefault: 'Default {value}', contextMax: 'Max {value}', contextEffective: 'Effective {value}',
  contextInvalid: 'Enter a positive whole token count, or use a value such as 256K or 1M.', contextTooLarge: 'Cannot exceed the catalog limit of {max}.',
  search: 'Search model name or ID', autoModels: 'Show all models automatically', modelName: 'Model', context: 'Context', reasoning: 'Default reasoning effort',
  providerDefault: 'Follow provider', noModels: 'No models available. Connect an account or refresh the catalog.', noMatches: 'No matching models.',
  unavailable: 'This account’s model catalog is temporarily unavailable. Try refreshing later.', saved: 'Settings saved',
  enabled: 'Enabled', disabled: 'Disabled', close: 'Close', pending: 'Working…',
}
let runtime: ((key: Key, values?: Record<string, string | number>) => string) | undefined
export function setRuntimeTranslate(t: typeof runtime): void { runtime = t }
export function tt(key: Key, values?: Record<string, string | number>): string {
  if (runtime) {
    try { const result = runtime(key, values); if (result && result !== key) return result } catch { /* fallback */ }
  }
  const lang = typeof document === 'undefined' ? 'zh' : document.documentElement.lang
  let text = (lang.toLowerCase().startsWith('en') ? en : zh)[key]
  for (const [name, value] of Object.entries(values ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}
