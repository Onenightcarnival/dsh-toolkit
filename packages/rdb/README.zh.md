# dsh-rdb

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的
关系数据库工作台插件：在 Web 界面侧边栏加一个「数据库」入口，面板里按条
记录数据库连接，左栏是连接与对象树（schema、表、视图），右侧分「数据」
「结构」「SQL」三个页签：翻页浏览、过滤、排序、双击改值、新增删除行并按
主键生成 SQL 预览后一次性提交；查看列、索引、DDL；SQL 编辑器执行任意语句
并导出 CSV。一个开关决定是否把 `db_*` 工具注入给 agent，每条连接单独控制
是否允许 agent 写入。

支持 SQLite（Node 内置 `node:sqlite`，无原生扩展）、PostgreSQL（`pg`）、
MySQL / MariaDB（`mysql2`）、华为云 GaussDB（`gaussdb-node`）。

## 安装

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-rdb-<版本>.tgz
```

tgz 从 [dsh-toolkit 的 Releases](https://github.com/Onenightcarnival/dsh-toolkit/releases) 下载，同一页还有把四个插件打在一起的
`onenightcarnival-dsh-toolkit-<版本>.tgz`，二者装其一。桌面版在「插件 → 配置中心 →
插件 → 从 .tgz 安装」选中包即可，重启生效。驱动已打进 `lib/index.js`，没有运行时依赖。

## 使用

1. 侧边栏点「数据库」，左栏「+ 新增」选类型：SQLite 填数据库文件路径；
   PostgreSQL / MySQL / GaussDB 填主机、端口、数据库、用户名、密码，可勾选 SSL。
   主机可填多个节点，逗号分隔，所有节点共用端口栏的端口。
   可选项：显示名称（默认 `数据库@主机` 或文件名，agent 用它引用这条连接）、
   目标节点、随机选择节点、「允许 agent 写入」（不勾时 agent 只能读）。
   「测试连接」返回实际连上的节点、服务端版本和延迟。

   多节点的选择规则与 libpq 的 `target_session_attrs` / `load_balance_hosts`
   一致：按填写顺序（勾了「随机选择节点」则随机顺序）逐个尝试，连不上的跳过；
   连上后查 `pg_is_in_recovery()` 和 `transaction_read_only`，不满足目标的断开
   换下一个。目标节点：任意节点（不检查）、可读写（非恢复态且非只读）、只读
   （恢复态或只读）、主库（非恢复态）、备库（恢复态）、优先备库（先在全部节点
   里找备库，没有再接受任意节点）。连接中断后下一次使用会按同样规则重连，
   主库宕机时自动落到列表里其他可用节点。GaussDB 对应 JDBC 的
   `targetServerType=master / slave / preferSlave` 与 `autoBalance`。
   MySQL / MariaDB 的判定：`SHOW REPLICA STATUS`（旧版 `SHOW SLAVE STATUS`）有
   复制通道即为备库，`read_only` / `super_read_only` 为只读；账号没有
   REPLICATION CLIENT 权限时按 read_only 同时判定两者。
2. 对象树按 schema 切换，列出表和视图，支持名称过滤。MySQL 的 schema 即同一
   服务器上的数据库，默认为连接填写的数据库，可切到有权限的其他库。选中一张表：
   - 数据：每页 100 行，列头点击排序，单列过滤（`=`、`like`、`is null` 等），
     双击单元格编辑（`∅` 置 NULL，Esc 取消），「新增行」「删除所选」，
     底部「保存改动」先展示将要执行的 SQL，确认后在一个事务里提交。
     没有主键的表只读，视图只读。「导出 CSV」下载整表。
   - 结构：列（类型、可空、默认值、主键）、索引、DDL。
   - SQL：Ctrl+Enter 执行光标所选或全部文本（单条语句，末尾分号与注释可带），
     结果最多 1000 行，可导出；会改数据的语句先弹确认。MySQL 的 `USE 库名` 会
     切换这条连接会话的默认库，直到连接重建。
3. 顶部「允许 agent 使用」开关打开后，agent 获得这些工具：
   `db_connections`（列连接）、`db_schema`（列表 / 描述表）、`db_query`
   （只读，单条，最多 500 行）、`db_explain`（执行计划）、`db_execute`
   （事务写入，需连接勾选「允许 agent 写入」且 `confirm=true`，工具描述要求
   agent 先把 SQL 给用户确认）。关掉开关工具立刻注销。开关和连接都存在
   `~/.dsh/dsh-rdb.json`（0600），保存即生效，无需重启。

## 安全边界

- 密码以明文存在用户主目录私有文件里（与 dsh-ssh、dsh-s3 同一信任模型），
  不返回给浏览器或 agent。
- `/api/dsh-rdb/*` 路由只接受本机回环地址，并要求 dsh web 自己的浏览器
  会话 cookie；没有 cookie 的本地进程得到 401。
- 多节点只在建立连接时选节点；同一条连接不做读写分离。需要写走主库、
  读走备库时，建两条连接（目标分别设主库、备库）。
- `db_query` / `db_explain` 在服务端做只读判定（拒绝 DML、DDL、
  `select … into`、`for update` 等），与前端判定无关；`db_execute`
  再叠加连接级写入开关。
- 每条语句带超时（默认 30 s：PostgreSQL / GaussDB 用 `statement_timeout`，
  MySQL 用 `max_execution_time`，MariaDB 用 `max_statement_time`），结果按行数
  截断（GUI 1000 行、工具 500 行、CSV 导出 10 万行）。

## 开发

在仓库根目录：

```sh
pnpm install
pnpm --filter @onenightcarnival/dsh-rdb run build       # lib/index.js（host，内联 pg / mysql2 / gaussdb-node）
                                                        # lib/client.js（浏览器半边，dsh 模块加载器封装）
pnpm --filter @onenightcarnival/dsh-rdb run typecheck
pnpm --filter @onenightcarnival/dsh-rdb pack            # onenightcarnival-dsh-rdb-<版本>.tgz
```

容器 / 无头环境验证：用 `DSH_HOME=<临时目录> dsh plugin --profile web add
file:<tgz>` 装进临时 profile，`dsh web --no-open --port 0` 启动后用就绪行里的
token URL 换 cookie，再打 `/api/dsh-rdb/*`；GUI 用 Playwright 打开 token URL
点侧边栏「数据库」即可截图。同一个 token 只能换一次 cookie，换浏览器要重启
dsh web；pnpm 对同版本号的 file: 包会复用 store 里的旧内容，迭代时先
`plugin remove` 再 add。

发版流程见仓库根目录的 README。

## 许可

MIT
