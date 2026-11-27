# @onenightcarnival/dsh-subscriptions

[English](README.md) | **中文**

DeepSeek Harness 的 ChatGPT 订阅插件，通过 [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) 使用套餐内的模型。入口：侧边栏「AI 订阅」，包含账号、模型和用量，支持宿主主题及中英文。

## 安装

独立包与集成包互斥：

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-subscriptions-<版本>.tgz
```

## ChatGPT

1. 在「AI 订阅」点击「使用 ChatGPT 继续」，完成浏览器 OAuth 授权。符合条件的 Plus 和 Pro 账号可授权本应用使用套餐。
2. 在会话模型选择器的 ChatGPT 分组选择模型。

| 页面 | 功能 |
|---|---|
| 账号 | 添加、重新登录、设为默认、断开连接 |
| 模型 | 刷新账号目录、显示筛选、默认推理强度、上下文编辑 |
| 用量 | 套餐用量说明与 ChatGPT 用量设置链接 |

模型勾选即时显示并依次保存；保存状态位于页头，失败时恢复已保存值并提供重试。

- 上下文接受 `256K`、`1M`、`1.5M` 或正整数，采用十进制单位。
- Enter 或「保存」提交；清空并保存或「恢复默认」使用目录默认值。
- 设置由各账号共用，不能超过目录给出的上限。

登录、请求与用量：

- OAuth 使用 PKCE、ID token 签名校验和 `127.0.0.1` HTTP 回调。依次尝试端口 1455、1457 和系统分配的空闲端口；手动模式要求粘贴地址栏中的完整回调 URL，页面无法访问不影响提交。
- 每台主机保留固定的 host ID，每个账号注册保留独立的 client ID。「重新登录」复用已有注册；相同邮箱的不同注册分别保存。
- 凭据保存在宿主本机。断开连接时尝试撤销远程会话，清除本地 token，保留注册信息供后续登录。撤销未确认时显示提示，也可在 ChatGPT 设置中移除应用权限。
- 模型目录从 `GET https://api.openai.com/v1/models` 实时读取。对话使用 OAuth 调用 `POST https://api.openai.com/v1/responses`，开启流式传输，关闭响应存储。
- 对话支持 DSH 本地函数工具。输入类型与推理强度跟随模型目录。该接口不提供托管生图、文件搜索、Code Interpreter、原生计算机操作和托管 MCP。
- 应用用量与套餐中的 Codex / ChatGPT Work 额度共用，应用限额不会增加额度。「管理用量」打开 [ChatGPT 设置 → 用量](https://chatgpt.com/settings/usage)；本接入不估算剩余额度。

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
| 通用 | `enabled`、`streamIdleTimeoutMs` |
| 模型元数据覆盖 | `chatgpt.models`；模型可用性以账号实时目录为准 |
| 模型条目 | `id`；可选 `name`、`contextWindow`、`inputModalities` |

凭证和设置保存在 DSH home 的 `plugins/subscriptions/`。界面读取不含 token 的账号状态；RPC 通过 DSH 已认证的连接。原版订阅插件使用相同的 provider 和 RPC 名称，两个包不能同时加载。

| 文件 | 内容 | 其他提供方的条目 |
|---|---|---|
| `auth.json` | 账号凭证 | 忽略；凭证条目不进入下一次写入 |
| `models.json` | 账号模型目录 | 忽略 |
| `model-defaults.json` | 各模型的默认推理强度 | 忽略；不进入下一次写入 |
| `provider-settings.json` | 显示筛选、上下文与账号偏好 | 忽略；不进入下一次写入 |

## 源码维护

`src/backend` 包含 OAuth PKCE、令牌刷新、流式模型适配和账号路由，提供方为 `chatgpt`。后端从本地源码构建。源码来源和 MIT 许可证位于 [SOURCE_NOTICES.txt](SOURCE_NOTICES.txt)。

构建将其与所打包第三方包的许可证一并写入独立包和集成包的 `THIRD_PARTY_LICENSES.txt`。修改后端时需重新验证 OAuth、RPC、模型和存储测试。

## 开发验证

构建后在仓库根目录执行：

| 命令 | 验证范围 |
|---|---|
| `pnpm --filter @onenightcarnival/dsh-subscriptions test` | OAuth、RPC、模型、存储和面板交互 |
| `pnpm --filter @onenightcarnival/dsh-subscriptions test:smoke` | 临时 DSH home 中的真实宿主；独立包、集成包启用/关闭与认证 |
| `node packages/subscriptions/test/preview.mjs` | 示例数据的本地 UI 预览 |

测试使用隔离数据，不读取个人凭证或调用真实模型。
