# dsh-rdb

**English** | [中文](README.zh.md)

Relational database workbench for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). Entry: **Database** in the web sidebar.

## Capabilities

| Surface | Behavior |
|---|---|
| Connections | Saved profiles, schema/table/view tree and multi-host selection |
| Data | Pagination, filters, sorting and inline edits with SQL preview and one transaction |
| Structure | Columns, indexes and DDL |
| SQL | Query editor and CSV export |
| Agent | `db_connections`, `db_schema`, `db_query`, `db_explain`, `db_execute`; global tool switch and per-connection write permission |

## Drivers and routing

| Database | Driver |
|---|---|
| SQLite | Built-in `node:sqlite` |
| PostgreSQL | `pg` |
| MySQL / MariaDB | `mysql2` |
| Huawei Cloud GaussDB | `gaussdb-node` |

Drivers are bundled. Connections accept comma-separated hosts with one shared port. Selection follows `target_session_attrs` (`any`, `read-write`, `read-only`, `primary`, `standby`, `prefer-standby`) and `load_balance_hosts`; failed connections reconnect through the same selection rules.

On MySQL, a schema is a database on the same server. A replication channel identifies a standby; `read_only` / `super_read_only` identifies read-only mode.

## Installation

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-rdb-<version>.tgz
```

Artifacts: [dsh-toolkit releases](https://github.com/Onenightcarnival/dsh-toolkit/releases). The standalone plugin and the five-module toolkit package are mutually exclusive.

## Data and access

| Boundary | Contract |
|---|---|
| Storage | `~/.dsh/dsh-rdb.json`, mode `0600` |
| Credentials | Host-only; excluded from browser and agent responses |
| HTTP | Loopback and GUI session cookie required |
| Reads | `db_query` uses server-side read-only classification |
| Writes | `db_execute` requires connection write permission and `confirm=true` |

Detailed configuration and development: [Chinese guide](README.zh.md).

## License

MIT
