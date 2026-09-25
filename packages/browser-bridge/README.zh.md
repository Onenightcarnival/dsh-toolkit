# @onenightcarnival/dsh-bridge-browser

[English](README.md) | 中文

dsh 的**浏览器操作桥**：在宿主 webserver 上挂载一个 **token 认证的 WebSocket 通道**（`/ext/bridge`），供 Chrome 扩展连接；把扩展调用投影到 dsh 0.1.7 Typert Remotes、按连接跟随 Session 与 Remote Event 流，并注册 `browser_*` 工具集（结构化文本为主，`browser_screenshot` 返回标注截图）——经扩展在真实浏览器中读取页面、点击元素、填写表单、滚动与导航，登录态保留。侧边栏是对话入口，工具才是产品本体。

**纯文本浏览器工具，多模态对话透传**：页面快照仍是结构化文本（标题、正文、带编号的交互清单、敏感值打码的表单字段），所有浏览器动作按稳定编号寻址。通用 RPC 通道也会透传 dsh 0.1.7 的图片消息和持久附件读取；延迟创建的新会话只在宿主确实挂载附件服务时声明图片限制。

## 配置

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `token` | `string` | 自动生成 | 固定 bearer token。缺省时首次启动生成，写入 `~/.dsh/ext-bridge-token`（0600）并打印在启动日志。 |
| `toolTimeoutMs` | `number` | 90000 | 单次工具调用预算，为扩展的 60 秒审批窗口预留时间。 |
| `snapshotMaxChars` | `number` | 200000 | 单次快照渲染字符上限，最小为 500（经 `hello.ok` caps 协商给扩展）。 |
| `maxInteractiveItems` | `number` | 400 | 单次快照交互清单条数上限。 |
| `sessionWorkspacePath` | `string` | `~/.dsh/browser-sessions` | 扩展创建的会话所用的专用 Host Workspace。插件会在首次调用未显式指定工作区的 `session.create` 时创建并幂等注册该目录；会话的 cwd 随之变为此路径，因此 GUI 会显示 `browser-sessions` 工作区分组。设为 `""` 可让会话继续显示在“未分组”中。 |
| `deferSessionCreate` | `boolean` | `true` | 会话只在第一条消息时才真正创建：`session.create` 先返回一个内存暂定 ID（不落库），历史读取为空，第一次 `session.prompt` 才创建真实会话（同一 ID、回放原始创建参数）。只打开面板不说话，会在会话库/GUI 里不留任何痕迹。 |
| `discoveryPort` | `number` | 43189 | 发现信标：只回 `/ext/bridge-config` 的回环监听，返回本实例的桥地址，供随机端口启动的宿主（DeepSeek Harness Desktop）使用。端口被占时顺延后三个端口；`0` 关闭。 |

工作区分组采用尽力而为方式。如果组合没有 workspace 域、目录创建失败，或 `workspace.create` 拒绝该路径，插件会记录一条警告，并在不注入工作区的情况下发送所有会话创建请求，因此浏览器聊天仍可使用。

## 使用

把 Release 的 `.tgz` 装进 dsh `web` profile：

- DeepSeek Harness Desktop：「插件 → 配置中心… → 插件 → 从 .tgz 安装」，然后重启应用。
- dsh 命令行：`npx @deepseek-ai/dsh@0.1.7-rc.2 plugin --profile web add file:<.tgz 路径>`，然后 `npx @deepseek-ai/dsh@0.1.7-rc.2 web`。

两种方式都会注册本包的 `dsh.bundle` 层（[`cordis.patch.yml`](cordis.patch.yml)），`dsh web` 无需额外参数即可挂载桥。源码 checkout 在仓库根目录运行 `pnpm run package` 可得到同一份 `.tgz`。

当前工作区固定使用 dsh 0.1.7-rc.2，也是最低支持版本；不再支持旧版 DSH。

