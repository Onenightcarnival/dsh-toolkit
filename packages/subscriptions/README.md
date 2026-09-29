# @onenightcarnival/dsh-subscriptions

**English** | [中文](README.zh.md)

ChatGPT subscriptions for DeepSeek Harness. The **AI subscriptions** sidebar panel follows the S3 / RDB layout and host theme, with English and Chinese translations.

Install this package or the toolkit:

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-subscriptions-0.6.0.tgz
```

Connect ChatGPT through browser OAuth. The callback tries local ports 1455 and 1457. If both are reserved or occupied, login automatically switches to manual callback mode: finish authorization, then copy the complete `localhost` URL from the browser address bar into the panel, even if that browser page cannot load. Credentials stay on the host. Add accounts, select the default, or disconnect them from the panel.

- **Models:** account-discovered ChatGPT (Codex) models in the conversation picker; refresh, visibility controls, default reasoning effort and editable context windows. Enter `256K`, `1M`, `1.5M` or a positive integer (decimal units), then press Enter or Save. Clear and save or choose Reset to default to inherit the catalog value. Context settings are shared across accounts; explicitly advertised maximums still apply.
- **Web Search:** `codex_web_search` uses the ChatGPT subscription directly, with DSH search cards and source URLs. DSH's web search provider setting is independent.
- **Images:** `codex_image_generate` supports generation and attachment-based editing, local files and inline image previews/downloads. Files live under `plugins/subscriptions/images/` in the DSH home.
- **Usage:** per-account quota windows and reset times, refreshed on demand. Missing usage is shown as unknown.

| Tool | Input | Result |
| --- | --- | --- |
| `codex_web_search` | `query` | Summary and up to eight sources |
| `codex_image_generate` | `prompt`; optional `referenceImages`, `size`, `quality` | Local paths and image attachments |

Tool lists use the settings at conversation creation. Disabling search also blocks calls in existing conversations immediately. Persisted switches use the capability keys `web_search` and `image_generate`.

Access depends on account entitlements and quota. This integration uses the ChatGPT subscription Codex backend; no OpenAI API key is required. Offline tests do not establish live account access.

The toolkit enables this module by default; set `subscriptions: false` to remove both host and UI. Standalone plugin ID: `subscriptions`. Optional config: `enabled`, `codexClientVersion`, `streamIdleTimeoutMs`, `rateLimit`, and a `models` array overriding discovery. Model entries accept `id`, `name`, `contextWindow`, and `inputModalities`. Defaults are recommended.

Auth and preferences use `plugins/subscriptions/` in the DSH home. The original subscription plugin shares the provider and authenticated RPC names; the two packages cannot be loaded together.

`src/backend` contains OAuth PKCE, token refresh, streaming model adapters, Codex search and image attachment handling. ChatGPT (Codex) is the sole provider. The backend builds from local source. Source provenance and MIT license notices reside in `THIRD_PARTY_LICENSES.txt`.

Third-party notices are included in both standalone and toolkit artifacts. Backend changes require rerunning the OAuth, RPC, model and tool-policy integration tests.

After building, run `pnpm --filter @onenightcarnival/dsh-subscriptions test` for RPC and panel regression tests, and `pnpm --filter @onenightcarnival/dsh-subscriptions test:smoke` for the real web host in isolated DSH homes (standalone, toolkit enabled/disabled and authentication). No personal credentials or live model calls are used. `node packages/subscriptions/test/preview.mjs` serves a local UI fixture with sample data only.
