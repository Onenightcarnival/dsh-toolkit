# dsh-otel

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）可观测上报插件，将会话、Agent 循环、LLM 调用与工具生命周期导出到 Langfuse 等 OTLP 兼容平台。

| 能力 | 行为 |
|---|---|
| 配置入口 | 设置 → 可观测（位于「侧边卡片」下方） |
| 配置存储 | 本机 DSH storage domain |
| 保存配置 | 热重启采集管线，即时生效 |
| 连通性测试 | 真实 OTLP 导出、负载探测、GenAI 调用链与管线验证 |
| 依赖 | 采集器、OTel SDK 与其他第三方依赖内联至 `lib/` |

## 安装

发布产物见 [Releases](https://github.com/Onenightcarnival/dsh-toolkit/releases)。独立包与 `dsh-toolkit` 集成包互斥。

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-otel-<版本>.tgz
```

桌面版入口：插件 → 配置中心 → 插件 → 从 .tgz 安装。

Headless 使用 `--profile headless` 安装，配置与 web profile 共用存储。运行时版本见[兼容性表](../../README.zh.md#运行时兼容性)。

## 配置

| 字段 | 契约 |
|---|---|
| Endpoint | OTLP/HTTP 基地址，归一化规则见下表 |
| Public Key | 与 Secret Key 组成 `Authorization: Basic`；两者均为空时省略认证头 |
| Secret Key | 仅保存在宿主，界面不回显 |
| 启用上报 | 关闭后卸载采集器，保留配置 |
| 采集正文 | 默认开启；导出 prompt、回复、工具参数与结果。关闭后仅导出结构元数据与 token 用量 |
| gzip 压缩 | 压缩 OTLP 请求体，接收端需支持 gzip |
| 正文截断上限 | 默认 `128000` 字符 |
| 单批最大 span 数 | 默认 `512` |

正文可能包含源码和凭据，访问与留存权限由接收平台管理。

### Endpoint 与导出

| 输入或后端 | 行为 |
|---|---|
| Langfuse 云端地址 | 按域名识别，补全 `/api/public/otel` |
| 自建 Langfuse / 网关 | 按 `pk-lf-` / `sk-lf-` 前缀识别，保留网关子路径并补全 `/api/public/otel` |
| 以 `/v1/traces` 结尾的地址 | 原样使用 |
| 通用 OTLP 后端 | 使用基地址，如 `http://localhost:4318` |
| Langfuse | 仅导出 Trace |
| 其他 OTLP 后端 | 导出 Trace、`gen_ai.client.operation.duration` 和 `gen_ai.client.token.usage` |
| HTTP 连接 | 正式导出与测试均禁用 keep-alive，每次导出新建连接 |

## 调用链

```text
ENTRY → AGENT → STEP → LLM / TOOL
```

每轮对话对应一条 trace；重试记录为同一 STEP 下的多次尝试，subagent 会话使用独立 trace。

每个 span 的 `langfuse.session.id` 和 `session.id` 均取自 `gen_ai.session.id`，供不同 Langfuse 版本归组会话。采集模型来自内嵌的 `@loongsuite/dsh-plugin`。

## 诊断

### 发送测试

| 阶段 | 数据 | 验证范围 |
|---|---|---|
| 连通性 | 小型 span | 地址、网络与认证 |
| 负载 | 约 900 KB 的 span | 网关请求体限制 |
| GenAI | `ENTRY → LLM` 与 `gen_ai.*` 属性 | GenAI 结构接收 |
| 采集管线 | 合成对话、完整 resource 与属性、`ENTRY → AGENT → STEP → LLM`、单批多 span | 内嵌采集器映射与真实 OTLP 导出 |

Langfuse 测试使用同一组凭证，通过 `/api/public/traces/{id}` 回查测试 trace。OTLP 接收成功与异步入库状态分别展示。

### 运行状态

| 状态或操作 | 含义 |
|---|---|
| 最近一次上报失败 | 采集器导出错误，同时写入 dsh 日志 |
| 累计导出 | 批次、span 数和最近一次结果 |
| 检查上报 | 逐条查询 Langfuse 入库状态，区分真实对话与测试 |
| 对话结束约 10 秒后计数未增长 | 检查该对话所在 profile / 实例是否启用插件 |
| 导出成功但未入库 | 接收端异步摄入待排查；trace ID 用于定位 worker 日志 |
| 旧版 Langfuse 返回任务 JSON | `could not deserialize response` 显示为兼容性提示 |
| 普通 trace 入库、GenAI trace 缺失 | 检查 Langfuse worker 的 GenAI 支持与版本 |

## 插件边界

本插件与 `@loongsuite/dsh-plugin` 互斥，同时启用会产生重复调用链。未暴露到面板的采集选项使用内嵌采集器的默认值。

## 开发

仓库根目录命令：

```sh
pnpm install
pnpm --filter @onenightcarnival/dsh-otel run build
pnpm --filter @onenightcarnival/dsh-otel run test
pnpm --filter @onenightcarnival/dsh-otel pack
node packages/otel/test/service.integration.mjs
```

测试覆盖纯函数、本地 OTLP 服务导出和真实 Cordis Context 集成。发布流程见[仓库说明](../../README.zh.md#发版)。

| 路径 | 职责 |
|---|---|
| `src/index.js` | `dshOtel` 服务、配置存储、采集器生命周期与诊断 |
| `src/typert.js` | 宿主 typert 清单 |
| `src/remote.js` | 客户端 typert contribution |
| `src/descriptors.js` | 两端共用的服务描述 |
| `src/schemas.js` | 两端共用的 zod 契约 |
| `src/client/` | 设置页签与表单 |
| `scripts/build.mjs` | 宿主、typert、remote 和客户端产物 |

`@deepseek-ai/*` 由宿主提供，其余依赖内联。typert、remote 和 descriptors 以包名参数化，独立包与集成包分别生成注册信息。

## 许可

本项目 MIT。采集管线来自 Apache-2.0 的 [@loongsuite/dsh-plugin](https://github.com/loongsuite/dsh-plugin)。第三方版权声明与许可全文见 [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES)。

## Interface language

Settings labels, controls, status and operation summaries follow the host Chinese or English language. Expanded diagnostic details and synthetic test records use English.
