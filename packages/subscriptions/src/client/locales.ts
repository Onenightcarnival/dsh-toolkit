export const zh = {
  googleSearchTitle: 'Antigravity Web Search', googleSearchHint: 'Google 网页搜索，包含摘要与来源。',
  googleImageTitle: 'Antigravity 图像生成与编辑', googleImageHint: 'Gemini 3.1 Flash Image，支持生成与编辑。',
  subscriptionType: '订阅类型', connectGoogle: '连接 Google Antigravity', emptyGoogle: '连接你的 Google Antigravity 账号',
  introGoogle: 'Google Antigravity 订阅，支持账号模型目录、推理强度、上下文配置和用量查询。',
  title: 'AI 订阅', back: '返回对话', accounts: '订阅账号', add: '添加账号', connect: '连接 ChatGPT',
  connected: '已连接', disconnected: '未连接', waiting: '等待授权', default: '默认账号', setDefault: '设为默认',
  disconnect: '断开连接', cancel: '取消', confirm: '确认断开', disconnectHint: '断开 {account} 并移除本地登录凭证？',
  intro: '使用 ChatGPT 订阅，在对话中调用模型、联网搜索与图像生成。',
  emptyTitle: '连接你的 ChatGPT 账号', emptyHint: '在浏览器中完成授权后，可用模型会自动出现在对话的模型选择器中。',
  authHint: '请在浏览器中完成账号授权。若新窗口未打开，点击下方链接继续。', openAuth: '打开授权页面',
  manualOnlyHint: '本机回调端口不可用，已切换为手动登录。请打开授权页面并完成登录；跳转到 localhost 后，即使浏览器显示无法访问，也请复制地址栏中的完整 URL，粘贴到下方并提交。',
  manual: '手动提交回调地址', manualHint: '无法自动回到应用时，将浏览器地址栏中的完整回调 URL 粘贴到这里。', submit: '提交',
  models: '模型', tools: '工具', usage: '用量', refresh: '刷新', loading: '加载中…', retry: '重试',
  modelHint: '勾选的模型显示在对话中；同类账号共用设置。',
  contextHint: '支持整数、256K、1M（十进制）。Enter 保存，留空恢复默认。',
  save: '保存', saveContext: '保存上下文', resetContext: '恢复默认',
  contextDefault: '默认 {value}', contextMax: '上限 {value}', contextEffective: '实际生效 {value}',
  contextInvalid: '请输入正整数，或使用 256K、1M 等写法。', contextTooLarge: '不能超过目录提供的上限 {max}。',
  search: '搜索模型名称或 ID', autoModels: '自动显示所有模型', modelName: '模型', context: '上下文', reasoning: '默认推理强度',
  providerDefault: '跟随提供方', noModels: '暂无可用模型，请连接账号或刷新模型目录。', noMatches: '没有匹配的模型。',
  unavailable: '暂时无法读取该账号的模型目录，请稍后刷新。', saved: '设置已保存',
  searchTitle: 'Codex Web Search', searchHint: '网页与图片搜索、天气、行情和赛事查询。',
  imageTitle: 'Codex 图像生成与编辑', imageHint: '支持透明背景、本地图片与对话图片编辑。',
  toolPolicy: '工具列表按会话创建时的开关设置生成；搜索关闭后也会立即阻止已有会话调用。实际可用性取决于账号权限与剩余额度。',
  enabled: '已启用', disabled: '已关闭', usageHint: '当前账号的订阅用量。',
  unknownUsage: '尚无用量数据', unsupportedUsage: '提供方暂未返回可用的用量窗口。', session: '短期额度', weekly: '每周额度', other: '其他额度',
  used: '已使用', resets: '重置时间', plan: '订阅方案', imageLoading: '图片加载中…', imagePreview: '生成的图片', close: '关闭',
  generating: '正在生成图片…', unknown: '未知', pending: '处理中…', provider: 'ChatGPT 订阅',
}
export type Key = keyof typeof zh
export const en: Record<Key, string> = {
  googleSearchTitle: 'Antigravity Web Search', googleSearchHint: 'Google web search with summaries and sources.',
  googleImageTitle: 'Antigravity image generation and editing', googleImageHint: 'Image generation and editing with Gemini 3.1 Flash Image.',
  subscriptionType: 'Subscription type', connectGoogle: 'Connect Google Antigravity', emptyGoogle: 'Connect your Google Antigravity account',
  introGoogle: 'Google Antigravity subscription with account model catalogs, reasoning effort, context settings and usage.',
  title: 'AI subscriptions', back: 'Back to chat', accounts: 'Subscription accounts', add: 'Add account', connect: 'Connect ChatGPT',
  connected: 'Connected', disconnected: 'Not connected', waiting: 'Waiting for authorization', default: 'Default account', setDefault: 'Set as default',
  disconnect: 'Disconnect', cancel: 'Cancel', confirm: 'Disconnect account', disconnectHint: 'Disconnect {account} and remove its local credentials?',
  intro: 'Use your ChatGPT subscription for models, web search and image generation in conversations.',
  emptyTitle: 'Connect your ChatGPT account', emptyHint: 'Authorize in your browser. Available models will appear in the conversation model picker.',
  authHint: 'Complete account authorization in your browser. If no window opened, use the link below.', openAuth: 'Open authorization page',
  manualOnlyHint: 'The local callback ports are unavailable. Open the authorization page and sign in. After redirecting to localhost, copy the full address-bar URL below and submit it, even if the browser says the page cannot be reached.',
  manual: 'Submit callback URL manually', manualHint: 'If the automatic callback fails, paste the full callback URL from your browser address bar.', submit: 'Submit',
  models: 'Models', tools: 'Tools', usage: 'Usage', refresh: 'Refresh', loading: 'Loading…', retry: 'Retry',
  modelHint: 'Selected models appear in conversations; shared across accounts of this provider.',
  contextHint: 'Use integers, 256K or 1M (decimal). Enter saves; blank restores the default.',
  save: 'Save', saveContext: 'Save context', resetContext: 'Reset to default',
  contextDefault: 'Default {value}', contextMax: 'Max {value}', contextEffective: 'Effective {value}',
  contextInvalid: 'Enter a positive whole token count, or use a value such as 256K or 1M.', contextTooLarge: 'Cannot exceed the catalog limit of {max}.',
  search: 'Search model name or ID', autoModels: 'Show all models automatically', modelName: 'Model', context: 'Context', reasoning: 'Default reasoning effort',
  providerDefault: 'Follow provider', noModels: 'No models available. Connect an account or refresh the catalog.', noMatches: 'No matching models.',
  unavailable: 'This account’s model catalog is temporarily unavailable. Try refreshing later.', saved: 'Settings saved',
  searchTitle: 'Codex Web Search', searchHint: 'Web and image search, weather, finance and sports queries.',
  imageTitle: 'Codex image generation and editing', imageHint: 'Transparent backgrounds, local files and conversation image editing.',
  toolPolicy: 'Tool lists use the settings at conversation creation. Disabling search also blocks calls in existing conversations immediately. Access depends on account entitlements and remaining quota.',
  enabled: 'Enabled', disabled: 'Disabled', usageHint: 'Subscription usage for the selected account.',
  unknownUsage: 'No usage data yet', unsupportedUsage: 'The provider has not returned any usage windows.', session: 'Short-term window', weekly: 'Weekly window', other: 'Other window',
  used: 'Used', resets: 'Resets', plan: 'Plan', imageLoading: 'Loading image…', imagePreview: 'Generated image', close: 'Close',
  generating: 'Generating image…', unknown: 'Unknown', pending: 'Working…', provider: 'ChatGPT subscription',
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
