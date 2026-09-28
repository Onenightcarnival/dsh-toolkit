# @onenightcarnival/dsh-subscriptions

[English](README.md) | **中文**

全家桶的 AI 订阅子包，首版仅接入 ChatGPT。侧边栏「AI 订阅」采用与 S3 / RDB 相同的账号列表、主面板、主题颜色与中英文界面。

## 使用

安装独立包或全家桶，二选一：

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-subscriptions-0.6.0.tgz
```

1. 打开「AI 订阅」，点击「连接 ChatGPT」，在浏览器完成 OAuth 授权。自动回调依次尝试本机 1455、1457 端口；两者都被系统保留或占用时会自动切换为手动模式。完成授权后，即使浏览器的 localhost 页面显示无法访问，也请复制地址栏中的完整 URL，回到面板粘贴并提交。
2. 在会话模型选择器的 ChatGPT (Codex) 分组选择模型。模型目录按账号发现，支持刷新、显示筛选和默认推理强度。
3. 「工具」中可开关 Web Search 和图像生成。搜索接入 DSH 原生 `web_search`，在「设置 → 联网搜索」选择 `codex` 提供方，保留原生引用展示。关闭后允许其他搜索提供方接手。
4. 在对话中请求生图或编辑图片，agent 调用 `image_generate`；生成文件保存在 DSH home 的 `plugins/subscriptions/images/`，有附件服务时可直接在对话中预览、下载，并继续编辑。
5. 「用量」显示所选账号的额度窗口与重置时间，支持刷新。可添加多个账号、设置默认账号或断开连接。

搜索开关立即生效；生图工具策略以会话创建时为准，修改后请新建会话。模型、搜索和生图的实际可用性取决于账号权限及额度，离线测试无法验证账号权益。这里通过 ChatGPT 订阅的 Codex 后端接入，不需要填写 OpenAI API key。

## 配置

全家桶默认挂载本模块，`subscriptions: false` 同时关闭主机与界面：

```yaml
- id: toolkit
  config:
    subscriptions: false
```

独立包插件 ID 为 `subscriptions`。可选配置：`enabled`、`codexClientVersion`、`streamIdleTimeoutMs`、`rateLimit`，以及用于覆盖自动发现的 `models` 数组（包含 `id`，可选 `name`、`contextWindow`、`inputModalities`）。一般保留默认值即可；手动模型列表不会增加账号权限。

凭证和设置由主机保存在 DSH home 的 `plugins/subscriptions/`，沿用参考插件的数据格式。界面只读取不含 token 的账号状态；RPC 通过 DSH 已认证的连接。不要同时加载原版 `dsh-plugin-subscriptions`，两者使用相同的 provider、工具和 RPC 名称。

## 源码维护

订阅后端作为二次开发分支维护在本仓库的 `src/backend`，直接从源码构建，不依赖原插件的 npm 包。后端包含 OAuth PKCE、令牌刷新、流式模型适配、原生搜索和图片附件处理，目前仅启用 ChatGPT（Codex）。原始代码来源和 MIT 许可证保留在 `THIRD_PARTY_LICENSES.txt`。

`THIRD_PARTY_LICENSES.txt` 随独立包和全家桶发布。修改协议后端时需重新验证 OAuth、RPC、工具策略和模型目录测试。

## 开发验证

构建后运行 `pnpm --filter @onenightcarnival/dsh-subscriptions test`，验证 RPC、工具开关和面板交互；运行 `pnpm --filter @onenightcarnival/dsh-subscriptions test:smoke`，在临时 DSH home 中启动真实 web 宿主，验证独立包、全家桶启用/关闭及接口认证。测试不读取个人凭证，也不调用真实模型。`node packages/subscriptions/test/preview.mjs` 提供仅使用示例数据的本地 UI 预览。
