# dsh-rdb

Relational database workbench for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). Adds a "Database" entry to the web GUI sidebar: saved connections, a schema/table/view tree, a paged data grid with filters, sorting and inline edits committed as one previewed transaction, a structure view (columns, indexes, DDL), a SQL editor with CSV export — and a single switch that injects the `db_*` toolset into the agent (`db_connections`, `db_schema`, `db_query`, `db_explain`, `db_execute`). Writes by the agent are gated per connection.

Supports SQLite (`node:sqlite`, no native addon), PostgreSQL (`pg`), MySQL / MariaDB (`mysql2`) and Huawei Cloud GaussDB (`gaussdb-node`). Drivers are bundled, so the package has no runtime dependencies. A connection may list several hosts (comma-separated, one shared port); node selection follows libpq's `target_session_attrs` (any / read-write / read-only / primary / standby / prefer-standby) and `load_balance_hosts`, with automatic reconnection to another node after a failure. On MySQL a "schema" is a database on the same server; a replica (`SHOW REPLICA STATUS` has a row) counts as standby and `read_only` / `super_read_only` as read-only.

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-rdb-<version>.tgz
```

The tarball is attached to every [dsh-toolkit release](https://github.com/Onenightcarnival/dsh-toolkit/releases), next to `onenightcarnival-dsh-toolkit-<version>.tgz`, which carries this plugin together with the other three. Install one or the other, not both.

Connections live in `~/.dsh/dsh-rdb.json` (mode 0600); passwords never reach the browser or the agent. Routes are loopback-only and require the GUI's browser-session cookie. `db_query` is read-only by server-side classification; `db_execute` requires the connection's "allow agent writes" flag and `confirm=true`. See [README.zh.md](README.zh.md) for the full guide (Chinese).

MIT
