# dsh-http

[English](README.md) | **中文**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）HTTP API 请求工具。入口：Web 侧边栏「HTTP」。

## 功能

| 界面 | 功能 |
|---|---|
| 目标 | Base URL、认证（bearer / basic / header / query）、固定 header、`{{变量}}`、允许的额外 host、变更开关、内网开关、超时 |
| 侧栏 | 范围选择器：「无目标」或某个目标，末项为「新增目标…」，并提供所选目标的编辑与连接测试；其下是该范围的两个页签。「请求」：保存的请求表单与过滤框；「+」新增一条空白请求并把光标放进其 URL 栏；可重命名（双击或菜单）、创建副本、「复制为 cURL」、删除。「历史」：全部请求记录，最新在前；选中一条即显示，记录可存为请求 |
| 请求栏 | 所选请求的表单，就地编辑并自动保存：方法、完整 URL（无目标）或 Base URL 之下的路径、「发送」。把 cURL 命令粘贴进 URL 栏即填好整张表单。页签：Params（URL 预览、「从 URL 导入参数」）、Body（JSON / 文本 / 表单；Tab 缩进）、Headers（附只读的目标固定 header）、Auth |
| 键值表 | Params、Headers 与表单字段：末尾始终有一行空白行；提供「添加」「批量编辑」（每行一条 `名称: 值`，`#` 开头的行停用）与「全部删除」；每行可勾选启用；同名项全部保留 |
| Auth 页签 | 目标已配置认证：只读显示。目标未配置认证或无目标：编辑请求自身的认证，支持 bearer、basic、自定义 header 与 query 参数 |
| 响应栏 | 所选请求的最近一次响应，可切换其历次响应；或从历史中选中的记录。状态、耗时与大小；页签 Preview（JSON 格式化 / 原始；图片直接显示；HTML 可看源码或在无脚本的沙箱中渲染；事件流边到边显示；复制；「保存到文件」）、Headers、Request（实际发出的 URL、header 与 body，密钥已遮罩）。发送中显示已用时间与取消按钮 |
| 历史 | 面板与 Agent 的全部请求按目标记录；Agent 发出的请求数秒内出现；可删除单条或清空该目标 |
| Agent | `http_targets`、`http_request`、`http_history` |

布局：侧栏、请求栏与响应栏并排；面板较窄时两栏上下排布，两栏之间的分隔条可拖动（双击复位）。`Ctrl` / `⌘` + `Enter` 发送请求。

## 事件流

内容类型为 `text/event-stream` 的响应按事件逐条读取。

| 方面 | 行为 |
|---|---|
| 接收中 | 响应栏显示状态、事件数与已用时间，事件到达即追加并保持滚动到末尾；「停止」结束该流 |
| 事件视图 | 每个事件一行：序号、相对请求开始的到达时间、事件类型（未命名为 `message`）与数据；展开后显示数据（JSON 则格式化）及 `id`、`retry` |
| 文本视图 | 由模型输出流拼出的文本：OpenAI Chat Completions 与 Responses、Anthropic Messages、Gemini。流中含此类增量时提供 |
| 原始视图 | 流的原文，流结束后提供 |
| 流的结束 | 服务端关闭；「停止」；目标超时时间内没有新数据；或达到 1 MiB 正文上限。各种情况都保留并记录已收到的内容，请求不计为失败 |
| 超时 | 面板读取时，目标超时随每个数据块重新计时；Agent 读取时覆盖整条流 |
| 历史 | 流的原文（上限 32 KiB）与每个事件的到达时间 |
| Agent | `http_request` 返回流的原文，读取到流结束、64 KiB 上限或目标超时为止 |

## 无目标的请求

| 方面 | 行为 |
|---|---|
| URL | URL 栏填写完整 URL；缺少协议时，回环与内网字面地址补 `http`，其余补 `https` |
| 可达范围 | 任意 host，含回环与内网 |
| 凭证 | 宿主不注入；请求自身的认证（Auth 页签）与写在 Headers 里的凭证随请求保存 |
| Agent | 不可调用也不列出：`http_request` 只接受已配置的目标，`http_history` 不含这些记录 |
| 升级为目标 | 「由此地址新建目标」打开目标对话框并以该 URL 的 origin 作为 Base URL；保存后请求移到新目标下，URL 改为路径 |

面板与 Agent 共用目标与历史：Agent 按名称调用目标，宿主注入凭证，请求记录进入面板显示的同一份历史。

