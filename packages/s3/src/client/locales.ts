/** dsh-s3 surface copy: zh is the key source, en mirrors every key. */

export const zh = {
  'entry.label': 'S3',
  'entry.tooltip': 'S3 对象存储浏览器',
  'panel.title': 'S3 对象存储',
  'panel.back': '返回会话',
  'panel.agentTools': '允许 agent 使用（注入 s3_* 工具）',
  'profiles.title': '桶',
  'profiles.add': '新增',
  'profiles.empty': '还没有配置桶。点「新增」填写 bucket、Endpoint 和访问密钥。',
  'profiles.edit': '编辑',
  'profiles.delete': '删除',
  'profiles.test': '测试连接',
  'profiles.deleteConfirm': '确定删除桶配置「{name}」？只移除本机保存的连接信息，不会动桶里的数据。',
  'profiles.testing': '连接测试中…',
  'profiles.testOk': '连接成功（{latency} ms）',
  'profiles.testFail': '连接失败：{error}',
  'form.title.create': '新增桶',
  'form.title.edit': '编辑桶「{name}」',
  'form.name': '显示名称',
  'form.namePlaceholder': '默认用 bucket 名',
  'form.optional': '可选',
  'form.bucket': 'Bucket 名称',
  'form.endpoint': 'Endpoint',
  'form.region': 'Region',
  'form.accessKeyId': 'Access Key ID',
  'form.secretAccessKey': 'Secret Access Key',
  'form.pathStyle': '路径风格寻址（path-style，MinIO / 自建服务勾选）',
  'form.prefix': '限定前缀',
  'form.cancel': '取消',
  'form.save': '保存',
  'form.saving': '保存中…',
  'browser.selectProfile': '在左侧选择一个桶开始浏览。',
  'browser.root': '根目录',
  'browser.refresh': '刷新',
  'browser.upload': '上传文件',
  'browser.newFolder': '新建文件夹',
  'browser.newFolderPrompt': '文件夹名称',
  'browser.filter': '过滤当前页…',
  'browser.loadMore': '加载更多',
  'browser.loading': '加载中…',
  'browser.empty': '这个前缀下没有对象。',
  'browser.col.name': '名称',
  'browser.col.size': '大小',
  'browser.col.modified': '修改时间',
  'browser.col.actions': '操作',
  'browser.download': '下载',
  'browser.preview': '预览',
  'browser.link': '分享链接',
  'browser.rename': '重命名',
  'browser.delete': '删除',
  'browser.selected': '已选 {count} 项',
  'browser.deleteSelected': '删除所选',
  'browser.clearSelection': '取消选择',
  'browser.deleteConfirmTitle': '确认删除',
  'browser.deleteConfirmBody': '将永久删除以下 {count} 项，文件夹会连同其中全部对象一起删除，无法撤销：',
  'browser.deleteConfirmOk': '删除',
  'browser.deleted': '已删除 {count} 个对象',
  'browser.deleteErrors': '{count} 个对象删除失败',
  'browser.renamePrompt': '新的对象名（同一目录内）',
  'browser.linkTitle': '分享链接',
  'browser.linkExpires': '有效期',
  'browser.linkCopy': '复制链接',
  'browser.linkCopied': '已复制',
  'browser.exp.1h': '1 小时',
  'browser.exp.1d': '1 天',
  'browser.exp.7d': '7 天',
  'browser.uploading': '上传 {name}（{percent}%）',
  'browser.uploadDone': '上传完成：{name}',
  'browser.uploadFail': '上传失败：{name} — {error}',
  'browser.folderCreated': '已创建文件夹 {name}',
  'browser.previewTruncated': '（只显示前 {size}，完整内容请下载）',
  'browser.previewBinary': '这个对象不是文本，无法预览；请下载查看。',
  'browser.close': '关闭',
  'browser.toolsOn': 'agent 工具已开启',
  'browser.toolsOff': 'agent 工具已关闭',
  'error.disabled': 'S3 插件的服务端未运行（路由 404）。请重启 dsh 或检查插件是否已启用。',
  'error.generic': '出错了：{error}',
} as const

export type S3Key = keyof typeof zh

