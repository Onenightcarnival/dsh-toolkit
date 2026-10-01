# dsh 浏览器操作

[English](browser.md) | **中文**

<img width="1701" height="897" alt="dsh 浏览器操作" src="https://github.com/user-attachments/assets/3b1f3a25-f962-4e02-a9ef-d23e0d01fc8e" />

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 连接到你正在使用的 Chrome 或 Firefox 标签页。模型可以读取页面内容、操作控件、导航和管理标签页，同时保留登录态、会话和 Cookie。侧边栏提供对话界面。

## 组件

| 组件 | 职责 |
|---|---|
| `@onenightcarnival/dsh-bridge-browser` | 宿主 RPC、浏览器工具与桥地址发现 |
| Chrome / Firefox MV3 扩展 | 标签页操作、页面读取与侧边栏对话 |
| dsh `0.2.0-rc.2` | 工作区锁定的最低支持运行时 |

浏览器模块源自 [Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser)。发布产物包含桥插件 `.tgz` 与 Chrome 扩展 zip，支持 [DeepSeek Harness Desktop](https://github.com/Onenightcarnival/deepseek-harness-desktop) 的随机宿主端口发现。

## 安装

[Release](https://github.com/Onenightcarnival/dsh-toolkit/releases) 中的浏览器组件：

| 文件 | 内容 |
|---|---|
| `onenightcarnival-dsh-bridge-browser-<版本>.tgz` | 装进 dsh `web` profile 的桥插件 |
| `dsh-browser-extension-chrome-<版本>.zip` | 构建好的 Chrome 扩展，以解压目录加载 |

1. **桥插件**
   - DeepSeek Harness Desktop：「插件 → 配置中心… → 插件 → 从 .tgz 安装」，选中 `.tgz`，按提示重启。
   - dsh 命令行：`npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add file:<.tgz 路径>`，然后启动（或重启）`dsh web`。
2. **Chrome 扩展**：把 zip 解压到一个不会删的目录，打开 `chrome://extensions`，开启「开发者模式」，「加载已解压的扩展程序」选中该目录。
3. 打开任意 `http(s)` 页面，点击 DeepSeek 鲸鱼图标。侧边栏显示**已连接**。

**更新**：用同样方式安装新的 `.tgz`，用新 zip 的内容替换扩展目录，在 `chrome://extensions` 的扩展卡片上点**重新加载**，再重启 dsh。侧边栏的「软件更新」卡片会把已安装版本和仓库版本比较，并链接到 Releases。

Firefox 没有打包产物，见 [Firefox 源码构建](#firefox-源码构建)。

> [!IMPORTANT]
> npm 上未加 scope 的 [`dsh-browser`](https://www.npmjs.com/package/dsh-browser) 包属于另一个项目，与本仓库无关。请只从 Releases 安装。

## 在 DeepSeek Harness Desktop 中使用

桌面版 dsh 使用随机端口。发现信标监听 `127.0.0.1:43189`，端口占用时依次尝试至 `43192`；仅响应 `/ext/bridge-config`，返回宿主桥地址。扩展自动探测该端口范围。`discoveryPort: 0` 关闭信标。

两个文件的安装方法见[安装](#安装)。

### 兼容性

桥插件钉在 dsh 0.2.0-rc.2，即桌面版当前内置版本。桌面版升级到新的 dsh 版本线后，桥插件需要重新适配并重新安装。

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

Playwright / 扩展的配对耗时比为 **1.24**（95% CI **1.16–1.34**）：Playwright 耗时约多 24%；等价地说，dsh 浏览器操作将延迟降低约 20%，每个任务平均节省 1.35 秒。评测使用 6 个浏览器任务、5 个确定性 seed、相同的 DSH profile 与模型（`deepseek-v4-flash`），并通过独立页面状态验证结果。详见[评测方法与复现说明](../benchmark/README.md)。

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
scripts/package.mjs
scripts/version.mjs
```

## 页面接口

| 接口 | 数据与边界 |
|---|---|
| 结构化快照 | 标题、URL、正文、编号控件、表单字段；支持开放 shadow DOM 与可访问 iframe |
| 元素寻址 | 编号跨快照稳定；delta 模式返回变化 |
| 截图 | 视口 PNG，标注编号与快照一致；模型需支持图片输入 |
| 划选引用 | 侧栏打开且允许共享时捕获，随消息发送，发送前保留在扩展内 |
| 文本隐私 | 密码与支付卡值显示为 `••••`；截图限制见[安全](#安全) |
| 图片附件 | 宿主声明图片能力后接受 PNG、JPEG、WebP 与 GIF |
| 标签页 | 工具绑定用户控制的标签页，保留登录态、会话和 Cookie |

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

桥地址自动探测。Firefox 需要在扩展设置中填写 `~/.dsh/ext-bridge-token` 的 bearer token；dsh 启动日志报告该文件路径。签名发布可使用同一份 `dist-firefox/` 产物。

### 启动与使用

使用源码 checkout 时，请在仓库根目录运行 `pnpm start`。受支持的精确公开版本为：

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 web
```

Chrome 本机使用无需配置；Firefox 需要填写上述本地桥 token。打开页面，点击 DeepSeek 鲸鱼图标，等待侧边栏显示**已连接**。已有 HTTP(S) 标签页会在第一次操作时自动加载。在浏览器受保护页面和扩展商店中，模型可以读取标签页元数据，并通过浏览器级能力导航到 HTTP(S)、后退、前进和刷新，但不能读取或操作受保护页面的 DOM。

## 故障排查

**读取含 emoji 的页面后报 400，继续追问也失败**

更新扩展和桥接插件，然后新建会话。文本提取保留完整 Unicode 字符，将孤立代理项替换为 `�`；更新不改写已有历史。

**侧边栏一直显示「未连接」**

- 确认本机 dsh web 正在运行（默认 `http://127.0.0.1:3080`）。
- 确认桥接已加载：浏览器打开 `http://127.0.0.1:3080/ext/bridge-config`，应返回类似 `{"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}` 的 JSON。非 JSON 响应表示桥接端点不可用。检查插件安装与配置端口，然后重启 dsh。
- 扩展会自动探测 3080/3081/3090 端口、发现信标窗口 43189–43192，以及旧版桌面端口 14389。若 dsh 运行在其它端口且关闭了信标，或使用 `--host 0.0.0.0` 远程部署，请在面板设置中填写地址与桥接 token。Firefox 始终需要 token。

## 开发

开发与发版流程见[仓库 README](../README.zh.md)。

## 安全

### 桥接访问

认证、特权方法与 token 轮换见[桥接认证](../packages/browser-bridge/README.zh.md#桥接认证)。

### 页面数据

| 数据 | 边界 |
|---|---|
| 页面文本 | 以带随机 nonce 的不可信内容标记传给所选模型；页面指令不具有授权效力 |
| 敏感字段 | 文本管线不读取密码和卡号值；可访问名称不使用这些字段的当前值 |
| 截图 | 遵循页面读取审批；共享关闭时禁止；图片无法遮蔽密码字段，在敏感页面关闭或拒绝截图 |
| 截图存储 | 经宿主持久附件服务保存，以图片块传给模型；设置中的「允许截图」控制该工具 |
| 划选引用 | 仅在侧栏打开且页面共享开启时捕获；发送前保留在扩展内，移除、跳转或关页时丢弃 |
| 引用来源 | 标题、URL 与选中文本均位于不可信内容边界内 |
| 上传文件 | 仅读取会话工作目录内的文件 |

### 读取与操作审批

| 模式或动作 | 行为 |
|---|---|
| 页面共享 auto（默认） | 自动读取受控标签页 |
| 页面共享 ask | 每次读取确认；可允许一次或切换为 auto，设置中可恢复 |
| 页面共享 off | 禁止读取 |
| 修改页面与导航 | 默认须批准；显示准确来源与已遮蔽输入内容的动作摘要 |
| 临时信任 | 仅当前侧栏会话有效；最后一个面板关闭或 service worker 重启时清除 |
| 永久信任 | 在设置中管理 |
| 跨域导航、未知历史目标 | 重新请求确认 |
| 面板关闭 | 审批最多等待 60 秒；启用通知时，系统通知可打开面板 |
| 会话审批 | 显示前恢复发起请求的会话 |
| 调用取消或桥超时 | 撤销待处理审批，操作不执行 |

### 完全控制

- 「允许模型完全控制浏览器」保存成功后生效；页面读取、操作和标签页列出、跟随、关闭无需确认。
- 调用在接收时固定访问模式；开启设置不提升已有受限调用的权限。
- 关闭设置立即限制访问，取消尚未下发的调用；已下发操作结束后保存限制设置。
- 撤销完成前重新开启仍保持受限；并发保存按请求顺序落盘。
- 受保护页面的 DOM 始终不可访问。

### 标签页绑定

- 发送消息或首次直接调用浏览器工具时绑定活动标签页；绑定属于整个扩展连接。
- 用户切换标签页或窗口后暂停后续操作；选择留在原页可后台操作，选择跟随则重置页面引用。
- 扩展不自动切换用户可见标签页；受控页关闭后须选择当前页才能继续。
- 切换标签页撤销已打开的动作审批。

### 页面钩子与可信输入

- 首次页面操作安装主世界钩子，自动应答 alert/confirm/prompt，记录控制台输出与 fetch/XHR 的 URL、方法、状态码和耗时；不记录请求体。纯读取不安装钩子。
- browser_console、browser_network 和 browser_evaluate 仅在完全控制开启时可用，结果标记为不可信页面内容。
- 可信输入默认关闭；开启后，Chrome debugger API 发送点击、按键、悬停和拖拽，支持 Tab 焦点移动及 canvas 输入。
- 调试器附着期间 Chrome 显示调试提示条；截图接口拒绝捕获时可回退到调试器。关闭可信输入后立即分离所有标签页。

### 扩展权限

| 权限 | 用途 |
|---|---|
| sidePanel / sidebar_action | Chrome 侧面板 / Firefox 侧栏 |
| storage | 设置与最近会话 |
| notifications | 面板关闭时的可选审批通知 |
| tabs、activeTab、scripting | 观察标签页变化并向受控页注入脚本或发送消息 |
| webNavigation | 枚举 frame 并绑定 frame 文档 |
| alarms | 后台保活 |
| `<all_urls>` | 内容脚本与 captureVisibleTab |
| debugger（Chrome） | 可信输入与截图回退；清单必选权限 |

Firefox AMO 清单声明向已配置的 dsh / 模型服务发送浏览活动、网站内容与活动、个人通信数据。

## 连接与限制

- 安装或重载扩展后，首次打开侧栏才探测端口和建立连接。
- 关闭侧栏后，已有健康连接可接收后台审批；连接中断或被替换后，须打开侧栏才重连。
- 同时仅一个扩展连接；被替换客户端停止自动重连。
- 重开侧栏默认恢复最近活动会话；其次选择最近非空持久会话，再创建新会话；可在设置中关闭恢复。
- 元素编号跨快照保持稳定；重新编号时明确提示。跨域 iframe 使用稳定的 (frame, index) 地址；受限或短暂 frame 单独报告不可用。
- 缺少可访问名称的控件在文本快照中标记；截图定位需要模型图片输入，验证码需要用户操作。
- 合成按键不触发 Tab 焦点移动等浏览器原生行为；可信输入支持原生行为。
- browser_wait 使用加载状态和固定静默窗口；持续变化的 SPA 也可能被报告为稳定。
