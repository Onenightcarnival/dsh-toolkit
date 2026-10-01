# dsh Browser Control Extension (Chrome and Firefox MV3)

English | [中文](README.zh.md)

Chrome / Firefox MV3 extension for dsh, with real-tab control, preserved login state and side-panel conversations.

| Channel | Data |
|---|---|
| Page snapshot | Structured text, numbered controls and masked sensitive fields |
| Page screenshot | Annotated viewport PNG from `browser_screenshot` |
| Chat attachments | PNG, JPEG, WebP and GIF; image support and limits advertised by the host |

## User guide

Installation, tools, page permissions and limitations: [browser control guide](../../docs/browser.md).

## Architecture

```
side panel (React) ◄─port─► background SW/event page ◄─WS─► dsh bridge plugin
                                 │
                  tabs.sendMessage (DSH_ACTION, DSH_SELECTION_WATCH)
                                 ▲ DSH_SELECTION
                                 ▼
                        content script (snapshot/actions/privacy/selection)
```

| Layer | Responsibility |
|---|---|
| `src/background/` | Bridge authentication, reconnect and keepalive; RPC; controlled-tab dispatch and approval |
| `src/content/` | Snapshots, stable element numbers, deltas, actions and sensitive-field masking |
| Selection watcher | Debounced capture with an open panel and page sharing enabled |
| `src/panel/` | Sessions, history, live events, settings, Markdown, question cards, tab handoff and stop control |
| Image attachments | Host capability and size checks; session-authorized durable reads |
| Selection quote | Removable quote included in the next prompt inside the untrusted-content boundary |
| Protocol | `protocol.ts` from `@onenightcarnival/dsh-bridge-browser`, shared through its source export |

## Build

```sh
pnpm install
pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

Run these commands from the repository root. Chrome outputs to `extensions/dsh-browser/dist/`; Firefox outputs to `extensions/dsh-browser/dist-firefox/`.

## Development loading

- Chrome: load `extensions/dsh-browser/dist/` from `chrome://extensions`.
- Firefox: load `extensions/dsh-browser/dist-firefox/manifest.json` from `about:debugging#/runtime/this-firefox`.
- Rebuild and reload after code changes.
