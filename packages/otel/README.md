# dsh-otel

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的可观测上报插件，
带原生配置面板的离线 `.tgz` 包。把 DSH 的会话、Agent 循环、LLM 调用和工具生命周期作为
OpenTelemetry GenAI 调用链上报到 Langfuse 等 OTLP 兼容平台。

采集与 OTLP 管线来自 Apache-2.0 协议的
[@loongsuite/dsh-plugin](https://github.com/loongsuite/dsh-plugin)（已打进包内，见 THIRD-PARTY-NOTICES）。
本插件在它之上补了三件事：

- **原生配置面板**：DSH Web UI 的 设置 → 插件 里多一个「可观测上报」页，填 Public Key、
  Secret Key、Endpoint 三个参数，外加「启用上报」和「采集正文」两个开关。
- **保存即生效**：配置存在本机 DSH 数据目录（storage domain），保存后热重启采集管线，
  不用改 `cordis.patch.yml`，不用设环境变量，不用重启 DSH。
- **一键连通性测试**：面板里点「发送测试 Trace」会真发一条 span 到你填的后端，
  认证错误、地址写错、网络不通分别给出对应提示；成功后平台上能看到一条名为
  `dsh-otel connection test` 的调用链。

包内没有任何运行时依赖（OTel SDK、zod 等全部打进 `lib/`），安装时不需要访问 npm registry，
适合离线环境。

## 安装

tgz 从 [dsh-toolkit 的 Releases](https://github.com/Onenightcarnival/dsh-toolkit/releases) 下载（附 `SHA256SUMS.txt`），同一页还有把四个插件
打在一起的 `onenightcarnival-dsh-toolkit-<版本>.tgz`，二者装其一。

```sh
dsh plugin --profile web add /absolute/path/to/onenightcarnival-dsh-otel-<版本>.tgz
```

桌面版（[DeepSeek Harness Desktop](https://github.com/Onenightcarnival/deepseek-harness-desktop)）：
菜单「插件 → 配置中心 → 插件 → 从 .tgz 安装」，选中下载好的 tgz。

要观测 headless profile 的话再执行一次 `--profile headless`（headless 没有界面，
配置沿用同一存储）。

## 配置

打开 DSH Web UI，设置 → 插件 → 可观测上报：

| 字段 | 说明 |
| --- | --- |
| Endpoint | OTLP/HTTP 基地址。粘贴 Langfuse base url 会像官方 SDK 一样自动在其后补全 `/api/public/otel`（云端按域名识别，自建/网关部署按 `pk-lf-`/`sk-lf-` key 前缀识别，网关子路径如 `https://gateway.corp/langfuse` 也支持）；填以 `/v1/traces` 结尾的完整地址则原样使用，不做补全；通用 OTLP 后端（Jaeger、SigNoz、Collector 等）填到端口即可，如 `http://localhost:4318`。 |
| Public Key (pk) | Langfuse 项目设置 → API Keys 里的 `pk-lf-…`。和 sk 一起编码成 `Authorization: Basic` 请求头；两者都留空则不发认证头。 |
| Secret Key (sk) | `sk-lf-…`。只保存在本机 DSH 数据目录，不回显、不进入前端状态。 |
| 启用上报 | 总开关。关闭后采集器卸载，配置保留。 |
| 高级设置 | gzip 压缩（压缩 OTLP 请求体，网关限制 body 大小时开启，需服务端支持）；正文截断上限（默认 128000 字符，直接影响单批请求体大小）；单批最大 span 数（默认 512）。 |
| 采集正文 | 默认开。上报 prompt、回复、工具参数与结果正文；关闭后只上报结构元数据和 token 用量。正文可能包含源码和凭据，接入共享后端前先确认平台的留存与访问控制策略。 |

Langfuse 不接收 OTLP 指标，检测到 Langfuse 形态的 endpoint 时自动只上报 Trace，
避免周期性 4xx 报错；其他后端会同时上报 `gen_ai.client.operation.duration` 和
`gen_ai.client.token.usage` 指标。

所有 OTLP 导出（正式上报与测试）均关闭 HTTP keep-alive，每次导出新建连接：公司网关常会
无提示地掐掉空闲长连接，复用死连接会让隔一段时间后的第一批上报以 ECONNRESET/超时失败并
丢弃；批量导出的频率下新建连接的开销可以忽略。

「发送测试 Trace」分四段：先发一条小 span 验证连通与认证；再发一条约 900KB 的大负载
span 探测网关请求体限制（nginx `client_max_body_size` 默认 1m，超限 413）；再发一条
GenAI 形态的 trace（ENTRY→LLM 层级 + `gen_ai.*` 语义属性）；最后做「真实管线复刻」——用
包内采集器的真实映射代码驱动一轮合成对话（完整 resource 属性、完整属性集、
ENTRY→AGENT→STEP→LLM 层级、单批多 span 导出），与真实对话逐字节同形态。对
Langfuse 后端，测试还会用同一对 pk/sk 通过公开 API（`/api/public/traces/{id}`）回查两条
测试 trace 是否真正入库——Langfuse 的 OTLP 摄入是异步管线，返回 200 只代表"收到"，老版本
的 worker 处理不了 GenAI 形态 span 时会在入库阶段悄悄丢弃，客户端毫无感知；回查能当场
实锤"普通 trace 入库、GenAI trace 被丢"的服务端版本缺陷（处理办法：请部署方升级
Langfuse）。运行中采集器的导出失败也会桥接到 dsh 日志并显示在面板顶部
（「最近一次上报失败」）；面板还实时显示「累计导出」统计（批次 / span 数 / 最近一次结果）——
对话结束约 10 秒后刷新状态，计数不增长说明该对话根本没有经过本插件导出（多半是对话
发生在未启用本插件的 profile/实例）。「回查最近导出」按钮用 Langfuse API 逐条确认最近
导出的 trace（真实对话与测试分别标注）是否真正入库——"导出成功但未入库"就是服务端异步
摄入任务失败的实锤，可把 trace ID 交给部署方在 worker 日志中定位。旧版 Langfuse 的 OTLP
接口以任务 JSON 而非规范 protobuf 应答，导出器会记一条"could not deserialize response"
提示——导出本身成功，面板会将其显示为可忽略的提示而非失败。导出时还会为每个 span 自动
补上 `langfuse.session.id`/`session.id` 别名（值取自 `gen_ai.session.id`）——新版 Langfuse
按新版 GenAI 语义键归组 session，旧版只认这对老键，补别名后新旧版本都能正确归组会话。

数据模型、span 结构和隐私行为与 `@loongsuite/dsh-plugin` 一致：每轮对话一条
`ENTRY → AGENT → STEP → LLM/TOOL` 调用链，重试保留为同一 STEP 下的多次尝试，
subagent 会话生成独立 trace。详见其
[README](https://github.com/loongsuite/dsh-plugin/blob/main/README.zh-CN.md)。

## 与 @loongsuite/dsh-plugin 的关系

不要同时安装两者，会产生重复调用链。dsh-otel 适合想在界面里管理配置的场景；
习惯环境变量和 patch 文件、或需要它全部高级配置项（batch 大小、导出间隔等）的场景，
直接用上游插件即可。本插件对未暴露的配置项一律采用上游默认值。

## 开发

需要 Node.js 22.19+。在仓库根目录：

```sh
pnpm install
pnpm --filter @onenightcarnival/dsh-otel run build      # lib/{index,typert,remote,client}.js
pnpm --filter @onenightcarnival/dsh-otel run test       # 纯函数单测 + 本地 OTLP 桩的导出 e2e
pnpm --filter @onenightcarnival/dsh-otel pack           # onenightcarnival-dsh-otel-<版本>.tgz
```

集成测试（真实 cordis Context + 桩服务）：`node test/service.integration.mjs`。

### 结构

```
src/index.js          host 半：cordis Service（key: dshOtel）。配置存 storage domain，
                      保存后热重启内嵌的 loongsuite 采集器；test 方法走一条真实的
                      OTLP 导出管线
src/typert.js         host 侧 typert 清单（strict 派发编解码）
src/remote.js         client 侧 typert contribution（与 host 共用 descriptors）
src/schemas.js        zod 线上契约，两端共用
src/client/           浏览器半：设置页签注册（settings.plugins.tab slot）与表单
scripts/build.mjs     四个产物的 esbuild 配置；DSH 运行时自带的包保持 external，
                      其余全部打进产物。descriptors / typert / remote 以导出清单的包名为参数，
                      全家桶包用自己的名字再生成一份
```

兼容范围沿用内嵌采集器：DSH `>=0.1.0-rc.6 <0.2.0`（在 `0.1.1-rc.2` 的 web profile
实测通过）。

### 发布

发版流程见仓库根目录的 README。

## 许可证

本项目 MIT。打进包内的第三方代码按各自协议分发（loongsuite 与 OpenTelemetry 为
Apache-2.0，zod 与 schemastery 为 MIT），版权声明与 Apache-2.0 全文见
[THIRD-PARTY-NOTICES](./THIRD-PARTY-NOTICES)。
