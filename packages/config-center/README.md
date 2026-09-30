# @onenightcarnival/dsh-config-center

**English** | [中文](README.zh.md)

Configuration center for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): MCP server management in the main sidebar, and common settings of built-in plugins in Settings → Plugins.

| Entry | Content |
|---|---|
| Sidebar → MCP (before AI Subscriptions) | Server list with live state; add, edit, enable / disable, delete; connection test |
| Settings → Plugins → Common settings | Common options of built-in plugins: round limit of goal mode; switch and trigger threshold of automatic context compaction |
| Settings → Environment dependencies | Install, check and repair the plugin-owned uv / uvx runtime |

## Python MCP environment

Install uv from Settings → Environment dependencies. The plugin downloads a fixed release and checks a pinned SHA256 before extracting binaries. Windows, macOS and glibc Linux on x64 / ARM64 are supported. No binaries ship inside the plugin package. The provided uv version is maintained with plugin releases.

All runtime data lives under `<DSH home>/tools/dsh-config-center/`: versioned binaries under `uv/`, managed interpreters under `python/`, and dedicated `cache/`, `tools/` and `bin/` directories. Python and MCP packages download on first use. System or desktop uv is never adopted and global PATH is unchanged.

Bare `uv` / `uvx` MCP commands resolve to managed absolute paths for both connection tests and persisted configuration. Installation also converts existing bare commands in the current profile patch. The official MCP client can restart these entries without a plugin startup hook. Custom executable paths and entries in other overlays are left untouched. After moving a configuration to another machine, install the environment again and adjust paths.

MCP → Connection settings → stdio startup wait defaults to 900 seconds (range 1–86400), shared by all stdio servers in the active profile. It persists in the profile's `dsh-config-center.json` and controls connection tests and dependency preparation before first save or activation. Active entries do not launch an extra preparation process. Subsequent kernel handshakes and tool calls retain upstream timeout policies. Downloads use the DSH network environment; `UV_PYTHON_INSTALL_MIRROR` can be set in MCP environment variables. The default interpreter policy is managed-only, with project uv configuration disabled; explicit user command arguments retain uv semantics.

Run `node --test packages/config-center/test/*.test.mjs` for regression tests. The opt-in `node packages/config-center/test/environment-live.mjs` downloads uv and managed Python and checks an isolated Python MCP fixture.

The Python file and `pyproject.toml` under `test/fixtures/python-mcp/` define the minimal package used by that installation test. They are not plugin runtime code and are excluded from published `.tgz` files.

## Installation

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-config-center-<version>.tgz
```

The integrated package `@onenightcarnival/dsh-toolkit` contains this plugin under the module key `configCenter`.

## Storage

MCP and common settings live in the active profile's `cordis.patch.yml`. Runtime downloads and caches use the separate directory described above.

| Content | Form in the file |
|---|---|
| MCP servers | Entries of top-level `insert` lists whose `name` is `@deepseek-ai/dsh-mcp-client` |
| Built-in plugin settings | Top-level override rows `- id: <entry>`: one `config` key, or the `disabled` field |

Edits address rows by entry id. Other rows, comments and `!!js` expressions stay as written; a field the form left unchanged keeps its formatting; fields outside the form (timeouts, reconnect policy) stay. Hand-written MCP entries appear in the list.

| Operation | File change |
|---|---|
| Add a server | Entry id `mcp-<name>`, appended to the `insert` list that holds MCP entries; a new row when none exists |
| Rename | An id of the form `mcp-<old name>` follows the name; a hand-chosen id stays |
| Enable / disable | Writes the entry's `disabled`; `disabled` in override rows of the same id is removed |
| Delete a server | Removes the entry and override rows of the same id; an emptied `insert` list goes with it |
| Blank setting | Removes the key; an override row left with only `id` goes with it |

## Application

| Host | After a save |
|---|---|
| Hot reload on (web profile default) | Applied through Loader reconciliation; on failure the file and the running composition are restored and the route returns the error |
| Hot reload off | Written to the file; applies after dsh restarts |

Saving an enabled MCP server waits for its first connection. The first `npx` / `uvx` run downloads dependencies.

## Expressions

A field value starting with `!!js ` is a Loader expression, written as a `!!js` scalar and evaluated by the host at load time:

```text
!!js process.env.GITHUB_TOKEN
!!js `Bearer ${process.env.MCP_TOKEN}`
```

## Live state

| State | Meaning |
|---|---|
| Connected | Entry loaded; tools are registered under `mcp__<name>__` |
| Loaded, no tools | Entry loaded without tools: disconnected, or the server has none |
| Loading | Entry is starting |
| Failed | Entry failed to start; the error is attached |
| Disabled | Entry is disabled |
| Not loaded | Entry is in the file; the running composition does not have it |

## Connection test

The test is independent of the running composition, uses the form's current values and writes nothing.

| Transport | Procedure | Timeout |
|---|---|---|
| stdio | Starts the command, prepares dependencies, runs `initialize` and `tools/list`, then stops the process | Configurable; default 900 seconds |
| streamable-http | POST `initialize`, then `tools/list` on the same session | 8 seconds per request |

## Routes

Path prefix `/api/dsh-config-center`. Loopback only; the Web UI's browser session is required.

| Request | Purpose |
|---|---|
| `GET /mcp` | Server list with live state |
| `POST /mcp` | Create or update: `{ id?, server }` |
| `DELETE /mcp?id=<id>` | Delete |
| `POST /mcp/test` | Connection test: `{ server }` |
| `POST /mcp/preferences` | Save `{ stdioTimeoutSeconds }`; `GET /mcp` returns the current value |
| `GET /settings` | Options with their current overrides |
| `POST /settings` | Save: `{ values }`; `null` restores the default |
| `GET /environment` | Managed runtime version, paths, readiness and installation progress |
| `POST /environment` | Start an installation or repair; returns `202`, poll `GET` for the result |

| Status | Meaning |
|---|---|
| `400` | Invalid field; `issue` names the reason |
| `409` | Edit refused: duplicate name, id taken, entry missing, or managed runtime unavailable |
| `500` | Write or reconciliation failed; the file is restored |

## Config

```yaml
- id: config-center
  config:
    enabled: false   # routes off; default true
```

## Adding a setting

One row in `SETTINGS` of `src/settings.ts`; the first option of a new entry adds the entry id to `SETTING_GROUPS`. Copy goes to `src/client/locales.ts` under `setting.<key>`, `setting.<key>.hint`, `group.<entry id>` and `group.<entry id>.hint`.

## Development

```sh
pnpm --filter @onenightcarnival/dsh-config-center run build
pnpm --filter @onenightcarnival/dsh-config-center run test         # patch document edits
pnpm --filter @onenightcarnival/dsh-config-center run test:smoke   # real host, isolated data directory
```

## License

MIT. Third-party notices: [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt).