export const en: Record<S3Key, string> = {
  'entry.label': 'S3',
  'entry.tooltip': 'S3 object storage browser',
  'panel.title': 'S3 storage',
  'panel.back': 'Back to chat',
  'panel.agentTools': 'Let the agent use these buckets (s3_* tools)',
  'profiles.title': 'Buckets',
  'profiles.add': 'Add',
  'profiles.empty': 'No buckets yet. Click "Add" and enter the bucket, endpoint and access keys.',
  'profiles.edit': 'Edit',
  'profiles.delete': 'Delete',
  'profiles.test': 'Test connection',
  'profiles.deleteConfirm': 'Remove the bucket profile "{name}"? Only the locally saved connection is removed; the bucket data is untouched.',
  'profiles.testing': 'Testing…',
  'profiles.testOk': 'Connected ({latency} ms)',
  'profiles.testFail': 'Connection failed: {error}',
  'form.title.create': 'Add bucket',
  'form.title.edit': 'Edit bucket "{name}"',
  'form.name': 'Display name',
  'form.namePlaceholder': 'defaults to the bucket name',
  'form.optional': 'Optional',
  'form.bucket': 'Bucket name',
  'form.endpoint': 'Endpoint',
  'form.region': 'Region',
  'form.accessKeyId': 'Access Key ID',
  'form.secretAccessKey': 'Secret Access Key',
  'form.pathStyle': 'Path-style addressing (MinIO / self-hosted)',
  'form.prefix': 'Scope prefix',
  'form.cancel': 'Cancel',
  'form.save': 'Save',
  'form.saving': 'Saving…',
  'browser.selectProfile': 'Pick a bucket on the left to start browsing.',
  'browser.root': 'Root',
  'browser.refresh': 'Refresh',
  'browser.upload': 'Upload files',
  'browser.newFolder': 'New folder',
  'browser.newFolderPrompt': 'Folder name',
  'browser.filter': 'Filter this page…',
  'browser.loadMore': 'Load more',
  'browser.loading': 'Loading…',
  'browser.empty': 'Nothing under this prefix.',
  'browser.col.name': 'Name',
  'browser.col.size': 'Size',
  'browser.col.modified': 'Modified',
  'browser.col.actions': 'Actions',
  'browser.download': 'Download',
  'browser.preview': 'Preview',
  'browser.link': 'Share link',
  'browser.rename': 'Rename',
  'browser.delete': 'Delete',
  'browser.selected': '{count} selected',
  'browser.deleteSelected': 'Delete selected',
  'browser.clearSelection': 'Clear selection',
  'browser.deleteConfirmTitle': 'Confirm deletion',
  'browser.deleteConfirmBody': 'Permanently delete these {count} item(s)? Folders are deleted with everything inside. This cannot be undone:',
  'browser.deleteConfirmOk': 'Delete',
  'browser.deleted': 'Deleted {count} object(s)',
  'browser.deleteErrors': '{count} object(s) failed to delete',
  'browser.renamePrompt': 'New object name (same folder)',
  'browser.linkTitle': 'Share link',
  'browser.linkExpires': 'Valid for',
  'browser.linkCopy': 'Copy link',
  'browser.linkCopied': 'Copied',
  'browser.exp.1h': '1 hour',
  'browser.exp.1d': '1 day',
  'browser.exp.7d': '7 days',
  'browser.uploading': 'Uploading {name} ({percent}%)',
  'browser.uploadDone': 'Uploaded {name}',
  'browser.uploadFail': 'Upload failed: {name} — {error}',
  'browser.folderCreated': 'Created folder {name}',
  'browser.previewTruncated': '(showing the first {size}; download for the full content)',
  'browser.previewBinary': 'This object is not text and cannot be previewed; download it instead.',
  'browser.close': 'Close',
  'browser.toolsOn': 'Agent tools are on',
  'browser.toolsOff': 'Agent tools are off',
  'error.disabled': 'The S3 plugin host is not running (route 404). Restart dsh or check that the plugin is enabled.',
  'error.generic': 'Something went wrong: {error}',
}

export type TranslateValues = Record<string, string | number>

export function interpolate(dictionary: Record<string, string>, key: string, values?: TranslateValues): string {
  let text = dictionary[key] ?? key
  if (values !== undefined) {
    for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

let runtimeT: ((key: S3Key, values?: TranslateValues) => string) | undefined

/** Wire the SDK translate seat (ctx.locale.bind); undefined restores the document-language pick. */
export function setRuntimeTranslate(t: ((key: S3Key, values?: TranslateValues) => string) | undefined): void {
  runtimeT = t
}

function dictionary(): Record<string, string> {
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : 'zh'
  return lang.toLowerCase().startsWith('en') ? en : zh
}

/** Translate a key (current language). */
export function tt(key: S3Key, values?: TranslateValues): string {
  if (runtimeT !== undefined) {
    try {
      const value = runtimeT(key, values)
      if (typeof value === 'string' && value !== '' && value !== key) return value
    } catch { /* fall through */ }
  }
  return interpolate(dictionary(), key, values)
}