扩展另从 Release 的 zip 安装（见[根 README](../../README.zh.md#安装)）。扩展会自动发现回环连接，无需输入 token；非回环部署仍需要配置的 bearer token。

## 安全模型

- 桥路径在 `/api` 信任栅栏**之外**（栅栏只罩 client-connection 注册的路由），因此自带 bearer token 认证：首帧必须是 `hello`（5 秒内），常量时间比对，失败即断开。
- `/api` 载体钉在回环上的方法（`settings.*`、`credentials.*`、`host.pickDirectory`、`host.openPath`）对非回环来源**即使 token 正确也拒绝**——对 `--host 0.0.0.0` 部署的纵深防御。
- 同一时刻仅一个活动连接，新认证连接顶替旧连接。
- 桥是 confused-deputy 边界而非通用认证层：不要把 `dsh web --host 0.0.0.0` 暴露在不信任的网络上。
- 抽取的页面文字会标记为模型的不可信输入。页面读取遵循扩展的询问/自动/关闭策略；状态变更工具必须经过按 origin 的侧边栏决策，没有侧边栏时失败关闭。同源后续操作可只在当前侧栏会话中临时信任，永久信任仍需显式设置。

## 线协议

帧为按 `t` 判别的 JSON 对象，定义在 [`protocol.ts`](src/protocol.ts)，是通过 workspace 包的 `./src/*` export 与扩展共享的真源。构建后的包还会发布 `@onenightcarnival/dsh-bridge-browser/protocol`，供外部消费方使用。

- 客户端 → 服务端：`hello`（认证+caps）、`rpc`（网关方法透传）、`respond`（按 RPC id 结算宿主交互）、`tool.result`、`pong`。
- 服务端 → 客户端：`hello.ok`（回显协商后的 caps）、`rpc.result`、`respond.result`（相关联的受理结果或错误）、`event`（由 dsh Remote 流与 waterfall 投影而来的 bridge 内部事件）、`tool.call`、`ping`、`error`。

每个 `respond` 同时携带全局唯一的传输 id 与宿主交互的 `rpcId`。扩展只把回执路由给发起操作的面板，并在超时、面板关闭或桥断线时拒绝尚未完成的响应。

## 工具

| 工具 | 用途 |
|---|---|
| `browser_snapshot` / `browser_find` / `browser_get_text` | 结构化文本快照（`delta: true` 只返回变化）；按文本/角色/选择器查找；整页或局部转为 Markdown。 |
| `browser_screenshot` | 带编号标注的视口 PNG，以图片块返回（模型路由需接受图片输入）。 |
| `browser_click` / `browser_type` / `browser_form_input` / `browser_press` / `browser_hover` / `browser_drag` / `browser_upload` | 按稳定编号或视口坐标操作清单元素；上传只读取会话工作目录内的文件。 |
| `browser_scroll` / `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | 页面移动。 |
| `browser_list_tabs` / `browser_follow_tab` / `browser_close_tab` | 标签页管理。 |
| `browser_wait` / `browser_wait_for` / `browser_batch` / `browser_handle_dialog` | 稳定检测、条件等待、单次往返最多 25 步、弹窗应答。 |
| `browser_console` / `browser_network` / `browser_evaluate` | 控制台/网络捕获与 JavaScript 求值；用户未开启完全控制时扩展一律拒绝。 |

## 模型体验

- **Token 影响**：一次 `browser_snapshot`（默认预算 200k 字符、400 项，常见页面远小于此）对常见英文页面约为 8–10k token，具体取决于语言和分词器；delta 快照只需零头。系统提示段落引导模型按需快照而非囤积页面文本。
- **KV 缓存影响**：无（快照不做服务端缓存）。
- **延迟**：每次动作等待扩展在真实页面执行 + 稳定检测（通常 0.2–2s；导航最长 5s）。
- **失败模式**：`bridge-closed`（扩展未连接）、`timeout`、`no-active-tab`、`content-unavailable`（页面需刷新）、`action-failed`（编号过期——模型应重新快照）。

## 扩展点

- 工具集是消费面；seam 是桥接线（`protocol.ts`）。在 `ctx.tools` 注册新工具并经由桥分发即可，扩展的 content script 按动作名分发。
- 协商 caps（`hello.ok`）让插件无需共享配置文件即可向扩展下达快照预算。

## 已知限制与后续工作

- 仅一个活动扩展连接（第二个窗口顶替第一个）。
- 可访问的跨源 iframe 会进入快照，并通过稳定的 `(frame, index)` 地址执行操作；受保护或已销毁的 frame 会标记为不可访问，不影响整页快照。
- token 手动轮换（改 `~/.dsh/ext-bridge-token` 或配置 `token`），无过期。
- Playwright 驱动的扩展 e2e 会在缺少可用的 Chromium 可执行文件或构建完成的扩展包时自行跳过。
- 审批由扩展 service worker 强制执行，而不是依赖模型自觉。未来接入 dsh 工具管线时可以把同一策略暴露给其它客户端。
