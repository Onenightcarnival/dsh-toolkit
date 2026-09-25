# dsh-s3

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的
S3 兼容对象存储浏览器插件：在 Web 界面侧边栏加一个「S3」入口，面板里
按条记录 bucket 连接（bucket 名、Endpoint、Region、AK/SK、路径风格、
可选前缀），浏览、上传、下载、预览、重命名、删除对象，生成限时分享
链接；一个开关决定是否把 `s3_*` 工具注入给 agent。

AWS S3、MinIO、阿里云 OSS、腾讯云 COS、Cloudflare R2、Backblaze B2 等
提供 S3 兼容接口的服务都能接。

## 安装

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-s3-<版本>.tgz
```

tgz 从 [dsh-toolkit 的 Releases](https://github.com/Onenightcarnival/dsh-toolkit/releases) 下载，同一页还有把四个插件打在一起的
`onenightcarnival-dsh-toolkit-<版本>.tgz`，二者装其一。桌面版在「插件 → 配置中心 →
插件 → 从 .tgz 安装」选中包即可，重启生效。AWS SDK 已打进 `lib/index.js`，没有运行时依赖。

## 使用

1. 侧边栏点「S3」，左栏「+ 新增」填 bucket 名、Endpoint、AK、SK 四项即可，
   「测试连接」验证。可选项：显示名称（默认用 bucket 名，agent 用它引用这个桶）、
   Region（不确定填 us-east-1）、限定前缀（把这条记录锁在某个目录下，浏览和
   agent 工具都出不去）、路径风格寻址（MinIO 与大多数自建服务需要勾选；
   AWS、R2 不勾）。Endpoint 留空表示 AWS S3。
2. 右侧按层级浏览（分页加载），拖拽或点「上传文件」上传（大文件自动
   分片），点文件名预览文本 / 图片，行内可下载、复制分享链接、重命名、
   删除；勾选多项可批量删除，删除前有确认清单，文件夹会连同内容一起删。
3. 顶部「允许 agent 使用」开关打开后，会话中的 agent 获得这些工具：
   `s3_buckets`、`s3_list`、`s3_stat`、`s3_get`、`s3_put`、`s3_upload`、
   `s3_download`、`s3_copy`、`s3_presign`、`s3_mkdir`、`s3_delete`
   （删除必须带 `confirm=true`，工具描述要求 agent 先向用户确认）。关掉
   开关工具立刻注销，agent 完全看不到这些桶。开关和记录都存在
   `~/.dsh/dsh-s3.json`（0600），保存即生效，无需重启。

## 安全边界

- AK/SK 以明文存在用户主目录私有文件里（与 dsh-ssh 插件同一信任模型），
  不会返回给浏览器或 agent；界面只显示密钥的前四位。
- `/api/dsh-s3/*` 路由只接受本机回环地址、同源浏览器标记，并且要求
  dsh web 自己的浏览器会话 cookie——没有 GUI cookie 的本地进程会得到 401。
- 对象下载路由对非图片 / PDF / 音视频类型一律强制 `attachment` 且
  `nosniff`，桶里存的 HTML/SVG 不会在 GUI 源内执行。
- 所有请求由 dsh host 进程发出，跟随桌面版的代理设置，浏览器端无 CORS 问题。

## 开发

在仓库根目录：

```sh
pnpm install
pnpm --filter @onenightcarnival/dsh-s3 run build        # lib/index.js（host，内联 AWS SDK）
                                                        # lib/client.js（浏览器半边，dsh 模块加载器封装）
pnpm --filter @onenightcarnival/dsh-s3 run typecheck
pnpm --filter @onenightcarnival/dsh-s3 pack             # onenightcarnival-dsh-s3-<版本>.tgz
```

容器 / 无头环境验证：起一个 S3 兼容服务（如 `s3rver` 或 MinIO），用
`DSH_HOME=<临时目录> dsh plugin --profile web add file:<tgz>` 装进临时
profile，`dsh web --no-open --port 0` 启动后用就绪行里的 token URL 换
cookie，再打 `/api/dsh-s3/*`；GUI 用 Playwright 打开 token URL 点侧边栏
「S3」即可截图。注意同一个 token 只能换一次 cookie，换浏览器要重启 dsh web；
pnpm 对同版本号的 file: 包会复用 store 里的旧内容，迭代时直接把 lib 拷进
profile 的 node_modules 或先 `plugin remove` 再 add。

发版流程见仓库根目录的 README。

## 许可

MIT
