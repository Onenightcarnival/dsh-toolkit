# @onenightcarnival/dsh-toolkit

[English](README.md) | **中文**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的集成插件包，包含七个模块。各模块保留独立插件的面板、工具、设置、数据文件和 API 路径。

## 安装

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-toolkit-<版本>.tgz
```

桌面版入口：插件 → 配置中心… → 插件 → 从 .tgz 安装。

集成包与独立插件互斥。运行时兼容性见[仓库说明](../../README.zh.md#运行时兼容性)。

## 模块配置

| 配置键 | 模块 | 配置参考 |
|---|---|---|
| `rdb` | 关系数据库 | [RDB](../rdb/README.zh.md) |
| `s3` | 对象存储 | [S3](../s3/README.zh.md) |
| `otel` | 可观测上报 | [OTel](../otel/README.md) |
| `browser` | 浏览器操作 | [Browser bridge](../browser-bridge/README.zh.md#配置) |
| `subscriptions` | AI 订阅 | [Subscriptions](../subscriptions/README.zh.md) |
| `memory` | 履历式记忆 | [Memory](../memory/README.zh.md) |
| `configCenter` | 配置中心 | [Config center](../config-center/README.zh.md#配置) |

web profile 插件 ID：`toolkit`。配置文件：`~/.dsh/profiles/web/cordis.patch.yml`。

| 配置值 | 行为 |
|---|---|
| 省略或 `{}` | 启用模块，使用默认配置 |
| 配置对象 | 启用模块，配置传入对应独立插件 |
| `false` | 禁用宿主模块及对应界面 |

覆盖操作替换整段 `config`，已有自定义值需一并列出。以下配置禁用 OTel，浏览器发现端口为 `43189`，其余模块使用默认配置：

```yaml
- id: toolkit
  config:
    otel: false
    browser:
      discoveryPort: 43189
```

## 挂载流程

```text
config → 宿主挂载模块 → GET /api/dsh-toolkit/modules → 客户端挂载对应界面
```

模块按 `rdb → s3 → otel → browser → subscriptions → configCenter → memory` 顺序挂载。接口返回配置启用的模块清单：

```json
{"rdb":true,"s3":true,"otel":false,"browser":true,"subscriptions":true,"configCenter":true,"memory":true}
```

| 请求 | 响应 |
|---|---|
| `GET /api/dsh-toolkit/modules` | `200`，模块布尔值映射，`Cache-Control: no-store` |
| 其他方法 | `405`，空 JSON 对象 |

## 结构

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 宿主模块挂载与模块清单接口 |
| `src/client.ts` | 按宿主清单挂载客户端插件 |
| `src/modules.ts` | 模块顺序、清单类型与 API 路径 |
| `src/typert.ts` | 以集成包名注册 OTel typert 清单 |
| `build.mjs` | 七个模块源码的宿主与客户端构建 |

## 许可

MIT。第三方声明见 [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt)。
