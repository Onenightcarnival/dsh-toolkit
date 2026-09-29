# @onenightcarnival/dsh-subscriptions

[English](README.md) | **中文**

全家桶的 AI 订阅子包，支持 ChatGPT 与 Google Antigravity。侧边栏「AI 订阅」包含类型选择、账号列表、模型设置和用量，沿用 S3 / RDB 的布局、主题颜色与中英文界面。

## 使用

安装独立包或全家桶，二选一：

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-subscriptions-0.6.0.tgz
```

1. 打开「AI 订阅」，点击「连接 ChatGPT」，在浏览器完成 OAuth 授权。自动回调依次尝试本机 1455、1457 端口；两者都被系统保留或占用时会自动切换为手动模式。完成授权后，即使浏览器的 localhost 页面显示无法访问，也请复制地址栏中的完整 URL，回到面板粘贴并提交。
2. 在会话模型选择器的 ChatGPT (Codex) 分组选择模型。模型目录按账号发现，支持刷新、显示筛选、默认推理强度与上下文编辑。上下文可输入 `256K`、`1M`、`1.5M` 或正整数（十进制单位），按 Enter 或点击保存；清空并保存或点击「恢复默认」使用目录默认值。设置由多个账号共用，目录明确提供的最大值仍作为上限。
3. 「工具」提供 Codex Web Search 和图像生成开关。`codex_web_search` 直接使用 ChatGPT 订阅，返回摘要、DSH 搜索结果卡片和来源链接；与 DSH 的联网搜索提供方设置独立。
4. `codex_image_generate` 支持生图和图片附件编辑；生成文件保存在 DSH home 的 `plugins/subscriptions/images/`，有附件服务时支持对话内预览、下载和继续编辑。
5. 「用量」显示所选账号的额度窗口与重置时间，支持刷新。可添加多个账号、设置默认账号或断开连接。

| 工具 | 输入 | 结果 |
| --- | --- | --- |
| `antigravity_web_search` | `query` | Google 搜索摘要和最多八条来源 |
| `antigravity_image_generate` | `prompt`；可选 `referenceImages`、`reasoningEffort`（`minimal` / `high`） | 本地路径和图片附件 |
| `codex_web_search` | `query` | 摘要和最多八条来源 |
| `codex_image_generate` | `prompt`；可选 `referenceImages`、`size`、`quality` | 本地路径和图片附件 |

Antigravity 搜索使用 Gemini 3 Flash 的 Google Search grounding；无来源引用时返回不可用错误。图片工具使用 Gemini 3.1 Flash Image，省略思考强度时读取模型默认设置。图片引用由 DSH 附件服务解析；工作区图片先通过 `read_image` 读取。工具请求只在 401 时刷新一次令牌、在 403/404 时切换地址，网络失败、限流和服务端错误不自动重发生图。

工具列表按会话创建时的开关设置生成；搜索关闭后也会立即阻止已有会话调用。持久化开关使用能力键 `web_search` 和 `image_generate`。

模型、搜索和生图的实际可用性取决于账号权限及额度。接入使用 ChatGPT 订阅的 Codex 后端，无需 OpenAI API key。

## Google Antigravity

侧栏选择 **Antigravity · Google**，点击「连接 Google Antigravity」。Google OAuth 使用 PKCE，回调地址为 `http://localhost:51121/oauth-callback`；端口被占用或被系统保留时支持手动提交完整回调 URL。账号凭证保存在主机。

| 能力 | 行为 |
| --- | --- |
| 模型 | Cloud Code Assist 实时目录中账号可用的 Gemini、Claude、GPT-OSS 对话及图片模型 |
| 配置 | 按提供方保存显示筛选、推理强度和上下文；同类账号共用配置 |
| 用量 | 额度分组、短时与每周窗口、重置时间；兼容按模型返回的额度 |
| 图片模型 | Gemini 3.1 Flash Image 可在对话中生成图片；结果保存为 DSH 附件，支持预览与继续编辑。思考强度支持 Minimal / High，跟随提供方时默认为 Minimal。需要附件服务。 |
| 工具 | 对话模型使用 DSH 会话工具；图片模型输出文本和图片，不调用会话工具。独立工具 `antigravity_web_search`、`antigravity_image_generate` 使用默认 Google 账号，开关位于 Antigravity 的「工具」页签 |

