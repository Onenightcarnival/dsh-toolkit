# @onenightcarnival/dsh-bridge-browser

English | [中文](README.zh.md)

The **browser-operation bridge** for dsh: mounts a token-authenticated WebSocket carrier (`/ext/bridge`) that the Chrome extension connects to, projects its calls onto dsh 0.1.5 Typert Remotes, follows Session and Remote Event streams per connection, and registers the `browser_*` tool set (structured text first; `browser_screenshot` returns an annotated image) that reads and operates the user's active tab through the extension — click elements, fill forms, scroll, and navigate in the real browser, login state preserved. The side panel is the conversation entry; the tools are the product.

**Text-only browser tools, multimodal chat passthrough**: page snapshots stay structured text (title, main content, numbered interactive inventory, and masked form fields), and every browser action uses stable inventory numbers. The generic RPC carrier also passes dsh 0.1.5 image prompts and durable attachment reads; deferred new sessions expose image limits only when the host actually mounts the attachment service.

## Config

| Key | Type | Default | Description |
|---|---|---|---|
| `token` | `string` | generated | Fixed bearer token. When absent, a token is generated on first boot, persisted at `~/.dsh/ext-bridge-token` (chmod 0600), and printed in the boot log. |
| `toolTimeoutMs` | `number` | 90000 | Per-tool-call budget, leaving time for the extension's 60-second approval window. |
| `snapshotMaxChars` | `number` | 200000 | Upper bound on one rendered snapshot's characters, minimum 500 (also negotiated to the extension via `hello.ok` caps). |
| `maxInteractiveItems` | `number` | 400 | Upper bound on interactive inventory items per snapshot. |
| `sessionWorkspacePath` | `string` | `~/.dsh/browser-sessions` | Dedicated Host Workspace for extension-created sessions. The plugin creates and idempotently registers the directory on the first implicit `session.create`; the session cwd becomes this path, so the GUI shows a `browser-sessions` workspace group. Set `""` to keep sessions Ungrouped. |
| `deferSessionCreate` | `boolean` | `true` | Sessions materialize only on the first message: `session.create` answers with a provisional id (nothing persisted), history reads empty, and the first `session.prompt` creates the real session (same id, original payload). Opening the panel without chatting leaves zero trace in the session store/GUI. |
| `discoveryPort` | `number` | 43189 | Discovery beacon: a loopback listener that answers only `/ext/bridge-config` with this instance's bridge URL, for hosts on a random web port (DeepSeek Harness Desktop). Falls back through the next three ports when taken; `0` disables. |

Workspace grouping is best-effort. If the composition has no workspace domain, directory creation fails, or `workspace.create` rejects the path, the plugin logs one warning and sends every session creation without an injected workspace so browser chat remains usable.

## Usage

Install the release `.tgz` into the dsh `web` profile:

- DeepSeek Harness Desktop: 插件 → 配置中心… → 插件 → 「从 .tgz 安装」, then restart the app.
- dsh CLI: `npx @deepseek-ai/dsh@0.1.5-rc.2 plugin --profile web add file:<path to .tgz>`, then `npx @deepseek-ai/dsh@0.1.5-rc.2 web`.

Both register the package's `dsh.bundle` layer ([`cordis.patch.yml`](cordis.patch.yml)), so `dsh web` mounts the bridge without further options. A checkout produces the same `.tgz` with `pnpm run package` at the repository root.

The workspace pins dsh 0.1.5-rc.2, the minimum supported runtime. Older DSH releases are not supported.

