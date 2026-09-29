# dsh-toolkit

[English](README.md) | **中文**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）插件集合，提供数据库、对象存储、可观测上报、浏览器操作和 AI 订阅。所有包共用版本号与发布流程。

| 包 | 内容 | 界面入口 |
|---|---|---|
| [`@onenightcarnival/dsh-rdb`](packages/rdb/README.zh.md) | 关系数据库工作台：SQLite / PostgreSQL / MySQL / GaussDB，数据网格、结构、SQL 编辑器，`db_*` 工具 | 侧边栏「数据库」 |
| [`@onenightcarnival/dsh-s3`](packages/s3/README.zh.md) | S3 兼容对象存储浏览器：MinIO / OSS / COS / R2，`s3_*` 工具 | 侧边栏「S3」 |
| [`@onenightcarnival/dsh-otel`](packages/otel/README.md) | OpenTelemetry GenAI 上报到 Langfuse 等 OTLP 后端 | 设置 → 插件 → 可观测上报 |
| [`@onenightcarnival/dsh-bridge-browser`](packages/browser-bridge/README.zh.md) | 浏览器桥：`browser_*` 工具经 Chrome / Firefox 扩展操作用户的标签页 | 设置 → 通用设置 → 浏览器桥地址 |
| [`@onenightcarnival/dsh-subscriptions`](packages/subscriptions/README.zh.md) | ChatGPT、Google Antigravity 订阅模型及 Codex 搜索与生图工具 | 侧边栏「AI 订阅」 |
| [`@onenightcarnival/dsh-toolkit`](packages/toolkit/README.zh.md) | 五个插件的集成包 | 各模块对应入口 |
| [`dsh-browser-extension`](extensions/dsh-browser/README.zh.md) | Chrome / Firefox MV3 扩展，与浏览器桥配对 | 浏览器侧边栏 |

## 运行时兼容性

| Toolkit 版本 | dsh 运行时 |
|---|---|
| 0.6.x | `0.1.7-rc.2`（本仓库锁定版本） |
| 0.5.x | `0.1.5-rc.2` |

插件与宿主使用同一运行时版本线。版本不匹配会导致 typert 校验失败，影响界面加载。

## 安装

