/** Pure authorization policy for model-requested browser tools. */

import type { ToolCall } from './tools.ts'
import type { TabFrame } from './frames.ts'
import type { ApprovalPrompt } from '../security/approval.ts'
import { getUiLocale, type UiLocale } from '../i18n.ts'

const PAGE_READS = new Set(['browser_snapshot', 'browser_get_text', 'browser_find', 'browser_wait_for', 'browser_screenshot', 'browser_console', 'browser_network'])
const STATE_CHANGING_ACTIONS = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_hover',
  'browser_form_input',
  'browser_drag',
  'browser_upload',
  'browser_handle_dialog',
  'browser_evaluate',
  'browser_navigate',
  'browser_open_tab',
  'browser_back',
  'browser_forward',
  'browser_reload',
])

function readSummary(name: string, locale: UiLocale): string {
  switch (name) {
    case 'browser_snapshot': return localized(locale, 'Read the current page and accessible iframes', '读取当前页面及可访问 iframe')
    case 'browser_find': return localized(locale, 'Search the current page for elements', '在当前页面查找元素')
    case 'browser_wait_for': return localized(locale, 'Watch the current page until a condition is met', '监视当前页面直到条件满足')
    case 'browser_screenshot': return localized(locale, 'Capture a screenshot of the visible page (passwords are not masked in images)', '截取当前可见页面的截图（截图中的密码不会被打码）')
    case 'browser_console': return localized(locale, 'Read the page console output', '读取页面控制台输出')
    case 'browser_network': return localized(locale, 'Read the page network request log', '读取页面网络请求记录')
    default: return localized(locale, 'Read text from the specified area of the current page', '读取当前页面的指定文本区域')
  }
}

/** Return an approval prompt, or undefined when this call needs no prompt. */
export function approvalPromptForCall(
  call: ToolCall,
  sharePageContent: 'ask' | 'auto' | 'off',
  frames: TabFrame[],
  locale: UiLocale = getUiLocale(),
): ApprovalPrompt | undefined {
  if (PAGE_READS.has(call.name)) {
    if (sharePageContent !== 'ask') return undefined
    const targetFrames = call.name === 'browser_snapshot' || call.name === 'browser_screenshot'
      ? frames
      : frames.filter((frame) => frame.frameId === requestedFrame(call.args))
    return {
      kind: 'read',
      action: call.name,
      summary: readSummary(call.name, locale),
      origins: uniqueOrigins(targetFrames, frames),
      canTrust: false,
    }
  }

  if (!STATE_CHANGING_ACTIONS.has(call.name)) return undefined
  if (call.name === 'browser_open_tab') {
    const destination = originFromUrl(typeof call.args.url === 'string' ? call.args.url : '')
    return {
      kind: 'action',
      action: call.name,
      summary: summarizeAction(call, locale),
      // A new tab does not mutate the current page; only the destination matters.
      origins: destination === undefined ? [] : [destination],
      canTrust: destination !== undefined,
    }
  }
  const frameId = requestedFrame(call.args)
  const target = frames.find((frame) => frame.frameId === frameId) ?? frames.find((frame) => frame.frameId === 0)
  const origins = uniqueOrigins(target === undefined ? [] : [target], frames)
  let canTrust = origins.length === 1 && call.name !== 'browser_back' && call.name !== 'browser_forward'
  if (call.name === 'browser_navigate') {
    const destination = originFromUrl(typeof call.args.url === 'string' ? call.args.url : '')
    if (destination !== undefined && !origins.includes(destination)) origins.push(destination)
    // Do not let an invalid, opaque, or cross-origin navigation become a
    // back door for adding the current page to the persistent allowlist.
    canTrust = destination !== undefined && origins.length === 1 && origins[0] === destination
  }
  return {
    kind: 'action',
    action: call.name,
    summary: summarizeAction(call, locale),
    origins,
    // Cross-origin/invalid navigation and unknown history destinations always
    // require a fresh decision; they must never expand trust implicitly.
    canTrust,
  }
}

function requestedFrame(args: Record<string, unknown>): number {
  return typeof args.frame === 'number' && Number.isInteger(args.frame) && args.frame >= 0 ? args.frame : 0
}

function uniqueOrigins(targets: TabFrame[], allFrames: TabFrame[]): string[] {
  const origins = new Set<string>()
  for (const frame of targets) {
    const origin = effectiveFrameOrigin(frame, allFrames)
    if (origin !== undefined) origins.add(origin)
  }
  return [...origins].sort()
}

