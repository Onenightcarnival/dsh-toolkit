/** Owned backend messages are localized at the UI boundary. */
export const errorMessages: Record<string, string> = {
  "日志不可用": "Log unavailable",
  "安装参数无效": "Invalid installation parameters",
  "技能参数无效": "Invalid skill parameters",
  "请先到「设置 → 环境依赖」安装或修复 uv / uvx。": "Install or repair uv / uvx in Settings → Environment dependencies.",
  "uv 下载校验失败，请重试。": "uv checksum verification failed. Try again.",
  "uv 版本校验失败。": "uv version verification failed.",
  "已安装的 uv 无法运行，请修复环境。": "Installed uv cannot run. Repair the environment.",
  "暂不支持当前系统或处理器架构。": "This operating system or architecture is not supported.",
  "uv 下载失败：HTTP {0}": "uv download failed: HTTP {0}",
  "uv 下载文件超过大小限制。": "uv download exceeds the size limit.",
  "uv 正在使用或目录不可写。请停止相关 MCP 后重试。": "uv is in use or its directory is not writable. Stop related MCP servers and retry.",
  "uv 替换失败，原版本保留在 {0}。请关闭相关 MCP 后重试。": "uv replacement failed. The original version is at {0}. Stop related MCP servers and retry.",
  "启动等待时间须为 1–{0} 的整数（秒）。": "Startup timeout must be an integer from 1 to {0} seconds.",
  "技能名无效": "Invalid skill name",
  "路径无效": "Invalid path",
  "不支持符号链接": "Symbolic links are not supported",
  "不是文件": "Not a file",
  "二进制文件无法预览": "Binary files cannot be previewed",
  "技能不存在": "Skill not found",
  "目标位置存在同名技能": "A skill with this name exists at the destination",
  "ZIP 最大 32 MB": "ZIP size limit: 32 MB",
  "解压内容超出限制": "Extracted contents exceed the limit",
  "ZIP 中没有技能": "No skills found in ZIP",
  "ZIP 中存在重复技能名": "Duplicate skill names in ZIP",
  "恢复失败，原文件保存在 {0}": "Recovery failed. Original files are at {0}",
  "{0} 秒内未完成 MCP 启动准备。{1}": "MCP startup preparation timed out after {0} seconds. {1}",
  "MCP 启动准备失败：{0}": "MCP startup preparation failed: {0}"
}
export function localizeError(message: string, language = typeof document === 'undefined' ? 'zh' : document.documentElement.lang): string {
  const english = language.toLowerCase().startsWith('en')
  for (const [zh, en] of Object.entries(errorMessages)) {
    const source = english ? zh : en, target = english ? en : zh
    const parts = source.split(/(\{\d+\})/g)
    const indices: string[] = []
    const pattern = parts.map(part => { if (/^\{\d+\}$/.test(part)) { indices.push(part); return '(.*?)' } return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }).join('')
    const match = new RegExp('^' + pattern + '$', 's').exec(message)
    if (match) return target.replace(/\{\d+\}/g, key => match[indices.indexOf(key) + 1] ?? key)
  }
  return message
}
