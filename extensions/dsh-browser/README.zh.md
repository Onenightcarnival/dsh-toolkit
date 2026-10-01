# dsh 浏览器操作扩展（Chrome 与 Firefox MV3）

[English](README.md) | 中文

dsh 的 Chrome / Firefox MV3 扩展，提供真实标签页操作与侧边栏对话，保留页面登录态。

| 通道 | 数据 |
|---|---|
| 页面快照 | 结构化文本、编号控件、敏感字段掩码 |
| 页面截图 | `browser_screenshot` 返回带编号的视口 PNG |
| 对话附件 | PNG、JPEG、WebP、GIF；由宿主声明图片能力和大小限制 |

## 使用指南

安装、工具、页面权限与限制见[浏览器操作指南](../../docs/browser.zh.md)。

## 架构

```
side panel (React) ◄─port─► background SW/事件页 ◄─WS─► dsh bridge plugin
                                 │
                  tabs.sendMessage (DSH_ACTION, DSH_SELECTION_WATCH)
                                 ▲ DSH_SELECTION
                                 ▼
                        content script (snapshot/actions/privacy/selection)
```

| 层 | 职责 |
|---|---|
| `src/background/` | 桥认证、重连与保活；RPC；受控标签页分发与审批 |
| `src/content/` | 页面快照、稳定元素编号、delta、动作执行与敏感字段掩码 |
| 划选监听 | 侧栏打开且页面共享开启时启用，防抖捕获 |
| `src/panel/` | 会话与历史、实时事件、设置、Markdown、问题卡片、标签页交接与停止操作 |
| 图片附件 | 宿主能力与大小预检；持久附件按会话权限读取 |
| 划选引用 | 可移除的引用，随下一条消息放入不可信内容边界 |
| 协议 | `@onenightcarnival/dsh-bridge-browser` 的 `protocol.ts`，两端通过源码导出共享 |

## 构建

```sh
pnpm install
pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

请在仓库根目录执行这些命令。Chrome 产物输出到 `extensions/dsh-browser/dist/`；Firefox 产物输出到 `extensions/dsh-browser/dist-firefox/`。

## 开发加载

- Chrome：在 `chrome://extensions` 加载 `extensions/dsh-browser/dist/`。
- Firefox：在 `about:debugging#/runtime/this-firefox` 加载 `extensions/dsh-browser/dist-firefox/manifest.json`。
- 修改代码后重新构建并重载扩展。
