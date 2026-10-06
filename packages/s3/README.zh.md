# dsh-s3

[English](README.md) | **中文**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）S3 兼容对象存储浏览器。入口：Web 侧边栏「S3」。

| 界面 | 功能 |
|---|---|
| 连接 | Bucket、Endpoint、Region、AK/SK、路径风格与前缀 |
| 对象 | 浏览、上传、下载、预览、重命名与删除 |
| 分享 | 限时预签名链接 |
| Agent | 全局 `s3_*` 工具开关 |

支持 AWS S3、MinIO、阿里云 OSS、腾讯云 COS、Cloudflare R2、Backblaze B2 等 S3 兼容服务。

## 安装

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-s3-<版本>.tgz
```

发布产物见 [Releases](https://github.com/Onenightcarnival/dsh-toolkit/releases)。独立包与集成包互斥。

桌面版入口：插件 → 配置中心 → 插件 → 从 .tgz 安装，重启生效。AWS SDK 已内联至 `lib/index.js`。

## 连接配置

入口：S3 → 新增。连接与工具开关保存到 `~/.dsh/dsh-s3.json`（0600），即时生效。

| 字段 | 取值 |
|---|---|
| Bucket、AK、SK | 桶名与访问凭证 |
| Endpoint | S3 服务地址；留空使用 AWS S3 |
| 显示名称 | 默认使用桶名；Agent 通过名称引用桶 |
| Region | 按服务配置填写，默认 us-east-1 |
| 限定前缀 | 浏览与 Agent 工具的共同访问范围 |
| 路径风格寻址 | 适用于 MinIO 等自建服务；按服务要求启用 |
| 测试连接 | 验证当前配置 |

## 对象操作

| 操作 | 行为 |
|---|---|
| 浏览 | 按层级分页加载 |
| 上传 | 拖拽或选择文件，大文件自动分片 |
| 预览 | 文本与图片 |
| 下载 / 分享 | 下载文件或复制限时链接 |
| 重命名 | 修改对象名称 |
| 删除 | 支持批量操作，确认清单后执行；文件夹包含其全部内容 |

## Agent 工具

「允许 Agent 使用」开启时注册以下工具，关闭时立即注销。

| 工具 | 功能 |
|---|---|
| `s3_buckets`、`s3_list`、`s3_stat` | 桶、对象列表与元数据 |
| `s3_get`、`s3_put` | 读取与写入文本 |
| `s3_upload`、`s3_download` | 本机与桶之间传输文件 |
| `s3_copy`、`s3_mkdir` | 复制 / 移动对象、创建目录标记 |
| `s3_presign` | 生成限时分享链接 |
| `s3_delete` | 删除对象；需用户确认及 `confirm=true` |

## 安全边界

| 边界 | 契约 |
|---|---|
| 凭证 | AK/SK 明文保存于连接配置文件，仅 host 进程读取；浏览器与 Agent 响应不含密钥，界面显示 Access Key 的前四位与末两位 |
| HTTP | `/api/dsh-s3/*` 仅接受本机回环地址与同源浏览器标记，并要求 dsh web 的浏览器会话 cookie；缺少 cookie 时返回 401 |
| 下载 | 图片 / PDF / 音视频类型可内联预览；其他类型按 `application/octet-stream` 附件返回并带 `nosniff` |
| 网络 | 请求由 dsh host 进程发出，跟随桌面版代理设置 |

## 开发

在仓库根目录：

```sh
pnpm install
pnpm --filter @onenightcarnival/dsh-s3 run build        # lib/index.js（host，内联 AWS SDK）
                                                        # lib/client.js（客户端，dsh 模块加载器封装）
pnpm --filter @onenightcarnival/dsh-s3 run typecheck
pnpm --filter @onenightcarnival/dsh-s3 pack             # onenightcarnival-dsh-s3-<版本>.tgz
```

容器 / 无头环境验证：

- 启动 S3 兼容服务（如 `s3rver` 或 MinIO）。
- `DSH_HOME=<临时目录> dsh plugin --profile web add file:<tgz>` 安装到临时 profile。
- `dsh web --no-open --port 0` 启动后，用就绪行中的 token URL 兑换 cookie，再请求 `/api/dsh-s3/*`；同一 token 仅可兑换一次，更换浏览器需重启 dsh web。
- GUI 检查：Playwright 打开 token URL，点击侧边栏「S3」截图。
- pnpm 复用 store 中同版本号的 file: 包；迭代时将 lib 复制到 profile 的 node_modules，或先 `plugin remove` 再 add。

发版流程见仓库根目录的 README。

## 许可

MIT
