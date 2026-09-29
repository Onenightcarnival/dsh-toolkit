# dsh 浏览器操作扩展（Chrome 与 Firefox MV3）

[English](README.md) | 中文

dsh 的 Chrome / Firefox MV3 扩展，提供真实标签页操作与侧边栏对话，保留页面登录态。

| 通道 | 数据 |
|---|---|
| 页面快照 | 结构化文本、编号控件、敏感字段掩码 |
| 页面截图 | `browser_screenshot` 返回带编号的视口 PNG |
| 对话附件 | PNG、JPEG、WebP、GIF；由宿主声明图片能力和大小限制 |

## 模型能做什么

| 能力 | 动作 | 说明 |
|---|---|---|
| 读取页面 | `browser_snapshot` | 标题/URL/正文/编号交互清单/表单字段（敏感值掩码）；`delta: true` 只返回变化，省 token |
| 点击元素 | `browser_click` | 按编号点击（链接/按钮/复选框…），React/Vue 组件兼容 |
| 填写表单 | `browser_type` | 输入文本，`replace` 清空重填 |
| 按键 | `browser_press` | Enter/Tab/Escape/方向键等 |
| 滚动 | `browser_scroll` | 视口滚动（up/down/top/bottom） |
| 导航 | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | 受控标签页内跳转，或新开标签页并跟随 |
| 列出标签页 | `browser_list_tabs` | 列出可访问标签页的稳定 ID、标题、URL 和活动/受控状态 |
| 跟随标签页 | `browser_follow_tab` | 将后续浏览器工具绑定到已列出的标签页，而不激活该标签页 |
| 关闭标签页 | `browser_close_tab` | 关闭已列出的标签页 |
| 读区域 | `browser_get_text` | 懒加载内容 / 局部文本 |
| 等待 | `browser_wait` | 页面加载与渲染稳定检测 |
| 图片对话 | `session.prompt` / `session.attachment` | 按宿主能力启用图片选择、纯图片发送和持久历史预览 |
| 引用你划选的内容 | 侧栏输入框 | 你在页面里选中的文字会变成输入框里的引用，随下一条消息一起发送 |

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

## 安装与使用

