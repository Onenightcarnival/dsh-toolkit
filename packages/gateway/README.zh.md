# API 网关

[English](README.md)

`@onenightcarnival/dsh-gateway` 以 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 协议对外提供 DeepSeek Harness 中已配置的模型路由，使用独立监听端口、API key 和逐请求用量统计。界面入口：主侧栏「API 网关」。

## 端点

网关默认监听 `127.0.0.1:23340`。每个请求通过 `Authorization: Bearer <key>` 或 `x-api-key: <key>` 携带 key。

| 端点 | 协议 | 流式 |
|---|---|---|
| `GET /v1/models` | OpenAI 列表；请求带 `anthropic-version` 或 `x-api-key` 时返回 Anthropic 形状 | — |
| `POST /v1/chat/completions` | OpenAI Chat Completions | `stream: true`、`stream_options.include_usage` |
| `POST /v1/responses` | OpenAI Responses | `stream: true`，带 `sequence_number` 的语义事件 |
| `POST /v1/messages` | Anthropic Messages | `stream: true`，`message_start` … `message_stop` |

每个请求翻译为一次宿主模型请求，宿主的流再翻译回对应协议。接受跨域浏览器客户端（`Access-Control-Allow-Origin: *`）；key 是唯一凭证。

### 模型

网关模型 id 为 `provider:model`，由宿主已注册的提供方路由及其模型清单构成；`GET /v1/models` 列出所用 key 可使用的 id。请求中的模型名按以下顺序解析：

1. 设置页中的别名。
2. 已注册提供方的 `provider:model` id。
3. 默认模型：设置页选定的模型，否则为宿主的默认模型选择。

因此请求中未知的模型名会落到默认模型上；响应中报告实际使用的 id。没有默认模型且无匹配时返回 `404 model_not_found`。

### 参数支持

| 协议 | 接受 | 忽略 | 返回 `400` |
|---|---|---|---|
| Chat Completions | `messages`（system / developer / user / assistant / tool）、文本与 `image_url` 片段、`function` 类型 `tools`、`tool_choice: none`、`temperature`、`max_tokens` / `max_completion_tokens`、`stop`、`reasoning_effort`、`stream`、`stream_options.include_usage` | `user`、`metadata`、`store`、`top_p`、`presence_penalty`、`frequency_penalty`、`seed`、其他 `tool_choice` 取值、历史轮次的 `reasoning_content` | `n` 不为 1、`logprobs`、`top_logprobs`、`text` 以外的 `response_format`、其他类型的 tools、上述五种以外的 role |
| Responses | `input` 字符串或条目（`message`、`function_call`、`function_call_output`；`reasoning` 条目丢弃）、`instructions`、`function` 类型 `tools`、`tool_choice: none`、`temperature`、`max_output_tokens`、`reasoning.effort`、`stream` | `store`、`metadata`、`truncation`、`parallel_tool_calls`、`include` | `previous_response_id`、内置工具（`web_search`、`file_search`、`code_interpreter` 等）、`text` 以外的 `text.format`、`item_reference` |
| Messages | `system` 字符串或文本块、含 `text`、`image`、`tool_use`、`tool_result` 块的 `messages`、`tools`（`custom` 或无类型）、`tool_choice.type: none`、`temperature`、`max_tokens`、`stop_sequences`、`stream` | `anthropic-version`、`anthropic-beta`、`metadata`、`top_p`、`top_k`、`thinking`、其他 `tool_choice` 取值 | 服务端工具（`web_search_20250305` 等）、文档及其他块类型 |

历史轮次中的 `thinking` 与 `redacted_thinking` 块被丢弃；模型当前产生的推理以 `reasoning_content`（Chat Completions）、`reasoning` 摘要条目（Responses）或 `thinking` 块（Messages）流式返回。图片以 `data:` URL 或 `http(s)` URL 传入（PNG、JPEG、WebP、GIF，单张 20 MiB），经宿主附件存储保存；宿主没有附件存储时拒绝图片输入。

### 错误

| 情况 | 状态码 |
|---|---|
| 缺少或无效的 key | `401` |
| key 无权使用解析出的模型 | `403` |
| 请求格式错误或含不支持的参数 | `400` |
| 无法解析模型 | `404` |
| 请求体超过限制（32 MiB） | `413` |
| 上游提供方失败 | 提供方状态码为 4xx 或 5xx 时原样返回，否则 `502` |

错误体遵循端点协议：OpenAI 端点为 `{ "error": { "message", "type", "code", "param" } }`，Messages 为 `{ "type": "error", "error": { "type", "message" } }`。流开始后的失败以流内错误帧返回（`data: {"error":…}`、`response.failed` + `error`，或 `error` 事件）并关闭连接。客户端断开即取消宿主请求。

## API key

key 以完整形式保存在 `$DSH_HOME/gateway/keys.json`（权限 0600）。首次启动生成名为 `default` 的第一把 key。每把 key 有名称、启用状态和可选的可用模型 id 清单；设置页提供新建、显示、复制、停用和删除。

