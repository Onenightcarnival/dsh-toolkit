# @onenightcarnival/dsh-config-center

[English](README.md) | **中文**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的配置中心：主侧栏提供 MCP 服务器管理，「设置 → 内置插件」提供常用设置。

| 入口 | 内容 |
|---|---|
| 主侧栏 → MCP（AI 订阅前） | 服务器列表与运行状态；新增、编辑、启用 / 停用、删除；连接测试 |
| 设置 → 内置插件 → 常用设置 | 内置插件的常用配置项：goal 目标模式的轮数上限；上下文自动压缩的开关与触发阈值 |
| 设置 → 环境依赖 | 安装、检测和修复配置中心专属的 uv / uvx 环境 |

## Python MCP 环境

在「设置 → 环境依赖」点击安装，下载固定版本 uv 并校验发布时钉住的 SHA256。支持 Windows、macOS、glibc Linux 的 x64 / ARM64；插件包本身不携带二进制。下载失败可重试，损坏环境可修复。提供的 uv 版本随插件更新维护。

环境保存在当前 DSH 数据目录的 `tools/dsh-config-center/`：`uv/<版本>/<平台>/` 存放可执行文件，`python/`、`cache/`、`tools/`、`bin/` 存放专属 Python、依赖缓存和工具环境。首次运行 Python MCP 时按需联网下载解释器和依赖，启动器仅使用托管 Python。插件不查找或复用系统和桌面壳的 uv，也不修改全局 PATH。

MCP 命令填写 `uv` / `uvx` 时，测试和保存都解析为专属绝对路径，运行环境写入当前 profile 的 patch，重启后由官方 MCP 客户端直接使用。环境安装完成后，该 profile 中已有的裸 `uv` / `uvx` 命令也会转换；自定义绝对路径保持原样。手工配置在其他 overlay 中的条目不自动迁移。配置迁移到另一台机器后，需重新安装环境并调整路径。

MCP 页的「连接设置 → stdio 启动等待（秒）」默认为 900，可设为 1–86400 秒，对当前 profile 的所有 stdio 服务器生效，保存在 profile 下的 `dsh-config-center.json`。测试连接，以及首次保存或启用前的依赖准备使用此值；正在运行的条目不额外启动准备进程。官方内核接管后的握手与工具调用仍使用内核策略。代理沿用 DSH 进程的网络配置，Python 下载源可通过 MCP 环境变量 `UV_PYTHON_INSTALL_MIRROR` 设置。系统 Python 与项目 uv 配置不作为默认运行环境，用户显式传入的命令参数仍按 uv 自身语义执行。

开发验证：`node --test packages/config-center/test/*.test.mjs`；真实下载和 Python MCP 握手：`node packages/config-center/test/environment-live.mjs`（需联网，使用隔离目录）。

`test/fixtures/python-mcp/` 中的 Python 文件和 `pyproject.toml` 仅为真实安装测试提供一个最小 MCP 包，不属于插件运行代码，也不包含在发布的 `.tgz` 中。

