# @onenightcarnival/dsh-subscriptions

[English](README.md) | **中文**

DeepSeek Harness 的 AI 订阅插件，支持 Codex、ChatGPT 与 Google Antigravity。入口：侧边栏「AI 订阅」，包含提供方、账号、模型、工具和用量，支持宿主主题及中英文。

## 安装

独立包与集成包互斥：

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-subscriptions-<版本>.tgz
```

## Codex

1. 在「AI 订阅」点击「连接 Codex」，完成浏览器 OAuth 授权。
2. 在会话模型选择器的 Codex 分组选择模型。

自动回调依次使用本机 1455、1457 端口。端口不可用时切换为手动模式：授权跳转到 localhost 后，将地址栏的完整 URL 粘贴回面板并提交；页面无法访问不影响提交。

| 页面 | 功能 |
|---|---|
| 账号 | 添加、设为默认、断开连接 |
| 模型 | 刷新账号目录、显示筛选、默认推理强度、上下文编辑 |
| 工具 | Codex Web Search 与图像生成开关 |
| 用量 | 当前账号的额度窗口、重置时间与刷新；缺失数据显示为未知 |

模型勾选与工具开关即时显示并依次保存；保存状态位于页头，失败时恢复已保存值并提供重试。

- 上下文接受 `256K`、`1M`、`1.5M` 或正整数，采用十进制单位。
- Enter 或「保存」提交；清空并保存或「恢复默认」使用目录默认值。
- 设置由同类账号共用，不能超过目录给出的上限。

Codex Web Search 独立于 DSH 的联网搜索提供方设置。生成图片保存到 DSH home 的 `plugins/subscriptions/images/`；附件服务提供对话内预览、下载与继续编辑。

## ChatGPT

选择 **ChatGPT · OpenAI**，点击「使用 ChatGPT 继续」。符合条件的 Plus 和 Pro 账号可通过 [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) 授权本应用使用套餐。

- OAuth 使用 PKCE、ID token 签名校验和 `127.0.0.1` HTTP 回调。依次尝试端口 1455、1457 和系统分配的空闲端口；手动模式要求粘贴完整回调 URL。
- 每台主机保留固定的 host ID，每个账号注册保留独立的 client ID。「重新登录」复用已有注册；相同邮箱的不同注册分别保存。
- 凭据保存在宿主本机。断开连接时尝试撤销远程会话，清除本地 token，保留注册信息供后续登录。撤销未确认时显示提示，也可在 ChatGPT 设置中移除应用权限。
- 模型目录从 `GET https://api.openai.com/v1/models` 实时读取。对话使用 OAuth 调用 `POST https://api.openai.com/v1/responses`，开启流式传输，关闭响应存储。
- 对话支持 DSH 本地函数工具。输入类型与推理强度跟随模型目录。该接口不提供托管生图、文件搜索、Code Interpreter、原生计算机操作和托管 MCP。
- 应用用量与套餐中的 Codex / ChatGPT Work 额度共用，应用限额不会增加额度。「管理用量」打开 [ChatGPT 设置 → 用量](https://chatgpt.com/settings/usage)；本接入不估算剩余额度。
- Codex 与 ChatGPT 的凭据、模型设置和目录分别保存；原有 Codex 账号和模型 ID 继续有效。

## 工具

| 工具 | 输入 | 结果 |
| --- | --- | --- |
| `antigravity_web_search` | `query` | Google 搜索摘要和最多八条来源 |
| `antigravity_image_generate` | `prompt`；可选 `referenceImages`、`reasoningEffort`（`minimal` / `high`） | 本地路径和图片附件 |
| `codex_web_search` | 原生 `web.run` 命令；兼容简写 `query` | 页面正文、行号、链接编号、引用 ID、完整来源与结构化结果 |
| `codex_image_generate` | `prompt`；可选 `transparent_background`、`referenced_image_paths`、`num_last_images_to_include` | 本地路径和图片附件 |

- Antigravity 搜索使用 Gemini 3 Flash 的 Google Search grounding；无来源引用时返回不可用错误。
- 图片工具使用 Gemini 3.1 Flash Image，省略思考强度时读取模型默认设置。
- 图片引用由 DSH 附件服务解析；工作区图片先通过 `read_image` 读取。
- 工具请求只在 401 时刷新一次令牌、在 403/404 时切换地址，网络失败、限流和服务端错误不自动重发生图。

工具列表按会话创建时的开关设置生成；搜索关闭后也会立即阻止已有会话调用。持久化开关使用能力键 `web_search` 和 `image_generate`。

模型、搜索和生图的实际可用性取决于账号权限及额度。接入使用 ChatGPT 订阅的 Codex 后端，无需 OpenAI API key。

### Codex 联网

| 命令 | 参数 |
| --- | --- |
| `search_query`、`image_query` | `q`；可选 `domains`、`recency` |
| `open` | `ref_id`；可选 `lineno` |
| `click` | `ref_id`、链接编号 `id` |
| `find` | `ref_id`、`pattern` |
| `screenshot` | `ref_id`、从零开始的页码 `pageno` |
| `finance`、`weather`、`sports`、`time` | 原生股票代码、地点、联赛、UTC 偏移等字段 |
| `response_length` | `short`、`medium`、`long` |

- 命令接受数组，可在一次调用中组合。
- `search_query` 每次最多四条；四条时须选择 `medium` 或 `long`。
- `query` 是单条搜索的兼容简写，与其他命令互斥。
- 引用 ID 按会话隔离，可用于后续页面操作。
- 来源不设八条上限，结构化 `results` 保留上游字段，不包含加密传输状态。
- 外部内容视为不可信数据，引用使用来源 URL。

PDF 截图命令透传至订阅端点；该端点不保证返回图片字节及原生桌面媒体组件。仅有页面引用不代表已返回截图。模型和账号可用性由提供方决定。

### Codex 生图

| 设置 | 规格 |
| --- | --- |
| 模型 | `gpt-image-2` |
| 尺寸 / 质量 | 默认 `auto` / `auto`；构图和尺寸写入 `prompt` |
| 背景 | `transparent_background: true` 启用透明背景；默认 `false` |
| 文件引用 | `referenced_image_paths`：1–5 个绝对路径，经当前 agent 的 `read_image` 权限流程读取 |
| 对话引用 | `num_last_images_to_include`：当前会话有效上下文中最近 1–5 张不同图片，按时间顺序传入 |
| 兼容字段 | `referenceImages`、`size`、`quality`；保留原有取值 |

- 引用方式互斥。
- 缺失、被拒绝或无效的编辑引用在生图请求前报错。
- 对话引用需要会话查询服务和附件服务。
- 生成文件保留上游原始字节，对话内附件遵循宿主图片限制和模型能力。
- 自动尺寸不承诺固定 4K 输出。

原生接口：[Codex 搜索命令](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/search.rs)、[Codex 生图工具](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/tool.rs)。

## Google Antigravity

侧栏选择 **Antigravity · Google**，点击「连接 Google Antigravity」。Google OAuth 使用 PKCE，回调地址为 `http://localhost:51121/oauth-callback`；端口被占用或被系统保留时支持手动提交完整回调 URL。账号凭证保存在主机。

| 能力 | 行为 |
| --- | --- |
| 模型 | Cloud Code Assist 实时目录中账号可用的 Gemini、Claude、GPT-OSS 对话及图片模型 |
| 配置 | 按提供方保存显示筛选、推理强度和上下文；同类账号共用配置 |
| 用量 | 额度分组、短时与每周窗口、重置时间；兼容按模型返回的额度 |
| 图片模型 | Gemini 3.1 Flash Image 可在对话中生成图片；结果保存为 DSH 附件，支持预览与继续编辑。思考强度支持 Minimal / High，跟随提供方时默认为 Minimal。需要附件服务。 |
| 工具 | 对话模型使用 DSH 会话工具；图片模型输出文本和图片，不调用会话工具。独立工具 `antigravity_web_search`、`antigravity_image_generate` 使用默认 Google 账号，开关位于 Antigravity 的「工具」页签 |

- 模型目录合并默认与备用 Google 地址的结果。
- 请求保留 Antigravity 客户端标识；单个地址的 403 支持切换到备用地址。
- 用量窗口独立于模型目录和方案查询，部分接口不可用时保留已获取的数据。

旧插件与本接入注册相同的 `antigravity` 提供方，二者只能启用其一。

OAuth 客户端配置按以下顺序读取：

1. 插件配置中的 `antigravity.clientId` 与可选的 `antigravity.clientSecret`。
2. 环境变量 `ANTIGRAVITY_CLIENT_ID`、`ANTIGRAVITY_CLIENT_SECRET`，兼容 `NOAGY_` 前缀。
3. `$DSH_HOME/plugins/subscriptions/antigravity-oauth-client.json`，字段为 `clientId` 与可选的 `clientSecret`。
4. 固定运行时依赖 `@cortexkit/antigravity-auth-core@2.2.0` 提供的默认客户端配置。

登录解析后的客户端配置保存在本机，用于后续令牌刷新。

- 项目标识优先使用 `antigravity.projectId`，其次读取账号项目发现结果。
- 项目发现接口缺失（404）或未返回项目时，使用账号兼容标识。
- 此标识不创建 Google Cloud 项目，也不改变账号权限；服务端要求真实项目时，可配置 `antigravity.projectId`。
- 认证、权限与额度错误保留为失败。

可用性取决于账号权限与额度；离线测试不代表账号可实际访问。

## 配置

集成包默认挂载本模块，`subscriptions: false` 同时关闭主机与界面：

```yaml
- id: toolkit
  config:
    subscriptions: false
```

独立包插件 ID：`subscriptions`。

| 配置范围 | 字段 |
|---|---|
| 通用 | `enabled`、`codexClientVersion`、`streamIdleTimeoutMs`、`rateLimit` |
| Codex 模型 | `models` |
| ChatGPT 模型元数据覆盖 | `chatgpt.models`；模型可用性以账号实时目录为准 |
| Antigravity 模型 | `antigravity.models` |
| 模型条目 | `id`；可选 `name`、`contextWindow`、`inputModalities` |
| Antigravity 连接 | `clientId`、`clientSecret`、`baseURL`、`userAgent`、`projectId`、`onboard`（默认关闭），均位于 `antigravity` 下 |

凭证和设置保存在 DSH home 的 `plugins/subscriptions/`。界面读取不含 token 的账号状态；RPC 通过 DSH 已认证的连接。原版订阅插件使用相同的 provider 和 RPC 名称，两个包不能同时加载。

## 源码维护

`src/backend` 包含 OAuth PKCE、令牌刷新、流式模型适配、Codex 搜索和图片附件处理，提供方为 `codex`、`chatgpt` 与 `antigravity`。后端从本地源码构建。Antigravity 协议参考：[LiZhenNet/dsh-antigravity](https://github.com/LiZhenNet/dsh-antigravity/tree/94957767c5e247d86cec8833fb1b67f659078af6)。源码来源和 MIT 许可证位于 `THIRD_PARTY_LICENSES.txt`。

`THIRD_PARTY_LICENSES.txt` 随独立包和集成包发布。修改协议后端时需重新验证 OAuth、RPC、工具策略和模型目录测试。

## 开发验证

构建后在仓库根目录执行：

| 命令 | 验证范围 |
|---|---|
| `pnpm --filter @onenightcarnival/dsh-subscriptions test` | OAuth、RPC、模型、工具策略和面板交互 |
| `pnpm --filter @onenightcarnival/dsh-subscriptions test:smoke` | 临时 DSH home 中的真实宿主；独立包、集成包启用/关闭与认证 |
| `node packages/subscriptions/test/preview.mjs` | 示例数据的本地 UI 预览 |

测试使用隔离数据，不读取个人凭证或调用真实模型。
