# @onenightcarnival/dsh-toolkit

**English** | [中文](README.zh.md)

Integrated plugin package for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), containing nine modules. Each module retains its standalone panels, tools, settings, data files and API paths.

## Installation

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-toolkit-<version>.tgz
```

Desktop entry: Plugins → Config center… → Plugins → Install from .tgz.

The integrated package and standalone plugins are mutually exclusive. Runtime compatibility: [repository guide](../../README.md#runtime-compatibility).

## Module configuration

| Key | Module | Configuration |
|---|---|---|
| `rdb` | Relational databases | [RDB](../rdb/README.md) |
| `s3` | Object storage | [S3](../s3/README.md) |
| `http` | HTTP API client | [HTTP](../http/README.md) |
| `otel` | Observability | [OTel](../otel/README.md) |
| `browser` | Browser control | [Browser bridge](../browser-bridge/README.md#config) |
| `subscriptions` | AI subscriptions | [Subscriptions](../subscriptions/README.md) |
| `memory` | Career memory | [Memory](../memory/README.md) |
| `configCenter` | Configuration center | [Config center](../config-center/README.md#config) |
| `gateway` | API gateway | [API gateway](../gateway/README.md#panel) |

Web profile plugin ID: `toolkit`. Configuration file: `~/.dsh/profiles/web/cordis.patch.yml`.

| Value | Behavior |
|---|---|
| Omitted or `{}` | Enabled with default configuration |
| Configuration object | Enabled; configuration passed to the standalone plugin |
| `false` | Host module and corresponding UI disabled |

An override replaces the entire `config` object; retained custom values must be included. This configuration disables OTel, sets browser discovery to port `43189`, and uses defaults for the remaining modules:

```yaml
- id: toolkit
  config:
    otel: false
    browser:
      discoveryPort: 43189
```

## Mount flow

```text
config → host modules → GET /api/dsh-toolkit/modules → corresponding client plugins
```

Mount order: `rdb → s3 → http → otel → browser → subscriptions → configCenter → memory → gateway`. The endpoint returns the modules enabled by configuration:

```json
{"rdb":true,"s3":true,"http":true,"otel":false,"browser":true,"subscriptions":true,"configCenter":true,"memory":true,"gateway":true}
```

| Request | Response |
|---|---|
| `GET /api/dsh-toolkit/modules` | `200`, module boolean map, `Cache-Control: no-store` |
| Other methods | `405`, empty JSON object |

## Sidebar entries

The toolkit stores the pin state of the shell sidebar. Pinning and unpinning use the shell's own controls and cover the sidebar entries of all plugins, including third-party plugins such as SSH and the task board:

| Action | Place |
|---|---|
| Unpin | The unpin button on an entry row of the expanded sidebar |
| Pin | The pin button on an unpinned entry in the **More** menu |
| Open an unpinned entry | Its row in the **More** menu |

| Moment | Behaviour |
|---|---|
| Start | Once the sidebar registers, the stored unpinned entries move from the sidebar into the **More** menu |
| Pin or unpin | The current unpinned set is saved at once |
| Failed save | The sidebar returns to the last saved state; the console logs a warning |

Features and data of an unpinned entry stay unchanged. The Plugins entry is always pinned. The pin state is read from the inject face of the shell's `sidebar` slot entry; a shell without that face keeps no stored pin state.

Toolkit module entries:

| Entry | Module | Entry ID |
|---|---|---|
| Database | `rdb` | `rdb` |
| S3 | `s3` | `s3` |
| HTTP | `http` | `http` |
| MCP | `configCenter` | `dsh-config-center-mcp` |
| Memory | `memory` | `memory` |
| Skills | `configCenter` | `dsh-config-center-skills` |
| AI subscriptions | `subscriptions` | `subscriptions` |
| API gateway | `gateway` | `gateway` |

Entry IDs of uninstalled plugins stay in the setting; a reinstalled plugin stays unpinned.

The setting is stored as `hiddenSidebarPanels` in `dsh-toolkit.json` in the active profile directory, for example `~/.dsh/profiles/web/dsh-toolkit.json`:

```json
{"hiddenSidebarPanels":["rdb","task-board"]}
```

| Request | Response |
|---|---|
| `GET /api/dsh-toolkit/sidebar` | `200`, `{"hidden":[unpinned entry ID…]}` |
| `PUT /api/dsh-toolkit/sidebar` with body `{"hidden":[…]}` | `200`, the saved structure; IDs must be 1–128 printable characters, at most 200, otherwise `400`; non-loopback or cross-site requests return `403` |
| Other methods | `405`, empty JSON object |

## Structure

| File | Responsibility |
|---|---|
| `src/index.ts` | Host module mounting, module map endpoint and sidebar preferences endpoint |
| `src/client.ts` | Client plugin mounting from the host map, sidebar pin persistence, settings nav icons |
| `src/modules.ts` | Module order, map type, entry ID constraints and API paths |
| `src/preferences.ts` | `dsh-toolkit.json` in the profile directory |
| `src/client/sidebar.ts` | Unpinned entry set and save requests |
| `src/client/pins.ts` | Two-way sync between the shell sidebar's pin state and the stored set |
| `src/client/section-icons.tsx` | Settings nav icons of Observability, Environment dependencies and Local logs (`settings.section.icon` slot, registered by section id) |
| `src/typert.ts` | OTel typert manifest registered under the toolkit package name |
| `build.mjs` | Host and client builds from the nine modules' sources |

## License

MIT. Third-party notices: [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt).