## 用量

三个协议端点上每个通过鉴权的请求写入一行到 `$DSH_HOME/gateway/usage.sqlite`（Node 内置 `node:sqlite`）：时间、key、协议、模型、是否流式、来自宿主 `usage` 块的输入 / 输出 / 缓存 / 推理 token、首个内容字节耗时、总耗时、状态码与错误码。插入时删除 400 天前的行。

用量页按今日、最近 7 日、最近 30 日取行，可再按 key、模型、协议、结果筛选，展示筛选后的合计并列出其中最新 200 条。费用只对 `pricing` 中填写了单价的模型计算（每百万输入与输出 token 的单价，货币由部署自行约定）；没有任何计价行时不显示费用。

## 面板

主侧栏「API 网关」打开中栏面板，分三个页签；最后停留的页签按浏览器记忆。

| 页签 | 内容 |
|---|---|
| 概览 | 监听状态、启用开关、地址与端口；端点清单；模型、key 与默认模型计数 |
| API key | key 表格的显示、复制、启用 / 停用与删除；key 的可用模型在「提供方 → 模型」两级勾选弹窗中选择，新建 key 同样 |
| 用量 | 顶部筛选（范围、key、模型、协议、结果），中部为筛选结果的指标卡片，下方是最新 200 条匹配请求的明细宽表 |

## 设置

| 设置 | 存储字段 | 默认值 |
|---|---|---|
| 启用网关 | `enabled` | `true` |
| 地址 | `host` | `127.0.0.1` |
| 端口 | `port` | `23340` |
| 默认模型 | `defaultModel` | `null`（宿主默认模型） |
| 别名 | `aliases` | `{}` |
| 单价 | `pricing` | `{}` |

面板只编辑监听字段；`defaultModel`、`aliases` 与 `pricing` 在设置文件或插件配置中编辑。用量页在单价产生数值后才显示费用列。

设置保存在 `$DSH_HOME/gateway/settings.json`；保存后重启监听。非回环地址对宿主所在网络开放；所有请求仍需 key。

插件配置提供设置文件存在之前的初始值：

| 键 | 含义 | 默认值 |
|---|---|---|
| `enabled` | `false` 使宿主不进入组合树 | `true` |
| `listen` | 初始监听状态 | `true` |
| `host`、`port` | 初始监听地址 | `127.0.0.1`、`23340` |
| `dataDir` | `settings.json`、`keys.json`、`usage.sqlite` 所在目录 | `$DSH_HOME/gateway` |
| `maxBodyBytes` | 请求体上限 | `33554432` |

独立插件 ID：`gateway`。Toolkit 模块键：`gateway`；`false` 同时关闭宿主与界面。独立安装与集成安装互斥。

## 管理接口

仅回环、需宿主浏览器会话，挂在宿主 web 端口。

| 请求 | 响应 |
|---|---|
| `GET /api/dsh-gateway/status` | 设置、监听状态、模型清单、key 清单、宿主默认模型 |
| `PUT /api/dsh-gateway/settings` | 保存完整设置对象，重启监听，返回状态 |
| `GET /api/dsh-gateway/keys`、`?id=` | key 清单；单把 key 的完整值 |
| `POST /api/dsh-gateway/keys` `{ name, models }` | 新 key 的完整值，响应中返回一次，之后经 `?id=` 读取 |
| `PATCH /api/dsh-gateway/keys` `{ id, name?, enabled?, models? }` | 更新后的记录 |
| `DELETE /api/dsh-gateway/keys?id=` | 剩余 key |
| `GET /api/dsh-gateway/usage?range=today\|7d\|30d&key=&model=&protocol=&outcome=ok\|error` | 范围内的筛选候选值、筛选结果的合计与分组、最新 200 条筛选行 |

## 开发

```sh
pnpm --filter @onenightcarnival/dsh-gateway run build
pnpm --filter @onenightcarnival/dsh-gateway run typecheck
pnpm --filter @onenightcarnival/dsh-gateway run test        # 协议翻译、存储、HTTP 服务
pnpm --filter @onenightcarnival/dsh-gateway run test:smoke  # 真实宿主与 echo 模型路由
```

| 路径 | 职责 |
|---|---|
| `src/index.ts` | 宿主入口：存储、监听生命周期、管理路由 |
| `src/server.ts` | `/v1` 监听：鉴权、分发、流式转发、账本记录 |
| `src/translate/common.ts` | 协议无关的请求模型与宿主消息构造 |
| `src/translate/openai-chat.ts`、`openai-responses.ts`、`anthropic.ts` | 各协议的请求解析、流式编码与完整对象 |
| `src/models.ts` | `provider:model` 目录、别名、默认回退 |
| `src/keys.ts`、`src/settings.ts`、`src/usage.ts` | key 文件、设置文件、SQLite 账本 |
| `src/images.ts` | 图片输入 → 宿主附件 |
| `src/client/` | 设置页 |