1. **安装 Release 文件**：到 [Releases](https://github.com/Onenightcarnival/dsh-toolkit/releases) 下载。桥插件 `.tgz` 装进 dsh `web` profile（DeepSeek Harness Desktop：「插件 → 配置中心… → 插件 → 从 .tgz 安装」；命令行：`npx @deepseek-ai/dsh@0.1.7-rc.2 plugin --profile web add file:<路径>`）；Chrome zip 解压后在 `chrome://extensions` 开启开发者模式并「加载已解压的扩展程序」。步骤见[根 README](../../README.zh.md#安装)。

2. **启动 dsh 并挂载桥插件**。DeepSeek Harness Desktop 启动时自动完成。源码 checkout 在仓库根目录运行 `pnpm start`，或使用受支持的精确公开版本：

   ```sh
   npx @deepseek-ai/dsh@0.1.7-rc.2 web
   ```

   两种方式都从本机 `web` profile 加载同一个 bundle。默认端口为 3080；如被占用，可追加 `--port <port>`。自动探测覆盖 3080/3081/3090、桥插件的发现信标窗口 43189–43192（随机端口的桌面版就靠它被找到）和旧版桌面端口 14389；其它地址在侧栏设置里填 `http://127.0.0.1:<端口>`。

   加载或重新加载扩展本身是被动的：只有打开侧栏后，扩展才会探测本机端口并创建 WebSocket。用户已建立的健康连接可在侧栏关闭后继续用于后台审批；但连接一旦掉线或被另一浏览器替换，没有打开侧栏时就不会重连。

3. **开始使用**：打开普通的 `http://` 或 `https://` 页面，点击 DeepSeek 鲸鱼图标打开侧边栏。两个构建都会自动探测本机 dsh。Chrome 回环连接无需地址或 Token；Firefox 的 `moz-extension://` UUID 不能证明扩展身份，必须在设置中填入 `~/.dsh/ext-bridge-token`。可以直接对话，或先点「读取页面」。

页面即使在扩展安装或重载之前已经打开，也会在第一次操作时自动补加载内容脚本，无需手动刷新。`chrome://`、Chrome Web Store 等浏览器内置或受保护页面只提供标签页元数据，以及浏览器级 HTTP(S) 导航、后退、前进和刷新；不能读取或操作其 DOM。

如果只开发扩展，Chrome 从 `chrome://extensions` 加载 `extensions/dsh-browser/dist/`；Firefox 运行 `build:firefox` 后，从 `about:debugging#/runtime/this-firefox` 加载 `extensions/dsh-browser/dist-firefox/manifest.json`。代码更新后需重新构建并重新加载。

## 页面与权限契约

- **页面快照**：页面快照包含结构化文本（标题/URL/正文/编号元素/表单），默认预算 200k 字符（插件可配，经 `hello.ok` 协商给扩展）。
- **页面文字是不可信输入**：快照和局部文本读取会放进带随机 nonce 的信任边界，并明确要求模型不得把网页中的命令当成指令。扩展负责执行操作审批。
- **稳定编号**：元素编号跨快照保持（WeakMap + `data-dsh-el`），模型可以说"点 7 号"；页面大改时显式提示"编号已重排"。
- **delta 模式**：`browser_snapshot({delta:true})` 只返回变化元素的编号。
- **隐私**：密码/卡号字段的值永远以 `••••` 呈现，绝不回传；可访问名称从不使用敏感字段的当前值。
- **标签页绑定**：提交提示时会在模型开始工作前绑定活动标签页；如果直接调用浏览器工具，也会在需要时完成首次绑定。手动切换标签页或窗口后，后续工具会暂停，并询问助手继续原页面还是跟随当前页。选择原页面后允许后台操作，但不会改变用户正在看的页面；选择跟随后会重置页面引用状态。受控页关闭后失败关闭，直到用户选择当前页；切页还会撤销尚未完成的操作审批。
- **分级审批**：默认「自动共享」允许模型按需读取受控标签页而不额外弹窗；「每次询问」可恢复逐次读取确认，「关闭」会阻断读取。在「每次询问」模式下，读取弹窗可以仅允许一次，也可以持久切回自动读取，之后仍可在设置中关闭。状态变更工具仍然失败关闭，并显示实际 origin 和脱敏动作摘要；用户可拒绝、仅允许一次，或只在当前侧栏会话中信任单个 origin。最后一个侧栏关闭或 Service Worker 重启会清空临时信任；永久信任需在设置中显式管理。侧栏关闭时，审批最多保留 60 秒；启用通知后，系统通知可把用户带回侧栏。会话级审批只会在其所属会话恢复完成后显示。调用方取消或桥接超时时，会先撤销尚未完成的审批，过期动作不会继续执行。
- **完全控制需显式开启**：**允许模型完全控制浏览器**只有设置保存成功后才会生效，启用后页面读取、页面操作以及标签页列出/跟随/关闭均无需确认。调用在收到时固定其访问模式，因此开启完全控制不会追溯提升已经开始的受限调用。关闭会立即生效：取消尚未下发操作的调用，等待已经下发到浏览器的操作完成，再保存限制设置。快速重新开启也会在旧权限撤销完成前保持受限，并发保存会按请求顺序落盘。受保护页面的 DOM 内容始终不可访问。
- **会话续接**：重新打开侧栏时默认恢复最近活跃的浏览器会话；若该会话不可用，则恢复最新的非空持久会话，最后才创建新会话。可在设置中关闭。

## 权限说明

Chrome 使用 `sidePanel`，Firefox 使用 `sidebar_action`。两者都申请 `storage`（设置与最近会话续接）、`notifications`（侧栏关闭时可选的审批提醒）、`tabs` + `activeTab` + `scripting`（观察切页，并向用户显式选择的受控标签页注入/发消息；安装前已打开的页面也会按需补注入）、`webNavigation`（枚举该标签页中的 frame，并把消息绑定到具体文档）、`alarms`（后台保活）、`<all_urls>`（内容脚本注入与 `captureVisibleTab`，后者不接受更窄的 host 模式）；Chrome 上另有 `debugger`（可信输入与截图回退；Chrome 不允许把它列为可选权限）。Firefox AMO manifest 如实声明扩展会把浏览活动、网页内容/操作和对话内容发送给用户配置的 dsh/模型服务。扩展绝不改变用户正在看的标签页，也不会静默跟随手动切页；只有用户选择继续原页面后，助手才会在后台操作。

## 已知限制

- 同时只有一个扩展连接桥。未打开侧栏的浏览器 Profile 不会抢占连接；另一个已打开的侧栏顶替连接后，被替换的一端会主动让权，不再反复重连互踢。
- 标签页绑定属于整个扩展连接，而不是单个对话会话。
- 可访问的跨源 iframe 会进入快照，并通过稳定的 `(frame, index)` 地址执行操作；受保护或已销毁的 frame 会标记为不可访问，不影响整页快照。
- 无可访问名称的控件会在文本快照中标注；截图定位需要模型支持图片输入。验证码由用户处理。
- 令牌无自动轮换。
- `browser_press` 的合成按键不触发 Tab 焦点移动等浏览器原生默认行为。Chrome「可信输入」通过 debugger API 提供原生输入行为。
- `browser_wait` 以加载完成 + 固定静默窗口为准，不观察持续 DOM 更新（连续刷新的 SPA 可能被报为稳定）。
