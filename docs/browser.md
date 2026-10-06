# dsh Browser Control

**English** | [中文](browser.zh.md)

<img width="1701" height="897" alt="dsh Browser Control" src="https://github.com/user-attachments/assets/3b1f3a25-f962-4e02-a9ef-d23e0d01fc8e" />

Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) to the Chrome or Firefox tabs you are already using. The model can read page content, operate controls, navigate, and manage tabs while preserving your login state, session, and cookies. A side panel or sidebar provides the conversation UI.

## Components

| Component | Responsibility |
|---|---|
| `@onenightcarnival/dsh-bridge-browser` | Host RPC, browser tools and bridge discovery |
| Chrome / Firefox MV3 extension | Tab operations, page reads and side-panel conversations |
| dsh `0.2.0-rc.2` | Workspace pin and minimum supported runtime |

The browser module derives from [Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser). Release artifacts include the bridge `.tgz` and Chrome extension zip, with random host-port discovery for [DeepSeek Harness Desktop](https://github.com/Onenightcarnival/deepseek-harness-desktop).

## Install

Browser components in each [release](https://github.com/Onenightcarnival/dsh-toolkit/releases):

| File | Contents |
|---|---|
| `onenightcarnival-dsh-bridge-browser-<version>.tgz` | bridge plugin for the dsh `web` profile |
| `dsh-browser-extension-chrome-<version>.zip` | built Chrome extension, loaded unpacked |

1. **Bridge plugin**
   - DeepSeek Harness Desktop: 插件 → 配置中心… → 插件 → 「从 .tgz 安装」, pick the `.tgz`, restart when prompted.
   - dsh CLI: `npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add file:<path to .tgz>`, then start (or restart) `dsh web`.
2. **Chrome extension**: unzip into a folder you will keep, open `chrome://extensions`, enable Developer mode, choose "Load unpacked" and select that folder.
3. Open any `http(s)` page and click the DeepSeek whale icon. The side panel shows **Connected**.

**Update**: install the new `.tgz` the same way, replace the extension folder's contents with the new zip, click **Reload** on the extension card in `chrome://extensions`, then restart dsh. The side panel's Updates card compares the installed version with the repository and links to Releases.

Firefox has no packaged build; see [Firefox source build](#firefox-source-build).

> [!IMPORTANT]
> The unscoped [`dsh-browser`](https://www.npmjs.com/package/dsh-browser) package on npm belongs to a different project and is not affiliated with this repository. Install from Releases only.

## Using with DeepSeek Harness Desktop

The desktop host uses a random port. The discovery beacon listens on `127.0.0.1:43189`, falling back through `43192`, and serves the host bridge URL at `/ext/bridge-config` only. The extension probes this port range automatically. `discoveryPort: 0` disables the beacon.

Install both files as described in [Install](#install).

### Compatibility

The bridge is pinned to dsh 0.2.0-rc.2, the desktop app's bundled version. A desktop release on a new dsh line needs a rebased bridge and a reinstall.

### Troubleshooting

While the desktop app runs, `http://127.0.0.1:43189/ext/bridge-config` returns `{"wsUrl":"ws://127.0.0.1:<port>/ext/bridge"}`.

- No response: the plugin is not in the web profile (the plugin manager should list `@onenightcarnival/dsh-bridge-browser`), or the app has not been restarted.
- 43189 held by another program: the desktop log line `discovery beacon listening on` names the port in use; alternatively set the bridge address in the extension settings.

## Performance

Paired 60-run end-to-end benchmark, August 18, 2026: six browser tasks, five deterministic seeds, the same DSH profile and model (`deepseek-v4-flash`), independently validated page state.

| Backend | Success | Mean end-to-end latency | Mean browser tool calls |
|---|---:|---:|---:|
| **dsh Browser Control** | **30/30** | **5.32 s** | **3.4** |
| Matched Playwright baseline | 30/30 | 6.67 s | 4.7 |

Paired Playwright / extension duration ratio: **1.24** (95% CI **1.16–1.34**). Methodology and reproduction: [benchmark README](../benchmark/README.md).

## Core capabilities

| Capability | Tool | Notes |
|---|---|---|
| Read page | `browser_snapshot` | Structured text snapshot: title, URL, main text, numbered controls (through shadow DOM, with select options, expanded/checked state, coordinates), and masked form fields; `region` to focus, `delta: true` for changes only; default budget 200k chars, 400 items |
| Screenshot | `browser_screenshot` | Viewport PNG, by default with interactive elements labeled by their indices; delivered as an image block through dsh's attachment service (the model route must declare image input) |
| Find elements | `browser_find` | Search by text, role, or selector (through shadow DOM); returns indices and center coordinates |
| Click element | `browser_click` | Click by inventory number or viewport coordinates (x, y); double-click and right-click supported |
| Fill forms | `browser_type` / `browser_form_input` | Type into one field (React/Vue-compatible; `replace` clears first), or set many at once: text, select by label or value, multi-select, checkbox/radio, contenteditable |
| Hover | `browser_hover` | Hover an element to reveal menus, tooltips, or hidden controls |
| Press keys | `browser_press` | Keyboard events such as Enter, Tab, Escape, and arrow keys, including combinations like `Ctrl+A` and `Shift+Tab` |
| Scroll | `browser_scroll` | Viewport scrolling (up, down, top, bottom), or scroll an element into view by index |
| Navigate | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | Navigation inside the controlled tab, or open a URL in a new tab and follow it (`active:false` keeps the current tab in front) |
| List tabs | `browser_list_tabs` | List accessible tabs with stable IDs, titles, URLs, window/index metadata, and active/controlled state |
| Follow tab | `browser_follow_tab` | Bind later browser tools to a tab returned by `browser_list_tabs` without activating it |
| Close tab | `browser_close_tab` | Close a tab returned by `browser_list_tabs` |
| Read region | `browser_get_text` | Page or region as Markdown (headings, lists, tables, links preserved; `format: "plain"` for raw text) |
| Wait | `browser_wait` / `browser_wait_for` | Page settle detection; or wait for text, a selector, or a URL to appear or disappear, with a timeout |
| Batch steps | `browser_batch` | Up to 25 tool steps in one round trip (type → press → wait_for…), stopping at the first failure; each step keeps its own approval rules |
| Drag | `browser_drag` | Drag an element (by index or coordinates) onto another element or point: pointer, mouse, and HTML5 drag events |
| Upload files | `browser_upload` | Attach files from the session working directory to a file input (or the button wrapping one); files outside that directory are refused, 20 MB per file / 50 MB per call |
| Page dialogs | `browser_handle_dialog` | alert/confirm/prompt are answered automatically (dismissed by default) and reported; set accept/dismiss and prompt text before triggering one |
| Console / network | `browser_console` / `browser_network` | Console output, uncaught errors, and fetch/XHR requests captured since the first action on the page; requires **Allow unrestricted browser control** |
| Run JavaScript | `browser_evaluate` | Evaluate an expression in the page and return its JSON value; requires **Allow unrestricted browser control** |
| Send images | `session.prompt` / `session.attachment` | Host-capability-gated image drafts, image-only prompts, and durable history previews |
| Quote a selection | side panel composer | Text you highlight in the page appears in the composer and is sent with your next message as fenced, attributed page content |
| Pick a model | model button next to the composer | Lists the providers and models configured in dsh (`session.modelCatalog`) and switches the current session's model and reasoning effort (`session.selectModel`); providers without credentials are greyed out. dsh also records the choice as the default for new sessions |
| Delete a session | session list | Sessions nothing holds are purged at once; a session this dsh process still holds is archived and leaves the list immediately, and its files are purged the next time dsh starts |

## Repository layout

```
packages/browser-bridge/
  cordis.patch.yml
extensions/dsh-browser/
scripts/package.mjs
scripts/version.mjs
```

## Page interface

| Interface | Data and boundary |
|---|---|
| Structured snapshot | Title, URL, text, numbered controls and form fields; open shadow DOM and accessible iframes |
| Element addressing | Stable numbers across snapshots; delta mode returns changes |
| Screenshot | Viewport PNG with matching snapshot indices; requires model image input |
| Selection quote | Captured with an open panel and page sharing enabled; retained in the extension until message submission |
| Text privacy | Password and payment-card values render as `••••`; screenshot limits are listed under [Security](#security) |
| Image attachments | PNG, JPEG, WebP and GIF when advertised by the host |
| Tabs | Tools bind to a user-controlled tab with its login state, session and cookies |

## Building from source

Requirements: Node.js `^22.19` or `>=24`, Corepack/pnpm, and Chrome 116+ or Firefox 140+.

### Chrome build

```sh
git clone https://github.com/Onenightcarnival/dsh-toolkit.git
cd dsh-toolkit
pnpm install && pnpm run build && pnpm run package
```

`dist/` then holds the same `.tgz` and zip a release ships; install them as in [Install](#install). `pnpm run build` alone leaves the loadable extension in `extensions/dsh-browser/dist/`.

### Firefox source build

Firefox uses a separate MV3 manifest, event-page background, and sidebar. Build it from a checkout, then open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `extensions/dsh-browser/dist-firefox/manifest.json`:

```sh
pnpm install
pnpm --filter dsh-browser-extension run build:firefox
```

The bridge address is auto-discovered. Firefox requires the bearer token from `~/.dsh/ext-bridge-token` in the extension settings; the dsh startup log reports the file path. Signed distribution can package the same `dist-firefox/` output.

### Start and use

From a source checkout, run `pnpm start` in the repository root. The exact supported public runtime is:

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 web
```

Local Chrome use requires no configuration; Firefox requires the local bridge token described above. Open a page, click the DeepSeek whale icon, and wait for **Connected**. Existing HTTP(S) tabs are instrumented on the first action. On browser-protected pages and extension stores, the model can read tab metadata and use browser-level HTTP(S) navigation, back, forward, and reload, but it cannot inspect or operate the protected page DOM.

## Troubleshooting

**Side panel stays "Not connected"**

- Make sure dsh web is running locally (default `http://127.0.0.1:3080`).
- Verify the bridge is loaded: open `http://127.0.0.1:3080/ext/bridge-config`. It should return JSON such as `{"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}`. A non-JSON response indicates that the bridge endpoint is unavailable. Check the plugin installation and configured port, then restart dsh.
- The extension probes ports 3080, 3081 and 3090, the discovery-beacon window 43189–43192, and the legacy desktop port 14389 automatically. If dsh runs on another port with the beacon disabled — or you use a remote `--host 0.0.0.0` deployment — set the address (and bridge token) in the panel settings. Firefox always requires the token.

## Development

Development and release steps: [repository README](../README.md).

## Security

### Bridge access

Authentication, privileged methods and token rotation: [bridge authentication](../packages/browser-bridge/README.md#bridge-authentication).

### Page data

| Data | Boundary |
|---|---|
| Page text | Sent to the selected model inside nonce-bound untrusted-content markers; page instructions grant no authority |
| Sensitive fields | The text pipeline excludes passwords and payment-card values; accessible names exclude their current values |
| Screenshots | Follow page-read approval and are blocked when sharing is off; images do not mask password fields; disable or decline screenshots on sensitive pages |
| Screenshot storage | Saved by the host attachment service and sent as image blocks; Allow screenshots controls this tool |
| Selection quotes | Captured only with an open panel and page sharing enabled; retained in the extension until submission, discarded on removal, navigation or tab closure |
| Quote attribution | Source title, URL and selected text share the untrusted-content boundary |
| Uploads | Read only files within the session workspace |

### Read and action approval

| Mode or action | Behavior |
|---|---|
| Page sharing auto (default) | Reads the controlled tab automatically |
| Page sharing ask | Confirms each read; permits one read or a switch to auto, reversible in Settings |
| Page sharing off | Blocks reads |
| Page changes and navigation | Require approval by default; show exact origins and an action summary with typed content redacted |
| Temporary trust | Applies to the current panel session; clears when the last panel closes or the service worker restarts |
| Permanent trust | Managed in Settings |
| Cross-origin navigation or unknown history destination | Prompts again |
| Closed panel | Approval waits up to 60 seconds; optional notifications open the panel |
| Session approval | Restores the requesting session before display |
| Caller cancellation or bridge timeout | Withdraws pending approval; no action executes |

### Unrestricted control

- Allow unrestricted browser control takes effect after a successful save; page reads, actions and tab list/follow/close operations need no confirmation.
- Calls capture their access mode on receipt; enabling the setting does not elevate existing restricted calls.
- Disabling immediately restricts access and cancels undispatched calls; the restrictive setting is saved after dispatched operations settle.
- Re-enabling remains restricted until revocation finishes; concurrent saves persist in request order.
- Protected-page DOM content remains inaccessible.

### Tab binding

- Prompt submission or the first direct browser-tool call binds the active tab for the entire extension connection.
- Manual tab or window switches pause subsequent actions; staying on the original tab permits background operation, while following resets page references.
- The extension does not change the visible tab; a closed controlled tab requires an explicit selection of the current page.
- Switching tabs withdraws open action approvals.

### Page hooks and trusted input

- The first page action installs main-world hooks for automatic alert/confirm/prompt answers, console output and fetch/XHR URL, method, status and timing. Request bodies are excluded. Pure reads install no hooks.
- browser_console, browser_network and browser_evaluate require unrestricted control; their results are untrusted page content.
- Trusted input is off by default. Chrome debugger API sends clicks, key presses, hovers and drags, including native Tab focus movement and canvas input.
- Chrome displays its debugging bar while attached; screenshots may use the debugger when the capture API refuses. Disabling trusted input immediately detaches all tabs.

### Extension permissions

| Permission | Purpose |
|---|---|
| sidePanel / sidebar_action | Chrome side panel / Firefox sidebar |
| storage | Settings and recent sessions |
| notifications | Optional approval reminders while the panel is closed |
| tabs, activeTab, scripting | Observe tab changes and inject or message the controlled page |
| webNavigation | Enumerate frames and bind frame documents |
| alarms | Background keepalive |
| `<all_urls>` | Content scripts and captureVisibleTab |
| debugger (Chrome) | Trusted input and screenshot fallback; required manifest permission |

The Firefox AMO manifest declares browsing activity, website content/activity and personal communications sent to the configured dsh/model service.

## Connections and limitations

- Installation or reload stays passive until the first panel opening starts discovery and connection.
- A healthy connection may receive background approvals after the panel closes; a dropped or replaced connection requires an open panel to reconnect.
- Only one extension connection is active; replaced clients stop automatic reconnection.
- Reopening resumes the latest active conversation, then the latest non-empty durable session, then creates a new session. Settings can disable resumption.
- Element numbers persist across snapshots; reindexing is reported. Cross-origin frames use stable (frame, index) addresses; restricted or short-lived frames report unavailable individually.
- Text snapshots flag unnamed controls; screenshot targeting requires model image input, and CAPTCHAs require user interaction.
- Synthetic key events do not trigger native actions such as Tab focus movement; trusted input supports native behavior.
- browser_wait uses page load and a fixed quiet window; continuously updating SPAs may be reported as stable.
