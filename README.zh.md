# dsh-toolkit

[English](README.md) | **中文**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的插件集合：一个仓库、一个版本号、一次发版。

| 包 | 内容 | 界面入口 |
|---|---|---|
| [`@onenightcarnival/dsh-rdb`](packages/rdb/README.zh.md) | 关系数据库工作台：SQLite / PostgreSQL / MySQL / GaussDB，数据网格、结构、SQL 编辑器，`db_*` 工具 | 侧边栏「数据库」 |
| [`@onenightcarnival/dsh-s3`](packages/s3/README.zh.md) | S3 兼容对象存储浏览器：MinIO / OSS / COS / R2，`s3_*` 工具 | 侧边栏「S3」 |
| [`@onenightcarnival/dsh-otel`](packages/otel/README.md) | OpenTelemetry GenAI 上报到 Langfuse 等 OTLP 后端 | 设置 → 插件 → 可观测上报 |
| [`@onenightcarnival/dsh-bridge-browser`](packages/browser-bridge/README.zh.md) | 浏览器桥：`browser_*` 工具经 Chrome / Firefox 扩展操作用户的标签页 | 设置 → 通用设置 → 浏览器桥地址 |
| [`@onenightcarnival/dsh-toolkit`](packages/toolkit) | 以上四个打进一个包 | 同上 |
| [`dsh-browser-extension`](extensions/dsh-browser/README.zh.md) | Chrome / Firefox MV3 扩展，与浏览器桥配对 | 浏览器侧边栏 |

当前对应 dsh `0.1.5-rc.2`，即 [DeepSeek Harness Desktop](https://github.com/Onenightcarnival/deepseek-harness-desktop) 内置的版本。

## 安装

每个 [Release](https://github.com/Onenightcarnival/dsh-toolkit/releases) 附带：

| 文件 | 用途 |
|---|---|
| `onenightcarnival-dsh-toolkit-<版本>.tgz` | 全家桶：四个插件一次装齐 |
| `onenightcarnival-dsh-rdb-<版本>.tgz` 等四个 | 单独安装某一个插件 |
| `dsh-browser-extension-chrome-<版本>.zip` | Chrome 扩展，解压后以未打包扩展加载 |
| `SHA256SUMS.txt` | 校验和 |

全家桶与单包二选一，不要同时安装。

**桌面版**：「插件 → 配置中心… → 插件 → 从 .tgz 安装」，选中 tgz，按提示重启。

**dsh 命令行**：

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-toolkit-<版本>.tgz
dsh web
```

**Chrome 扩展**：把 zip 解压到一个固定目录，`chrome://extensions` 开启「开发者模式」，「加载已解压的扩展程序」选中该目录。桥地址自动发现，本机无需 token。Firefox 从源码构建，见 [docs/browser.zh.md](docs/browser.zh.md)。

### 全家桶的模块开关

全家桶在 web profile 里是一行 `toolkit`，四个模块各有一个配置键，设为 `false` 即不挂载（主机与界面同时生效）。在 `~/.dsh/profiles/web/cordis.patch.yml` 覆盖时整段 `config` 会替换，其余键按需一并写出：

```yaml
- id: toolkit
  config:
    otel: false
    browser:
      discoveryPort: 43189
```

其余键与各单包的配置一致：`rdb`、`s3` 见各自 README，`browser` 见 [浏览器桥的配置](packages/browser-bridge/README.zh.md#配置)。

### 从旧版单包迁移

0.5.0 起包名带 `@onenightcarnival/` scope，旧的 `dsh-rdb`、`dsh-s3`、`dsh-otel` 不能原地升级：先在插件管理器里移除旧包，再安装新包。连接、凭证与设置存在 `~/.dsh` 下，与包名无关，迁移后保留。

## 目录

```
packages/rdb              @onenightcarnival/dsh-rdb
packages/s3               @onenightcarnival/dsh-s3
packages/otel             @onenightcarnival/dsh-otel
packages/browser-bridge   @onenightcarnival/dsh-bridge-browser
packages/toolkit          @onenightcarnival/dsh-toolkit：host 半挂载四个模块并提供 /api/dsh-toolkit/modules，
                          client 半按该清单挂载各模块的界面，typert 清单以本包名重新生成
extensions/dsh-browser    Chrome / Firefox 扩展（vite）
benchmark                 浏览器操作的 Playwright 对照评测
docs/browser.zh.md        浏览器操作的完整说明（桌面版发现信标、排查、安全模型）
scripts/build-plugin.mjs  各插件共用的 esbuild 驱动：host bundle + 模块加载器封装的 client bundle
scripts/version.mjs       一个版本号写进全部 package.json、扩展 manifest 与 otel 的 PLUGIN_VERSION
scripts/package.mjs       打出 dist/ 里的全部发布产物
scripts/check-runtime.mjs 校验根目录锁定的 dsh 运行时
scripts/smoke-runtime.mjs 用临时 DSH home 启动真实 web 宿主跑浏览器桥
```

## 开发

Node.js `^22.19 || >=24`，pnpm 11。全部命令在仓库根目录执行。

```sh
pnpm install
pnpm run build        # 全部包，按依赖顺序
pnpm run typecheck
pnpm run test
pnpm run package      # dist/：五个 tgz、扩展 zip、SHA256SUMS.txt

pnpm --filter @onenightcarnival/dsh-rdb run build      # 单个包
pnpm --filter dsh-browser-extension run build:firefox
```

各插件 host 半的构建把第三方依赖全部打进 `lib/index.js`（`@deepseek-ai/*` 由 dsh 运行时提供，保持 external），tgz 安装不访问 npm registry。全家桶直接从四个子包的源码打包，不依赖子包的构建产物；它的 typecheck 覆盖四个子包的源码，整个 workspace 只有一条 dsh 版本线（`pnpm-workspace.yaml` 的 overrides）。

安装验证：`DSH_HOME=<临时目录> dsh plugin --profile web add file:<tgz>` 装进临时 profile，`dsh web --no-open --port 0` 启动后用就绪行里的 token URL 换 cookie，再打 `/api/dsh-toolkit/modules`、`/api/dsh-rdb/profiles`、`/api/dsh-s3/profiles`、`/ext/bridge-config`。同一个 token 只能换一次 cookie；pnpm 对同版本号的 file: 包复用 store 里的旧内容，迭代时先 `plugin remove` 再 add。

## 发版

版本号只有一个，由 `scripts/version.mjs` 写进全部包、扩展 manifest 与 otel 的 `PLUGIN_VERSION`：

```sh
node scripts/version.mjs set 0.5.1
git commit -am "v0.5.1" && git tag v0.5.1 && git push origin main v0.5.1
```

推送 tag 触发 `.github/workflows/release.yml`：tag 与提交的版本号不一致即失败；一致则安装、typecheck、构建、测试、打包，把 `dist/` 里的全部文件挂到同名 GitHub Release。带预发布后缀的 tag（`v0.5.1-rc.1`）标为 pre-release，浏览器 manifest 只取数字部分。GitHub Desktop 里的操作：History 中右键目标 commit → Create Tag → 再 Push origin 一次。

## 许可

MIT。打进包内的第三方代码按各自协议分发，见各包的 `THIRD-PARTY-NOTICES`。
