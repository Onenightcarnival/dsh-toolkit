# @onenightcarnival/dsh-bridge-browser

[English](README.md) | 中文

dsh 浏览器操作桥，连接宿主与 Chrome / Firefox 扩展。

| 边界 | 契约 |
|---|---|
| 传输 | `/ext/bridge` WebSocket；握手认证、单活动连接 |
| 宿主 | dsh 0.2.0 Typert Remotes、Session 与 Remote Event 流 |
| 工具 | `browser_*` 读取和操作受控标签页，保留登录态 |
| 页面 | 结构化文本、稳定编号与带编号截图 |
| 附件 | 图片消息与持久附件读取；图片限制由宿主附件服务声明 |

## 配置

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `token` | `string` | 自动生成 | 固定 bearer token。缺省时首次启动生成，写入 `~/.dsh/ext-bridge-token`（0600）；启动日志报告文件路径。 |
| `toolTimeoutMs` | `number` | 90000 | 单次工具调用超时。 |
| `snapshotMaxChars` | `number` | 200000 | 单次快照渲染字符上限，最小为 500（经 `hello.ok` caps 协商给扩展）。 |
| `maxInteractiveItems` | `number` | 400 | 单次快照交互清单条数上限。 |
| `sessionWorkspacePath` | `string` | `~/.dsh/browser-sessions` | 扩展创建的会话所用的专用 Host Workspace。插件会在首次调用未显式指定工作区的 `session.create` 时创建并幂等注册该目录；会话的 cwd 随之变为此路径，GUI 显示 `browser-sessions` 工作区分组。设为 `""` 可让会话继续显示在“未分组”中。 |
| `deferSessionCreate` | `boolean` | `true` | 会话只在第一条消息时才真正创建：`session.create` 先返回一个内存暂定 ID（不落库），历史读取为空，第一次 `session.prompt` 才创建真实会话（同一 ID、回放原始创建参数）。仅打开面板不会持久化会话。 |
| `discoveryPort` | `number` | 43189 | 发现信标：只回 `/ext/bridge-config` 的回环监听，返回本实例的桥地址，供随机端口启动的宿主（DeepSeek Harness Desktop）使用。端口被占时顺延后三个端口；`0` 关闭。 |

组合没有 workspace 域、目录创建失败，或 `workspace.create` 拒绝该路径时，插件记录一条警告并以无工作区方式创建会话；浏览器聊天仍可使用。

## 使用与权限

安装、工具能力和页面权限见[浏览器操作指南](../../docs/browser.zh.md)。运行时版本见[兼容性表](../../README.zh.md#运行时兼容性)。

安装后由 [cordis.patch.yml](cordis.patch.yml) 注册 dsh.bundle 层，dsh web 自动挂载桥接插件。

### 桥接认证

- WebSocket 首帧必须在 5 秒内发送 hello，token 使用常量时间比较，认证失败时关闭连接。
- 回环 Chrome 扩展来源可免 token；Firefox 和非回环连接必须提供 token。
- settings.*、credentials.*、host.pickDirectory 和 host.openPath 拒绝非回环连接，即使 token 有效。
- 新的已认证连接替换旧连接。
- token 无过期时间；轮换时修改 ~/.dsh/ext-bridge-token 或配置中的 token。
- 桥接服务仅部署在可信网络。

## 线协议

帧为按 `t` 判别的 JSON 对象，定义在 [`protocol.ts`](src/protocol.ts)，是通过 workspace 包的 `./src/*` export 与扩展共享的真源。构建后的包还会发布 `@onenightcarnival/dsh-bridge-browser/protocol`，供外部消费方使用。

- 客户端 → 服务端：`hello`（认证+caps）、`rpc`（网关方法透传）、`respond`（按 RPC id 结算宿主交互）、`tool.result`、`pong`。
- 服务端 → 客户端：`hello.ok`（回显协商后的 caps）、`rpc.result`、`respond.result`（相关联的受理结果或错误）、`event`（由 dsh Remote 流与 waterfall 投影而来的 bridge 内部事件）、`tool.call`、`ping`、`error`。

每个 `respond` 同时携带全局唯一的传输 id 与宿主交互的 `rpcId`。扩展只把回执路由给发起操作的面板，并在超时、面板关闭或桥断线时拒绝尚未完成的响应。

## 调用与验证

- 工具注册路径：ctx.tools → 桥协议 → 扩展动作处理器。
- 快照预算经 hello.ok 协商；快照作为普通工具结果返回，服务端不缓存页面快照。
- 动作调用等待页面执行与稳定检测完成。
- 扩展端到端测试需要可用 Chromium 和已构建的扩展；缺少时跳过。

| 错误 | 含义 |
|---|---|
| bridge-closed | 扩展未连接 |
| timeout | 调用超时 |
| no-active-tab | 无可操作标签页 |
| content-unavailable | 页面内容脚本不可用 |
| action-failed | 动作失败；元素编号失效时重新获取快照 |
