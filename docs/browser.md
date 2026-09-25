# dsh Browser Control

**English** | [中文](browser.zh.md)

<img width="1701" height="897" alt="dsh Browser Control" src="https://github.com/user-attachments/assets/3b1f3a25-f962-4e02-a9ef-d23e0d01fc8e" />

Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) to the Chrome or Firefox tabs you are already using. The model can read page content, operate controls, navigate, and manage tabs while preserving your login state, session, and cookies. A side panel or sidebar provides the conversation UI.

`dsh` is DeepSeek AI's open-source, plugin-based agent harness. This repository provides a companion browser bridge plugin and Chrome/Firefox MV3 extension as one standalone pnpm workspace.

This repository is a fork of [Lum1104/dsh-browser](https://github.com/Lum1104/dsh-browser) adapted for [DeepSeek Harness Desktop](https://github.com/Onenightcarnival/deepseek-harness-desktop). Differences from upstream:

- the bridge plugin is published as `@onenightcarnival/dsh-bridge-browser`;
- a fixed-port discovery beacon lets the extension find a desktop app that starts dsh on a random port;
- releases ship a `.tgz` for the desktop app's plugin manager plus a Chrome extension zip.

Installation: [Install](#install). Desktop specifics: [Using with DeepSeek Harness Desktop](#using-with-deepseek-harness-desktop).

Browser operation is text-first with screenshots on demand: pages become a numbered inventory of interactive elements (piercing open shadow DOM and iframes, with select options and states), the model addresses elements by number, and `browser_screenshot` captures the viewport with those numbers drawn on the image so a multimodal model can pick targets visually. The tool set follows Claude in Chrome's shape: read page (snapshot or Markdown), find, screenshot, click/type/hover/drag/batch form input, file upload, dialog handling, conditional wait, batched steps, tab management, and — behind the full-control setting — console, network, and JavaScript evaluation. The side panel also accepts PNG, JPEG, WebP, and GIF attachments when the host advertises image support.

> [!IMPORTANT]
> The workspace pins dsh 0.1.5-rc.2, the minimum supported runtime. Older DSH releases are not supported.

## Install

Each [release](https://github.com/Onenightcarnival/dsh-toolkit/releases) ships two files:

| File | Contents |
|---|---|
| `onenightcarnival-dsh-bridge-browser-<version>.tgz` | bridge plugin for the dsh `web` profile |
| `dsh-browser-extension-chrome-<version>.zip` | built Chrome extension, loaded unpacked |

1. **Bridge plugin**
   - DeepSeek Harness Desktop: 插件 → 配置中心… → 插件 → 「从 .tgz 安装」, pick the `.tgz`, restart when prompted.
   - dsh CLI: `npx @deepseek-ai/dsh@0.1.5-rc.2 plugin --profile web add file:<path to .tgz>`, then start (or restart) `dsh web`.
2. **Chrome extension**: unzip into a folder you will keep, open `chrome://extensions`, enable Developer mode, choose "Load unpacked" and select that folder.
3. Open any `http(s)` page and click the DeepSeek whale icon. The side panel shows **Connected**.

**Update**: install the new `.tgz` the same way, replace the extension folder's contents with the new zip, click **Reload** on the extension card in `chrome://extensions`, then restart dsh. The side panel's Updates card compares the installed version with the repository and links to Releases.

Firefox has no packaged build; see [Firefox source build](#firefox-source-build).

> [!IMPORTANT]
> The unscoped [`dsh-browser`](https://www.npmjs.com/package/dsh-browser) package on npm belongs to a different project and is not affiliated with this repository. Install from Releases only.

## Using with DeepSeek Harness Desktop

The desktop app starts dsh on a random port. The bridge plugin therefore runs a discovery beacon: a loopback listener on `127.0.0.1:43189` (falling back through 43192) that answers only `/ext/bridge-config` with the real bridge URL. The extension probes that port window, and the desktop app needs no change. `discoveryPort: 0` disables the beacon.

Install both files as described in [Install](#install).

### Compatibility

The bridge is pinned to dsh 0.1.5-rc.2, the desktop app's bundled version. A desktop release on a new dsh line needs a rebased bridge and a reinstall.

### Troubleshooting

While the desktop app runs, `http://127.0.0.1:43189/ext/bridge-config` returns `{"wsUrl":"ws://127.0.0.1:<port>/ext/bridge"}`.

- No response: the plugin is not in the web profile (the plugin manager should list `@onenightcarnival/dsh-bridge-browser`), or the app has not been restarted.
- 43189 held by another program: the desktop log line `discovery beacon listening on` names the port in use; alternatively set the bridge address in the extension settings.

## Performance

In a paired 60-run end-to-end benchmark on August 18, 2026, both backends completed all 30 assigned runs successfully, while dsh Browser Control required fewer model/tool round trips and finished faster:

| Backend | Success | Mean end-to-end latency | Mean browser tool calls |
|---|---:|---:|---:|
| **dsh Browser Control** | **30/30** | **5.32 s** | **3.4** |
| Matched Playwright baseline | 30/30 | 6.67 s | 4.7 |

The paired Playwright / extension duration ratio was **1.24** (95% CI **1.16–1.34**): Playwright took about 24% longer, or equivalently, dsh Browser Control reduced latency by about 20% and saved 1.35 seconds per task on average. The suite used six browser tasks, five deterministic seeds, the same DSH profile and model (`deepseek-v4-flash`), and independently validated page state. See the [benchmark methodology and reproduction guide](benchmark/README.md).

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
scripts/package-desktop.mjs
scripts/version.mjs
```

## Why this design

- **Your real browser, not a headless copy**: the model works in the page you already have open, retaining logins, sessions, and cookies.
- **A text-first page interface with screenshots as a supplement**: numbered controls, stable IDs across snapshots, delta updates, and masked sensitive values make most pages operable without images; charts, canvases, and complex layouts get an annotated screenshot whose labels are the snapshot indices.
- **Pointing instead of describing**: highlight the passage you mean and the side panel quotes it, so "explain this" needs no page tour. The quote is captured only while a panel is open, and nothing is sent until you send the message.
- **A narrow privacy boundary**: passwords and payment-card values are always rendered as `••••` and never leave the page.
- **A guarded bridge**: authenticated handshakes protect remote connections, privileged gateway methods reject non-loopback callers, and the extension binds tools to one user-controlled tab.

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

The bridge address is still auto-discovered. Firefox's `moz-extension://` UUID does not authenticate an add-on, so copy the bearer token from `~/.dsh/ext-bridge-token` into the extension settings (the dsh startup log reports that file's path). Signed distribution can package the same `dist-firefox/` output.

### Start and use

From a source checkout, run `pnpm start` in the repository root. The exact supported public runtime is:

```sh
npx @deepseek-ai/dsh@0.1.5-rc.2 web
```

Local Chrome use requires no configuration; Firefox requires the local bridge token described above. Open a page, click the DeepSeek whale icon, and wait for **Connected**. Existing HTTP(S) tabs are instrumented on the first action. On browser-protected pages and extension stores, the model can read tab metadata and use browser-level HTTP(S) navigation, back, forward, and reload, but it cannot inspect or operate the protected page DOM.

## Troubleshooting

**Side panel stays "Not connected"**

- Make sure dsh web is running locally (default `http://127.0.0.1:3080`).
- Verify the bridge is loaded: open `http://127.0.0.1:3080/ext/bridge-config`. It should return JSON such as `{"wsUrl":"ws://127.0.0.1:3080/ext/bridge"}`. If it returns a web page instead of JSON, the running dsh predates the bridge registration — restart dsh and refresh the page; the extension reconnects on its own.
- The extension probes ports 3080, 3081 and 3090, the discovery-beacon window 43189–43192, and the legacy desktop port 14389 automatically. If dsh runs on another port with the beacon disabled — or you use a remote `--host 0.0.0.0` deployment — set the address (and bridge token) in the panel settings. Firefox always requires the token.

## Development

Development and release steps: [repository README](../README.md).

## Security

- The bridge path sits outside the `/api` trust boundary and performs its own bearer-token authentication.
- Local Chrome extension origins retain zero-configuration loopback access; Firefox origins are per-install UUIDs and must present the bearer token.
- Privileged gateway methods such as `settings.*`, `credentials.*`, and `host.open*` reject non-loopback sources.
- Password and payment-card values never leave the page through the text pipeline. Screenshots go through the same approval as page reads (and are blocked when page-content sharing is off), but password fields cannot be masked inside an image, so disable or decline screenshots on sensitive pages; captured images are saved through dsh's durable attachment service and handed to the model as image blocks. **Allow screenshots** in Settings turns `browser_screenshot` off entirely.
- **Trusted input** (off by default) sends clicks, key presses, hovers, and drags through Chrome's debugger API as real input events, so Tab moves focus and canvas apps respond; it requests the optional `debugger` permission and shows Chrome's "is debugging this browser" bar while a tab is attached. Turning it off detaches every tab immediately.
- The first action on a page installs main-world hooks that answer `alert`/`confirm`/`prompt` (so a dialog cannot freeze the tab), and record console output and fetch/XHR metadata (URL, method, status, timing — never bodies). Pure reads install nothing. `browser_console`, `browser_network`, and `browser_evaluate` are refused unless **Allow unrestricted browser control** is on; everything they return is page-authored and wrapped as untrusted content.
- `browser_upload` reads only files under the session's working directory — the same boundary as the agent's file tools — and never widens it.
- When work begins, the assistant binds to the active tab (at prompt submission, or at the first direct browser-tool call). If you switch tabs manually, later browser actions pause and the side panel asks whether the assistant should continue on the original tab or follow the new one. Choosing the original tab permits background operation; the extension never silently retargets or changes your visible tab. Closing the controlled tab also pauses tools until you explicitly select the current page.
- Text you highlight is captured only while a side panel is open and page sharing is not `off`, and never from password or payment-card fields. It stays inside the extension until you send the message, is dropped when you dismiss it or its page navigates or closes, and reaches the model inside the same untrusted-content boundary as page snapshots — including its source title and URL, which the page also controls.
- Page-authored text is wrapped as untrusted input. The default `auto` mode reads only the controlled tab without an extra prompt; privacy-sensitive users can select `ask` for per-read confirmation or `off` to block reads entirely. In `ask` mode, the read dialog can allow one read or persistently switch back to `auto`; this can be reversed in Settings. Read page text is sent to the selected model.
- Click, type, keypress, navigation, history, and reload calls fail closed until the user approves them. An origin may be trusted for the current side-panel session (cleared when the last panel closes or the service worker restarts), while permanent trust is managed explicitly in Settings. Explicit cross-origin `browser_navigate` calls and unknown history destinations always prompt again.
- **Allow unrestricted browser control** is an explicit global opt-in. It becomes active only after the setting is saved successfully; while enabled, page reads, page actions, and tab list/follow/close operations run without approval prompts. Calls capture their access mode when received, so enabling unrestricted control never retroactively elevates an existing restricted call. Disabling it takes effect immediately, cancels calls that have not dispatched an action, waits for already-dispatched browser operations to settle, and only then saves the restrictive setting. A rapid re-enable remains restricted until that revocation finishes, and concurrent saves persist in request order. Browser-protected DOM content remains inaccessible in either mode.
