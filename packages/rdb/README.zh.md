# dsh-rdb

[English](README.md) | **中文**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）关系数据库工作台。入口：Web 侧边栏「数据库」。

| 界面 | 功能 |
|---|---|
| 连接与对象树 | 保存连接，按 schema 浏览表与视图 |
| 数据 | 分页、过滤、排序、单元格编辑、新增与删除；SQL 预览后事务提交 |
| 结构 | 列、索引与 DDL |
| SQL | 语句执行与 CSV 导出 |
| Agent | 全局工具开关，连接级写入权限 |

| 数据库 | 驱动 |
|---|---|
| SQLite | Node 内置 `node:sqlite` |
| PostgreSQL | `pg` |
| MySQL / MariaDB | `mysql2` |
| 华为云 GaussDB | `gaussdb-node` |

## 安装

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-rdb-<版本>.tgz
```

发布产物见 [Releases](https://github.com/Onenightcarnival/dsh-toolkit/releases)。独立包与集成包互斥。

桌面版入口：插件 → 配置中心 → 插件 → 从 .tgz 安装，重启生效。数据库驱动已内联至 `lib/index.js`。

## 连接配置

入口：数据库 → 新增。连接与工具开关保存到 `~/.dsh/dsh-rdb.json`（0600），即时生效。

| 字段 | 取值 |
|---|---|
| SQLite | 数据库文件路径 |
| PostgreSQL / MySQL / GaussDB | 主机、端口、数据库、用户名、密码；可选 SSL |
| 多主机 | 逗号分隔，共用端口 |
| 显示名称 | 默认数据库@主机或文件名；Agent 通过名称引用连接 |
| 目标节点 | 任意、可读写、只读、主库、备库、优先备库 |
| 随机选择节点 | 关闭时按填写顺序尝试，开启时随机排序 |
| 允许 Agent 写入 | 默认关闭 |
| 测试连接 | 返回实际节点、服务端版本与延迟 |

### 节点选择

节点选择遵循 libpq 的 `target_session_attrs` / `load_balance_hosts`。连接失败或目标不匹配时尝试下一节点；断线后按相同规则重连。

| 目标 | 条件 |
|---|---|
| 任意 | 可连接 |
| 可读写 | 非恢复态且非只读 |
| 只读 | 恢复态或只读 |
| 主库 / 备库 | 非恢复态 / 恢复态 |
| 优先备库 | 先尝试全部备库，无备库时接受任意节点 |

PostgreSQL / GaussDB 查询 `pg_is_in_recovery()` 与 `transaction_read_only`。GaussDB 对应 JDBC 的 `targetServerType=master / slave / preferSlave` 与 `autoBalance`。

MySQL / MariaDB 通过 `SHOW REPLICA STATUS`（旧版 `SHOW SLAVE STATUS`）判断复制通道，通过 `read_only` / `super_read_only` 判断只读状态；无 REPLICATION CLIENT 权限时，两者均按 read_only 判断。

## 数据与 SQL

| 功能 | 行为 |
|---|---|
| 对象树 | 按 schema 切换与名称过滤，包含表和视图；MySQL schema 为同服务器上的数据库 |
| 数据页 | 每页 100 行；列头排序，单列过滤 |
| 编辑 | 双击单元格；`∅` 置 NULL，Esc 取消；支持新增行与删除所选 |
| 保存改动 | SQL 预览与确认后，在一个事务中提交 |
| 只读对象 | 无主键的表、视图 |
| 结构页 | 列、类型、可空、默认值、主键、索引与 DDL |
| SQL 执行 | Ctrl+Enter 执行选中内容或全文；单条语句，允许末尾分号与注释；写操作需确认 |
| SQL 结果 | 最多 1000 行，支持 CSV 导出 |
| 表导出 | CSV 最多 10 万行 |
| MySQL `USE` | 切换当前连接的默认库，持续到连接重建 |

## Agent 工具

「允许 Agent 使用」开启时注册以下工具，关闭时立即注销。

| 工具 | 契约 |
|---|---|
| `db_connections` | 列出连接 |
| `db_schema` | 列出或描述表 |
| `db_query` | 只读单条查询，最多 500 行 |
| `db_explain` | 执行计划 |
| `db_execute` | 事务写入；需连接写入权限及 `confirm=true`，执行前向用户展示 SQL 并确认 |

## 安全边界

| 边界 | 契约 |
|---|---|
| 凭证 | 密码以明文保存在 `~/.dsh/dsh-rdb.json`（0600），不返回给浏览器或 Agent |
| HTTP | `/api/dsh-rdb/*` 只接受本机回环地址，并要求 dsh web 的浏览器会话 cookie；无 cookie 的本地进程得到 401 |
| 节点选择 | 仅在建立连接时选节点；同一条连接不做读写分离。写走主库、读走备库使用两条连接，目标分别设主库、备库 |
| 只读判定 | `db_query` / `db_explain` 在服务端判定，拒绝 DML、DDL、`select … into`、`for update` 等；与前端判定无关 |
| 写入 | `db_execute` 需连接级写入开关及 `confirm=true` |
| 超时 | 每条语句默认 30 s：PostgreSQL / GaussDB 用 `statement_timeout`，MySQL 用 `max_execution_time`，MariaDB 用 `max_statement_time` |
| 行数上限 | GUI 1000 行、工具 500 行、CSV 导出 10 万行 |

## 开发

在仓库根目录：

```sh
pnpm install
pnpm --filter @onenightcarnival/dsh-rdb run build       # lib/index.js（host，内联 pg / mysql2 / gaussdb-node）
                                                        # lib/client.js（客户端，dsh 模块加载器封装）
pnpm --filter @onenightcarnival/dsh-rdb run typecheck
pnpm --filter @onenightcarnival/dsh-rdb pack            # onenightcarnival-dsh-rdb-<版本>.tgz
```

安装验证步骤见[根 README](../../README.zh.md#安装验证)；本插件检查 `/api/dsh-rdb/*` 接口，GUI 用 Playwright 打开 token URL 后点击侧边栏「数据库」截图。

发版流程见[根 README](../../README.zh.md#发版)。

## 许可

MIT