## 安装

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-http-<版本>.tgz
```

发布产物见 [Releases](https://github.com/Onenightcarnival/dsh-toolkit/releases)。独立包与集成包互斥。

## 目标

| 字段 | 取值 |
|---|---|
| Base URL | `http(s)` 协议、host 与可选路径前缀；请求路径拼接在其下。不接受凭证、query 与片段 |
| 名称 | 默认用 host；Agent 按名称引用目标（唯一，不区分大小写） |
| 认证 | `none`；`bearer`（Authorization: Bearer）；`basic`；`header`（自定义 header）；`query`（附加到每个 URL 的参数）。密钥保存在宿主；编辑时留空保留已保存的值 |
| 固定 header | 每个请求都发送；同名请求 header 覆盖。传输层 header（`Host`、`Content-Length`、`Transfer-Encoding`、`Connection` 等）不接受 |
| 变量 | `{{名称}}` 在路径、query、header 与 body 中替换；未定义的名称原样保留。非密钥 |
| 允许的额外 host | Base URL host 之外，绝对 URL 或重定向可以到达的 host；`*.example.com` 匹配子域 |
| 允许变更 | Agent 可使用 POST / PUT / PATCH / DELETE；每次调用仍需 `confirm=true` |
| 允许访问内网 | 请求可到达回环、链路本地与 RFC 1918 地址，含解析到这些地址的域名 |
| 超时 | 1 000–120 000 ms，覆盖含重定向与正文下载的整个请求；默认 30 000。面板读取[事件流](#事件流)时随每个数据块重新计时 |
| 测试连接 | 带认证 GET Base URL；任意 HTTP 状态码视为可达 |

## 请求处理

| 步骤 | 行为 |
|---|---|
| URL | `path` 拼接在 Base URL 路径之下；绝对 URL 必须位于 Base host 或允许的 host |
| Query | 参数按顺序发送，同名项全部保留 |
| 认证 | 注入目标的认证；目标未配置认证时使用请求自身的认证，仅对面板发出的请求生效 |
| Body | GET 与 HEAD 忽略 body；以 `{` 或 `[` 开头的 body 默认 `content-type: application/json`，否则 `text/plain`；表单模式发送 `application/x-www-form-urlencoded` |
| 重定向 | 最多 5 跳，每跳按允许的 host 检查；origin 变化时去掉凭证；303 以及 POST 后的 301/302 改为无 body 的 GET |
| 响应 | 文本正文按声明的 charset 解码；完整的二进制正文交给面板用于预览与保存，不写入历史；面板保留 1 MiB，Agent 64 KiB，历史每个正文 32 KiB |
| 遮罩 | 目标密钥、请求自身的认证，以及写在请求 header `Authorization`、`Proxy-Authorization`、`Cookie`、`X-API-Key`、`API-Key`、`X-Auth-Token`、`X-Access-Token` 中的凭证，在交给面板、Agent 与历史的 URL、header 和正文中替换为 `••••••`（含其 URL 编码） |
| 代理 | 请求经宿主全局 `fetch` 发出，遵循内核的出站代理策略 |

## Agent 工具

「允许 Agent 使用」开启时注册，关闭时立即注销。

| 工具 | 功能 |
|---|---|
| `http_targets` | 目标列表：Base URL、认证类型、固定 header、变量名、允许的 host 与开关 |
| `http_request` | `target`、`method`、`path`、`query`、`headers`、`body`、`confirm`。GET / HEAD / OPTIONS 直接执行；其他方法需目标开启变更并传 `confirm=true` |
| `http_history` | 一个或全部目标的最近请求：状态、耗时与正文预览；不含无目标的请求 |

## 不支持的功能

| 范围 | 限制 |
|---|---|
| Body | 不支持 multipart 表单、文件上传与二进制文件 body；没有 GraphQL 编辑器 |
| 认证 | 不支持 OAuth、digest、NTLM 与 AWS 签名 |
| Cookie | 没有 cookie 管理；`Cookie` header 按填写内容发送 |
| 请求 | 每个范围一个扁平列表：没有文件夹与手动排序；方法限 GET、POST、PUT、PATCH、DELETE、HEAD、OPTIONS；超时与重定向按目标设置 |
| 协议 | 仅 HTTP：不支持 WebSocket 与 gRPC |
| 脚本 | 没有请求前后脚本、测试，以及 cURL 之外的代码生成 |
| 编辑器 | 纯文本编辑器：没有语法高亮与响应过滤 |

## 数据与访问

| 边界 | 契约 |
|---|---|
| 存储 | `~/.dsh/dsh-http.json`（目标、开关）、`~/.dsh/dsh-http-requests.json`（保存的请求）与 `~/.dsh/dsh-http-history.jsonl`（请求记录），权限 `0600` |
| 保存的请求 | 每个目标最多 500 个，无目标的请求最多 500 个；body 最大 256 KiB。目标的认证保留在目标上；请求自身的认证与写在其 header 里的凭证随请求明文保存。删除目标同时删除其请求 |
| 凭证 | 仅宿主读取；摘要只含认证类型、非密钥名称与短提示 |
| 历史 | 默认保留 200 条，先丢最旧（`historyLimit`，10–1 000）；删除目标同时删除其历史 |
| HTTP | `/api/dsh-http/*` 仅接受本机回环、同源浏览器标记与 GUI 会话 cookie；缺少 cookie 返回 `401` |

## 接口

| 请求 | 响应 |
|---|---|
| `GET /api/dsh-http/targets` | `{ targets: [摘要…] }` |
| `POST /api/dsh-http/targets` | 创建；`201` `{ target }` |
| `PATCH /api/dsh-http/targets?id=` | 更新；`{ target }` |
| `DELETE /api/dsh-http/targets?id=` | 删除目标、其保存的请求及其历史 |
| `GET /api/dsh-http/requests?target=` | `{ requests }`，按创建顺序；`target=direct` 列出无目标的请求 |
| `POST /api/dsh-http/requests`，请求体 `{ targetId, … }` | 创建；`targetId` 为目标 id 或 `direct`；`201` `{ request }` |
| `PATCH /api/dsh-http/requests?id=` | 更新给出的字段；带 `targetId` 即移动请求；`{ request }` |
| `DELETE /api/dsh-http/requests?id=` | 删除请求 |
| `GET` / `POST /api/dsh-http/settings` | `{ settings: { agentTools, historyLimit } }` |
| `POST /api/dsh-http/send`，请求体 `{ id, request }` | `{ exchange }`；`id` 为目标 id，或 `direct` 并在 `request.path` 中给出完整 URL；`request.query` 为对象或 `[名称, 值]` 列表；`request.auth` 为请求自身的认证；`request.requestId` 将记录关联到保存的请求；策略与传输失败记录在 `exchange.error`。带 `Accept: application/x-ndjson` 时按行返回 JSON 对象：事件流到达期间为 `{"type":"head"}` 与 `{"type":"event"}`，最后是 `{"type":"done","exchange"}` 或 `{"type":"error"}`。响应前关闭连接即取消请求，记录的错误为 `cancelled` |
| `GET /api/dsh-http/history?target=&limit=` | `{ entries }`，最新在前 |
| `DELETE /api/dsh-http/history?id=` / `?target=` / 无参数 | `{ removed }` |
| `POST /api/dsh-http/test`，请求体 `{ id }` | `{ result: { ok, status, latencyMs, error } }` |

## 开发

```sh
pnpm install
pnpm --filter @onenightcarnival/dsh-http run build        # lib/index.js（宿主）、lib/client.js（客户端）
pnpm --filter @onenightcarnival/dsh-http run typecheck
pnpm --filter @onenightcarnival/dsh-http run test         # 存储、引擎（本地 HTTP 服务）与工具测试
pnpm --filter @onenightcarnival/dsh-http pack
```

| 文件 | 职责 |
|---|---|
| `src/protocol.ts` | 宿主与客户端共享的线协议、URL 拼接、server-sent event 解析器 |
| `src/store.ts` | 目标校验与存储、保存的请求、请求历史 |
| `src/engine.ts` | host 与内网策略、认证、重定向、正文上限、事件流增量读取、遮罩 |
| `src/routes.ts` | `/api/dsh-http/*` |
| `src/tools.ts` | `http_*` Agent 工具 |
| `src/client/curl.ts` | cURL 命令的解析与生成、query 拆分 |
| `src/client/sse.ts` | 已记录事件流的行、模型输出流的文本 |
| `src/client/panel/SseView.tsx` | 事件流视图：事件、文本、原始 |
| `src/client/panel/HttpPanel.tsx` | 三栏外壳：目标选择器、请求选择与自动保存、分隔条、快捷键、发送与取消 |
| `src/client/panel/{RequestList,HistorySidebar,RequestPane,ResponsePane}.tsx` | 保存的请求列表、请求记录列表、请求页签、响应页签 |
| `src/client/panel/{TargetForm,KeyValueEditor}.tsx` | 目标对话框；末尾带空行的名称/值编辑器 |

## 许可

MIT
