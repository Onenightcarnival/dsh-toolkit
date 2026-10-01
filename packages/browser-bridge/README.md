# @onenightcarnival/dsh-bridge-browser

English | [中文](README.zh.md)

Browser control bridge between dsh and the Chrome / Firefox extension.

| Boundary | Contract |
|---|---|
| Transport | `/ext/bridge` WebSocket; authenticated handshake, one active connection |
| Host | dsh 0.2.0 Typert Remotes, Session and Remote Event streams |
| Tools | `browser_*` reads and operates the controlled tab with login state preserved |
| Page | Structured text, stable element numbers and annotated screenshots |
| Attachments | Image prompts and durable reads; limits advertised by the host attachment service |

## Config

| Key | Type | Default | Description |
|---|---|---|---|
| `token` | `string` | generated | Fixed bearer token. When absent, a token is generated on first boot, persisted at `~/.dsh/ext-bridge-token` (chmod 0600), with its file path reported in the boot log. |
| `toolTimeoutMs` | `number` | 90000 | Per-tool-call timeout. |
| `snapshotMaxChars` | `number` | 200000 | Upper bound on one rendered snapshot's characters, minimum 500 (also negotiated to the extension via `hello.ok` caps). |
| `maxInteractiveItems` | `number` | 400 | Upper bound on interactive inventory items per snapshot. |
| `sessionWorkspacePath` | `string` | `~/.dsh/browser-sessions` | Dedicated Host Workspace for extension-created sessions. The plugin creates and idempotently registers the directory on the first implicit `session.create`; the session cwd uses this path and the GUI shows a `browser-sessions` workspace group. Set `""` to keep sessions Ungrouped. |
| `deferSessionCreate` | `boolean` | `true` | Sessions materialize only on the first message: `session.create` answers with a provisional id (nothing persisted), history reads empty, and the first `session.prompt` creates the real session (same id, original payload). Opening the panel alone creates no stored session. |
| `discoveryPort` | `number` | 43189 | Discovery beacon: a loopback listener that answers only `/ext/bridge-config` with this instance's bridge URL, for hosts on a random web port (DeepSeek Harness Desktop). Falls back through the next three ports when taken; `0` disables. |

Workspace grouping is best-effort. If the composition has no workspace domain, directory creation fails, or `workspace.create` rejects the path, the plugin logs one warning and sends every session creation without an injected workspace with browser chat still available.

## Usage and permissions

Installation, tools and page permissions: [browser control guide](../../docs/browser.md). Runtime versions: [compatibility table](../../README.md#runtime-compatibility).

Installation registers the `dsh.bundle` layer in [`cordis.patch.yml`](cordis.patch.yml); `dsh web` mounts the bridge automatically.

### Bridge authentication

- The first WebSocket frame must be `hello` within 5 seconds. Token comparison is constant-time; failed authentication closes the connection.
- Loopback Chrome extension origins may connect without a token; Firefox and non-loopback connections require one.
- `settings.*`, `credentials.*`, `host.pickDirectory` and `host.openPath` reject non-loopback connections even with a valid token.
- A new authenticated connection replaces the previous connection.
- Tokens have no expiry; rotate them through `~/.dsh/ext-bridge-token` or the `token` configuration.
- Deploy the bridge only on trusted networks.

## Wire protocol

Frames are JSON objects discriminated by `t`, defined in [`protocol.ts`](src/protocol.ts) — the single source of truth shared with the extension through the workspace package's `./src/*` export. The built package also publishes `@onenightcarnival/dsh-bridge-browser/protocol` for external consumers.

- Client → server: `hello` (auth + caps), `rpc` (gateway method passthrough), `respond` (resolve a host interaction by its RPC id), `tool.result`, `pong`.
- Server → client: `hello.ok` (echoes negotiated caps), `rpc.result`, `respond.result` (correlated acceptance or error), `event` (bridge-owned projection of dsh Remote streams and waterfalls), `tool.call`, `ping`, `error`.

Each `respond` carries a globally unique transport id as well as the host interaction's `rpcId`. The extension routes its receipt only to the panel that initiated it and rejects pending responses on timeout, panel closure, or bridge disconnection.

## Calls and validation

- Tool dispatch: `ctx.tools` → bridge protocol → extension action handler.
- Snapshot budgets are negotiated through `hello.ok`; snapshots are ordinary tool results and are not cached server-side.
- Actions wait for page execution and settle detection.
- Extension end-to-end tests require usable Chromium and a built extension; otherwise they skip.

| Error | Meaning |
|---|---|
| `bridge-closed` | Extension disconnected |
| `timeout` | Call timed out |
| `no-active-tab` | No operable tab |
| `content-unavailable` | Page content script unavailable |
| `action-failed` | Action failed; take a new snapshot for stale element indices |