模型目录合并默认与备用 Google 地址的结果。请求保留 Antigravity 客户端标识；单个地址的 403 支持切换到备用地址。用量窗口独立于模型目录和方案查询，部分接口不可用时保留已获取的数据。

旧插件与本接入使用相同的 `antigravity` 提供方，启用本接入前需停用旧插件。

OAuth 客户端配置按以下顺序读取：

1. 插件配置中的 `antigravity.clientId` 与可选的 `antigravity.clientSecret`。
2. 环境变量 `ANTIGRAVITY_CLIENT_ID`、`ANTIGRAVITY_CLIENT_SECRET`，兼容 `NOAGY_` 前缀。
3. `$DSH_HOME/plugins/subscriptions/antigravity-oauth-client.json`，字段为 `clientId` 与可选的 `clientSecret`。
4. 固定运行时依赖 `@cortexkit/antigravity-auth-core@2.2.0` 提供的默认客户端配置。

登录时保存解析后的客户端配置，已有账号继续使用本地配置刷新令牌。插件源码与构建产物保留核心包导入；客户端常量由依赖包提供。登录不再下载参考项目源码。

项目标识优先使用 `antigravity.projectId`，其次读取账号项目发现结果。项目发现接口缺失（404）或未返回项目时，使用与参考插件一致的账号兼容标识。此标识不创建 Google Cloud 项目，也不改变账号权限；服务端要求真实项目时，可配置 `antigravity.projectId`。认证、权限与额度错误保留为失败。

## 配置

全家桶默认挂载本模块，`subscriptions: false` 同时关闭主机与界面：

```yaml
- id: toolkit
  config:
    subscriptions: false
```

独立包插件 ID 为 `subscriptions`。配置项：`enabled`、`codexClientVersion`、`streamIdleTimeoutMs`、`rateLimit`、Codex 的 `models` 和 Antigravity 的 `antigravity.models`。模型条目包含 `id`，可选 `name`、`contextWindow`、`inputModalities`。Antigravity 另支持 `clientId`、`clientSecret`、`baseURL`、`userAgent`、`projectId`、`onboard`（默认关闭）。

凭证和设置保存在 DSH home 的 `plugins/subscriptions/`。界面读取不含 token 的账号状态；RPC 通过 DSH 已认证的连接。原版订阅插件使用相同的 provider 和 RPC 名称，两个包不能同时加载。

## 源码维护

`src/backend` 包含 OAuth PKCE、令牌刷新、流式模型适配、Codex 搜索和图片附件处理，提供方为 `codex` 与 `antigravity`。后端从本地源码构建。Antigravity 协议参考：[LiZhenNet/dsh-antigravity](https://github.com/LiZhenNet/dsh-antigravity/tree/94957767c5e247d86cec8833fb1b67f659078af6)。源码来源和 MIT 许可证位于 `THIRD_PARTY_LICENSES.txt`。

`THIRD_PARTY_LICENSES.txt` 随独立包和全家桶发布。修改协议后端时需重新验证 OAuth、RPC、工具策略和模型目录测试。

## 开发验证

构建后运行 `pnpm --filter @onenightcarnival/dsh-subscriptions test`，验证 RPC、工具开关和面板交互；运行 `pnpm --filter @onenightcarnival/dsh-subscriptions test:smoke`，在临时 DSH home 中启动真实 web 宿主，验证独立包、全家桶启用/关闭及接口认证。测试不读取个人凭证，也不调用真实模型。`node packages/subscriptions/test/preview.mjs` 提供仅使用示例数据的本地 UI 预览。
