# dsh 浏览器操作

[English](browser.md) | **中文**

<img width="1701" height="897" alt="dsh 浏览器操作" src="https://github.com/user-attachments/assets/3b1f3a25-f962-4e02-a9ef-d23e0d01fc8e" />

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 连接到你正在使用的 Chrome 或 Firefox 标签页。模型可以读取页面内容、操作控件、导航和管理标签页，同时保留登录态、会话和 Cookie。侧边栏提供对话界面。

`dsh` 是由 DeepSeek AI 开发的开源、插件化 agent harness（智能体框架）。本仓库将配套的浏览器桥插件与 Chrome/Firefox MV3 扩展组成一个独立的 pnpm workspace。

本仓库是 [Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser) 的分支，面向 [DeepSeek Harness Desktop](https://github.com/Onenightcarnival/deepseek-harness-desktop) 桌面版。与上游的差异：

- 桥插件以 `@onenightcarnival/dsh-bridge-browser` 发布；
- 固定端口的发现信标，让扩展找到以随机端口启动 dsh 的桌面版；
- 发布页提供桌面版插件管理器可直接安装的 `.tgz` 与 Chrome 扩展 zip。

安装方法见[安装](#安装)，桌面版相关说明见[在 DeepSeek Harness Desktop 中使用](#在-deepseek-harness-desktop-中使用)。

浏览器操作以结构化文本为主、截图为辅：页面会转换为带编号的交互元素清单（穿透开放 shadow DOM 与 iframe，含 select 选项与状态），模型通过编号定位元素；`browser_screenshot` 可截取可见区域并把编号标注在图上，供多模态模型按图选点。工具集按 Claude in Chrome 的形态设计：读页面（快照或 Markdown）、找元素、截图、点击/输入/悬停/拖拽/批量填表、上传文件、处理弹窗、条件等待、批量步骤、标签页管理，以及在完全控制模式下的控制台、网络与 JavaScript 求值。宿主声明图片能力时，侧栏也可发送 PNG、JPEG、WebP 和 GIF。

> [!IMPORTANT]
> 当前工作区固定使用 dsh 0.1.5-rc.2，也是最低支持版本；不再支持旧版 DSH。

## 安装

每个 [Release](https://github.com/Onenightcarnival/dsh-toolkit/releases) 附带两个文件：

| 文件 | 内容 |
|---|---|
| `onenightcarnival-dsh-bridge-browser-<版本>.tgz` | 装进 dsh `web` profile 的桥插件 |
| `dsh-browser-extension-chrome-<版本>.zip` | 构建好的 Chrome 扩展，以解压目录加载 |

1. **桥插件**
   - DeepSeek Harness Desktop：「插件 → 配置中心… → 插件 → 从 .tgz 安装」，选中 `.tgz`，按提示重启。
   - dsh 命令行：`npx @deepseek-ai/dsh@0.1.5-rc.2 plugin --profile web add file:<.tgz 路径>`，然后启动（或重启）`dsh web`。
2. **Chrome 扩展**：把 zip 解压到一个不会删的目录，打开 `chrome://extensions`，开启「开发者模式」，「加载已解压的扩展程序」选中该目录。
3. 打开任意 `http(s)` 页面，点击 DeepSeek 鲸鱼图标。侧边栏显示**已连接**。

**更新**：用同样方式安装新的 `.tgz`，用新 zip 的内容替换扩展目录，在 `chrome://extensions` 的扩展卡片上点**重新加载**，再重启 dsh。侧边栏的「软件更新」卡片会把已安装版本和仓库版本比较，并链接到 Releases。

Firefox 没有打包产物，见 [Firefox 源码构建](#firefox-源码构建)。

> [!IMPORTANT]
> npm 上未加 scope 的 [`dsh-browser`](https://www.npmjs.com/package/dsh-browser) 包属于另一个项目，与本仓库无关。请只从 Releases 安装。

## 在 DeepSeek Harness Desktop 中使用

桌面版以随机端口启动 dsh。桥插件因此运行一个发现信标：监听 `127.0.0.1:43189`（被占时顺延到 43192）的回环端口，只回 `/ext/bridge-config`，返回真实的桥地址。扩展探测这个端口窗口，桌面版无需改动。`discoveryPort: 0` 关闭信标。

两个文件的安装方法见[安装](#安装)。

### 兼容性

桥插件钉在 dsh 0.1.5-rc.2，即桌面版当前内置版本。桌面版升级到新的 dsh 版本线后，桥插件需要重新适配并重新安装。

### 排查

桌面版运行时，`http://127.0.0.1:43189/ext/bridge-config` 返回 `{"wsUrl":"ws://127.0.0.1:<端口>/ext/bridge"}`。

- 没有响应：桥插件没装进 web profile（插件管理器里应有 `@onenightcarnival/dsh-bridge-browser`），或桌面版没有重启。
- 43189 被别的程序占用：桌面版日志里 `discovery beacon listening on` 一行给出实际端口；也可以在扩展设置里手动填写桥地址。

## 性能基准

在 2026 年 8 月 18 日完成的 60 次配对端到端评测中，两个后端分配到的 30 次运行均全部成功；dsh 浏览器操作使用了更少的模型/工具轮次，并以更短时间完成任务：

| 后端 | 成功率 | 平均端到端耗时 | 平均浏览器工具调用 |
|---|---:|---:|---:|
| **dsh 浏览器操作** | **30/30** | **5.32 秒** | **3.4** |
| 对齐工具契约的 Playwright 基线 | 30/30 | 6.67 秒 | 4.7 |

Playwright / 扩展的配对耗时比为 **1.24**（95% CI **1.16–1.34**）：Playwright 耗时约多 24%；等价地说，dsh 浏览器操作将延迟降低约 20%，每个任务平均节省 1.35 秒。评测使用 6 个浏览器任务、5 个确定性 seed、相同的 DSH profile 与模型（`deepseek-v4-flash`），并通过独立页面状态验证结果。详见[评测方法与复现说明](benchmark/README.md)。

## 核心能力

| 能力 | 工具 | 说明 |
|---|---|---|
| 读取页面 | `browser_snapshot` | 结构化文本快照：标题/URL/正文/编号交互清单（含 shadow DOM、select 选项、展开/选中状态、坐标）/表单字段（敏感值掩码）；`region` 聚焦、`delta: true` 只返回变化；默认预算 200k 字符、400 项 |
| 截图 | `browser_screenshot` | 可见区域 PNG，默认把交互元素编号标注在图上；经 dsh 附件服务作为图片块返回，模型路由需声明图片输入 |
| 查找元素 | `browser_find` | 按文本/角色/选择器查找（穿透 shadow DOM），返回编号与中心坐标 |
| 点击元素 | `browser_click` | 按编号或视口坐标 (x, y) 点击，支持双击与右键 |
| 填写表单 | `browser_type` / `browser_form_input` | 单字段输入（React/Vue 受控组件兼容），或一次设置多个字段：文本、select（按标签/值）、多选、复选框/单选、contenteditable |
| 悬停 | `browser_hover` | 悬停某元素以展开菜单、提示或隐藏控件 |
| 按键 | `browser_press` | 键盘事件（Enter/Tab/Escape/方向键…），支持 `Ctrl+A`、`Shift+Tab` 等组合键 |
| 滚动 | `browser_scroll` | 视口滚动（up/down/top/bottom），或按编号把元素滚到可见 |
| 页面导航 | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | 受控标签页内导航，或新开标签页并跟随（`active:false` 时保持当前页在前台） |
| 列出标签页 | `browser_list_tabs` | 列出可访问标签页的稳定 ID、标题、URL、窗口/顺序以及活动/受控状态 |
| 跟随标签页 | `browser_follow_tab` | 将后续浏览器工具绑定到 `browser_list_tabs` 返回的标签页，而不激活该标签页 |
| 关闭标签页 | `browser_close_tab` | 关闭 `browser_list_tabs` 返回的标签页 |
| 读取区域 | `browser_get_text` | 整页或局部转为 Markdown（保留标题、列表、表格、链接；`format: "plain"` 返回纯文本） |
| 等待稳定 | `browser_wait` / `browser_wait_for` | 页面稳定检测；或等待文本/选择器/URL 出现或消失，带超时 |
| 批量步骤 | `browser_batch` | 一次往返最多执行 25 个工具步骤（输入 → 回车 → 等待…），遇到首个失败即停止；每一步仍按各自的审批规则处理 |
| 拖拽 | `browser_drag` | 把元素（按编号或坐标）拖到另一个元素或位置：派发 pointer、mouse 与 HTML5 drag 事件 |
| 上传文件 | `browser_upload` | 把会话工作目录里的文件附加到文件输入框（或包裹它的上传按钮）；目录之外的文件一律拒绝，单文件 20 MB、单次 50 MB |
| 页面弹窗 | `browser_handle_dialog` | alert/confirm/prompt 会被自动应答（默认取消）并报告；可在触发前指定接受/取消与 prompt 文本 |
| 控制台 / 网络 | `browser_console` / `browser_network` | 读取自首次操作以来捕获的控制台输出、未捕获异常与 fetch/XHR 请求；需要开启**允许模型完全控制浏览器** |
| 执行 JavaScript | `browser_evaluate` | 在页面中求值表达式并返回 JSON 结果；需要开启**允许模型完全控制浏览器** |
| 发送图片 | `session.prompt` / `session.attachment` | 按宿主能力启用图片草稿、纯图片消息和持久历史预览 |
| 引用选中内容 | 侧栏输入框 | 在页面里划选的文字会出现在输入框，随下一条消息一起发送，并带上来源与不可信内容边界 |
| 选择模型 | 输入框旁的模型按钮 | 列出 dsh 里已配置的提供方与模型（`session.modelCatalog`），为当前会话切换模型和推理强度（`session.selectModel`）；未配置凭据的提供方灰显。切换后 dsh 同时把它记为新会话的默认模型 |
| 删除会话 | 会话列表 | 未被占用的会话立即清除文件；当前 dsh 进程仍持有的会话先归档并从列表消失，文件在下次启动 dsh 时清除 |

## 组成

```
packages/browser-bridge/
  cordis.patch.yml
extensions/dsh-browser/
scripts/package-desktop.mjs
scripts/version.mjs
```

## 为什么这样设计

- **使用你的真实浏览器，而不是无头副本**：模型操作你已经打开的页面，登录态、会话和 Cookie 均会保留。
- **文本优先、截图补充的页面接口**：编号控件、跨快照稳定 ID、delta 更新和敏感值掩码让模型在多数页面上不看图也能操作；图表、画布、复杂布局再用带编号标注的截图，图上的编号就是快照里的编号。
- **用「指」代替「描述」**：直接划选你要问的那段文字，侧栏会把它引用下来，说「解释这个」不必再描述整页内容。只有侧栏打开时才会捕获，并且在你发送消息之前不会离开浏览器。
- **收窄隐私边界**：密码和支付卡字段始终显示为 `••••`，字段值不会离开页面。
- **受保护的桥连接**：远程连接使用认证握手，特权网关方法拒绝非回环调用方，扩展把工具绑定到一个由用户控制的标签页。

## 从源码构建

前置要求：Node.js `^22.19` 或 `>=24`、Corepack/pnpm，以及 Chrome 116+ 或 Firefox 140+。

### Chrome 构建

```sh
git clone https://github.com/Onenightcarnival/dsh-toolkit.git
cd dsh-toolkit
pnpm install && pnpm run build && pnpm run package
```

`dist/` 里就是 Release 附带的同一份 `.tgz` 和 zip，按[安装](#安装)一节安装即可。只跑 `pnpm run build` 时，可加载的扩展在 `extensions/dsh-browser/dist/`。

### Firefox 源码构建

Firefox 使用独立的 MV3 manifest、事件页后台和 Sidebar。在 checkout 中构建后，打开 `about:debugging#/runtime/this-firefox`，选择「临时载入附加组件」，再选取 `extensions/dsh-browser/dist-firefox/manifest.json`：

```sh
pnpm install
pnpm --filter dsh-browser-extension run build:firefox
```

桥地址仍会自动探测。Firefox 的 `moz-extension://` UUID 不能证明扩展身份，因此需要把 `~/.dsh/ext-bridge-token` 中的 bearer token 填入扩展设置（dsh 启动日志会报告该文件路径）。签名发布时可直接使用同一份 `dist-firefox/` 产物。

### 启动与使用

使用源码 checkout 时，请在仓库根目录运行 `pnpm start`。受支持的精确公开版本为：

```sh
npx @deepseek-ai/dsh@0.1.5-rc.2 web
```

Chrome 本机使用无需配置；Firefox 需要填写上述本地桥 token。打开页面，点击 DeepSeek 鲸鱼图标，等待侧边栏显示**已连接**。已有 HTTP(S) 标签页会在第一次操作时自动加载。在浏览器受保护页面和扩展商店中，模型可以读取标签页元数据，并通过浏览器级能力导航到 HTTP(S)、后退、前进和刷新，但不能读取或操作受保护页面的 DOM。

## 故障排查

**侧边栏一直显示「未连接」**

- 确认本机 dsh web 正在运行（默认 `http://127.0.0.1:3080`）。
- 确认桥接已加载：浏览器打开 `http://127.0.0.1:3080/ext/bridge-config`，应返回类似 `{"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}` 的 JSON。如果返回的是网页而不是 JSON，说明当前运行的 dsh 早于桥接注册——重启 dsh 并刷新页面即可，扩展会自动重连。
- 扩展会自动探测 3080/3081/3090 端口、发现信标窗口 43189–43192，以及旧版桌面端口 14389。若 dsh 运行在其它端口且关闭了信标，或使用 `--host 0.0.0.0` 远程部署，请在面板设置中填写地址与桥接 token。Firefox 始终需要 token。

## 开发

开发与发版流程见[仓库 README](../README.zh.md)。

## 安全

- 桥路径在 `/api` 信任栅栏之外，自带 bearer token 认证。
- Chrome 扩展的本地 Origin 保留零配置回环访问；Firefox Origin 是每次安装生成的 UUID，必须携带 bearer token。
- 特权网关方法（`settings.*`/`credentials.*`/`host.open*`）对非回环来源一律拒绝。
- 单活动连接；页面文本管线中密码和卡号值永不回传。截图与读取页面走同一道审批（页面内容共享设为「关闭」时同样禁止），但截图中的密码框无法打码，请在敏感页面上关闭或拒绝截图；截图经 dsh 持久附件服务保存后以图片块交给模型。设置中的**允许截图**可以整体关闭 `browser_screenshot`。
- **可信输入**（默认关闭）会把点击、按键、悬停和拖拽经 Chrome 调试器 API 作为真实输入事件发送，因此 Tab 能移动焦点、canvas 应用也能响应；它会申请可选的 `debugger` 权限，并在附加到标签页期间显示 Chrome 的「正在调试此浏览器」提示条。关闭后立即从所有标签页分离。
- 对页面的首次操作会安装主世界钩子：自动应答 `alert`/`confirm`/`prompt`（避免弹窗卡死标签页），并记录控制台输出与 fetch/XHR 元数据（URL、方法、状态码、耗时，绝不记录请求体）。纯读取不安装任何东西。`browser_console`、`browser_network` 和 `browser_evaluate` 在未开启**允许模型完全控制浏览器**时一律拒绝；它们返回的内容全部来自页面，都包在不可信内容边界内。
- `browser_upload` 只读取会话工作目录之下的文件——与 agent 的文件工具同一边界——绝不扩大范围。
- 助手开始工作时会绑定当时的活动标签页（提交提示时绑定；直接调用浏览器工具时则在首次调用绑定）。用户手动切页后，后续浏览器操作会暂停，侧栏会询问让助手继续原页面还是跟随新页面；选择原页面后允许在后台继续，但扩展绝不静默改绑或切换用户正在看的页面。受控标签页关闭后也会暂停，直到用户显式选择当前页。
- 只有在侧栏打开、且页面共享不是「关闭」时才会捕获划选内容，密码和卡号字段永不读取。内容在发送之前始终留在扩展内部；移除、页面跳转或标签页关闭都会丢弃它；发送时与页面快照一样包在不可信内容边界内，来源标题和 URL 同样由页面提供，因此也放在边界之内。
- 网页文字会标记为不可信输入。默认「自动共享」只按需读取受控标签页且不额外弹窗；对隐私敏感时可选择「每次询问」，或用「关闭」完全阻断读取。在「每次询问」模式下，读取弹窗可以仅允许一次，也可以持久切回自动读取；之后仍可在设置中关闭。读取的页面文字会发送给当前选择的模型。
- 点击、输入、按键、导航、历史跳转和刷新默认失败关闭，必须由用户批准。可以只在当前侧栏会话中信任单个 origin（最后一个侧栏关闭或 Service Worker 重启即清空）；永久信任需在设置中显式管理。显式跨域 `browser_navigate` 和未知目标的历史跳转始终重新询问。
- **允许模型完全控制浏览器**是显式的全局选择，只有设置保存成功后才会生效。启用后，页面读取、页面操作和标签页列出/跟随/关闭都不会再请求确认。调用在收到时固定其访问模式，因此开启完全控制不会追溯提升已经开始的受限调用。关闭会立即生效：取消尚未下发操作的调用，等待已经下发到浏览器的操作完成，再保存限制设置。快速重新开启也会在旧权限撤销完成前保持受限，并发保存会按请求顺序落盘。无论是否启用，浏览器受保护页面的 DOM 内容都无法访问。