## 安装

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-config-center-<版本>.tgz
```

集成包 `@onenightcarnival/dsh-toolkit` 已包含本插件，模块键 `configCenter`。

## 存储

MCP 和常用设置写在当前 profile 的 `cordis.patch.yml`。运行环境的数据目录见上文。

| 内容 | 在文件中的形态 |
|---|---|
| MCP 服务器 | 顶层 `insert` 列表里 `name` 为 `@deepseek-ai/dsh-mcp-client` 的条目 |
| 内置插件设置 | 顶层覆盖行 `- id: <条目>`：`config` 的一个键，或 `disabled` 字段 |

编辑按条目 id 定位。其余行、注释与 `!!js` 表达式保持原样；表单未改动的字段保留原有写法；表单之外的字段（超时、重连策略）保留。手写的 MCP 条目同样出现在列表里。

| 操作 | 文件变化 |
|---|---|
| 新增服务器 | 条目 id 为 `mcp-<名称>`，追加到已有 MCP 条目所在的 `insert` 列表；没有则新建一行 |
| 改名 | id 形如 `mcp-<旧名称>` 的条目随名称改为 `mcp-<新名称>`；手写的 id 不变 |
| 启用 / 停用 | 写条目的 `disabled`，同 id 覆盖行里的 `disabled` 移除 |
| 删除服务器 | 移除条目与同 id 的覆盖行；空的 `insert` 列表一并移除 |
| 设置留空 | 移除对应的键；只剩 `id` 的覆盖行一并移除 |

## 生效

| 宿主 | 保存后 |
|---|---|
| 开启热重载（web profile 默认） | 经 Loader 协调立即生效；协调失败时文件与运行中的组合恢复原状，接口返回错误 |
| 未开启热重载 | 写入文件，重启 dsh 后生效 |

保存启用中的 MCP 服务器会等待首次连接完成。`npx` / `uvx` 首次运行需下载依赖。

## 表达式

以 `!!js ` 开头的字段值是 Loader 表达式，写入文件时为 `!!js` 标量，由宿主在加载时求值：

```text
!!js process.env.GITHUB_TOKEN
!!js `Bearer ${process.env.MCP_TOKEN}`
```

## 运行状态

| 状态 | 含义 |
|---|---|
| 已连接 | 条目已加载，`mcp__<名称>__` 前缀下有已注册的工具 |
| 已加载，未提供工具 | 条目已加载，未注册工具：未连接，或服务器没有工具 |
| 加载中 | 条目正在启动 |
| 加载失败 | 条目启动失败，附错误信息 |
| 已停用 | 条目被停用 |
| 尚未加载 | 条目在文件里，运行中的组合没有它 |

## 连接测试

测试独立于运行中的组合，使用表单当前的值，不写文件。

| 连接方式 | 过程 | 超时 |
|---|---|---|
| stdio | 启动命令、准备依赖，完成 `initialize` 与 `tools/list`，然后结束进程 | 默认 900 秒，可配置 |
| streamable-http | POST `initialize`，在同一会话上 `tools/list` | 每个请求 8 秒 |

## 接口

路径前缀 `/api/dsh-config-center`。仅本机回环地址可访问，需要 Web 界面的浏览器会话。

| 请求 | 作用 |
|---|---|
| `GET /mcp` | 服务器列表与运行状态 |
| `POST /mcp` | 新增或更新：`{ id?, server }` |
| `DELETE /mcp?id=<id>` | 删除 |
| `POST /mcp/test` | 连接测试：`{ server }` |
| `POST /mcp/preferences` | 保存启动等待时间：`{ stdioTimeoutSeconds }`；`GET /mcp` 返回当前值 |
| `GET /settings` | 设置项与当前覆盖值 |
| `POST /settings` | 保存：`{ values }`，值为 `null` 表示恢复默认 |
| `GET /environment` | 专属环境的版本、路径、可用状态和安装进度 |
| `POST /environment` | 开始安装或修复；返回 `202`，轮询 `GET` 获取结果 |

| 状态码 | 含义 |
|---|---|
| `400` | 字段无效，`issue` 为原因 |
| `409` | 编辑被拒绝：名称重复、id 被占用、条目不存在或专属环境未就绪 |
| `500` | 写入或协调失败，文件已恢复 |

## 配置

```yaml
- id: config-center
  config:
    enabled: false   # 关闭接口；默认 true
```

## 增加设置项

`src/settings.ts` 的 `SETTINGS` 加一行；新条目的第一项在 `SETTING_GROUPS` 加条目 id。文案加到 `src/client/locales.ts` 的 `setting.<key>`、`setting.<key>.hint`、`group.<条目 id>`、`group.<条目 id>.hint`。

## 开发

```sh
pnpm --filter @onenightcarnival/dsh-config-center run build
pnpm --filter @onenightcarnival/dsh-config-center run test         # patch 文档编辑
pnpm --filter @onenightcarnival/dsh-config-center run test:smoke   # 真实宿主，隔离的数据目录
```

## 协议

MIT。第三方声明：[THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt)。
