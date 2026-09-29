# @onenightcarnival/dsh-subscriptions

[English](README.md) | **中文**

全家桶的 AI 订阅子包，首版仅接入 ChatGPT。侧边栏「AI 订阅」采用与 S3 / RDB 相同的账号列表、主面板、主题颜色与中英文界面。

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
| `codex_web_search` | `query` | 摘要和最多八条来源 |
| `codex_image_generate` | `prompt`；可选 `referenceImages`、`size`、`quality` | 本地路径和图片附件 |

工具列表按会话创建时的开关设置生成；搜索关闭后也会立即阻止已有会话调用。持久化开关使用能力键 `web_search` 和 `image_generate`。

模型、搜索和生图的实际可用性取决于账号权限及额度。接入使用 ChatGPT 订阅的 Codex 后端，无需 OpenAI API key。

## 配置

全家桶默认挂载本模块，`subscriptions: false` 同时关闭主机与界面：

```yaml
- id: toolkit
  config:
    subscriptions: false
```

独立包插件 ID 为 `subscriptions`。可选配置：`enabled`、`codexClientVersion`、`streamIdleTimeoutMs`、`rateLimit`，以及用于覆盖自动发现的 `models` 数组（包含 `id`，可选 `name`、`contextWindow`、`inputModalities`）。一般保留默认值即可；手动模型列表不会增加账号权限。

凭证和设置保存在 DSH home 的 `plugins/subscriptions/`。界面读取不含 token 的账号状态；RPC 通过 DSH 已认证的连接。原版订阅插件使用相同的 provider 和 RPC 名称，两个包不能同时加载。

## 源码维护

`src/backend` 包含 OAuth PKCE、令牌刷新、流式模型适配、Codex 搜索和图片附件处理。提供方仅有 ChatGPT（Codex），后端从本地源码构建。源码来源和 MIT 许可证位于 `THIRD_PARTY_LICENSES.txt`。

`THIRD_PARTY_LICENSES.txt` 随独立包和全家桶发布。修改协议后端时需重新验证 OAuth、RPC、工具策略和模型目录测试。

## 开发验证

构建后运行 `pnpm --filter @onenightcarnival/dsh-subscriptions test`，验证 RPC、工具开关和面板交互；运行 `pnpm --filter @onenightcarnival/dsh-subscriptions test:smoke`，在临时 DSH home 中启动真实 web 宿主，验证独立包、全家桶启用/关闭及接口认证。测试不读取个人凭证，也不调用真实模型。`node packages/subscriptions/test/preview.mjs` 提供仅使用示例数据的本地 UI 预览。