function effectiveFrameOrigin(frame: TabFrame, frames: TabFrame[], visited = new Set<number>()): string | undefined {
  if (visited.has(frame.frameId)) return undefined
  visited.add(frame.frameId)
  const direct = originFromUrl(frame.url)
  if (direct !== undefined) return direct
  const parent = frames.find((candidate) => candidate.frameId === frame.parentFrameId)
  return parent === undefined ? undefined : effectiveFrameOrigin(parent, frames, visited)
}

export function originFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'blob:') return undefined
    return url.origin === 'null' ? undefined : url.origin
  } catch {
    return undefined
  }
}

function summarizeAction(call: ToolCall, locale: UiLocale): string {
  const frame = typeof call.args.frame === 'number' && call.args.frame !== 0
    ? localized(locale, `, iframe ${call.args.frame}`, `，iframe ${call.args.frame}`)
    : ''
  const index = typeof call.args.index === 'number' ? call.args.index : '?'
  switch (call.name) {
    case 'browser_click': return localized(locale, `Click element [${index}]${frame}`, `点击元素 [${index}]${frame}`)
    case 'browser_type': {
      const length = typeof call.args.text === 'string' ? call.args.text.length : 0
      return localized(
        locale,
        `Enter ${length} characters in element [${index}]${frame} (the text is not shown in this dialog)`,
        `向元素 [${index}] 输入 ${length} 个字符${frame}（文本内容不会显示在确认框）`,
      )
    }
    case 'browser_hover': return localized(locale, `Hover over element [${index}]${frame}`, `悬停在元素 [${index}] 上${frame}`)
    case 'browser_form_input': {
      const count = Array.isArray(call.args.fields) ? call.args.fields.length : 0
      return localized(
        locale,
        `Fill ${count} form field${count === 1 ? '' : 's'}${frame} (values are not shown in this dialog)`,
        `填写 ${count} 个表单字段${frame}（内容不会显示在确认框）`,
      )
    }
    case 'browser_drag': return localized(locale, `Drag element [${index}] to another element or position${frame}`, `拖动元素 [${index}] 到另一个元素或位置${frame}`)
    case 'browser_upload': {
      const count = Array.isArray(call.args.paths) ? call.args.paths.length : 0
      return localized(locale, `Upload ${count} file${count === 1 ? '' : 's'} into element [${index}]${frame}`, `向元素 [${index}] 上传 ${count} 个文件${frame}`)
    }
    case 'browser_handle_dialog': return localized(
      locale,
      `${call.args.action === 'accept' ? 'Accept' : 'Dismiss'} the page's next confirm/prompt dialog`,
      `${call.args.action === 'accept' ? '接受' : '取消'}页面下一次弹出的确认/输入框`,
    )
    case 'browser_evaluate': return localized(locale, 'Run JavaScript in the page', '在页面中执行 JavaScript')
    case 'browser_press': return localized(
      locale,
      `Press “${safeInline(typeof call.args.key === 'string' ? call.args.key : '')}”${frame}`,
      `发送按键「${safeInline(typeof call.args.key === 'string' ? call.args.key : '')}」${frame}`,
    )
    case 'browser_navigate': return localized(
      locale,
      `Navigate to ${displayUrl(typeof call.args.url === 'string' ? call.args.url : '', locale)}`,
      `导航到 ${displayUrl(typeof call.args.url === 'string' ? call.args.url : '', locale)}`,
    )
    case 'browser_open_tab': {
      const destination = displayUrl(typeof call.args.url === 'string' ? call.args.url : '', locale)
      return call.args.active === false
        ? localized(
          locale,
          `Open a background tab at ${destination}`,
          `在后台新标签页打开 ${destination}`,
        )
        : localized(
          locale,
          `Open a new tab at ${destination}`,
          `在新标签页打开 ${destination}`,
        )
    }
    case 'browser_back': return localized(locale, 'Go back in browser history (destination domain unknown)', '返回浏览历史上一页（目标域名未知）')
    case 'browser_forward': return localized(locale, 'Go forward in browser history (destination domain unknown)', '前进到浏览历史下一页（目标域名未知）')
    case 'browser_reload': return localized(locale, 'Reload the current page', '重新加载当前页面')
    default: return call.name
  }
}

function displayUrl(value: string, locale: UiLocale): string {
  try {
    const url = new URL(value)
    return safeInline(`${url.origin}${url.pathname}`, 160)
  } catch {
    return localized(locale, '(invalid URL)', '(无效 URL)')
  }
}

function localized(locale: UiLocale, english: string, chinese: string): string {
  return locale === 'zh' ? chinese : english
}

function safeInline(value: string, maxLength = 40): string {
  const inline = value.replace(/\s+/g, ' ').trim()
  return inline.length <= maxLength ? inline : `${inline.slice(0, maxLength - 1)}…`
}
