# @onenightcarnival/dsh-toolkit

[English](README.md) | **中文**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的集成插件包，包含九个模块。各模块保留独立插件的面板、工具、设置、数据文件和 API 路径。

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
| `http` | HTTP API 请求 | [HTTP](../http/README.zh.md) |
| `otel` | 可观测上报 | [OTel](../otel/README.md) |
| `browser` | 浏览器操作 | [Browser bridge](../browser-bridge/README.zh.md#配置) |
| `subscriptions` | AI 订阅 | [Subscriptions](../subscriptions/README.zh.md) |
| `memory` | 履历式记忆 | [Memory](../memory/README.zh.md) |
| `gateway` | API 网关 | [API 网关](../gateway/README.zh.md#面板) |
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

模块按 `rdb → s3 → http → otel → browser → subscriptions → configCenter → memory → gateway` 顺序挂载。接口返回配置启用的模块清单：

```json
{"rdb":true,"s3":true,"http":true,"otel":false,"browser":true,"subscriptions":true,"configCenter":true,"memory":true,"gateway":true}
```

| 请求 | 响应 |
|---|---|
| `GET /api/dsh-toolkit/modules` | `200`，模块布尔值映射，`Cache-Control: no-store` |
| 其他方法 | `405`，空 JSON 对象 |

## 侧栏入口

集成包保存宿主侧栏的固定状态。固定与取消固定使用宿主自带的控件，适用于全部插件的侧栏入口（含 SSH、任务看板等第三方插件）：

| 操作 | 位置 |
|---|---|
| 取消固定 | 侧栏展开时入口行上的取消固定按钮 |
| 固定 | 「更多」菜单中未固定入口上的固定按钮 |
| 打开未固定的入口 | 「更多」菜单中的入口行 |

| 时机 | 行为 |
|---|---|
| 启动 | 侧栏注册后，已保存的未固定入口从侧栏移入「更多」菜单 |
| 固定或取消固定 | 当前未固定集合立即保存 |
| 保存失败 | 侧栏恢复到上一次保存的状态，控制台记录警告 |

未固定入口的功能与数据不受影响。「插件」入口始终固定。固定状态取自宿主 `sidebar` 槽位注册项的注入对象；宿主不提供该对象时不保存固定状态。

toolkit 模块入口：

| 入口 | 模块 | 入口 ID |
|---|---|---|
| 数据库 | `rdb` | `rdb` |
| S3 | `s3` | `s3` |
| HTTP | `http` | `http` |
| MCP | `configCenter` | `dsh-config-center-mcp` |
| 记忆 | `memory` | `memory` |
| 技能 | `configCenter` | `dsh-config-center-skills` |
| AI 订阅 | `subscriptions` | `subscriptions` |
| API 网关 | `gateway` | `gateway` |

已卸载插件的入口 ID 保留在设置中，重新安装后保持未固定。

设置保存在当前 profile 目录的 `dsh-toolkit.json`（`hiddenSidebarPanels`），例如 `~/.dsh/profiles/web/dsh-toolkit.json`：

```json
{"hiddenSidebarPanels":["rdb","task-board"]}
```

| 请求 | 响应 |
|---|---|
| `GET /api/dsh-toolkit/sidebar` | `200`，`{"hidden":[未固定的入口 ID…]}` |
| `PUT /api/dsh-toolkit/sidebar`，请求体 `{"hidden":[…]}` | `200`，保存后的同一结构；ID 须为 1–128 个可打印字符，最多 200 个，否则返回 `400`；非回环或跨站请求返回 `403` |
| 其他方法 | `405`，空 JSON 对象 |

## 结构

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 宿主模块挂载、模块清单接口与侧栏设置接口 |
| `src/client.ts` | 按宿主清单挂载客户端插件、保存侧栏固定状态、注册设置页导航图标 |
| `src/modules.ts` | 模块顺序、清单类型、入口 ID 约束与 API 路径 |
| `src/preferences.ts` | profile 目录内的 `dsh-toolkit.json` 读写 |
| `src/client/sidebar.ts` | 未固定入口集合与保存请求 |
| `src/client/pins.ts` | 宿主侧栏固定状态与已保存集合的双向同步 |
| `src/client/section-icons.tsx` | 可观测、环境依赖、本机日志设置页的导航图标（`settings.section.icon` 槽位，按设置页 id 注册） |
| `src/typert.ts` | 以集成包名注册 OTel typert 清单 |
| `build.mjs` | 九个模块源码的宿主与客户端构建 |

## 许可

MIT。第三方声明见 [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt)。