The extension is installed separately from the release zip (see the [root README](../../README.md#install)). Loopback connections are discovered automatically and require no token entry; non-loopback deployments still require the configured bearer token.

## Security model

- The bridge route lives **outside** the `/api` trust fence (which only guards client-connection's routes), so it carries its own bearer-token authentication: the first frame must be `hello` with the token within 5s, verified in constant time. Failed auth closes the socket.
- Gateway methods the `/api` carrier pins to loopback (`settings.*`, `credentials.*`, `host.pickDirectory`, `host.openPath`) are refused for non-loopback remotes **even with a valid token** — defense in depth for `--host 0.0.0.0` deployments.
- One active connection at a time; a new authenticated socket replaces the previous one.
- The bridge is a confused-deputy boundary, not a general auth layer: never expose `dsh web --host 0.0.0.0` on untrusted networks.
- Extracted page text is marked as untrusted model input. Page reads honor the extension's ask/auto/off policy, while state-changing tools require an origin-scoped side-panel decision and fail closed without a panel. Same-origin repetition can be trusted for the current panel session; permanent trust remains an explicit setting.

## Wire protocol

Frames are JSON objects discriminated by `t`, defined in [`protocol.ts`](src/protocol.ts) — the single source of truth shared with the extension through the workspace package's `./src/*` export. The built package also publishes `@onenightcarnival/dsh-bridge-browser/protocol` for external consumers.

- Client → server: `hello` (auth + caps), `rpc` (gateway method passthrough), `respond` (resolve a host interaction by its RPC id), `tool.result`, `pong`.
- Server → client: `hello.ok` (echoes negotiated caps), `rpc.result`, `respond.result` (correlated acceptance or error), `event` (bridge-owned projection of dsh Remote streams and waterfalls), `tool.call`, `ping`, `error`.

Each `respond` carries a globally unique transport id as well as the host interaction's `rpcId`. The extension routes its receipt only to the panel that initiated it and rejects pending responses on timeout, panel closure, or bridge disconnection.

## Tools

| Tool | Purpose |
|---|---|
| `browser_snapshot` / `browser_find` / `browser_get_text` | Structured text snapshot (`delta: true` returns only changes); search by text/role/selector; page or region as Markdown. |
| `browser_screenshot` | Annotated viewport PNG delivered as an image block (model route must accept image input). |
| `browser_click` / `browser_type` / `browser_form_input` / `browser_press` / `browser_hover` / `browser_drag` / `browser_upload` | Operate inventory items by stable index or viewport coordinates; upload reads files from the session working directory only. |
| `browser_scroll` / `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | Page movement. |
| `browser_list_tabs` / `browser_follow_tab` / `browser_close_tab` | Tab management. |
| `browser_wait` / `browser_wait_for` / `browser_batch` / `browser_handle_dialog` | Settle detection, conditional waits, up to 25 steps per round trip, dialog answers. |
| `browser_console` / `browser_network` / `browser_evaluate` | Console/network capture and JavaScript evaluation; the extension refuses them unless the user enabled unrestricted browser control. |

## Model Experience

- **Token effect**: one `browser_snapshot` (default budget 200k chars, 400 items; typical pages are far smaller) costs roughly 8–10k tokens for a typical English page; the exact count depends on language and tokenizer, and delta snapshots cost a fraction of that. The system-prompt section tells the model to snapshot on demand rather than hoard page text.
- **KV-cache effect**: none beyond ordinary tool results; snapshots are not cached server-side.
- **Latency**: each action awaits the extension's real-page execution plus settle detection (typically 0.2–2s; navigation up to 5s).
- **Failure modes**: `bridge-closed` (extension not connected), `timeout`, `no-active-tab`, `content-unavailable` (page needs a refresh), `action-failed` (stale inventory index — the model should re-snapshot).

## Extension points

- The tool set is the consumer surface; the seam is the bridge wire (`protocol.ts`). Add tools by registering on `ctx.tools` and dispatching over the bridge; the extension's content script dispatches by action name.
- Negotiated caps (`hello.ok`) let the plugin dictate snapshot budgets to the extension without a shared config file.

## Known Limitations and Deferred Work

- One active extension connection (a second window replaces the first).
- Accessible cross-origin iframes are snapshotted and operated with stable `(frame, index)` addresses. Restricted or short-lived frames are reported as unavailable without failing the whole page snapshot.
- Token rotation is manual (edit `~/.dsh/ext-bridge-token` or set `token` in config); no expiry.
- The Playwright-driven extension e2e self-skips without a usable Chromium executable or a built extension bundle.
- Approval is enforced in the extension service worker rather than delegated to model behavior. A future dsh tool-pipeline integration may surface the same policy in other clients.
