# @onenightcarnival/dsh-toolkit

**English** | [中文](README.zh.md)

Integrated plugin package for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), containing seven modules. Each module retains its standalone panels, tools, settings, data files and API paths.

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
| `otel` | Observability | [OTel](../otel/README.md) |
| `browser` | Browser control | [Browser bridge](../browser-bridge/README.md#config) |
| `subscriptions` | AI subscriptions | [Subscriptions](../subscriptions/README.md) |
| `memory` | Career memory | [Memory](../memory/README.md) |
| `configCenter` | Configuration center | [Config center](../config-center/README.md#config) |

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

Mount order: `rdb → s3 → otel → browser → subscriptions → configCenter → memory`. The endpoint returns the modules enabled by configuration:

```json
{"rdb":true,"s3":true,"otel":false,"browser":true,"subscriptions":true,"configCenter":true,"memory":true}
```

| Request | Response |
|---|---|
| `GET /api/dsh-toolkit/modules` | `200`, module boolean map, `Cache-Control: no-store` |
| Other methods | `405`, empty JSON object |

## Sidebar entries

Settings → Toolkit lists the sidebar entries of enabled modules, one switch per entry. Switches apply immediately; an entry turned off leaves the left sidebar and its open panel closes, while features and data stay unchanged.

| Entry | Module | Entry ID |
|---|---|---|
| Database | `rdb` | `rdb` |
| S3 | `s3` | `s3` |
| MCP | `configCenter` | `dsh-config-center-mcp` |
| Memory | `memory` | `memory` |
| Skills | `configCenter` | `dsh-config-center-skills` |
| AI subscriptions | `subscriptions` | `subscriptions` |

The setting is stored as `hiddenSidebarPanels` in `dsh-toolkit.json` in the active profile directory, for example `~/.dsh/profiles/web/dsh-toolkit.json`:

```json
{"hiddenSidebarPanels":["rdb","dsh-config-center-mcp"]}
```

| Request | Response |
|---|---|
| `GET /api/dsh-toolkit/sidebar` | `200`, `{"hidden":[entry ID…]}` |
| `PUT /api/dsh-toolkit/sidebar` with body `{"hidden":[…]}` | `200`, the saved structure; unknown IDs return `400`; non-loopback or cross-site requests return `403` |
| Other methods | `405`, empty JSON object |

Module clients accept a `{ sidebar }` config as the entry visibility source; standalone plugins receive none and always show their entries.

## Structure

| File | Responsibility |
|---|---|
| `src/index.ts` | Host module mounting, module map endpoint and sidebar preferences endpoint |
| `src/client.ts` | Client plugin mounting from the host map, sidebar visibility, settings section |
| `src/modules.ts` | Module order, map type, sidebar entry table and API paths |
| `src/preferences.ts` | `dsh-toolkit.json` in the profile directory |
| `src/client/sidebar.ts` | Sidebar visibility state and save requests |
| `src/client/SidebarPage.tsx` | Settings → Toolkit page |
| `src/client/locales.ts` | Chinese and English copy |
| `src/typert.ts` | OTel typert manifest registered under the toolkit package name |
| `build.mjs` | Host and client builds from the seven modules' sources |

## License

MIT. Third-party notices: [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt).