每个 [Release](https://github.com/Onenightcarnival/dsh-toolkit/releases) 附带：

| 文件 | 用途 |
|---|---|
| `onenightcarnival-dsh-toolkit-<版本>.tgz` | 集成安装五个插件 |
| `onenightcarnival-dsh-rdb-<版本>.tgz` 等五个 | 单独安装某一个插件 |
| `dsh-browser-extension-chrome-<版本>.zip` | Chrome 扩展，解压后以未打包扩展加载 |
| `SHA256SUMS.txt` | 校验和 |

安装方式：集成包或独立插件，二者互斥。

**桌面版**：「插件 → 配置中心… → 插件 → 从 .tgz 安装」，选中 tgz，按提示重启。

**dsh 命令行**：

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-toolkit-<版本>.tgz
dsh web
```

**Chrome 扩展**：zip 解压至固定目录 → `chrome://extensions` →「开发者模式」→「加载已解压的扩展程序」。本机 Chrome 自动发现桥地址，无需输入 token。Firefox 使用源码构建并配置 token，见[浏览器操作](docs/browser.zh.md)。

### 模块配置

web profile 插件 ID 为 `toolkit`。配置位于 `~/.dsh/profiles/web/cordis.patch.yml`。

| 模块配置值 | 宿主与界面行为 |
|---|---|
| 省略或 `{}` | 启用模块，使用默认配置 |
| 配置对象 | 启用模块，使用对应独立插件的配置 |
| `false` | 禁用模块 |

覆盖操作替换整段 `config`，已有自定义值需一并列出。以下配置禁用可观测上报，将浏览器发现端口设为 `43189`，其余模块使用默认配置：

```yaml
- id: toolkit
  config:
    otel: false
    browser:
      discoveryPort: 43189
```

其余键与各单包的配置一致：`rdb`、`s3` 见各自 README，`browser` 见 [浏览器桥的配置](packages/browser-bridge/README.zh.md#配置)。

### 从旧版单包迁移

0.5.0 起包名使用 `@onenightcarnival/` scope。迁移顺序：移除旧的 `dsh-rdb`、`dsh-s3`、`dsh-otel` → 安装对应新包。连接、凭证与设置保存在 `~/.dsh`，迁移后保留。

## 目录

| 路径 | 职责 |
|---|---|
| `packages/{rdb,s3,otel,browser-bridge,subscriptions}` | 五个独立插件 |
| `packages/toolkit` | 模块配置、宿主挂载、界面挂载与 typert 注册 |
| `extensions/dsh-browser` | Chrome / Firefox MV3 扩展 |
| `benchmark` | 浏览器操作的 Playwright 对照评测 |
| `docs/browser.zh.md` | 浏览器安装、能力、故障排查与安全边界 |
| `scripts/build-plugin.mjs` | 共享 esbuild 构建：宿主与客户端产物 |
| `scripts/version.mjs` | 包、扩展 manifest 与 OTel 版本同步 |
| `scripts/package.mjs` | 发布产物与校验和 |
| `scripts/check-runtime.mjs` | 运行时版本校验 |
| `scripts/smoke-runtime.mjs` | 隔离数据目录中的真实宿主验证 |

## 开发

Node.js `^22.19 || >=24`，pnpm 11。全部命令在仓库根目录执行。

```sh
pnpm install
pnpm run build        # 全部包，按依赖顺序
pnpm run typecheck
pnpm run test
pnpm run package      # dist/：六个 tgz、扩展 zip、SHA256SUMS.txt

pnpm --filter @onenightcarnival/dsh-rdb run build      # 单个包
pnpm --filter dsh-browser-extension run build:firefox
```

### 构建契约

| 项目 | 约定 |
|---|---|
| 宿主依赖 | `@deepseek-ai/*` 由 dsh 提供；其余依赖按各包构建配置内联 |
| 订阅认证依赖 | `@cortexkit/antigravity-auth-core` 保留为 subscriptions 与 toolkit 的运行时依赖 |
| 集成包 | 直接编译五个子包的源码；类型检查覆盖同一组源码 |
| 运行时版本 | `pnpm-workspace.yaml` 的 overrides 统一锁定 |

### 安装验证

1. 将 `DSH_HOME` 指向临时目录，执行 `dsh plugin --profile web add file:<tgz>`。
2. 执行 `dsh web --no-open --port 0`，使用就绪日志中的 token URL 换取 cookie。每个 token 仅可兑换一次。
3. 携带 cookie 检查 `/api/dsh-toolkit/modules`、`/api/dsh-rdb/profiles`、`/api/dsh-s3/profiles` 和 `/ext/bridge-config`。

同版本 `file:` 包的安装内容由 pnpm store 缓存；重新验证前先执行 `plugin remove`，再安装。

## 发版

发布版本取自 `v<版本>` tag：

```sh
git tag v<版本>
git push origin v<版本>
```

| 阶段 | 结果 |
|---|---|
| 安装 | 使用锁文件安装依赖 |
| 版本同步 | `scripts/version.mjs set` 将 tag 版本写入包、扩展 manifest 与 OTel `PLUGIN_VERSION` |
| 验证与构建 | 类型检查 → 构建 → 测试 → 打包 |
| 发布 | `dist/` 全部文件附加到同名 GitHub Release |

流程定义：[release.yml](.github/workflows/release.yml)。产物版本以 tag 为准；仓库版本通过 `pnpm version:set <版本>` 同步。带预发布后缀的 tag 标记为预发布，浏览器 manifest 仅保留数字版本。

## 许可

MIT。第三方声明见 [OTel](packages/otel/THIRD-PARTY-NOTICES)、[Subscriptions](packages/subscriptions/THIRD_PARTY_LICENSES.txt) 和 [Toolkit](packages/toolkit/THIRD_PARTY_LICENSES.txt)。
