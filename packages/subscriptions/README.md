# @onenightcarnival/dsh-subscriptions

**English** | [中文](README.zh.md)

ChatGPT subscriptions for DeepSeek Harness. The **AI subscriptions** sidebar panel follows the S3 / RDB layout and host theme, with English and Chinese translations.

Install this package or the toolkit:

```sh
dsh plugin --profile web add file:./onenightcarnival-dsh-subscriptions-0.6.0.tgz
```

Connect ChatGPT through browser OAuth. The callback tries local ports 1455 and 1457. If both are reserved or occupied, login automatically switches to manual callback mode: finish authorization, then copy the complete `localhost` URL from the browser address bar into the panel, even if that browser page cannot load. Credentials stay on the host. Add accounts, select the default, or disconnect them from the panel.

- **Models:** account-discovered ChatGPT (Codex) models in the conversation picker; refresh, visibility controls and default reasoning effort.
- **Web Search:** uses native `web_search` and citations. Select `codex` in Settings → Web search. The switch takes effect immediately and releases search to other providers when disabled.
- **Images:** `image_generate` supports generation and attachment-based editing, local files and inline image previews/downloads. Image tool settings apply to newly created conversations. Files live under `plugins/subscriptions/images/` in the DSH home.
- **Usage:** per-account quota windows and reset times, refreshed on demand. Missing usage is shown as unknown.

Access depends on account entitlements and quota. This integration uses the ChatGPT subscription Codex backend; no OpenAI API key is required. Offline tests do not establish live account access.

The toolkit enables this module by default; set `subscriptions: false` to remove both host and UI. Standalone plugin ID: `subscriptions`. Optional config: `enabled`, `codexClientVersion`, `streamIdleTimeoutMs`, `rateLimit`, and a `models` array overriding discovery. Model entries accept `id`, `name`, `contextWindow`, and `inputModalities`. Defaults are recommended.

Auth and preferences use `plugins/subscriptions/` in the DSH home, compatible with the reference plugin. Do not load the original subscription plugin alongside this package: they share provider, tool and authenticated RPC names.

The subscription backend is a locally maintained fork in `src/backend`, built directly from source. It includes OAuth PKCE, token refresh, streaming model adapters, native search and image attachment handling. Only ChatGPT (Codex) is enabled. This package does not depend on the original plugin's npm package. Source provenance and the original MIT license are preserved in `THIRD_PARTY_LICENSES.txt`.

Third-party notices are included in both standalone and toolkit artifacts. Backend changes require rerunning the OAuth, RPC, model and tool-policy integration tests.

After building, run `pnpm --filter @onenightcarnival/dsh-subscriptions test` for RPC and panel regression tests, and `pnpm --filter @onenightcarnival/dsh-subscriptions test:smoke` for the real web host in isolated DSH homes (standalone, toolkit enabled/disabled and authentication). No personal credentials or live model calls are used. `node packages/subscriptions/test/preview.mjs` serves a local UI fixture with sample data only.
